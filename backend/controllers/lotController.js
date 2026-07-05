const { pool } = require("../db/pool");
const path    = require("path");
const fs      = require("fs");
const ExcelJS = require("exceljs");
const archiver = require("archiver");
const s3dExportQ = require("../db/queries/s3dExportQueries");

const UPLOADS_ROOT = path.join(__dirname, "..", "uploads");

// Read PDF page count from raw bytes (no heavy dep needed)
async function getPdfPageCount(filePath) {
  try {
    const buf = await fs.promises.readFile(filePath);
    const str = buf.toString("latin1");
    const m = str.match(/\/Type\s*\/Pages\b[\s\S]{0,400}?\/Count\s+(\d+)/);
    if (m) return parseInt(m[1]);
    return (str.match(/\/Type\s*\/Page\b/g) || []).length || 1;
  } catch { return 1; }
}

function fmtDate(d) {
  if (!d) return "";
  const dt = new Date(d);
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const yy = dt.getFullYear();
  return `${dd}-${mm}-${yy}`;
}

pool.query(`
  CREATE TABLE IF NOT EXISTS lots (
    id          SERIAL PRIMARY KEY,
    lot_number  INTEGER      NOT NULL,
    job_no      VARCHAR(50)  NOT NULL,
    unit_no     VARCHAR(50)  NOT NULL,
    created_by  VARCHAR(50)  NOT NULL,
    created_at  TIMESTAMPTZ  DEFAULT NOW(),
    issued_at   TIMESTAMPTZ  DEFAULT NULL
  );
  CREATE TABLE IF NOT EXISTS lot_lines (
    lot_id      INTEGER NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
    drawing_id  INTEGER NOT NULL REFERENCES drawings(id),
    PRIMARY KEY (lot_id, drawing_id)
  );
  ALTER TABLE lots ADD COLUMN IF NOT EXISTS issued_at TIMESTAMPTZ DEFAULT NULL;
  ALTER TABLE lot_lines ADD COLUMN IF NOT EXISTS file_path TEXT DEFAULT NULL;
`).catch(console.error);

// One-time backfill: issued lot_lines rows from before file_path snapshotting
// existed have NULL file_path. Without a value there, the revision-aware
// "already issued" checks elsewhere can't match them and would wrongly treat
// them as never-issued. Backfilling with each drawing's CURRENT file is safe —
// correct for the common case (no revision since issuance), and no worse than
// today's behavior for the rare case where one occurred unnoticed. Idempotent:
// only touches rows still NULL, so it's a no-op after the first run.
pool.query(`
  UPDATE lot_lines ll
  SET file_path = 'uploads/' || d.job_no || '/' || d.unit_no || '/' || d.zone || '/' || d.stored_file
  FROM drawings d, lots l
  WHERE ll.drawing_id = d.id AND ll.lot_id = l.id
    AND l.issued_at IS NOT NULL AND ll.file_path IS NULL
`).catch(console.error);

// Extracts the revision number (R<n>) from a stored-file path/name like
// ".../LINE_R1-3.pdf". Used to show the revision that was ACTUALLY issued
// (from the lot_lines file_path snapshot) rather than the drawing's current
// rev_no, which may have moved on since this lot was issued.
function extractRevNo(fileNameOrPath) {
  if (!fileNameOrPath) return null;
  const m = fileNameOrPath.match(/_R(\d+)-\d+\.pdf$/i);
  return m ? parseInt(m[1], 10) : null;
}

