const { pool } = require("../pool");

async function getAll() {
  const { rows } = await pool.query(
    `SELECT * FROM stress_lines ORDER BY line_id`
  );
  return rows;
}

async function getAllLineIds() {
  const { rows } = await pool.query(`SELECT line_id FROM stress_lines`);
  return new Set(rows.map((r) => String(r.line_id).trim().toUpperCase()));
}

async function insertMany(lines) {
  for (const s of lines) {
    await pool.query(
      `INSERT INTO stress_lines (line_id, stress_system, dept, uploaded_on, uploaded_by, source_file)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (line_id) DO NOTHING`,
      [
        s.line_id,
        s.stress_system || null,
        s.dept || null,
        s.uploadedOn ? new Date(s.uploadedOn) : new Date(),
        s.uploadedBy || null,
        s.sourceFile || null,
      ]
    );
  }
}

// After uploading new stress data, mark all drawings stress_critical accordingly
async function syncStressCriticalOnDrawings() {
  // Mark drawings whose line_no base (strip last segment) matches a stress line
  // Using SQL: split line_no by '-' and compare the prefix
  await pool.query(`
    UPDATE drawings d
    SET stress_critical = CASE
      WHEN EXISTS (
        SELECT 1 FROM stress_lines sl
        WHERE UPPER(
          -- strip last dash-segment (the zone/number suffix)
          REGEXP_REPLACE(d.line_no, '-[^-]+$', '')
        ) = UPPER(sl.line_id)
      ) THEN 'Y'
      ELSE 'N'
    END
  `);
}

async function isLineCritical(lineNo) {
  // Compare without the last dash-segment
  const { rows } = await pool.query(
    `SELECT 1 FROM stress_lines
     WHERE UPPER(line_id) = UPPER(REGEXP_REPLACE($1, '-[^-]+$', ''))`,
    [lineNo]
  );
  return rows.length > 0;
}

// Scoped version — checks stress_index (new table) for specific job+unit.
// Falls back to legacy stress_lines if no scoped entry found.
async function isLineCriticalScoped(jobNo, unitNo, lineNo) {
  const m = String(lineNo).match(/^([A-Za-z]+-\d+-[A-Za-z0-9]{1,7})/);
  const base = m ? m[1] : String(lineNo).replace(/-[A-Za-z]$/, '');
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM stress_index WHERE job_no=$1 AND unit_no=$2 AND line_no=$3`,
      [jobNo, unitNo, base]
    );
    if (rows.length > 0) return true;
  } catch {
    // stress_index table may not exist yet — fall through to legacy
  }
  return isLineCritical(lineNo);
}

module.exports = {
  getAll,
  getAllLineIds,
  insertMany,
  syncStressCriticalOnDrawings,
  isLineCritical,
  isLineCriticalScoped,
};
