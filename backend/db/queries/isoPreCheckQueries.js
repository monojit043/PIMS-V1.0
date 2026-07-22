"use strict";
const { pool } = require("../pool");

// ── Special Items — checker-added, per-line ─────────────────────────────────
// Self-migrating (same pattern as inch_data in inchController.js) rather than
// living in iso_prechecks_schema.sql, which nothing actually runs — that file
// caused a "relation does not exist" incident earlier because edits to it
// never reach the live DB without a manual migrate.js run. This table heals
// itself on every server start instead.
//
// "IPMCS" (a separate database on the same Postgres server, not yet built)
// will eventually contribute a second source of special items per line —
// this table only holds what checkers enter directly inside PIMS for now.
pool.query(`
  CREATE TABLE IF NOT EXISTS iso_special_items (
    id          SERIAL PRIMARY KEY,
    drawing_id  INTEGER NOT NULL REFERENCES drawings(id) ON DELETE CASCADE,
    tag         VARCHAR(100),
    description TEXT NOT NULL,
    category    VARCHAR(100),
    qty         NUMERIC,
    added_by    VARCHAR(20),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_iso_special_items_drawing ON iso_special_items(drawing_id);
`).catch(console.error);

// ── Read ──────────────────────────────────────────────────────────────────────

async function getActiveSubmission(drawingId, revNo) {
  const { rows } = await pool.query(
    `SELECT * FROM iso_pdf_submissions
     WHERE drawing_id=$1 AND rev_no=$2 AND is_active=TRUE
     ORDER BY cycle_no DESC LIMIT 1`,
    [drawingId, revNo]
  );
  return rows[0] || null;
}

// Previous cycle within same revision — used for PDF-path WELD_COUNT_DELTA comparison
async function getPreviousSubmission(drawingId, revNo, currentCycleNo) {
  const { rows } = await pool.query(
    `SELECT s.*,
            (SELECT COUNT(*)::int FROM iso_weld_records w
             WHERE w.submission_id = s.id) AS weld_count
     FROM iso_pdf_submissions s
     WHERE s.drawing_id=$1 AND s.rev_no=$2 AND s.cycle_no < $3
     ORDER BY s.cycle_no DESC LIMIT 1`,
    [drawingId, revNo, currentCycleNo]
  );
  return rows[0] || null;
}

// Previous cycle's result for a specific check code — used by IDF-path WELD_COUNT_DELTA
// so we compare IDF counts against IDF counts only (not against PDF-extracted counts).
async function getPreviousCheckResult(drawingId, revNo, currentCycleNo, checkCode) {
  const { rows } = await pool.query(
    `SELECT r.result, r.detail, s.cycle_no
     FROM iso_pre_check_results r
     JOIN iso_pdf_submissions s ON s.id = r.submission_id
     WHERE s.drawing_id=$1 AND s.rev_no=$2 AND s.cycle_no < $3
       AND r.check_code = $4
     ORDER BY s.cycle_no DESC LIMIT 1`,
    [drawingId, revNo, currentCycleNo, checkCode]
  );
  return rows[0] || null;
}

async function getWeldsBySubmission(submissionId) {
  const { rows } = await pool.query(
    `SELECT * FROM iso_weld_records
     WHERE submission_id=$1 ORDER BY weld_no, sheet_no`,
    [submissionId]
  );
  return rows;
}

// job_no for a drawing — used to scope linelist queries
async function getJobNoForDrawing(drawingId) {
  const { rows } = await pool.query(
    `SELECT job_no FROM drawings WHERE id=$1 LIMIT 1`,
    [drawingId]
  );
  return rows[0]?.job_no || null;
}

// Fetch all linelist rows for a given line (one row per nominal size).
// service/unitNo/seqNo come from parsing the system line_no (e.g. P-111-40201-B → P, 111, 40201).
async function getLinelistData(jobNo, service, unitNo, seqNo) {
  const { rows } = await pool.query(
    `SELECT ll.line_size, ll.line_class, ll.insulation
     FROM linelist_lines  ll
     JOIN linelist_uploads lu ON lu.id = ll.upload_id
     WHERE lu.job_no       = $1
       AND ll.service      = $2
       AND split_part(ll.unit_no::text, ' ', 1) = $3
       AND ll.line_no::text = $4`,
    [jobNo, service, String(unitNo), String(seqNo)]
  );
  return rows;
}

// ── Write ─────────────────────────────────────────────────────────────────────