// POST /api/lots/create
async function createLot(req, res) {
  const { jobNo, unitNo, lineNos } = req.body;
  const userId = req.session.user.id;
  if (!jobNo || !unitNo || !Array.isArray(lineNos) || lineNos.length === 0)
    return res.status(400).json({ ok: false, error: "jobNo, unitNo, lineNos[] required" });

  try {
    const { rows: seq } = await pool.query(
      `SELECT COALESCE(MAX(lot_number), 0) + 1 AS next_lot FROM lots WHERE job_no=$1 AND unit_no=$2`,
      [jobNo, unitNo]
    );
    const lotNumber = seq[0].next_lot;

    const { rows } = await pool.query(
      `INSERT INTO lots (lot_number, job_no, unit_no, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
      [lotNumber, jobNo, unitNo, userId]
    );
    const lotId = rows[0].id;

    for (const lineNo of lineNos) {
      const { rows: drw } = await pool.query(
        `SELECT id FROM drawings WHERE job_no=$1 AND unit_no=$2 AND line_no=$3 LIMIT 1`,
        [jobNo, unitNo, lineNo]
      );
      if (drw[0]) {
        // Remove from any other planned (unissued) lot first
        await pool.query(
          `DELETE FROM lot_lines WHERE drawing_id=$1 AND lot_id IN (SELECT id FROM lots WHERE issued_at IS NULL AND job_no=$2 AND unit_no=$3)`,
          [drw[0].id, jobNo, unitNo]
        );
        await pool.query(
          `INSERT INTO lot_lines (lot_id, drawing_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [lotId, drw[0].id]
        );
      }
    }

    // Delete any planned lots that were left empty after lines were stripped above
    await pool.query(
      `DELETE FROM lots WHERE job_no=$1 AND unit_no=$2 AND issued_at IS NULL
       AND id NOT IN (SELECT DISTINCT lot_id FROM lot_lines)`,
      [jobNo, unitNo]
    );

    res.json({ ok: true, lotId, lotNumber, message: `Lot ${lotNumber} created with ${lineNos.length} line(s)` });
  } catch (err) {
    console.error("createLot error:", err);
    res.status(500).json({ ok: false, error: "Failed to create lot" });
  }
}

// GET /api/lots/planned?project=X&unit=Y
async function getPlannedLots(req, res) {
  const { project, unit } = req.query;
  if (!project || !unit)
    return res.status(400).json({ ok: false, error: "project and unit required" });

  try {
    const { rows } = await pool.query(
      `SELECT l.id, l.lot_number, COUNT(ll.drawing_id)::int AS line_count
       FROM lots l
       LEFT JOIN lot_lines ll ON ll.lot_id = l.id
       WHERE l.job_no=$1 AND l.unit_no=$2 AND l.issued_at IS NULL
       GROUP BY l.id
       ORDER BY l.lot_number`,
      [project, unit]
    );
    res.json({ ok: true, lots: rows.map(r => ({ id: r.id, lotNumber: r.lot_number, lineCount: r.line_count })) });
  } catch (err) {
    console.error("getPlannedLots error:", err);
    res.status(500).json({ ok: false, error: "Failed" });
  }
}

// POST /api/lots/:lotId/issue
// Body: { excludeLineIds: [drawingId, ...] }  — lines to carry forward to next lot
async function issueLot(req, res) {
  const lotId = parseInt(req.params.lotId);
  const { excludeLineIds = [] } = req.body;
  const userId = req.session.user.id;

  try {
    const { rows: lotRows } = await pool.query(
      `SELECT * FROM lots WHERE id=$1 AND issued_at IS NULL`, [lotId]
    );
    if (!lotRows[0])
      return res.status(404).json({ ok: false, error: "Lot not found or already issued" });
    const lot = lotRows[0];

    // Snapshot each line's current file path into lot_lines before issuing
    await pool.query(
      `UPDATE lot_lines ll
       SET file_path = 'uploads/' || d.job_no || '/' || d.unit_no || '/' || d.zone || '/' || d.stored_file
       FROM drawings d
       WHERE d.id = ll.drawing_id AND ll.lot_id = $1`,
      [lotId]
    );

    await pool.query(`UPDATE lots SET issued_at=NOW() WHERE id=$1`, [lotId]);

    if (excludeLineIds.length > 0) {
      // Auto-create next planned lot for carry-forward lines
      const { rows: seq } = await pool.query(
        `SELECT COALESCE(MAX(lot_number), 0) + 1 AS next_lot FROM lots WHERE job_no=$1 AND unit_no=$2`,
        [lot.job_no, lot.unit_no]
      );
      const nextLotNumber = seq[0].next_lot;

      const { rows: newLot } = await pool.query(
        `INSERT INTO lots (lot_number, job_no, unit_no, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
        [nextLotNumber, lot.job_no, lot.unit_no, userId]
      );
      const newLotId = newLot[0].id;

      for (const drawingId of excludeLineIds) {
        await pool.query(`DELETE FROM lot_lines WHERE lot_id=$1 AND drawing_id=$2`, [lotId, drawingId]);
        await pool.query(
          `INSERT INTO lot_lines (lot_id, drawing_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [newLotId, drawingId]
        );
      }
    }

    // S3D lock feed — every line that actually stayed in this issued lot gets its lot no attached.
    const { rows: issuedLines } = await pool.query(
      `SELECT d.job_no, d.unit_no, d.zone, d.line_no
       FROM lot_lines ll JOIN drawings d ON d.id = ll.drawing_id
       WHERE ll.lot_id=$1`,
      [lotId]
    );
    for (const line of issuedLines) {
      await s3dExportQ.markLotIssued({
        jobNo: line.job_no, unitNo: line.unit_no, zone: line.zone, lineNo: line.line_no,
        lotNo: lot.lot_number,
      }).catch(e => console.error("[S3D] markLotIssued error:", e.message));
    }

    res.json({ ok: true, message: `Lot ${lot.lot_number} issued`, lotNumber: lot.lot_number });
  } catch (err) {
    console.error("issueLot error:", err);
    res.status(500).json({ ok: false, error: "Failed to issue lot" });
  }
}

