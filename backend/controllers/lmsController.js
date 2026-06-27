const { pool } = require('../db/pool');
const XLSX     = require('xlsx');
const multer   = require('multer');
const path     = require('path');

// ── Create / migrate table on startup ──
pool.query(`
  CREATE TABLE IF NOT EXISTS lms_data (
    id          SERIAL PRIMARY KEY,
    job_no      VARCHAR(50)  NOT NULL,
    unit_no     VARCHAR(50)  NOT NULL,
    line_no     VARCHAR(200),
    equip_raw   VARCHAR(500),
    row_data    JSONB,
    uploaded_by VARCHAR(50),
    uploaded_at TIMESTAMPTZ  DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_lms_data_job_unit ON lms_data(job_no, unit_no);
  CREATE INDEX IF NOT EXISTS idx_lms_data_line_no  ON lms_data(job_no, unit_no, line_no);
  ALTER TABLE lms_data ADD COLUMN IF NOT EXISTS lms_type VARCHAR(100) NOT NULL DEFAULT 'General';
  CREATE INDEX IF NOT EXISTS idx_lms_data_type ON lms_data(job_no, unit_no, lms_type);
`).catch(console.error);

// ── Multer — memory storage ──
const _upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xls', '.csv'].includes(ext)) return cb(null, true);
    cb(new Error('Only .xlsx / .xls / .csv files are accepted'));
  },
}).single('file');

// ── Normalise a cell value for matching (strip non-breaking spaces, collapse whitespace) ──
function normalise(v) {
  return String(v ?? '')
    .replace(/ /g, ' ')   // non-breaking space → regular space
    .replace(/\s+/g, ' ')      // collapse all whitespace
    .trim()
    .toLowerCase();
}

// ── Scan first 50 rows for the "Equipment no. / Line no." column ──
// Returns { headerRowIdx, colEquip, allHeaders, headerLabel }
// On failure returns { error, scanned } with debug info about what was found
function detectLmsHeaders(rawRows) {
  const scanned = [];   // for debug output on failure

  for (let i = 0; i < Math.min(50, rawRows.length); i++) {
    const row = rawRows[i] || [];

    // Collect non-empty cell texts for this row (for debug)
    const texts = row
      .filter(c => c != null && String(c).trim() !== '')
      .map(c => String(c).substring(0, 60));
    if (texts.length) scanned.push(`Row ${i + 1}: ${texts.join(' | ')}`);

    // Match any cell whose normalised text contains "equipment"
    const equipIdx = row.findIndex(c => normalise(c).includes('equipment'));
    if (equipIdx < 0) continue;

    return {
      headerRowIdx: i,
      colEquip:     equipIdx,
      headerLabel:  String(row[equipIdx]).trim(),
      allHeaders:   row.map((c, idx) =>
        (c != null && String(c).trim()) ? String(c).trim() : `Col${idx + 1}`
      ),
    };
  }

  // Not found — return debug info so the UI can show it
  return {
    notFound: true,
    scanned,
  };
}

// ── Extract base line_no from LMS values — zone suffix is intentionally dropped ──
// Examples:
//   2"-P-101-12000-A-IH   → P-101-12000  (zone -A dropped; drawings match on base)
//   2"-P-111-12404-D5D-IH → P-111-12404  (pipe-class -D5D not captured)
// Zone is stripped here so that P-101-12000-A, -B, -C in drawings all resolve
// to the same LMS rows.
function extractLineNo(raw) {
  if (!raw) return null;
  // Matches PREFIX-UNIT-SEQNO anywhere in the raw string (e.g. "2"-TRM-111-VV1227-01-A-IH")
  // PREFIX: one or more letters  UNIT: digits  SEQNO: 1-7 alphanumeric chars
  const m = String(raw).match(/([A-Za-z]+-\d+-[A-Za-z0-9]{1,7})/);
  return m ? m[1] : null;
}

