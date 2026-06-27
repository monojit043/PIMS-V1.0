const path = require("path");
const XLSX = require("xlsx");
const ExcelJS = require("exceljs");
const archiver = require("archiver");
const fs = require("fs");
const { pool } = require("../db/pool");
const stressQ = require("../db/queries/stressQueries");
const drawingQ = require("../db/queries/drawingQueries");

const UPLOADS_ROOT = path.join(__dirname, "..", "uploads");

// POST /api/upload-stress-data  (multer single xlsx in route)
async function uploadStressData(req, res) {
  if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded" });
  const userId = req.session.user.id;

  try {
    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

    const stressLines = rows
      .map((row) => {
        const lineId = String(row["line_id"] || row["Line ID"] || row["LINE_ID"] || "").trim();
        if (!lineId) return null;
        return {
          line_id: lineId,
          stress_system: String(row["stress_system"] || row["Stress System"] || "").trim() || null,
          dept: String(row["dept"] || row["Department"] || row["Dept"] || "").trim() || null,
          uploadedOn: new Date().toISOString(),
          uploadedBy: userId,
          sourceFile: path.basename(req.file.path),
        };
      })
      .filter(Boolean);

    if (!stressLines.length) return res.status(400).json({ ok: false, error: "No valid stress lines found in file" });

    await stressQ.insertMany(stressLines);
    await stressQ.syncStressCriticalOnDrawings();

    res.json({ ok: true, message: `${stressLines.length} stress line(s) imported and drawings updated` });
  } catch (err) {
    console.error("uploadStressData error:", err);
    res.status(500).json({ ok: false, error: "Failed to process stress data: " + err.message });
  }
}

