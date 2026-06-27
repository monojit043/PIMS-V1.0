'use strict';
const path     = require('path');
const fs       = require('fs');
const ExcelJS  = require('exceljs');
const archiver = require('archiver');
const { pool } = require('../db/pool');

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? '' : dt.toISOString().split('T')[0];
}

// Ensure PK constraint exists on gad_lot_lines
pool.query(`
  DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_name='gad_lot_lines' AND constraint_type='PRIMARY KEY'
    ) THEN
      ALTER TABLE gad_lot_lines ADD PRIMARY KEY (lot_id, gad_id);
    END IF;
  END $$;
`).catch(console.error);

// ── POST /api/gad/lots/issue-selected ─────────────────────────────────────
// GL selects Final GADs and issues them as a lot.
async function issueSelectedGADs(req, res) {
  const { jobNo, unitNo, gadIds } = req.body;
  const userId = req.session.user.id;
  if (!jobNo || !unitNo || !Array.isArray(gadIds) || gadIds.length === 0)
    return res.status(400).json({ ok: false, error: 'jobNo, unitNo, gadIds[] required' });

  try {
    const { rows: roleCheck } = await pool.query(
      `SELECT 1 FROM user_role_assignments
       WHERE project_id=$1 AND unit_no=$2 AND user_id=$3 AND role='GL' LIMIT 1`,
      [jobNo, unitNo, String(userId)]
    );
    if (!roleCheck.length)
      return res.status(403).json({ ok: false, error: 'GL role required to issue lots' });

    // 1. Find or create lowest planned lot
    const { rows: planned } = await pool.query(
      `SELECT id, lot_number FROM gad_lots
       WHERE job_no=$1 AND unit_no=$2 AND issued_at IS NULL
       ORDER BY lot_number ASC LIMIT 1`,
      [jobNo, unitNo]
    );
    let lotId, lotNumber;
    if (planned.length > 0) {
      ({ id: lotId, lot_number: lotNumber } = planned[0]);
    } else {
      const { rows: seq } = await pool.query(
        `SELECT COALESCE(MAX(lot_number), 0) + 1 AS next_lot FROM gad_lots WHERE job_no=$1 AND unit_no=$2`,
        [jobNo, unitNo]
      );
      lotNumber = seq[0].next_lot;
      const { rows: nl } = await pool.query(
        `INSERT INTO gad_lots (lot_number, job_no, unit_no, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
        [lotNumber, jobNo, unitNo, userId]
      );
      lotId = nl[0].id;
    }

    // 2. Lines currently in this planned lot
    const { rows: existing } = await pool.query(
      `SELECT gad_id FROM gad_lot_lines WHERE lot_id=$1`, [lotId]
    );
    const plannedSet  = new Set(existing.map(r => r.gad_id));
    const selectedSet = new Set(gadIds.map(Number));
    const carryForwardIds = [...plannedSet].filter(id => !selectedSet.has(id));

    // 3. Remove selected GADs from any other planned lots
    for (const gadId of gadIds) {
      await pool.query(
        `DELETE FROM gad_lot_lines WHERE gad_id=$1 AND lot_id != $2
         AND lot_id IN (SELECT id FROM gad_lots WHERE issued_at IS NULL AND job_no=$3 AND unit_no=$4)`,
        [gadId, lotId, jobNo, unitNo]
      );
    }

    // 4. Replace lot lines with selection, snapshot file path
    await pool.query(`DELETE FROM gad_lot_lines WHERE lot_id=$1`, [lotId]);
    for (const gadId of gadIds) {
      const { rows: g } = await pool.query(
        `SELECT job_no, unit_no, area_no, stored_file FROM gads WHERE id=$1`, [gadId]
      );
      const fp = g[0]
        ? `uploads/${g[0].job_no}/${g[0].unit_no}/gad/${g[0].area_no}/${g[0].stored_file}`
        : null;
      await pool.query(
        `INSERT INTO gad_lot_lines (lot_id, gad_id, file_path) VALUES ($1,$2,$3)
         ON CONFLICT (lot_id, gad_id) DO UPDATE SET file_path = EXCLUDED.file_path`,
        [lotId, gadId, fp]
      );
    }

    // 5. Issue the lot
    await pool.query(`UPDATE gad_lots SET issued_at=NOW() WHERE id=$1`, [lotId]);

    // 6. Carry-forward → next planned lot
    if (carryForwardIds.length > 0) {
      const { rows: nextP } = await pool.query(
        `SELECT id FROM gad_lots WHERE job_no=$1 AND unit_no=$2 AND issued_at IS NULL
         ORDER BY lot_number ASC LIMIT 1`,
        [jobNo, unitNo]
      );
      let nextLotId;
      if (nextP.length > 0) {
        nextLotId = nextP[0].id;
      } else {
        const { rows: seq } = await pool.query(
          `SELECT COALESCE(MAX(lot_number), 0) + 1 AS next_lot FROM gad_lots WHERE job_no=$1 AND unit_no=$2`,
          [jobNo, unitNo]
        );
        const { rows: nl } = await pool.query(
          `INSERT INTO gad_lots (lot_number, job_no, unit_no, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
          [seq[0].next_lot, jobNo, unitNo, userId]
        );
        nextLotId = nl[0].id;
      }
      for (const gadId of carryForwardIds) {
        await pool.query(
          `INSERT INTO gad_lot_lines (lot_id, gad_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [nextLotId, gadId]
        );
      }
    }

    // 7. Clean up empty planned lots
    await pool.query(
      `DELETE FROM gad_lots WHERE job_no=$1 AND unit_no=$2 AND issued_at IS NULL
       AND id NOT IN (SELECT DISTINCT lot_id FROM gad_lot_lines)`,
      [jobNo, unitNo]
    );

    res.json({
      ok: true, lotNumber,
      gadCount: gadIds.length,
      carryForwardCount: carryForwardIds.length,
      message: `Lot ${lotNumber} issued with ${gadIds.length} GAD(s)` +
               (carryForwardIds.length ? `. ${carryForwardIds.length} planned GAD(s) carried forward.` : ''),
    });
  } catch (err) {
    console.error('issueSelectedGADs error:', err);
    res.status(500).json({ ok: false, error: 'Failed to issue lot' });
  }
}

// ── GET /api/gad/lots — all lots grouped by job → unit ───────────────────
async function getGADLots(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT l.id, l.lot_number, l.job_no, l.unit_no, l.created_at, l.issued_at,
              COUNT(ll.gad_id)::int AS gad_count
       FROM gad_lots l
       LEFT JOIN gad_lot_lines ll ON ll.lot_id = l.id
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
        gadCount:  r.gad_count,
        createdAt: r.created_at,
        issuedAt:  r.issued_at || null,
        issued:    !!r.issued_at,
      });
    }
    res.json({ ok: true, tree });
  } catch (err) {
    console.error('getGADLots error:', err);
    res.status(500).json({ ok: false, error: 'Failed' });
  }
}

// ── GET /api/gad/lots/planned?jobNo=&unitNo= ─────────────────────────────
async function getPlannedGADLots(req, res) {
  const { jobNo, unitNo } = req.query;
  if (!jobNo || !unitNo)
    return res.status(400).json({ ok: false, error: 'jobNo and unitNo required' });
  try {
    const { rows } = await pool.query(
      `SELECT l.id, l.lot_number, COUNT(ll.gad_id)::int AS gad_count
       FROM gad_lots l
       LEFT JOIN gad_lot_lines ll ON ll.lot_id = l.id
       WHERE l.job_no=$1 AND l.unit_no=$2 AND l.issued_at IS NULL
       GROUP BY l.id ORDER BY l.lot_number`,
      [jobNo, unitNo]
    );
    res.json({ ok: true, lots: rows.map(r => ({ id: r.id, lotNumber: r.lot_number, gadCount: r.gad_count })) });
  } catch (err) {
    console.error('getPlannedGADLots error:', err);
    res.status(500).json({ ok: false, error: 'Failed' });
  }
}

// ── GET /api/gad/lots/:lotId/lines ───────────────────────────────────────
async function getGADLotLines(req, res) {
  const lotId = parseInt(req.params.lotId);
  try {
    const { rows: lotRows } = await pool.query(`SELECT * FROM gad_lots WHERE id=$1`, [lotId]);
    if (!lotRows[0]) return res.status(404).json({ ok: false, error: 'Lot not found' });
    const lot = lotRows[0];

    const { rows } = await pool.query(
      `SELECT g.id, g.job_no, g.unit_no, g.area_no, g.gad_no, g.rev_no,
              g.stress_critical, g.approved_by_id, g.stored_file,
              u.name AS approved_by_name,
              ll.file_path AS lot_file_path
       FROM gad_lot_lines ll
       JOIN gads g ON g.id = ll.gad_id
       LEFT JOIN users u ON u.id::text = g.approved_by_id
       WHERE ll.lot_id = $1
       ORDER BY g.gad_no`,
      [lotId]
    );

    res.json({
      ok: true,
      lot: {
        id: lot.id, lotNumber: lot.lot_number,
        jobNo: lot.job_no, unitNo: lot.unit_no,
        createdAt: lot.created_at, issuedAt: lot.issued_at,
        issued: !!lot.issued_at,
      },
      gads: rows.map(g => ({
        gadId:          g.id,
        gadNo:          g.gad_no,
        revNo:          g.rev_no || 'R0-1',
        areaNno:        g.area_no,
        stressCritical: g.stress_critical || 'N',
        approvedBy:     g.approved_by_name || null,
        filePath:       g.lot_file_path ||
                        (g.stored_file
                          ? `uploads/${g.job_no}/${g.unit_no}/gad/${g.area_no}/${g.stored_file}`
                          : null),
      })),
    });
  } catch (err) {
    console.error('getGADLotLines error:', err);
    res.status(500).json({ ok: false, error: 'Failed' });
  }
}

// ── POST /api/gad/lots/:lotId/issue ──────────────────────────────────────
// Body: { excludeGadIds: [] } — carry these forward to next lot
async function issueGADLot(req, res) {
  const lotId = parseInt(req.params.lotId);
  const { excludeGadIds = [] } = req.body;
  const userId = req.session.user.id;
  try {
    const { rows: lotRows } = await pool.query(
      `SELECT * FROM gad_lots WHERE id=$1 AND issued_at IS NULL`, [lotId]
    );
    if (!lotRows[0])
      return res.status(404).json({ ok: false, error: 'Lot not found or already issued' });
    const lot = lotRows[0];

    // Snapshot file paths
    await pool.query(
      `UPDATE gad_lot_lines ll
       SET file_path = 'uploads/' || g.job_no || '/' || g.unit_no || '/gad/' || g.area_no || '/' || g.stored_file
       FROM gads g
       WHERE g.id = ll.gad_id AND ll.lot_id = $1`,
      [lotId]
    );

    await pool.query(`UPDATE gad_lots SET issued_at=NOW() WHERE id=$1`, [lotId]);

    if (excludeGadIds.length > 0) {
      const { rows: seq } = await pool.query(
        `SELECT COALESCE(MAX(lot_number), 0) + 1 AS next_lot FROM gad_lots WHERE job_no=$1 AND unit_no=$2`,
        [lot.job_no, lot.unit_no]
      );
      const { rows: newLot } = await pool.query(
        `INSERT INTO gad_lots (lot_number, job_no, unit_no, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
        [seq[0].next_lot, lot.job_no, lot.unit_no, userId]
      );
      const newLotId = newLot[0].id;
      for (const gadId of excludeGadIds) {
        await pool.query(`DELETE FROM gad_lot_lines WHERE lot_id=$1 AND gad_id=$2`, [lotId, gadId]);
        await pool.query(
          `INSERT INTO gad_lot_lines (lot_id, gad_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [newLotId, gadId]
        );
      }
    }

    res.json({ ok: true, message: `Lot ${lot.lot_number} issued`, lotNumber: lot.lot_number });
  } catch (err) {
    console.error('issueGADLot error:', err);
    res.status(500).json({ ok: false, error: 'Failed to issue lot' });
  }
}

// ── DELETE /api/gad/lots/:lotId/gads/:gadId ──────────────────────────────
async function removeGADFromLot(req, res) {
  const lotId = parseInt(req.params.lotId);
  const gadId = parseInt(req.params.gadId);
  try {
    await pool.query(`DELETE FROM gad_lot_lines WHERE lot_id=$1 AND gad_id=$2`, [lotId, gadId]);
    await pool.query(
      `DELETE FROM gad_lots WHERE id=$1 AND issued_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM gad_lot_lines WHERE lot_id=$1)`,
      [lotId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('removeGADFromLot error:', err);
    res.status(500).json({ ok: false, error: 'Failed' });
  }
}

// ── GET /api/gad/lots/:lotId/export?format=excel|zip ─────────────────────
async function exportGADLot(req, res) {
  const lotId  = parseInt(req.params.lotId);
  const format = (req.query.format || 'excel').toLowerCase();

  try {
    const { rows: lotRows } = await pool.query(`SELECT * FROM gad_lots WHERE id=$1`, [lotId]);
    if (!lotRows[0]) return res.status(404).json({ ok: false, error: 'Lot not found' });
    const lot = lotRows[0];

    const { rows } = await pool.query(
      `SELECT g.id, g.job_no, g.unit_no, g.area_no, g.gad_no, g.rev_no,
              g.stored_file, u.name AS approved_by_name, ll.file_path AS lot_file_path
       FROM gad_lot_lines ll
       JOIN gads g ON g.id = ll.gad_id
       LEFT JOIN users u ON u.id::text = g.approved_by_id
       WHERE ll.lot_id = $1
       ORDER BY g.gad_no`,
      [lotId]
    );

    const lines = rows.map(d => {
      const relPath = d.lot_file_path ||
        (d.stored_file ? `uploads/${d.job_no}/${d.unit_no}/gad/${d.area_no}/${d.stored_file}` : null);
      return {
        jobNo:      d.job_no,
        unitNo:     d.unit_no,
        areaNno:    d.area_no,
        gadNo:      d.gad_no,
        storedFile: d.stored_file || '',
        revNo:      d.rev_no || 'R0-1',
        approvedBy: d.approved_by_name || '',
        absPath:    relPath ? path.join(__dirname, '..', relPath) : null,
      };
    });

    // ── Build Excel ───────────────────────────────────────────────────────────
    const wb = new ExcelJS.Workbook();
    wb.creator = 'PIMS';
    const ws = wb.addWorksheet('Lot ' + lot.lot_number);

    const COLS = [
      { header: 'SNO',                    key: 'sno',            width: 6  },
      { header: 'job_nr',                 key: 'job_nr',         width: 12 },
      { header: 'unit_id',                key: 'unit_id',        width: 10 },
      { header: 'area_no',                key: 'area_no',        width: 10 },
      { header: 'division_name',          key: 'division_name',  width: 16 },
      { header: 'dept_name',              key: 'dept_name',      width: 12 },
      { header: 'document_source',        key: 'document_source',width: 14 },
      { header: 'document_name',          key: 'document_name',  width: 22 },
      { header: 'issue_lot',              key: 'issue_lot',      width: 12 },
      { header: 'physical_document_name', key: 'phys_doc',       width: 28 },
      { header: 'paper_size',             key: 'paper_size',     width: 10 },
      { header: 'revision_reason',        key: 'rev_reason',     width: 26 },
      { header: 'revision_nr',            key: 'rev_nr',         width: 12 },
      { header: 'object_name',            key: 'object_name',    width: 22 },
      { header: 'FOLDERCODE',             key: 'foldercode',     width: 28 },
      { header: 'title',                  key: 'title',          width: 14 },
      { header: 'approval_flag',          key: 'appr_flag',      width: 14 },
      { header: 'approver1',              key: 'approver1',      width: 16 },
      { header: 'issue_dt',               key: 'issue_dt',       width: 14 },
      { header: 'issue_reason',           key: 'issue_reason',   width: 26 },
    ];
    ws.columns = COLS;

    const headerRow = ws.getRow(1);
    headerRow.eachCell(cell => {
      cell.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border    = { bottom: { style: 'thin', color: { argb: 'FFB8D4F8' } } };
    });
    headerRow.height = 28;

    const issueDt = fmtDate(lot.issued_at);

    lines.forEach((l, i) => {
      const row = ws.addRow({
        sno:             i + 1,
        job_nr:          l.jobNo,
        unit_id:         l.unitNo,
        area_no:         l.areaNno,
        division_name:   'ENGINEERING',
        dept_name:       'PIPING',
        document_source: l.jobNo,
        document_name:   l.gadNo,
        issue_lot:       `LOT-${lot.lot_number}`,
        phys_doc:        l.gadNo + '.pdf',
        paper_size:      'A3',
        rev_reason:      'ISSUED FOR CONSTRUCTION',
        rev_nr:          l.revNo,
        object_name:     l.gadNo,
        foldercode:      'SELF RESOURCED/GAD',
        title:           'GAD',
        appr_flag:       'TRUE',
        approver1:       l.approvedBy,
        issue_dt:        issueDt,
        issue_reason:    'ISSUED FOR CONSTRUCTION',
      });
      const bg = i % 2 === 0 ? 'FFFFFFFF' : 'FFF0F7FF';
      row.eachCell(cell => {
        cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
        cell.alignment = { vertical: 'middle' };
        cell.border    = { bottom: { style: 'hair', color: { argb: 'FFE2E8F0' } } };
      });
    });

    ws.autoFilter = { from: 'A1', to: { row: 1, column: COLS.length } };

    const excelName = `GAD-Lot-${lot.lot_number}_${lot.job_no}_Unit${lot.unit_no}.xlsx`;

    if (format === 'excel') {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${excelName}"`);
      await wb.xlsx.write(res);
      res.end();
      return;
    }

    // ── ZIP: Excel + PDFs ─────────────────────────────────────────────────────
    const zipName = `GAD-Lot-${lot.lot_number}_${lot.job_no}_Unit${lot.unit_no}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', err => console.error('exportGADLot archiver error:', err));
    archive.pipe(res);

    const excelBuf = await wb.xlsx.writeBuffer();
    archive.append(excelBuf, { name: excelName });

    for (const l of lines) {
      if (l.absPath && fs.existsSync(l.absPath)) {
        archive.file(l.absPath, { name: `GADs/${l.storedFile}` });
      }
    }

    await archive.finalize();
  } catch (err) {
    console.error('exportGADLot error:', err);
    if (!res.headersSent) res.status(500).json({ ok: false, error: 'Export failed: ' + err.message });
  }
}

module.exports = {
  issueSelectedGADs,
  getGADLots,
  getPlannedGADLots,
  getGADLotLines,
  issueGADLot,
  removeGADFromLot,
  exportGADLot,
};
