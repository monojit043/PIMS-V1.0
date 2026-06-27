"use strict";
const { pool } = require("../db/pool");
const XLSX     = require("xlsx");
const multer   = require("multer");
const path     = require("path");

// ── Auto-create / migrate tables on startup ──────────────────────────────────
pool.query(`
  CREATE TABLE IF NOT EXISTS stress_index (
    id            SERIAL PRIMARY KEY,
    job_no        VARCHAR(50)  NOT NULL,
    unit_no       VARCHAR(50)  NOT NULL,
    line_no       VARCHAR(200),
    line_no_raw   VARCHAR(500),
    stress_system VARCHAR(200),
    row_data      JSONB,
    uploaded_by   VARCHAR(50),
    uploaded_at   TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_stress_idx_job_unit ON stress_index(job_no, unit_no);
  CREATE INDEX IF NOT EXISTS idx_stress_idx_line     ON stress_index(job_no, unit_no, line_no);
  ALTER TABLE drawings ADD COLUMN IF NOT EXISTS stress_system VARCHAR(200);
`).catch(console.error);

// ── Multer memory storage ─────────────────────────────────────────────────────
const _upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if ([".xlsx", ".xls", ".csv"].includes(ext)) return cb(null, true);
    cb(new Error("Only .xlsx / .xls / .csv files accepted"));
  },
}).single("file");

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractBase(raw) {
  const m = String(raw).match(/([A-Za-z]+-\d+-[A-Za-z0-9]{1,7})/);
  return m ? m[1] : null;
}

function detectColumns(headers) {
  const norm = s => s.toLowerCase().replace(/[\s._\-/()]/g, "");
  const linePatterns = ["lineno","linenumber","line","isono","documentno","drawingno","pipeno","isodrg"];
  const sysPatterns  = ["stresssystem","systemno","systemnumber","ssno","stressno","stresssys","system","ss"];

  let lineCol = -1, sysCol = -1;
  headers.forEach((h, i) => {
    const n = norm(String(h || ""));
    if (lineCol < 0 && linePatterns.some(p => n.includes(p))) lineCol = i;
  });
  headers.forEach((h, i) => {
    if (i === lineCol) return;
    const n = norm(String(h || ""));
    if (sysCol < 0 && sysPatterns.some(p => n.includes(p))) sysCol = i;
  });
  return { lineCol, sysCol };
}

