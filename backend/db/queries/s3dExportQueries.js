"use strict";
const { pool } = require("../pool");

// Upserts the current known state for one line into s3d_export_log.
// Called from the three PIMS-side trigger points (GL-ready, GL comment-back,
// lot issuance) — never called from the export job itself, which only reads.
async function upsertLine({ jobNo, unitNo, zone, lineNo, lockStatus, lotNo = null }) {
  await pool.query(
    `INSERT INTO s3d_export_log (job_no, unit_no, zone, line_no, lock_status, lot_no, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (job_no, unit_no, zone, line_no)
     DO UPDATE SET lock_status=EXCLUDED.lock_status, lot_no=EXCLUDED.lot_no, updated_at=NOW()`,
    [jobNo, unitNo, zone, lineNo, lockStatus, lotNo]
  );
}

// Trigger 1 — checkers cleared the line with no comments, it's ready for GL
// review. lot_no is reset to NULL here: if this is a later revision of a line
// that was previously issued in a lot, that old lot_no no longer applies to
// this (not-yet-issued) revision.
function markPendingLock({ jobNo, unitNo, zone, lineNo }) {
  return upsertLine({ jobNo, unitNo, zone, lineNo, lockStatus: "PENDING_LOCK", lotNo: null });
}

// Trigger 2 — GL sent the line back with comments (to a checker or direct to
// Modeller). No longer ready to be locked.
function markWorking({ jobNo, unitNo, zone, lineNo }) {
  return upsertLine({ jobNo, unitNo, zone, lineNo, lockStatus: "WORKING", lotNo: null });
}

// Trigger 3 — line issued into a lot. Already locked from an earlier export
// cycle (or about to be, same day) — this just attaches the lot number.
function markLotIssued({ jobNo, unitNo, zone, lineNo, lotNo }) {
  return upsertLine({ jobNo, unitNo, zone, lineNo, lockStatus: "PENDING_LOCK", lotNo });
}

// Read side, used only by the export job: every line whose current state
// hasn't been sent to S3D yet.
async function getPendingExportRows() {
  const { rows } = await pool.query(
    `SELECT job_no, unit_no, zone, line_no, lock_status, lot_no
     FROM s3d_export_log
     WHERE lock_status IS DISTINCT FROM last_exported_lock_status
        OR lot_no       IS DISTINCT FROM last_exported_lot_no
     ORDER BY job_no, unit_no, zone, line_no`
  );
  return rows;
}

async function markExported(rows) {
  for (const r of rows) {
    await pool.query(
      `UPDATE s3d_export_log
       SET last_exported_lock_status = lock_status,
           last_exported_lot_no      = lot_no
       WHERE job_no=$1 AND unit_no=$2 AND zone=$3 AND line_no=$4`,
      [r.job_no, r.unit_no, r.zone, r.line_no]
    );
  }
}

module.exports = { markPendingLock, markWorking, markLotIssued, getPendingExportRows, markExported };
