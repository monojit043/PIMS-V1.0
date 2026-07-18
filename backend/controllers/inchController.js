const { pool } = require('../db/pool');
const XLSX     = require('xlsx');
const multer   = require('multer');
const path     = require('path');

// ── Create / migrate table on startup ──
pool.query(`
  CREATE TABLE IF NOT EXISTS inch_data (
    id          SERIAL PRIMARY KEY,
    job_no      VARCHAR(50)  NOT NULL,
    unit_no     VARCHAR(50)  NOT NULL,
    line_no     VARCHAR(200),
    inch_dia    NUMERIC,
    inch_meter  NUMERIC,
    uploaded_by VARCHAR(50),
    uploaded_at TIMESTAMPTZ  DEFAULT NOW()
  );
  ALTER TABLE inch_data DROP COLUMN IF EXISTS row_data;
  ALTER TABLE inch_data ADD COLUMN IF NOT EXISTS line_no    VARCHAR(200);
  ALTER TABLE inch_data ADD COLUMN IF NOT EXISTS inch_dia   NUMERIC;
  ALTER TABLE inch_data ADD COLUMN IF NOT EXISTS inch_meter NUMERIC;
  CREATE INDEX IF NOT EXISTS idx_inch_data_job_unit ON inch_data(job_no, unit_no);
  CREATE INDEX IF NOT EXISTS idx_inch_data_line_no  ON inch_data(job_no, unit_no, line_no);
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

// ── Scan the first N rows of a sheet (as array-of-arrays) to locate headers ──
// Returns { headerRowIdx, colPipeline, colInchDia, colInchMeter }
const HEADER_SCAN_ROWS = 15;

// Collapse embedded line breaks / repeated whitespace (common in wrapped header
// cells like "DESIGN TEMP\n(deg. C)") into single spaces before regex matching —
// otherwise "." in the regexes below won't cross a literal newline.
function norm(c) {
  return String(c ?? '').replace(/\s+/g, ' ').trim();
}

function detectHeaders(rawRows) {
  for (let i = 0; i < Math.min(HEADER_SCAN_ROWS, rawRows.length); i++) {
    const row = (rawRows[i] || []).map(norm);
    const pipeIdx     = row.findIndex(c => /pipe.?line.?name/i.test(c));
    if (pipeIdx < 0) continue;                        // this row doesn't have it

    const inchDiaIdx   = row.findIndex(c => /inch.?dia(meter)?/i.test(c) && !/meter/i.test(c));
    const inchMeterIdx = row.findIndex(c => /inch.?meter/i.test(c));

    return {
      headerRowIdx: i,
      colPipeline:  pipeIdx,
      colInchDia:   inchDiaIdx,
      colInchMeter: inchMeterIdx,
      headerLabels: {
        pipeline:  row[pipeIdx],
        inchDia:   inchDiaIdx   >= 0 ? row[inchDiaIdx]   : null,
        inchMeter: inchMeterIdx >= 0 ? row[inchMeterIdx] : null,
      },
    };
  }
  return null;   // not found in first N rows
}

// POST /api/inch/upload
async function uploadInchData(req, res) {
  _upload(req, res, async (multerErr) => {
    if (multerErr) return res.status(400).json({ ok: false, error: multerErr.message });
    if (!req.file)  return res.status(400).json({ ok: false, error: 'No file uploaded' });

    const { jobNo, unitNo } = req.body;
    if (!jobNo || !unitNo)
      return res.status(400).json({ ok: false, error: 'jobNo and unitNo are required' });

    const userId = req.session?.user?.id ?? null;

    try {
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
      if (!workbook.SheetNames.length)
        return res.status(400).json({ ok: false, error: 'Excel file has no sheets' });

      // Some exports (e.g. SP3D reports) bundle the real data in a sheet that
      // isn't first — search every sheet for one whose header row matches,
      // instead of assuming SheetNames[0] is the data sheet.
      let rawRows = null;
      let found   = null;
      for (const name of workbook.SheetNames) {
        const candidateRows = XLSX.utils.sheet_to_json(workbook.Sheets[name], {
          header: 1,
          defval: null,
        });
        const candidateFound = detectHeaders(candidateRows);
        if (candidateFound) {
          rawRows = candidateRows;
          found   = candidateFound;
          break;
        }
      }

      if (!found) {
        return res.status(400).json({
          ok: false,
          error: `Could not find a "PIPELINE NAME" column in the first ${HEADER_SCAN_ROWS} rows of any sheet ` +
                 `(checked: ${workbook.SheetNames.join(', ')})`,
        });
      }

      const { headerRowIdx, colPipeline, colInchDia, colInchMeter, headerLabels } = found;
      const dataRows = rawRows.slice(headerRowIdx + 1);

      // Replace-on-upload
      await pool.query(`DELETE FROM inch_data WHERE job_no=$1 AND unit_no=$2`, [jobNo, unitNo]);

      let inserted = 0;
      for (const row of dataRows) {
        const raw = (col) => (col >= 0 && row[col] != null ? row[col] : null);

        const lineNo    = raw(colPipeline) != null ? String(raw(colPipeline)).trim() : null;
        if (!lineNo) continue;   // skip blank / subtotal rows

        const inchDia   = colInchDia   >= 0 ? (parseFloat(raw(colInchDia))   || null) : null;
        const inchMeter = colInchMeter >= 0 ? (parseFloat(raw(colInchMeter)) || null) : null;

        await pool.query(
          `INSERT INTO inch_data (job_no, unit_no, line_no, inch_dia, inch_meter, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [jobNo, unitNo, lineNo, inchDia, inchMeter, userId]
        );
        inserted++;
      }

      res.json({
        ok: true,
        inserted,
        headerRow:   headerRowIdx + 1,   // 1-based for human-readable feedback
        headerLabels,
        message: `${inserted} rows saved for ${jobNo} / ${unitNo} ` +
                 `(headers found on row ${headerRowIdx + 1}: ` +
                 `"${headerLabels.pipeline}"` +
                 (headerLabels.inchDia    ? `, "${headerLabels.inchDia}"`    : ' — ⚠ INCH DIA not found') +
                 (headerLabels.inchMeter  ? `, "${headerLabels.inchMeter}"`  : ' — ⚠ INCH METER not found') +
                 `)`,
      });
    } catch (err) {
      console.error('uploadInchData error:', err);
      res.status(500).json({ ok: false, error: 'Failed to process file' });
    }
  });
}