// POST /api/lots/:lotId/lines  — add more lines to an existing planned lot
async function assignLinesToLot(req, res) {
  const lotId = parseInt(req.params.lotId);
  const { jobNo, unitNo, lineNos } = req.body;
  if (!jobNo || !unitNo || !Array.isArray(lineNos) || lineNos.length === 0)
    return res.status(400).json({ ok: false, error: "jobNo, unitNo, lineNos[] required" });

  try {
    const { rows: lotRows } = await pool.query(
      `SELECT * FROM lots WHERE id=$1 AND issued_at IS NULL`, [lotId]
    );
    if (!lotRows[0])
      return res.status(404).json({ ok: false, error: "Lot not found or already issued" });

    for (const lineNo of lineNos) {
      const { rows: drw } = await pool.query(
        `SELECT id FROM drawings WHERE job_no=$1 AND unit_no=$2 AND line_no=$3 LIMIT 1`,
        [jobNo, unitNo, lineNo]
      );
      if (drw[0]) {
        // Remove from any other planned lot first
        await pool.query(
          `DELETE FROM lot_lines WHERE drawing_id=$1 AND lot_id IN (SELECT id FROM lots WHERE issued_at IS NULL AND job_no=$2 AND unit_no=$3)`,
          [drw[0].id, jobNo, unitNo]
        );
        await pool.query(
          `INSERT INTO lot_lines (lot_id, drawing_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [lotId, drw[0].id]
        );
      }
    }

    // Delete any planned lots left empty after lines were moved above
    await pool.query(
      `DELETE FROM lots WHERE job_no=$1 AND unit_no=$2 AND issued_at IS NULL
       AND id NOT IN (SELECT DISTINCT lot_id FROM lot_lines)`,
      [jobNo, unitNo]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("assignLinesToLot error:", err);
    res.status(500).json({ ok: false, error: "Failed to assign lines" });
  }
}

// DELETE /api/lots/:lotId/lines/:drawingId  — remove a line from a planned lot
async function removeLineFromLot(req, res) {
  const lotId = parseInt(req.params.lotId);
  const drawingId = parseInt(req.params.drawingId);
  try {
    await pool.query(`DELETE FROM lot_lines WHERE lot_id=$1 AND drawing_id=$2`, [lotId, drawingId]);
    // If the lot is now empty and still unissued, delete it
    await pool.query(
      `DELETE FROM lots WHERE id=$1 AND issued_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM lot_lines WHERE lot_id=$1)`,
      [lotId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("removeLineFromLot error:", err);
    res.status(500).json({ ok: false, error: "Failed" });
  }
}

// GET /api/lots  — all lots (issued + planned), tree grouped by job → unit
async function getLots(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT l.id, l.lot_number, l.job_no, l.unit_no, l.created_at, l.issued_at,
              COUNT(ll.drawing_id)::int AS line_count
       FROM lots l
       LEFT JOIN lot_lines ll ON ll.lot_id = l.id
       GROUP BY l.id
       ORDER BY l.job_no, l.unit_no, l.lot_number`
    );

    const tree = {};
    for (const r of rows) {
      if (!tree[r.job_no]) tree[r.job_no] = {};
      if (!tree[r.job_no][r.unit_no]) tree[r.job_no][r.unit_no] = [];
      tree[r.job_no][r.unit_no].push({
        id:        r.id,
        lotNumber: r.lot_number,
        lineCount: r.line_count,
        createdAt: r.created_at,
        issuedAt:  r.issued_at || null,
        issued:    !!r.issued_at,
      });
    }
    res.json({ ok: true, tree });
  } catch (err) {
    console.error("getLots error:", err);
    res.status(500).json({ ok: false, error: "Failed" });
  }
}

// GET /api/lots/:lotId/lines
async function getLotLines(req, res) {
  const lotId = parseInt(req.params.lotId);
  try {
    const { rows: lotRows } = await pool.query(`SELECT * FROM lots WHERE id=$1`, [lotId]);
    if (!lotRows[0]) return res.status(404).json({ ok: false, error: "Lot not found" });
    const lot = lotRows[0];

    const { rows } = await pool.query(
      `SELECT d.id, d.job_no, d.unit_no, d.zone, d.line_no, d.stored_file, d.rev_no, d.stress_critical,
              ll.file_path AS lot_file_path,
              inch.inch_dia, inch.inch_meter,
              appr.approved_by_name, appr.approved_at
       FROM lot_lines ll
       JOIN drawings d ON d.id = ll.drawing_id
       LEFT JOIN inch_data inch
         ON inch.job_no = d.job_no AND inch.unit_no = d.unit_no AND inch.line_no = d.line_no
       LEFT JOIN LATERAL (
         -- Scoped to the revision that was ACTUALLY issued in this lot (parsed
         -- from the ll.file_path snapshot, same as the revNo display below) —
         -- not d.rev_no, which may have moved on since this lot was issued.
         -- Without this, a line issued at R0 then later approved again at R1
         -- would show R1's approver here, even though this lot reflects R0.
         SELECT u.name AS approved_by_name, src.ts AS approved_at
         FROM (
           SELECT user_id, created_at AS ts, 1 AS pri
           FROM drawing_comments
           WHERE drawing_id = d.id AND type = 'approve'
             AND rev_no = COALESCE((regexp_match(ll.file_path, '_R(\\d+)-\\d+\\.pdf$'))[1]::int, d.rev_no)
           UNION ALL
           SELECT user_id, completed_at AS ts, 2 AS pri
           FROM drawing_claims
           WHERE drawing_id = d.id AND comment_type = 'approve' AND completed_at IS NOT NULL
         ) src
         JOIN users u ON u.id = src.user_id
         ORDER BY src.pri ASC, src.ts DESC
         LIMIT 1
       ) appr ON true
       WHERE ll.lot_id = $1
       ORDER BY d.line_no`,
      [lotId]
    );

    res.json({
      ok: true,
      lot: { id: lot.id, lotNumber: lot.lot_number, jobNo: lot.job_no, unitNo: lot.unit_no, createdAt: lot.created_at, issuedAt: lot.issued_at, issued: !!lot.issued_at },
      lines: rows.map(d => ({
        drawingId:      d.id,
        jobNo:          d.job_no,
        unitNo:         d.unit_no,
        zone:           d.zone,
        lineNo:         d.line_no,
        // Prefer the revision that was ACTUALLY issued (from the file_path
        // snapshot) over the drawing's current rev_no, which may have moved
        // on if the line was re-uploaded since this lot was issued.
        revNo:          extractRevNo(d.lot_file_path) ?? (d.rev_no || 0),
        stressCritical: d.stress_critical || 'N',
        approvedBy:     d.approved_by_name || null,
        approvedAt:     d.approved_at      || null,
        inchDia:        d.inch_dia   != null ? Number(d.inch_dia)   : null,
        inchMeter:      d.inch_meter != null ? Number(d.inch_meter) : null,
        filePath:       d.lot_file_path || (d.stored_file ? `uploads/${d.job_no}/${d.unit_no}/${d.zone}/${d.stored_file}` : null),
      })),
    });
  } catch (err) {
    console.error("getLotLines error:", err);
    res.status(500).json({ ok: false, error: "Failed" });
  }
}

// POST /api/lots/issue-selected
// GL selects finalized lines from Final Isometrics and issues the current planned lot.
// Logic:
//   1. Take the lowest planned lot for this job/unit (create one if none exists)
//   2. Issue it with exactly the selected lines
//   3. Any lines that were in the planned lot but NOT selected → carry forward to the next planned lot
async function issueSelectedLines(req, res) {
  const { jobNo, unitNo, lineNos } = req.body;
  const userId = req.session.user.id;
  if (!jobNo || !unitNo || !Array.isArray(lineNos) || lineNos.length === 0)
    return res.status(400).json({ ok: false, error: "jobNo, unitNo, lineNos[] required" });

  try {
    // Guard: detect a cross-unit selection before touching any lot data. The
    // per-line resolution below (step 3) is scoped to (jobNo, unitNo), so a
    // line belonging to a different unit than the one requested would
    // otherwise just fail to match and be silently dropped — no error, no
    // indication to the caller. Catch that here and reject with a per-unit
    // breakdown instead of letting anything partially issue.
    const { rows: unitBreakdown } = await pool.query(
      `SELECT unit_no, COUNT(*)::int AS cnt FROM drawings
       WHERE job_no=$1 AND line_no = ANY($2::text[])
       GROUP BY unit_no`,
      [jobNo, lineNos]
    );
    if (unitBreakdown.length > 1) {
      const breakdown = unitBreakdown.map(r => `${r.cnt} ISO selected in Unit ${r.unit_no}`).join(', ');
      return res.status(409).json({
        ok: false,
        error: `Selected lines span multiple units: ${breakdown}. Please issue lots separately for each unit.`,
        unitBreakdown: unitBreakdown.map(r => ({ unitNo: r.unit_no, count: r.cnt }))
      });
    }

    // 1. Find or create the lowest planned lot
    const { rows: planned } = await pool.query(
      `SELECT id, lot_number FROM lots WHERE job_no=$1 AND unit_no=$2 AND issued_at IS NULL ORDER BY lot_number ASC LIMIT 1`,
      [jobNo, unitNo]
    );

    let lotId, lotNumber;
    if (planned.length > 0) {
      ({ id: lotId, lot_number: lotNumber } = planned[0]);
    } else {
      const { rows: seq } = await pool.query(
        `SELECT COALESCE(MAX(lot_number), 0) + 1 AS next_lot FROM lots WHERE job_no=$1 AND unit_no=$2`,
        [jobNo, unitNo]
      );
      lotNumber = seq[0].next_lot;
      const { rows: nl } = await pool.query(
        `INSERT INTO lots (lot_number, job_no, unit_no, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
        [lotNumber, jobNo, unitNo, userId]
      );
      lotId = nl[0].id;
    }

    // 2. Lines currently planned in this lot (before we change anything)
    const { rows: existingLines } = await pool.query(
      `SELECT drawing_id FROM lot_lines WHERE lot_id=$1`, [lotId]
    );
    const plannedDrawingIds = new Set(existingLines.map(r => r.drawing_id));

    // 3. Resolve selected lineNos → drawing IDs
    const selectedDrawingIds = [];
    for (const lineNo of lineNos) {
      const { rows: drw } = await pool.query(
        `SELECT id FROM drawings WHERE job_no=$1 AND unit_no=$2 AND line_no=$3 LIMIT 1`,
        [jobNo, unitNo, lineNo]
      );
      if (drw[0]) selectedDrawingIds.push(drw[0].id);
    }
    const selectedSet = new Set(selectedDrawingIds);

    // 4. Carry-forward = lines that were planned but are NOT in the selection
    const carryForwardIds = [...plannedDrawingIds].filter(id => !selectedSet.has(id));

    // 5. Remove selected lines from any OTHER planned lots they may belong to
    for (const drawingId of selectedDrawingIds) {
      await pool.query(
        `DELETE FROM lot_lines WHERE drawing_id=$1 AND lot_id != $2
         AND lot_id IN (SELECT id FROM lots WHERE issued_at IS NULL AND job_no=$3 AND unit_no=$4)`,
        [drawingId, lotId, jobNo, unitNo]
      );
    }

    // 6. Replace this lot's lines with exactly the selection, snapshotting current file path
    await pool.query(`DELETE FROM lot_lines WHERE lot_id=$1`, [lotId]);
    for (const drawingId of selectedDrawingIds) {
      const { rows: drw } = await pool.query(
        `SELECT job_no, unit_no, zone, stored_file FROM drawings WHERE id=$1`, [drawingId]
      );
      const fp = drw[0]
        ? `uploads/${drw[0].job_no}/${drw[0].unit_no}/${drw[0].zone}/${drw[0].stored_file}`
        : null;
      await pool.query(
        `INSERT INTO lot_lines (lot_id, drawing_id, file_path) VALUES ($1,$2,$3) ON CONFLICT (lot_id, drawing_id) DO UPDATE SET file_path = EXCLUDED.file_path`,
        [lotId, drawingId, fp]
      );
    }

    // 7. Issue the lot
    await pool.query(`UPDATE lots SET issued_at=NOW() WHERE id=$1`, [lotId]);

    // S3D lock feed — attach the lot no to every line actually issued in it.
    if (selectedDrawingIds.length > 0) {
      const { rows: issuedLines } = await pool.query(
        `SELECT job_no, unit_no, zone, line_no FROM drawings WHERE id = ANY($1::int[])`,
        [selectedDrawingIds]
      );
      for (const line of issuedLines) {
        await s3dExportQ.markLotIssued({
          jobNo: line.job_no, unitNo: line.unit_no, zone: line.zone, lineNo: line.line_no,
          lotNo: lotNumber,
        }).catch(e => console.error("[S3D] markLotIssued error:", e.message));
      }
    }

    // 8. Carry-forward lines → next planned lot (find existing or create)
    if (carryForwardIds.length > 0) {
      const { rows: nextPlanned } = await pool.query(
        `SELECT id FROM lots WHERE job_no=$1 AND unit_no=$2 AND issued_at IS NULL ORDER BY lot_number ASC LIMIT 1`,
        [jobNo, unitNo]
      );
      let nextLotId;
      if (nextPlanned.length > 0) {
        nextLotId = nextPlanned[0].id;
      } else {
        const { rows: seq } = await pool.query(
          `SELECT COALESCE(MAX(lot_number), 0) + 1 AS next_lot FROM lots WHERE job_no=$1 AND unit_no=$2`,
          [jobNo, unitNo]
        );
        const { rows: nl } = await pool.query(
          `INSERT INTO lots (lot_number, job_no, unit_no, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
          [seq[0].next_lot, jobNo, unitNo, userId]
        );
        nextLotId = nl[0].id;
      }
      for (const drawingId of carryForwardIds) {
        await pool.query(
          `INSERT INTO lot_lines (lot_id, drawing_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [nextLotId, drawingId]
        );
      }
    }

    // 9. Clean up any empty planned lots
    await pool.query(
      `DELETE FROM lots WHERE job_no=$1 AND unit_no=$2 AND issued_at IS NULL
       AND id NOT IN (SELECT DISTINCT lot_id FROM lot_lines)`,
      [jobNo, unitNo]
    );

    res.json({
      ok: true, lotNumber,
      lineCount: selectedDrawingIds.length,
      carryForwardCount: carryForwardIds.length,
      message: `Lot ${lotNumber} issued with ${selectedDrawingIds.length} line(s)${carryForwardIds.length ? `. ${carryForwardIds.length} planned line(s) carried forward.` : ''}`
    });
  } catch (err) {
    console.error("issueSelectedLines error:", err);
    res.status(500).json({ ok: false, error: "Failed to issue lot" });
  }
}

// GET /api/lots/:lotId/export?format=excel|zip
async function exportLot(req, res) {
  const lotId  = parseInt(req.params.lotId);
  const format = (req.query.format || "excel").toLowerCase();

  try {
    // ── Fetch lot header ──────────────────────────────────────────────────────
    const { rows: lotRows } = await pool.query(`SELECT * FROM lots WHERE id=$1`, [lotId]);
    if (!lotRows[0]) return res.status(404).json({ ok: false, error: "Lot not found" });
    const lot = lotRows[0];
    const issueLotLabel = `LOT-${lot.lot_number}`;

    // ── Fetch lines with inch + approver ─────────────────────────────────────
    const { rows } = await pool.query(
      `SELECT d.id, d.job_no, d.unit_no, d.zone, d.line_no, d.stored_file, d.rev_no,
              ll.file_path AS lot_file_path,
              inch.inch_dia, inch.inch_meter,
              appr.approved_by_name, appr.approved_at
       FROM lot_lines ll
       JOIN drawings d ON d.id = ll.drawing_id
       LEFT JOIN inch_data inch
         ON inch.job_no = d.job_no AND inch.unit_no = d.unit_no AND inch.line_no = d.line_no
       LEFT JOIN LATERAL (
         -- Scoped to the revision that was ACTUALLY issued in this lot (parsed
         -- from the ll.file_path snapshot, same as the revNo display below) —
         -- not d.rev_no, which may have moved on since this lot was issued.
         -- Without this, a line issued at R0 then later approved again at R1
         -- would show R1's approver here, even though this lot reflects R0.
         SELECT u.name AS approved_by_name, src.ts AS approved_at
         FROM (
           SELECT user_id, created_at AS ts, 1 AS pri
           FROM drawing_comments
           WHERE drawing_id = d.id AND type = 'approve'
             AND rev_no = COALESCE((regexp_match(ll.file_path, '_R(\\d+)-\\d+\\.pdf$'))[1]::int, d.rev_no)
           UNION ALL
           SELECT user_id, completed_at AS ts, 2 AS pri
           FROM drawing_claims
           WHERE drawing_id = d.id AND comment_type = 'approve' AND completed_at IS NOT NULL
         ) src
         JOIN users u ON u.id = src.user_id
         ORDER BY src.pri ASC, src.ts DESC
         LIMIT 1
       ) appr ON true
       WHERE ll.lot_id = $1
       ORDER BY d.line_no`,
      [lotId]
    );

    // ── Resolve absolute file paths & read page counts ────────────────────────
    const lines = await Promise.all(rows.map(async (d) => {
      const relPath = d.lot_file_path ||
        (d.stored_file ? `uploads/${d.job_no}/${d.unit_no}/${d.zone}/${d.stored_file}` : null);
      const absPath = relPath ? path.join(__dirname, "..", relPath) : null;
      const pageCount = absPath && fs.existsSync(absPath) ? await getPdfPageCount(absPath) : 1;
      return {
        jobNo:       d.job_no,
        unitNo:      d.unit_no,
        zone:        d.zone,
        lineNo:      d.line_no,
        storedFile:  d.stored_file || "",
        // Same reasoning as getLotLines — show the revision that was
        // actually issued, not the drawing's current (possibly later) rev_no.
        revNo:       extractRevNo(d.lot_file_path) ?? (d.rev_no || 0),
        approvedBy:  d.approved_by_name || "",
        approvedAt:  d.approved_at || null,
        inchDia:     d.inch_dia  != null ? Number(d.inch_dia)  : null,
        inchMeter:   d.inch_meter != null ? Number(d.inch_meter) : null,
        absPath,
        pageCount,
      };
    }));

    // ── Build Excel workbook ──────────────────────────────────────────────────
    const wb = new ExcelJS.Workbook();
    wb.creator = "PIMS";
    const ws = wb.addWorksheet("Lot " + lot.lot_number);

    const COLS = [
      { header: "SNO",                    key: "sno",            width: 6  },
      { header: "job_nr",                 key: "job_nr",         width: 12 },
      { header: "unit_id",                key: "unit_id",        width: 10 },
      { header: "division_name",          key: "division_name",  width: 16 },
      { header: "dept_name",              key: "dept_name",      width: 12 },
      { header: "document_source",        key: "document_source",width: 14 },
      { header: "document_name",          key: "document_name",  width: 22 },
      { header: "ZONE",                   key: "zone",           width: 8  },
      { header: "num_sheet",              key: "num_sheet",      width: 10 },
      { header: "issue_lot",              key: "issue_lot",      width: 12 },
      { header: "physical_document_name", key: "phys_doc",       width: 28 },
      { header: "paper_size",             key: "paper_size",     width: 10 },
      { header: "revision_reason",        key: "rev_reason",     width: 26 },
      { header: "revision_nr",            key: "rev_nr",         width: 12 },
      { header: "revision_dt",            key: "rev_dt",         width: 14 },
      { header: "object_name",            key: "object_name",    width: 22 },
      { header: "FOLDERCODE",             key: "foldercode",     width: 28 },
      { header: "title",                  key: "title",          width: 14 },
      { header: "approval_dt1",           key: "appr_dt1",       width: 14 },
      { header: "approval_flag",          key: "appr_flag",      width: 14 },
      { header: "approver1",              key: "approver1",      width: 16 },
      { header: "issue_dt",              key: "issue_dt",        width: 14 },
      { header: "issue_reason",           key: "issue_reason",   width: 26 },
      { header: "inch_dia",               key: "inch_dia",       width: 12 },
      { header: "inch_meter",             key: "inch_meter",     width: 12 },
    ];

    ws.columns = COLS;

    // Header style
    const headerRow = ws.getRow(1);
    headerRow.eachCell(cell => {
      cell.font      = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill      = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A5F" } };
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      cell.border    = { bottom: { style: "thin", color: { argb: "FFB8D4F8" } } };
    });
    headerRow.height = 28;

    const issueDt = fmtDate(lot.issued_at);

    lines.forEach((l, i) => {
      const row = ws.addRow({
        sno:            i + 1,
        job_nr:         l.jobNo,
        unit_id:        l.unitNo,
        division_name:  "ENGINEERING",
        dept_name:      "PIPING",
        document_source: l.jobNo,
        document_name:  l.lineNo,
        zone:           l.zone,
        num_sheet:      l.pageCount,
        issue_lot:      issueLotLabel,
        phys_doc:       l.storedFile,
        paper_size:     "A3",
        rev_reason:     "ISSUED FOR CONSTRUCTION",
        rev_nr:         l.revNo,
        rev_dt:         fmtDate(l.approvedAt),
        object_name:    l.lineNo,
        foldercode:     "SELF RESOURCED/ISOMETRICS",
        title:          "ISOMETRICS",
        appr_dt1:       fmtDate(l.approvedAt),
        appr_flag:      "TRUE",
        approver1:      l.approvedBy,
        issue_dt:       issueDt,
        issue_reason:   "ISSUED FOR CONSTRUCTION",
        inch_dia:       l.inchDia,
        inch_meter:     l.inchMeter,
      });

      // Zebra stripe
      const bg = i % 2 === 0 ? "FFFFFFFF" : "FFF0F7FF";
      row.eachCell(cell => {
        cell.fill      = { type: "pattern", pattern: "solid", fgColor: { argb: bg } };
        cell.alignment = { vertical: "middle" };
        cell.border    = { bottom: { style: "hair", color: { argb: "FFE2E8F0" } } };
      });
    });

    // Autofilter on header row
    ws.autoFilter = { from: "A1", to: { row: 1, column: COLS.length } };

    const excelName = `Lot-${lot.lot_number}_${lot.job_no}_Unit${lot.unit_no}.xlsx`;

    // ── Excel only ────────────────────────────────────────────────────────────
    if (format === "excel") {
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${excelName}"`);
      await wb.xlsx.write(res);
      res.end();
      return;
    }

    // ── Excel + PDFs in ZIP ───────────────────────────────────────────────────
    const zipName = `Lot-${lot.lot_number}_${lot.job_no}_Unit${lot.unit_no}.zip`;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("error", err => { console.error("archiver error:", err); });
    archive.pipe(res);

    // Add Excel into the ZIP
    const excelBuf = await wb.xlsx.writeBuffer();
    archive.append(excelBuf, { name: excelName });

    // Add each PDF
    for (const l of lines) {
      if (l.absPath && fs.existsSync(l.absPath)) {
        archive.file(l.absPath, { name: `ISOs/${l.storedFile}` });
      }
    }

    await archive.finalize();

  } catch (err) {
    console.error("exportLot error:", err);
    if (!res.headersSent) res.status(500).json({ ok: false, error: "Export failed: " + err.message });
  }
}

// GET /api/lots/status?jobNo=X&unitNo=Y&lotNumber=N
// Returns live status of every line in a planned lot — visible to all logged-in users.
async function getLotStatus(req, res) {
  const { jobNo, unitNo, lotNumber } = req.query;
  if (!jobNo || !unitNo || !lotNumber)
    return res.status(400).json({ ok: false, error: 'jobNo, unitNo, lotNumber required' });

  try {
    const { rows: lotRows } = await pool.query(
      `SELECT id, lot_number, created_by, created_at
       FROM lots
       WHERE job_no=$1 AND unit_no=$2 AND lot_number=$3 AND issued_at IS NULL
       LIMIT 1`,
      [jobNo, unitNo, parseInt(lotNumber)]
    );
    if (!lotRows[0])
      return res.status(404).json({ ok: false, error: 'Lot not found or already issued' });
    const lot = lotRows[0];

    const { rows: creatorRows } = await pool.query(
      `SELECT name FROM users WHERE id=$1`, [lot.created_by]
    );

    const { rows } = await pool.query(
      `SELECT d.id, d.zone, d.line_no, d.rev_no, d.status, d.tags, d.stress_critical,
              COALESCE(
                json_agg(
                  json_build_object('userId', dc.user_id, 'name', u.name, 'roles', dc.roles)
                ) FILTER (WHERE dc.id IS NOT NULL),
                '[]'::json
              ) AS claimers
       FROM lot_lines ll
       JOIN drawings d ON d.id = ll.drawing_id
       LEFT JOIN drawing_claims dc ON dc.drawing_id = d.id
       LEFT JOIN users u ON u.id::text = dc.user_id
       WHERE ll.lot_id = $1
       GROUP BY d.id
       ORDER BY d.zone, d.line_no`,
      [lot.id]
    );

    res.json({
      ok: true,
      lot: {
        id: lot.id,
        lotNumber: lot.lot_number,
        jobNo,
        unitNo,
        createdBy: creatorRows[0]?.name || lot.created_by,
        createdAt: lot.created_at,
      },
      lines: rows.map(d => ({
        drawingId:      d.id,
        zone:           d.zone,
        lineNo:         d.line_no,
        revNo:          d.rev_no || 0,
        status:         d.status,
        stressCritical: d.stress_critical || 'N',
        tags:           d.tags || [],
        claimers:       d.claimers || [],
      })),
    });
  } catch (err) {
    console.error('getLotStatus error:', err);
    res.status(500).json({ ok: false, error: 'Failed' });
  }
}

module.exports = { createLot, getPlannedLots, issueLot, assignLinesToLot, removeLineFromLot, getLots, getLotLines, issueSelectedLines, exportLot, getLotStatus };