// Create new submission atomically:
//   • computes next cycle_no (MAX+1) inside a transaction so concurrent uploads don't collide
//   • supersedes all previously active submissions for same drawing+rev in the same transaction
async function createSubmission({ drawingId, revNo, pdfFileName, pdfFilePath, pdfHash, uploadedBy }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: seq } = await client.query(
      `SELECT COALESCE(MAX(cycle_no), 0) + 1 AS next_cycle
       FROM iso_pdf_submissions WHERE drawing_id=$1 AND rev_no=$2`,
      [drawingId, revNo]
    );
    const cycleNo = seq[0].next_cycle;

    const { rows } = await client.query(
      `INSERT INTO iso_pdf_submissions
         (drawing_id, rev_no, cycle_no, pdf_file_name, pdf_file_path, pdf_hash,
          parse_status, is_active, uploaded_by, uploaded_at)
       VALUES ($1,$2,$3,$4,$5,$6,'PENDING',TRUE,$7,NOW())
       RETURNING *`,
      [drawingId, revNo, cycleNo,
       pdfFileName || null, pdfFilePath || null, pdfHash || null,
       uploadedBy || null]
    );
    const sub = rows[0];

    // Mark any previously active submission for this drawing+rev as superseded
    await client.query(
      `UPDATE iso_pdf_submissions
       SET is_active=FALSE, superseded_at=NOW(), superseded_by=$1
       WHERE drawing_id=$2 AND rev_no=$3 AND is_active=TRUE AND id != $1`,
      [sub.id, drawingId, revNo]
    );

    await client.query("COMMIT");
    return sub;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function markParsingStarted(submissionId) {
  await pool.query(
    `UPDATE iso_pdf_submissions
     SET parse_status='PARSING', parse_started_at=NOW()
     WHERE id=$1`,
    [submissionId]
  );
}

async function markParseDone(submissionId, {
  extractedLineNo, extractedRev, extractedDate,
  extractedSheetCount, pdfGeneratedAt,
}) {
  await pool.query(
    `UPDATE iso_pdf_submissions
     SET parse_status='DONE', parse_completed_at=NOW(),
         extracted_line_no=$2, extracted_rev=$3, extracted_date=$4,
         extracted_sheet_count=$5, pdf_generated_at=$6
     WHERE id=$1`,
    [submissionId,
     extractedLineNo   || null,
     extractedRev      || null,
     extractedDate     || null,
     extractedSheetCount != null ? extractedSheetCount : null,
     (pdfGeneratedAt instanceof Date && !isNaN(pdfGeneratedAt.getTime())) ? pdfGeneratedAt : null]
  );
}

async function markParseFailed(submissionId, errorMsg) {
  await pool.query(
    `UPDATE iso_pdf_submissions
     SET parse_status='FAILED', parse_completed_at=NOW(), parse_error=$2
     WHERE id=$1`,
    [submissionId, String(errorMsg).slice(0, 2000)]
  );
}

// Upsert one check result row.
// PASS results are auto-acknowledged; all others stay pending for checker action.
async function upsertCheckResult(submissionId, checkCode, checkName, result, detail) {
  const autoActioned = result === "PASS";
  const autoAction   = autoActioned ? "AUTO_ACKNOWLEDGED" : null;

  await pool.query(
    `INSERT INTO iso_pre_check_results
       (submission_id, check_code, check_name, result, detail,
        source, confidence, checker_actioned, checker_action, created_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,'PDF_PARSED','MEDIUM',$6,$7,NOW())
     ON CONFLICT (submission_id, check_code) DO UPDATE SET
       check_name       = EXCLUDED.check_name,
       result           = EXCLUDED.result,
       detail           = EXCLUDED.detail,
       source           = EXCLUDED.source,
       checker_actioned = EXCLUDED.checker_actioned,
       checker_action   = EXCLUDED.checker_action,
       created_at       = NOW()`,
    [submissionId, checkCode, checkName, result,
     detail != null ? JSON.stringify(detail) : null,
     autoActioned, autoAction]
  );
}