// GET /api/inch/unit?project=X&unit=Y
// Returns { lineNo: { inchDia, inchMeter } } — bulk map for ISO table badges
async function getInchForUnit(req, res) {
  const { project, unit } = req.query;
  if (!project || !unit)
    return res.status(400).json({ ok: false, error: 'project and unit required' });

  try {
    const { rows } = await pool.query(
      `SELECT line_no, inch_dia, inch_meter
       FROM inch_data
       WHERE job_no=$1 AND unit_no=$2 AND line_no IS NOT NULL
       ORDER BY id`,
      [project, unit]
    );
    const map = {};
    for (const r of rows) {
      map[r.line_no] = { inchDia: r.inch_dia, inchMeter: r.inch_meter };
    }
    res.json({ ok: true, map });
  } catch (err) {
    console.error('getInchForUnit error:', err);
    res.status(500).json({ ok: false, error: 'Failed' });
  }
}

// GET /api/inch/line?project=X&unit=Y&lineNo=Z
// Returns a single row — used by line details modal
async function getInchByLine(req, res) {
  const { project, unit, lineNo } = req.query;
  if (!project || !unit || !lineNo)
    return res.status(400).json({ ok: false, error: 'project, unit, lineNo required' });

  try {
    const { rows } = await pool.query(
      `SELECT line_no, inch_dia, inch_meter, uploaded_at
       FROM inch_data
       WHERE job_no=$1 AND unit_no=$2 AND line_no=$3
       LIMIT 1`,
      [project, unit, lineNo]
    );
    if (!rows[0]) return res.json({ ok: true, data: null });
    const r = rows[0];
    res.json({
      ok: true,
      data: {
        lineNo:     r.line_no,
        inchDia:    r.inch_dia,
        inchMeter:  r.inch_meter,
        uploadedAt: r.uploaded_at,
      },
    });
  } catch (err) {
    console.error('getInchByLine error:', err);
    res.status(500).json({ ok: false, error: 'Failed' });
  }
}

// GET /api/inch/data?project=X&unit=Y — all rows, used by inch-upload.html preview
async function getInchData(req, res) {
  const { project, unit } = req.query;
  if (!project || !unit)
    return res.status(400).json({ ok: false, error: 'project and unit required' });

  try {
    const { rows } = await pool.query(
      `SELECT id, line_no, inch_dia, inch_meter, uploaded_at
       FROM inch_data
       WHERE job_no=$1 AND unit_no=$2
       ORDER BY id`,
      [project, unit]
    );
    res.json({
      ok: true,
      count: rows.length,
      rows: rows.map(r => ({
        id:          r.id,
        lineNo:      r.line_no,
        inchDia:     r.inch_dia,
        inchMeter:   r.inch_meter,
        uploadedAt:  r.uploaded_at,
      })),
    });
  } catch (err) {
    console.error('getInchData error:', err);
    res.status(500).json({ ok: false, error: 'Failed' });
  }
}

// GET /api/inch/export?project=X&unit=Y — stream Excel download of stored data
async function exportInchData(req, res) {
  const { project, unit } = req.query;
  if (!project || !unit)
    return res.status(400).json({ ok: false, error: 'project and unit required' });

  try {
    const { rows } = await pool.query(
      `SELECT line_no, inch_dia, inch_meter, uploaded_at
       FROM inch_data
       WHERE job_no=$1 AND unit_no=$2 AND line_no IS NOT NULL
       ORDER BY id`,
      [project, unit]
    );
    if (!rows.length)
      return res.status(404).json({ ok: false, error: 'No data found for this project / unit' });

    const uploadedAt = rows[0].uploaded_at
      ? new Date(rows[0].uploaded_at).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' })
      : '';

    const sheetData = rows.map(r => ({
      'PIPELINE NAME': r.line_no,
      'INCH DIA':      r.inch_dia  != null ? Number(r.inch_dia)    : '',
      'INCH METER':    r.inch_meter != null ? Number(r.inch_meter) : '',
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(sheetData);

    // Auto-width columns
    ws['!cols'] = [{ wch: 30 }, { wch: 12 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, ws, 'INCH Data');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `INCH_${project}_${unit}_${uploadedAt.replace(/ /g, '-')}.xlsx`;

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error('exportInchData error:', err);
    res.status(500).json({ ok: false, error: 'Export failed' });
  }
}

// GET /api/inch/summary — one entry per job+unit
async function getInchSummary(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT job_no, unit_no,
              COUNT(*)::int      AS row_count,
              COUNT(line_no)::int AS matched_count,
              MAX(uploaded_at)   AS uploaded_at
       FROM inch_data
       GROUP BY job_no, unit_no
       ORDER BY job_no, unit_no`
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error('getInchSummary error:', err);
    res.status(500).json({ ok: false, error: 'Failed' });
  }
}

module.exports = { uploadInchData, getInchForUnit, getInchByLine, getInchData, exportInchData, getInchSummary };