// POST /api/lms/upload
async function uploadLmsData(req, res) {
  _upload(req, res, async (multerErr) => {
    if (multerErr) return res.status(400).json({ ok: false, error: multerErr.message });
    if (!req.file)  return res.status(400).json({ ok: false, error: 'No file uploaded' });

    const { jobNo, unitNo, lmsType } = req.body;
    const effectiveLmsType = (lmsType && lmsType.trim()) ? lmsType.trim() : 'General';
    if (!jobNo || !unitNo)
      return res.status(400).json({ ok: false, error: 'jobNo and unitNo are required' });

    const userId = req.session?.user?.id ?? null;

    try {
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
      if (!workbook.SheetNames.length)
        return res.status(400).json({ ok: false, error: 'Excel file has no sheets' });

      // ── Scan every sheet in order — use the first one that has the Equipment column ──
      let rawRows = null;
      let usedSheet = null;
      let found = null;

      for (const sName of workbook.SheetNames) {
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sName], {
          header: 1,
          defval: null,
        });
        const result = detectLmsHeaders(rows);
        if (!result.notFound) {
          rawRows   = rows;
          usedSheet = sName;
          found     = result;
          break;
        }
      }

      if (!found) {
        // Collect debug lines from all sheets for the error message
        const allScanned = workbook.SheetNames.map(sName => {
          const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sName], { header: 1, defval: null });
          const r    = detectLmsHeaders(rows);
          return `Sheet "${sName}": ${r.scanned.length ? r.scanned.join(' / ') : '(empty)'}`;
        });
        console.warn('LMS header not found in any sheet.\n' + allScanned.join('\n'));
        return res.status(400).json({
          ok:      false,
          error:   `Could not find "Equipment no. / Line no." column in any of the ${workbook.SheetNames.length} sheet(s).`,
          scanned: allScanned,
        });
      }

      console.log(`LMS: using sheet "${usedSheet}", header on row ${found.headerRowIdx + 1}`);

      const { headerRowIdx, colEquip, allHeaders, headerLabel } = found;
      const dataRows = rawRows.slice(headerRowIdx + 1);

      // Replace-on-upload: delete existing rows for this job+unit+type only
      await pool.query('DELETE FROM lms_data WHERE job_no=$1 AND unit_no=$2 AND lms_type=$3', [jobNo, unitNo, effectiveLmsType]);

      let inserted = 0;
      let matched  = 0;

      for (const row of dataRows) {
        const equipRaw = (row[colEquip] != null) ? String(row[colEquip]).trim() : null;
        if (!equipRaw) continue;   // skip empty rows

        const lineNo = extractLineNo(equipRaw);
        if (lineNo) matched++;

        // Build JSONB row from all header columns (preserve order)
        const rowObj = {};
        allHeaders.forEach((h, idx) => {
          if (row[idx] != null) rowObj[h] = row[idx];
        });

        await pool.query(
          `INSERT INTO lms_data (job_no, unit_no, line_no, equip_raw, row_data, uploaded_by, lms_type)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [jobNo, unitNo, lineNo, equipRaw, JSON.stringify(rowObj), userId, effectiveLmsType]
        );
        inserted++;
      }

      res.json({
        ok:          true,
        inserted,
        matched,
        unmatched:   inserted - matched,
        lmsType:     effectiveLmsType,
        headerRow:   found.headerRowIdx + 1,
        equipColumn: found.headerLabel,
        sheetName:   usedSheet,
        message:     `${inserted} rows saved for ${jobNo} / ${unitNo} (${effectiveLmsType}) — ` +
                     `${matched} line numbers extracted from "${found.headerLabel}" ` +
                     `(sheet "${usedSheet}", row ${found.headerRowIdx + 1})`,
      });
    } catch (err) {
      console.error('uploadLmsData error:', err);
      res.status(500).json({ ok: false, error: 'Failed to process file' });
    }
  });
}

// GET /api/lms/line?project=X&unit=Y&lineNo=Z — all items for a single line, used by line details modal
// lineNo may include a zone suffix (e.g. P-101-12000-A); we strip it before matching
// because lms_data stores only the base (P-101-12000), so zones A/B/C all resolve to the same rows.
async function getLmsByLine(req, res) {
  const { project, unit, lineNo } = req.query;
  if (!project || !unit || !lineNo)
    return res.status(400).json({ ok: false, error: 'project, unit, lineNo required' });

  // Extract base PREFIX-UNIT-SEQNO, dropping zone and subline
  // e.g. TRM-111-VV1227-01-A → TRM-111-VV1227,  P-101-12000-A → P-101-12000
  const _m = String(lineNo).match(/^([A-Za-z]+-\d+-[A-Za-z0-9]{1,7})/);
  const baseLineNo = _m ? _m[1] : lineNo.replace(/-[A-Za-z]$/, '');

  try {
    const { rows } = await pool.query(
      `SELECT id, line_no, equip_raw, row_data, lms_type, uploaded_at
       FROM lms_data
       WHERE job_no=$1 AND unit_no=$2 AND line_no=$3
       ORDER BY lms_type, id`,
      [project, unit, baseLineNo]
    );
    res.json({
      ok:    true,
      count: rows.length,
      rows:  rows.map(r => ({
        id:         r.id,
        lineNo:     r.line_no,
        equipRaw:   r.equip_raw,
        rowData:    r.row_data,
        lmsType:    r.lms_type,
        uploadedAt: r.uploaded_at,
      })),
    });
  } catch (err) {
    console.error('getLmsByLine error:', err);
    res.status(500).json({ ok: false, error: 'Failed' });
  }
}

// GET /api/lms/data?project=X&unit=Y
async function getLmsData(req, res) {
  const { project, unit } = req.query;
  if (!project || !unit)
    return res.status(400).json({ ok: false, error: 'project and unit required' });

  try {
    const { rows } = await pool.query(
      `SELECT id, line_no, equip_raw, row_data, lms_type, uploaded_at
       FROM lms_data
       WHERE job_no=$1 AND unit_no=$2
       ORDER BY lms_type, id`,
      [project, unit]
    );
    res.json({
      ok:    true,
      count: rows.length,
      rows:  rows.map(r => ({
        id:         r.id,
        lineNo:     r.line_no,
        equipRaw:   r.equip_raw,
        rowData:    r.row_data,
        lmsType:    r.lms_type,
        uploadedAt: r.uploaded_at,
      })),
    });
  } catch (err) {
    console.error('getLmsData error:', err);
    res.status(500).json({ ok: false, error: 'Failed' });
  }
}

// GET /api/lms/summary — one entry per job+unit
async function getLmsSummary(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT job_no, unit_no, lms_type,
              COUNT(*)::int          AS row_count,
              COUNT(line_no)::int    AS matched_count,
              MAX(uploaded_at)       AS uploaded_at
       FROM lms_data
       GROUP BY job_no, unit_no, lms_type
       ORDER BY job_no, unit_no, lms_type`
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error('getLmsSummary error:', err);
    res.status(500).json({ ok: false, error: 'Failed' });
  }
}