// All BOM items for a submission — used by the "View All BOM Items" and
// "View Items with Issues" buttons (as opposed to upsertCheckResult's
// flagged_items, which is only the actionable subset).
// filter: null/undefined for all items; "non_reportable" for items tagged
// with the literal "Non-Reportable" item code S3D writes for BOM lines
// deliberately excluded from procurement; "issues" for anything that isn't
// a clean real item — real items missing tag/description, PLUS
// Non-Reportable items (which always carry has_tag=false in storage, so
// they fall out of this same condition without a separate OR clause).
async function getBomItems(submissionId, filter) {
  const conditions = ["submission_id = $1"];
  if (filter === "non_reportable") {
    conditions.push("item_code ILIKE 'non-reportable'");
  } else if (filter === "issues") {
    conditions.push("is_routing_ref = false AND (has_tag = false OR has_description = false)");
  }

  const { rows } = await pool.query(
    `SELECT item_code, description, has_tag, has_description, is_routing_ref
     FROM iso_bom_items
     WHERE ${conditions.join(" AND ")}
     ORDER BY id`,
    [submissionId]
  );
  return rows;
}

// Resolve a drawing's id from job/unit/line — same lookup pattern used by
// the GET /api/iso-prechecks route, duplicated here since special items are
// keyed by drawing (the line), not by a specific pre-check submission/cycle.
async function findDrawingId(jobNo, unitNo, lineNo) {
  const { rows } = unitNo
    ? await pool.query(
        `SELECT id FROM drawings WHERE job_no=$1 AND unit_no=$2 AND line_no=$3 LIMIT 1`,
        [jobNo, unitNo, lineNo]
      )
    : await pool.query(
        `SELECT id FROM drawings WHERE job_no=$1 AND line_no=$2 LIMIT 1`,
        [jobNo, lineNo]
      );
  return rows[0]?.id ?? null;
}

async function getSpecialItems(drawingId) {
  const { rows } = await pool.query(
    `SELECT id, tag, description, category, qty, added_by, created_at
     FROM iso_special_items
     WHERE drawing_id = $1
     ORDER BY id`,
    [drawingId]
  );
  return rows;
}

async function addSpecialItem({ drawingId, tag, description, category, qty, addedBy }) {
  const { rows } = await pool.query(
    `INSERT INTO iso_special_items (drawing_id, tag, description, category, qty, added_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, tag, description, category, qty, added_by, created_at`,
    [drawingId, tag || null, description, category || null, qty != null ? qty : null, addedBy || null]
  );
  return rows[0];
}

// Bulk insert BOM items extracted from the IDF -20/-21 block.
// One call per submission; no ON CONFLICT needed (called once per cycle).
async function bulkInsertBomItems(records) {
  if (!records || records.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const r of records) {
      await client.query(
        `INSERT INTO iso_bom_items
           (submission_id, item_code, description,
            has_tag, has_description, is_routing_ref, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [
          r.submissionId,
          r.itemCode    || "",
          r.description || "",
          r.hasTag      === true,
          r.hasDesc     === true,
          r.isRoutingRef === true,
        ]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Insert pipe schedule rows for one submission (called once per PDF parse cycle).
// One row per unique pipe BOM item code found across all sheets.
async function insertPipeSchedule(rows) {
  if (!rows || rows.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const r of rows) {
      await client.query(
        `INSERT INTO iso_pipe_schedule
           (submission_id, item_code, description,
            pipe_ns_in, curv_length_m, inch_dia, inch_meter, bom_qty_m, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
        [
          r.submissionId,
          r.itemCode    || "",
          r.description || "",
          r.pipeNsIn   != null ? r.pipeNsIn   : null,
          r.curvLengthM != null ? r.curvLengthM : null,
          r.inchDia    != null ? r.inchDia    : null,
          r.inchMeter  != null ? r.inchMeter  : null,
          r.bomQtyM    != null ? r.bomQtyM    : null,
        ]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Bulk insert weld records — ignores conflicts (same weld+sheet already inserted)
async function bulkInsertWelds(records) {
  if (!records || records.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const r of records) {
      await client.query(
        `INSERT INTO iso_weld_records
           (submission_id, weld_no, weld_type, sheet_no, source, created_at)
         VALUES ($1,$2,$3,$4,'PDF_PARSED',NOW())
         ON CONFLICT (submission_id, weld_no, sheet_no) DO NOTHING`,
        [r.submissionId, r.weldNo, r.weldType || null, r.sheetNo]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  getActiveSubmission,
  getPreviousSubmission,
  getPreviousCheckResult,
  getWeldsBySubmission,
  getJobNoForDrawing,
  getLinelistData,
  createSubmission,
  markParsingStarted,
  markParseDone,
  markParseFailed,
  upsertCheckResult,
  bulkInsertWelds,
  bulkInsertBomItems,
  getBomItems,
  insertPipeSchedule,
  findDrawingId,
  getSpecialItems,
  addSpecialItem,
};
