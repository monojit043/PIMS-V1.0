const { pool } = require('../db/pool');

// Column mapping: OUTCOLS key → DB column name
const COL_MAP = {
  'PID_NO':                   'pid_no',
  'SERVICE':                  'service',
  'UNIT_NO':                  'unit_no',
  'LINE_NO':                  'line_no',
  'LINE_SIZE':                'line_size',
  'LINE_SIZE_UNIT':           'line_size_unit',
  'LINE_CLASS':               'line_class',
  'LINE_FROM':                'line_from',
  'LINE_TO':                  'line_to',
  'MIN_DESIGN_PRESS':         'min_design_press',
  'MIN_DESIGN_PRESS_UNIT':    'min_design_press_unit',
  'MIN_DESIGN_TEMP':          'min_design_temp',
  'MIN_DESIGN_TEMP_UNIT':     'min_design_temp_unit',
  'MIN_OPERATING_PRESS':      'min_operating_press',
  'MIN_OPERATING_PRESS_UNIT': 'min_operating_press_unit',
  'MIN_OPERATING_TEMP':       'min_operating_temp',
  'MIN_OPERATING_TEMP_UNIT':  'min_operating_temp_unit',
  'OPERATING_TEMP':           'operating_temp',
  'OPERATING_TEMP_UNIT':      'operating_temp_unit',
  'OPERATING_PRESS':          'operating_press',
  'OPERATING_PRESS_UNIT':     'operating_press_unit',
  'DESIGN_TEMP':              'design_temp',
  'DESIGN_TEMP_UNIT':         'design_temp_unit',
  'DESIGN_PRESS':             'design_press',
  'DESIGN_PRESS_UNIT':        'design_press_unit',
  'INSULATION':               'insulation',
  'FULL_VACCUM':              'full_vaccum',
  'FLUID_STATE':              'fluid_state',
  'MULTI PHASE (FLOW REGIME)':'multi_phase',
  'INSULATION THICKNESS':     'insulation_thickness',
};

const DB_COLS = Object.values(COL_MAP);
const OUT_KEYS = Object.keys(COL_MAP);