// GET /api/lms/export?project=X&unit=Y — stream Excel download
async function exportLmsData(req, res) {
  const { project, unit } = req.query;
  if (!project || !unit)
    return res.status(400).json({ ok: false, error: 'project and unit required' });

  try {
    const { rows } = await pool.query(
      `SELECT line_no, equip_raw, row_data, uploaded_at
       FROM lms_data
       WHERE job_no=$1 AND unit_no=$2
       ORDER BY id`,
      [project, unit]
    );
    if (!rows.length)
      return res.status(404).json({ ok: false, error: 'No data found for this project / unit' });

    // Collect all unique column headers (preserving insertion order across rows)
    const allKeys = [];
    const keySet  = new Set();
    rows.forEach(r => {
      if (r.row_data) {
        Object.keys(r.row_data).forEach(k => {
          if (!keySet.has(k)) { keySet.add(k); allKeys.push(k); }
        });
      }
    });

    const sheetData = rows.map(r => {
      const obj = { 'Line No (Extracted)': r.line_no || '' };
      allKeys.forEach(k => { obj[k] = r.row_data?.[k] ?? ''; });
      return obj;
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(sheetData);
    XLSX.utils.book_append_sheet(wb, ws, 'LMS Data');

    const buf        = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const uploadedAt = rows[0].uploaded_at
      ? new Date(rows[0].uploaded_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
      : '';
    const filename   = `LMS_${project}_${unit}_${uploadedAt.replace(/ /g, '-')}.xlsx`;

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error('exportLmsData error:', err);
    res.status(500).json({ ok: false, error: 'Export failed' });
  }
}

module.exports = { uploadLmsData, getLmsByLine, getLmsData, getLmsSummary, exportLmsData };