// GET /api/final-isometrics?jobNo=
async function getFinalIsometrics(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT d.*, u.name AS uploader_name,
              (SELECT l.lot_number FROM lot_lines ll JOIN lots l ON l.id = ll.lot_id
               WHERE ll.drawing_id = d.id ORDER BY l.issued_at DESC NULLS LAST LIMIT 1) AS issue_lot
       FROM drawings d LEFT JOIN users u ON u.id = d.uploaded_by
       WHERE d.status IN ('Ready for EDMS','Final') ${req.query.jobNo ? "AND d.job_no=$1" : ""}
       ORDER BY d.unit_no, d.line_no`,
      req.query.jobNo ? [req.query.jobNo] : []
    );
    res.json({ ok: true, isometrics: rows });
  } catch (err) {
    console.error("getFinalIsometrics error:", err);
    res.json({ ok: false, isometrics: [] });
  }
}

// POST /api/final-isometrics/export-metadata
async function exportMetadata(req, res) {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Final Isometrics");
    const headers = [
      "SNO", "job_nr", "sub_job_nr", "unit_id", "division_name", "dept_name",
      "document_source", "document_name", "ZONE", "issue_lot", "physical_document_name",
      "paper_size", "revision_reason", "revision_nr", "revision_dt", "object_name",
      "FOLDERCODE", "title", "approval_dt1", "approval_flag", "approver1", "issue_dt", "issue_reason",
    ];
    ws.addRow(headers);
    const today = new Date().toISOString().split("T")[0];
    const approver = String(req.session.user?.id || "SGL");

    items.forEach((it, idx) => {
      ws.addRow([
        idx + 1, it.job_nr || "", "0", it.unit_id || "", "ENGINEERING", "PIPING", "EIL",
        it.document_name || "", it.ZONE || "", it.issue_lot || "1",
        (it.document_name || "") + ".pdf", "A3", "ISSUED FOR CONSTRUCTION",
        it.revision_nr || "",
        it.revision_dt ? new Date(it.revision_dt).toISOString().split("T")[0] : today,
        it.document_name || "", "SELF RESOURCED/ISOMETRICS", "ISOMETRICS",
        today, "Y", approver, today, "ISSUED FOR CONSTRUCTION",
      ]);
    });
    ws.columns.forEach((c) => { c.width = Math.min(Math.max(10, (c.header || "").toString().length + 4), 40); });

    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader("Content-Disposition", "attachment; filename=Final_Isometrics_Metadata.xlsx");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("exportMetadata error:", err);
    res.status(500).json({ ok: false, error: "Failed to generate metadata" });
  }
}

// POST /api/final-isometrics/export-zip
async function exportZip(req, res) {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Final Isometrics");
    const headers = [
      "SNO", "job_nr", "sub_job_nr", "unit_id", "division_name", "dept_name",
      "document_source", "document_name", "ZONE", "issue_lot", "physical_document_name",
      "paper_size", "revision_reason", "revision_nr", "revision_dt", "object_name",
      "FOLDERCODE", "title", "approval_dt1", "approval_flag", "approver1", "issue_dt", "issue_reason",
    ];
    ws.addRow(headers);
    const today = new Date().toISOString().split("T")[0];
    const approver = String(req.session.user?.id || "SGL");

    items.forEach((it, idx) => {
      ws.addRow([
        idx + 1, it.job_nr || "", "0", it.unit_id || "", "ENGINEERING", "PIPING", "EIL",
        it.document_name || "", it.ZONE || "", it.issue_lot || "1",
        (it.document_name || "") + ".pdf", "A3", "ISSUED FOR CONSTRUCTION",
        it.revision_nr || "",
        it.revision_dt ? new Date(it.revision_dt).toISOString().split("T")[0] : today,
        it.document_name || "", "SELF RESOURCED/ISOMETRICS", "ISOMETRICS",
        today, "Y", approver, today, "ISSUED FOR CONSTRUCTION",
      ]);
    });

    const xlsxBuffer = await wb.xlsx.writeBuffer();
    const jobNo = items[0]?.job_nr || "JOB";
    const now = new Date();
    const baseName = `${jobNo}_${String(now.getDate()).padStart(2,"0")}${String(now.getMonth()+1).padStart(2,"0")}_METADATA`;

    res.setHeader("Content-Disposition", `attachment; filename=${baseName}.zip`);
    res.setHeader("Content-Type", "application/zip");

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => { throw err; });
    archive.pipe(res);
    archive.append(Buffer.from(xlsxBuffer), { name: `${baseName}.xlsx` });

    for (const it of items) {
      const { rows } = await pool.query(
        `SELECT stored_file, zone FROM drawings WHERE job_no=$1 AND unit_no=$2 AND line_no=$3`,
        [it.job_nr || it.jobNo, it.unit_id || it.unitNo, it.document_name || it.line_no]
      );
      if (rows[0]?.stored_file) {
        const pdfPath = path.join(UPLOADS_ROOT, it.job_nr || it.jobNo, it.unit_id || it.unitNo, rows[0].zone, rows[0].stored_file);
        if (fs.existsSync(pdfPath)) {
          const cleanName = path.basename(pdfPath).replace(/_R\d+-\d+/, "");
          archive.file(pdfPath, { name: cleanName });
        }
      }
    }

    await archive.finalize();
  } catch (err) {
    console.error("exportZip error:", err);
    res.status(500).json({ ok: false, error: "Failed to generate ZIP" });
  }
}

// POST /api/final-isometrics-revert
async function revertFinalIsometrics(req, res) {
  const { isos } = req.body;
  if (!Array.isArray(isos) || !isos.length)
    return res.status(400).json({ ok: false, error: "No isometrics selected" });

  let count = 0;
  for (const iso of isos) {
    const { rows } = await pool.query(
      `SELECT id FROM drawings WHERE job_no=$1 AND unit_no=$2 AND line_no=$3 AND zone=$4`,
      [iso.job_nr, iso.unit_id, iso.document_name, iso.ZONE]
    );
    if (!rows[0]) continue;
    await pool.query(
      `UPDATE drawings SET status='Ready for GL', notify_gl=TRUE, notify_modeller=FALSE WHERE id=$1`,
      [rows[0].id]
    );
    count++;
  }
  res.json({ ok: true, count });
}

// GET /api/report-summary
async function getReportSummary(req, res) {
  try {
    const { rows } = await pool.query(`
      SELECT
        job_no, unit_no,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status='Uploaded') AS uploaded,
        COUNT(*) FILTER (WHERE status='Under Review') AS under_review,
        COUNT(*) FILTER (WHERE status LIKE 'Comments Received%') AS comments_received,
        COUNT(*) FILTER (WHERE status='Ready for GL') AS ready_gl,
        COUNT(*) FILTER (WHERE status='Ready for SGL') AS ready_sgl,
        COUNT(*) FILTER (WHERE status IN ('Ready for EDMS','Final')) AS final,
        COUNT(*) FILTER (WHERE stress_critical='Y') AS stress_critical
      FROM drawings
      GROUP BY job_no, unit_no
      ORDER BY job_no, unit_no
    `);
    res.json({ ok: true, summary: rows });
  } catch (err) {
    console.error("getReportSummary error:", err);
    res.json({ ok: false, summary: [] });
  }
}

module.exports = {
  uploadStressData, getFinalIsometrics,
  exportMetadata, exportZip, revertFinalIsometrics, getReportSummary,
};