// ── POST /api/linelist/save ───────────────────────────────────────────────────
// Body: { jobNo, revNo, sourceFiles: string[], rows: object[] }
async function saveLinelist(req, res) {
  const { jobNo, revNo, sourceFiles, rows } = req.body || {};
  const userId = req.session?.user?.id;

  if (!jobNo)  return res.status(400).json({ ok: false, message: 'jobNo is required.' });
  if (!rows?.length) return res.status(400).json({ ok: false, message: 'No rows to save.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Mark all previous uploads for this job as not latest
    await client.query(
      `UPDATE linelist_uploads SET is_latest = FALSE WHERE job_no = $1`,
      [jobNo]
    );

    // Insert the upload record
    const { rows: upRows } = await client.query(
      `INSERT INTO linelist_uploads (job_no, source_files, rev_no, uploaded_by, row_count, is_latest)
       VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id`,
      [jobNo, JSON.stringify(sourceFiles || []), revNo ?? 0, userId, rows.length]
    );
    const uploadId = upRows[0].id;

    // Bulk insert lines in batches of 500
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const params = [];
      const valueClauses = batch.map((row, bIdx) => {
        const start = bIdx * (DB_COLS.length + 1) + 1; // +1 for upload_id
        params.push(uploadId);
        DB_COLS.forEach((_, ci) => {
          const key = OUT_KEYS[ci];
          params.push(String(row[key] ?? ''));
        });
        const slots = Array.from({ length: DB_COLS.length + 1 }, (_, k) => `$${start + k}`);
        return `(${slots.join(', ')})`;
      });

      await client.query(
        `INSERT INTO linelist_lines (upload_id, ${DB_COLS.join(', ')}) VALUES ${valueClauses.join(', ')}`,
        params
      );
    }

    await client.query('COMMIT');
    res.json({ ok: true, uploadId, rowCount: rows.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('saveLinelist error:', err);
    res.status(500).json({ ok: false, message: 'Failed to save line list.' });
  } finally {
    client.release();
  }
}

// ── GET /api/linelist/jobs ────────────────────────────────────────────────────
// Returns one row per job (latest upload only) for the dashboard section
async function getJobsSummary(req, res) {
  try {
    const { rows } = await pool.query(`
      SELECT
        lu.id           AS upload_id,
        lu.job_no,
        lu.rev_no,
        lu.row_count,
        lu.uploaded_at,
        lu.source_files,
        u.name          AS uploaded_by_name,
        ARRAY_AGG(DISTINCT ll.unit_no) FILTER (WHERE ll.unit_no != '') AS units
      FROM linelist_uploads lu
      LEFT JOIN users u          ON u.id = lu.uploaded_by
      LEFT JOIN linelist_lines ll ON ll.upload_id = lu.id
      WHERE lu.is_latest = TRUE
      GROUP BY lu.id, lu.job_no, lu.rev_no, lu.row_count, lu.uploaded_at, lu.source_files, u.name
      ORDER BY lu.uploaded_at DESC
      LIMIT 50
    `);
    res.json({ ok: true, jobs: rows });
  } catch (err) {
    console.error('getJobsSummary error:', err);
    res.status(500).json({ ok: false, message: 'Failed to load stored line lists.' });
  }
}

// ── GET /api/linelist/lines/:jobNo ────────────────────────────────────────────
// Returns all lines for the latest upload of a job
async function getJobLines(req, res) {
  const { jobNo } = req.params;
  try {
    const { rows } = await pool.query(`
      SELECT ll.*
      FROM linelist_lines ll
      JOIN linelist_uploads lu ON lu.id = ll.upload_id
      WHERE lu.job_no = $1 AND lu.is_latest = TRUE
      ORDER BY ll.unit_no, ll.line_no
    `, [jobNo]);
    res.json({ ok: true, rows });
  } catch (err) {
    console.error('getJobLines error:', err);
    res.status(500).json({ ok: false, message: 'Failed to load lines.' });
  }
}

// ── GET /api/linelist/history/:jobNo ─────────────────────────────────────────
// Returns all upload revisions for a job (newest first)
async function getUploadHistory(req, res) {
  const { jobNo } = req.params;
  try {
    const { rows } = await pool.query(`
      SELECT lu.id, lu.job_no, lu.rev_no, lu.row_count, lu.uploaded_at,
             lu.is_latest, lu.source_files, u.name AS uploaded_by_name
      FROM linelist_uploads lu
      LEFT JOIN users u ON u.id = lu.uploaded_by
      WHERE lu.job_no = $1
      ORDER BY lu.uploaded_at DESC
    `, [jobNo]);
    res.json({ ok: true, history: rows });
  } catch (err) {
    console.error('getUploadHistory error:', err);
    res.status(500).json({ ok: false, message: 'Failed to load history.' });
  }
}

// ── GET /api/linelist/check-rev/:jobNo ───────────────────────────────────────
// Returns whether a job has existing data and what the next rev should be
async function checkRev(req, res) {
  const { jobNo } = req.params;
  try {
    const { rows } = await pool.query(`
      SELECT MAX(rev_no) AS max_rev FROM linelist_uploads WHERE job_no = $1
    `, [jobNo]);
    const maxRev = rows[0].max_rev;
    if (maxRev === null) {
      res.json({ ok: true, exists: false, nextRev: 0 });
    } else {
      res.json({ ok: true, exists: true, nextRev: maxRev + 1, currentRev: maxRev });
    }
  } catch (err) {
    console.error('checkRev error:', err);
    res.status(500).json({ ok: false, message: 'Failed to check revision.' });
  }
}

// ── GET /api/linelist/export/:uploadId ───────────────────────────────────────
// Returns all lines for a specific upload (for re-download by revision)
async function getByUploadId(req, res) {
  const { uploadId } = req.params;
  try {
    const { rows: lines } = await pool.query(
      `SELECT ll.* FROM linelist_lines ll WHERE ll.upload_id = $1 ORDER BY ll.unit_no, ll.line_no`,
      [uploadId]
    );
    const { rows: uploads } = await pool.query(
      `SELECT lu.*, u.name AS uploaded_by_name FROM linelist_uploads lu LEFT JOIN users u ON u.id = lu.uploaded_by WHERE lu.id = $1`,
      [uploadId]
    );
    if (!uploads.length) return res.status(404).json({ ok: false, message: 'Upload not found.' });
    res.json({ ok: true, upload: uploads[0], rows: lines });
  } catch (err) {
    console.error('getByUploadId error:', err);
    res.status(500).json({ ok: false, message: 'Failed to load upload.' });
  }
}

// ── GET /api/linelist/line-data?jobNo=&lineNo= ────────────────────────────────
// Returns engineering data for a single line from the normalized line list.
// Matches: service-unit_no_numeric-line_no  vs  drawing lineNo (e.g. P-101-12453-B)
async function getLineData(req, res) {
  const { jobNo, lineNo } = req.query;
  if (!jobNo || !lineNo) return res.status(400).json({ ok: false, message: 'jobNo and lineNo required.' });

  try {
    const { rows } = await pool.query(
      `SELECT ll.service, ll.unit_no, ll.line_no,
              ll.design_temp,        ll.design_temp_unit,
              ll.operating_temp,     ll.operating_temp_unit,
              ll.min_design_temp,    ll.min_design_temp_unit,
              ll.design_press,       ll.design_press_unit,
              ll.operating_press,    ll.operating_press_unit,
              ll.insulation,         ll.insulation_thickness,
              ll.fluid_state,        ll.line_class,
              ll.service             AS svc
       FROM linelist_lines ll
       JOIN linelist_uploads lu ON lu.id = ll.upload_id
       WHERE lu.job_no = $1
         AND lu.is_latest = TRUE
         AND (
           $2 = ll.service || '-' || REGEXP_REPLACE(ll.unit_no, '\\s.*$', '') || '-' || ll.line_no
           OR $2 ILIKE ll.service || '-' || REGEXP_REPLACE(ll.unit_no, '\\s.*$', '') || '-' || ll.line_no || '-%'
         )
       LIMIT 1`,
      [jobNo, lineNo]
    );
    res.json({ ok: true, data: rows[0] || null });
  } catch (err) {
    console.error('getLineData error:', err);
    res.status(500).json({ ok: false, message: 'Failed to fetch line data.' });
  }
}

module.exports = { saveLinelist, getJobsSummary, getJobLines, getUploadHistory, checkRev, getByUploadId, getLineData };
