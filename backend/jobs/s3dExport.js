"use strict";
const path  = require("path");
const fs    = require("fs");
const fsp   = fs.promises;
const ExcelJS = require("exceljs");

const s3dExportQ = require("../db/queries/s3dExportQueries");

const EXPORT_LOGS_DIR = path.join(__dirname, "..", "s3d_export_logs");

// S3D_EXPORT_DIR in .env can override the drop location (e.g. a UNC network
// share once S3D's LAN address is confirmed). Defaults to D:\PIMS_SQL\output.
const EXPORT_DIR = process.env.S3D_EXPORT_DIR || "D:\\PIMS_SQL\\output";
const EXPORT_FILENAME = "pims_s3d_lock_feed.xlsx";

// Internal lock_status → the literal vocabulary S3D's own schema expects.
// Translated only here, at write time, so the DB never stores S3D's bare
// "APPROVED" string (see s3d_export_log's comment in schema.sql for why).
const LOCK_STATUS_TO_S3D = {
  PENDING_LOCK: "APPROVED",
  WORKING: "WORKING",
};

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// Builds today's delta workbook and overwrites the fixed file S3D reads from.
// Idempotent/re-runnable: rows are only marked exported after a successful
// write, and pulling the same unchanged rows twice is harmless.
async function runExport(triggeredBy = "scheduler") {
  const startedAt = new Date();
  const rows = await s3dExportQ.getPendingExportRows();

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Lock Feed");
  ws.columns = [
    { header: "job_no",  key: "job_no",  width: 14 },
    { header: "unit_no", key: "unit_no", width: 12 },
    { header: "zone",    key: "zone",    width: 10 },
    { header: "line_id", key: "line_id", width: 30 },
    { header: "lot_no",  key: "lot_no",  width: 10 },
    { header: "status",  key: "status",  width: 12 },
  ];
  for (const r of rows) {
    ws.addRow({
      job_no: r.job_no, unit_no: r.unit_no, zone: r.zone, line_id: r.line_no,
      lot_no: r.lot_no ?? "", status: LOCK_STATUS_TO_S3D[r.lock_status] || r.lock_status,
    });
  }

  ensureDir(EXPORT_DIR);
  const filePath = path.join(EXPORT_DIR, EXPORT_FILENAME);
  await wb.xlsx.writeFile(filePath);

  await s3dExportQ.markExported(rows);

  const completedAt = new Date();
  const summary = { total: rows.length, filePath };

  ensureDir(EXPORT_LOGS_DIR);
  const logTimestamp = startedAt.toISOString().slice(0, 19).replace("T", "_").replace(/:/g, "-");
  const log = {
    triggeredBy,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    summary,
    rows,
  };
  await fsp.writeFile(path.join(EXPORT_LOGS_DIR, `${logTimestamp}.json`), JSON.stringify(log, null, 2), "utf8");

  console.log(`[S3D EXPORT] Run complete — ${rows.length} line(s) written to ${filePath}`);
  return { triggeredBy, startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(), summary };
}

module.exports = { runExport };