function parseExcel(buffer) {
  const wb      = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const ws      = wb.Sheets[wb.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  // Detect header row in first 20 rows
  let headerIdx = -1;
  for (let i = 0; i < Math.min(20, rawRows.length); i++) {
    const { lineCol } = detectColumns((rawRows[i] || []).map(c => String(c || "")));
    if (lineCol >= 0) { headerIdx = i; break; }
  }
  if (headerIdx < 0)
    return { ok: false, error: "Could not find a line number column in the first 20 rows of the file." };

  const headerRow = rawRows[headerIdx] || [];
  const { lineCol, sysCol } = detectColumns(headerRow.map(c => String(c || "")));
  const headers = headerRow.map((h, i) =>
    (h != null && String(h).trim()) ? String(h).trim() : `Col${i + 1}`
  );

  const rows = [];
  for (const raw of rawRows.slice(headerIdx + 1)) {
    const rawLineNo = raw[lineCol] != null ? String(raw[lineCol]).trim() : null;
    if (!rawLineNo) continue;
    const base = extractBase(rawLineNo);
    if (!base) continue;
    const sysNo = sysCol >= 0 && raw[sysCol] != null ? String(raw[sysCol]).trim() || null : null;
    const rowData = {};
    headers.forEach((h, idx) => { if (raw[idx] != null) rowData[h] = raw[idx]; });
    rows.push({ lineNoRaw: rawLineNo, lineNo: base, stressSystem: sysNo, rowData });
  }

  return {
    ok: true, rows,
    headerRow:    headerIdx + 1,
    lineColumn:   headers[lineCol],
    systemColumn: sysCol >= 0 ? headers[sysCol] : null,
  };
}

// ── POST /api/stress-index/preview ───────────────────────────────────────────
async function previewStressUpload(req, res) {
  _upload(req, res, async (multerErr) => {
    if (multerErr) return res.status(400).json({ ok: false, error: multerErr.message });
    if (!req.file)  return res.status(400).json({ ok: false, error: "No file uploaded" });

    const { jobNo, unitNo } = req.body;
    if (!jobNo || !unitNo)
      return res.status(400).json({ ok: false, error: "jobNo and unitNo are required" });

    const parsed = parseExcel(req.file.buffer);
    if (!parsed.ok) return res.status(400).json({ ok: false, error: parsed.error });

    try {
      // Current stress_index for this job+unit
      const { rows: curr } = await pool.query(
        "SELECT line_no, stress_system FROM stress_index WHERE job_no=$1 AND unit_no=$2",
        [jobNo, unitNo]
      );
      const currMap = new Map(curr.map(r => [r.line_no, r.stress_system]));

      // Drawings: strip zone + subline to get base line_no for matching
      // e.g. P-111-12345-A → P-111-12345,  P-111-12345-01-A → P-111-12345
      const { rows: drw } = await pool.query(
        `SELECT DISTINCT ON (base_line)
           SUBSTRING(line_no FROM '^([A-Za-z]+-[0-9]+-[A-Za-z0-9]{1,7})') AS base_line,
           stress_critical
         FROM drawings WHERE job_no=$1 AND unit_no=$2
         ORDER BY base_line, stress_critical DESC`,
        [jobNo, unitNo]
      );
      const drwMap = new Map(drw.filter(d => d.base_line).map(d => [d.base_line, d.stress_critical]));

      const newLineNos = new Set(parsed.rows.map(p => p.lineNo));
      const preview    = [];

      // Lines from new Excel
      for (const p of parsed.rows) {
        const inDrawings    = drwMap.has(p.lineNo);
        const currentSC     = drwMap.get(p.lineNo) || null;
        const currentSystem = currMap.get(p.lineNo) || null;

        let action;
        if (!currentSystem)                          action = "new";
        else if (currentSystem !== p.stressSystem)   action = "system_changed";
        else                                         action = "unchanged";

        preview.push({
          lineNoRaw: p.lineNoRaw, lineNo: p.lineNo,
          stressSystem: p.stressSystem, currentSystem,
          inDrawings, currentSC, action,
        });
      }

      // Lines in current index but NOT in new Excel → will be removed
      for (const [lineNo, sysNo] of currMap) {
        if (!newLineNos.has(lineNo)) {
          preview.push({
            lineNoRaw: lineNo, lineNo, stressSystem: null,
            currentSystem: sysNo, inDrawings: drwMap.has(lineNo),
            currentSC: drwMap.get(lineNo) || null, action: "removed",
          });
        }
      }

      const summary = {
        total:         parsed.rows.length,
        new:           preview.filter(p => p.action === "new").length,
        systemChanged: preview.filter(p => p.action === "system_changed").length,
        unchanged:     preview.filter(p => p.action === "unchanged").length,
        removed:       preview.filter(p => p.action === "removed").length,
        notInDrawings: preview.filter(p => !p.inDrawings).length,
        headerRow:     parsed.headerRow,
        lineColumn:    parsed.lineColumn,
        systemColumn:  parsed.systemColumn,
      };

      res.json({ ok: true, preview, summary, jobNo, unitNo });
    } catch (err) {
      console.error("previewStressUpload error:", err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}

// ── POST /api/stress-index/apply ─────────────────────────────────────────────
async function applyStressUpload(req, res) {
  _upload(req, res, async (multerErr) => {
    if (multerErr) return res.status(400).json({ ok: false, error: multerErr.message });
    if (!req.file)  return res.status(400).json({ ok: false, error: "No file uploaded" });

    const { jobNo, unitNo } = req.body;
    if (!jobNo || !unitNo)
      return res.status(400).json({ ok: false, error: "jobNo and unitNo are required" });

    const userId = req.session?.user?.id || null;
    const parsed = parseExcel(req.file.buffer);
    if (!parsed.ok) return res.status(400).json({ ok: false, error: parsed.error });
    if (!parsed.rows.length)
      return res.status(400).json({ ok: false, error: "No valid stress lines found in the file" });

    try {
      // Lines currently in index (needed to know which ones to reset to N)
      const { rows: oldRows } = await pool.query(
        "SELECT line_no FROM stress_index WHERE job_no=$1 AND unit_no=$2",
        [jobNo, unitNo]
      );
      const oldLineNos = new Set(oldRows.map(r => r.line_no));
      const newLineNos = new Set(parsed.rows.map(p => p.lineNo));
      const toRemove   = [...oldLineNos].filter(l => !newLineNos.has(l));

      // Replace index
      await pool.query("DELETE FROM stress_index WHERE job_no=$1 AND unit_no=$2", [jobNo, unitNo]);
      for (const p of parsed.rows) {
        await pool.query(
          `INSERT INTO stress_index
             (job_no, unit_no, line_no, line_no_raw, stress_system, row_data, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [jobNo, unitNo, p.lineNo, p.lineNoRaw, p.stressSystem,
           JSON.stringify(p.rowData), userId]
        );
      }

      // Set Y + stress_system — group by system so each drawing gets its correct system number
      let setY = 0;
      if (newLineNos.size > 0) {
        const sysGroups = new Map(); // stress_system → [base line_nos]
        parsed.rows.forEach(p => {
          const k = p.stressSystem || null;
          if (!sysGroups.has(k)) sysGroups.set(k, []);
          sysGroups.get(k).push(p.lineNo);
        });
        for (const [sysNo, lineNos] of sysGroups) {
          const r = await pool.query(
            `UPDATE drawings SET stress_critical='Y', stress_system=$1
             WHERE job_no=$2 AND unit_no=$3
               AND SUBSTRING(line_no FROM '^([A-Za-z]+-[0-9]+-[A-Za-z0-9]{1,7})') = ANY($4::text[])`,
            [sysNo, jobNo, unitNo, lineNos]
          );
          setY += r.rowCount;
        }
      }

      // Set N + clear stress_system — drawings whose base line_no was removed from the index
      let setN = 0;
      if (toRemove.length > 0) {
        const r = await pool.query(
          `UPDATE drawings SET stress_critical='N', stress_system=NULL
           WHERE job_no=$1 AND unit_no=$2
             AND SUBSTRING(line_no FROM '^([A-Za-z]+-[0-9]+-[A-Za-z0-9]{1,7})') = ANY($3::text[])
             AND stress_critical = 'Y'`,
          [jobNo, unitNo, toRemove]
        );
        setN = r.rowCount;
      }

      res.json({
        ok: true,
        inserted: parsed.rows.length,
        setY, setN,
        removedFromIndex: toRemove.length,
        headerRow:   parsed.headerRow,
        lineColumn:  parsed.lineColumn,
        systemColumn: parsed.systemColumn,
      });
    } catch (err) {
      console.error("applyStressUpload error:", err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}

// ── GET /api/stress-index/data?project=X&unit=Y ───────────────────────────────
async function getStressIndexData(req, res) {
  const { project, unit } = req.query;
  if (!project || !unit)
    return res.status(400).json({ ok: false, error: "project and unit required" });
  try {
    const { rows } = await pool.query(
      `SELECT id, line_no, line_no_raw, stress_system, row_data, uploaded_by, uploaded_at
       FROM stress_index WHERE job_no=$1 AND unit_no=$2
       ORDER BY stress_system NULLS LAST, line_no`,
      [project, unit]
    );
    res.json({
      ok: true,
      rows: rows.map(r => ({
        id:           r.id,
        lineNo:       r.line_no,
        lineNoRaw:    r.line_no_raw,
        stressSystem: r.stress_system,
        rowData:      r.row_data,
        uploadedBy:   r.uploaded_by,
        uploadedAt:   r.uploaded_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

// ── GET /api/stress-index/summary ────────────────────────────────────────────
async function getStressIndexSummary(req, res) {
  try {
    const { rows } = await pool.query(`
      SELECT job_no, unit_no,
             COUNT(*)::int                      AS total_lines,
             COUNT(DISTINCT stress_system)::int AS systems,
             MAX(uploaded_at)                   AS uploaded_at
      FROM stress_index
      GROUP BY job_no, unit_no
      ORDER BY job_no, unit_no
    `);
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

// ── GET /api/stress-index/export?project=X&unit=Y ────────────────────────────
async function exportStressIndex(req, res) {
  const { project, unit } = req.query;
  if (!project || !unit)
    return res.status(400).json({ ok: false, error: "project and unit required" });
  try {
    const { rows } = await pool.query(
      `SELECT line_no, line_no_raw, stress_system, row_data
       FROM stress_index WHERE job_no=$1 AND unit_no=$2
       ORDER BY stress_system NULLS LAST, line_no`,
      [project, unit]
    );
    if (!rows.length)
      return res.status(404).json({ ok: false, error: "No stress index data for this selection" });

    const keySet = new Set(); const allKeys = [];
    rows.forEach(r => {
      if (r.row_data) Object.keys(r.row_data).forEach(k => {
        if (!keySet.has(k)) { keySet.add(k); allKeys.push(k); }
      });
    });

    const sheetData = rows.map(r => {
      const obj = {
        "Line No (Extracted)": r.line_no,
        "Line No (Raw)":       r.line_no_raw,
        "Stress System":       r.stress_system || "",
      };
      allKeys.forEach(k => { obj[k] = r.row_data?.[k] ?? ""; });
      return obj;
    });

    const wb  = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheetData), "Stress Index");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    res.setHeader("Content-Disposition", `attachment; filename="StressIndex_${project}_${unit}.xlsx"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(buf);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

module.exports = {
  previewStressUpload,
  applyStressUpload,
  getStressIndexData,
  getStressIndexSummary,
  exportStressIndex,
};
