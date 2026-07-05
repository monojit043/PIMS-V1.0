const { pool } = require("../db/pool");

function fmt(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${yy} ${hh}:${min}`;
}

function fmtDate(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;
}

function pendingLabel(status) {
  if (status?.startsWith('Comments Received')) return "Pending Incorporation";
  const map = {
    "Final": "None",
    "Ready for EDMS": "None",
    "Ready for SGL": "Pending SGL",
    "Ready for GL": "Pending GL",
    "GL Commented": "Pending Checker Review",
    "SGL Commented": "Pending Checker Review",
    "Sent for Supporting Check": "Pending SC",
    "Under Review": "Pending Checker",
    "Uploaded": "Awaiting Claim",
  };
  return map[status] || "Pending";
}

// ── Summary stats ──────────────────────────────────────────────────────────────
// GET /api/report/summary?jobNo=X&units=A,B,C
async function getSummary(req, res) {
  const { jobNo, units: unitsStr } = req.query;
  if (!jobNo || !unitsStr) return res.status(400).json({ ok: false, error: "jobNo and units required" });
  const units = unitsStr.split(",").filter(Boolean);

  try {
    const [statusRes, stressRes, revRes, unitRes, checkerRes] = await Promise.all([
      pool.query(
        `SELECT status, COUNT(*) AS cnt FROM drawings
         WHERE job_no=$1 AND unit_no=ANY($2) AND status!='Superseded'
         GROUP BY status ORDER BY cnt DESC`,
        [jobNo, units]
      ),
      pool.query(
        `SELECT stress_critical, COUNT(*) AS cnt FROM drawings
         WHERE job_no=$1 AND unit_no=ANY($2) AND status!='Superseded'
         GROUP BY stress_critical`,
        [jobNo, units]
      ),
      pool.query(
        `SELECT rev_no, COUNT(*) AS cnt FROM drawings
         WHERE job_no=$1 AND unit_no=ANY($2) AND status!='Superseded'
         GROUP BY rev_no ORDER BY rev_no`,
        [jobNo, units]
      ),
      pool.query(
        `SELECT unit_no,
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE status IN ('Final','Ready for EDMS')) AS completed,
           COUNT(*) FILTER (WHERE status NOT IN ('Uploaded','Final','Ready for EDMS','Superseded')) AS in_progress,
           COUNT(*) FILTER (WHERE status='Uploaded') AS pending
         FROM drawings WHERE job_no=$1 AND unit_no=ANY($2) AND status!='Superseded'
         GROUP BY unit_no ORDER BY unit_no`,
        [jobNo, units]
      ),
      pool.query(
        `SELECT
           COUNT(DISTINCT CASE WHEN 'PC'=ANY(dc.roles) AND dc.completed_at IS NOT NULL THEN dc.drawing_id END) AS pc_checked,
           COUNT(DISTINCT CASE WHEN 'MC'=ANY(dc.roles) AND dc.completed_at IS NOT NULL THEN dc.drawing_id END) AS mc_checked,
           COUNT(DISTINCT CASE WHEN 'SC'=ANY(dc.roles) AND dc.completed_at IS NOT NULL THEN dc.drawing_id END) AS sc_checked,
           COUNT(DISTINCT CASE WHEN 'GL'=ANY(dc.roles) AND dc.completed_at IS NOT NULL THEN dc.drawing_id END) AS gl_reviewed,
           COUNT(DISTINCT CASE WHEN 'SGL'=ANY(dc.roles) AND dc.completed_at IS NOT NULL THEN dc.drawing_id END) AS sgl_reviewed,
           COUNT(DISTINCT CASE WHEN 'Modeller'=ANY(dc.roles) AND dc.completed_at IS NOT NULL THEN dc.drawing_id END) AS incorporated
         FROM drawing_claims dc
         JOIN drawings d ON d.id=dc.drawing_id
         WHERE d.job_no=$1 AND d.unit_no=ANY($2)`,
        [jobNo, units]
      ),
    ]);

    const statusDist = {};
    let total = 0;
    for (const r of statusRes.rows) {
      statusDist[r.status] = parseInt(r.cnt);
      total += parseInt(r.cnt);
    }

    const completed = (statusDist["Final"] || 0) + (statusDist["Ready for EDMS"] || 0);
    const inProgress = total - (statusDist["Uploaded"] || 0) - completed;
    const pending = statusDist["Uploaded"] || 0;
    const stressCritical = parseInt(stressRes.rows.find(r => r.stress_critical === "Y")?.cnt || 0);
    const completionPct = total ? Math.round(completed * 100 / total) : 0;

    const revDist = {};
    for (const r of revRes.rows) revDist[`R${r.rev_no}`] = parseInt(r.cnt);

    const unitBreakdown = unitRes.rows.map(r => ({
      unitNo: r.unit_no,
      total: parseInt(r.total),
      completed: parseInt(r.completed),
      inProgress: parseInt(r.in_progress),
      pending: parseInt(r.pending),
    }));

    const ca = checkerRes.rows[0] || {};
    const checkerActivity = {
      pcChecked: parseInt(ca.pc_checked || 0),
      mcChecked: parseInt(ca.mc_checked || 0),
      scChecked: parseInt(ca.sc_checked || 0),
      glReviewed: parseInt(ca.gl_reviewed || 0),
      sglReviewed: parseInt(ca.sgl_reviewed || 0),
      incorporated: parseInt(ca.incorporated || 0),
    };

    res.json({ ok: true, summary: {
      total, completed, inProgress, pending, stressCritical, completionPct,
      statusDist, revDist, unitBreakdown, checkerActivity,
    }});
  } catch (err) {
    console.error("getSummary error:", err);
    res.status(500).json({ ok: false, error: "Failed to generate summary" });
  }
}

// GET /api/report/user-activity?jobNo=X&units=A,B
async function getUserActivity(req, res) {
  const { jobNo, units: unitsStr } = req.query;
  if (!jobNo || !unitsStr) return res.status(400).json({ ok: false, error: "jobNo and units required" });
  const units = unitsStr.split(",").filter(Boolean);

  try {
    const { rows } = await pool.query(
      `SELECT u.name, u.id AS user_id,
         array_agg(DISTINCT unnest_role) FILTER (WHERE unnest_role IS NOT NULL) AS roles,
         COUNT(DISTINCT dc.drawing_id) AS lines_handled,
         COUNT(DISTINCT dc.drawing_id) FILTER (WHERE dc.completed_at IS NOT NULL) AS lines_completed,
         MAX(dc.completed_at) AS last_activity
       FROM drawing_claims dc
       JOIN users u ON u.id=dc.user_id
       JOIN drawings d ON d.id=dc.drawing_id
       LEFT JOIN LATERAL unnest(dc.roles) AS unnest_role ON TRUE
       WHERE d.job_no=$1 AND d.unit_no=ANY($2)
       GROUP BY u.name, u.id
       ORDER BY lines_completed DESC, u.name`,
      [jobNo, units]
    );

    res.json({ ok: true, activity: rows.map(r => ({
      name: r.name,
      userId: r.user_id,
      roles: r.roles || [],
      linesHandled: parseInt(r.lines_handled),
      linesCompleted: parseInt(r.lines_completed),
      lastActivity: r.last_activity ? fmtDate(r.last_activity) : "-",
    }))});
  } catch (err) {
    console.error("getUserActivity error:", err);
    res.status(500).json({ ok: false, error: "Failed" });
  }
}

// ── Detailed line data ─────────────────────────────────────────────────────────
async function buildReportData(jobNo, units, onlyInProgress) {
  const { rows } = await pool.query(
    `SELECT
       d.id, d.unit_no, d.zone, d.line_no,
       d.stored_file, d.uploaded_by, d.uploaded_on,
       d.rev_no, d.status, d.stress_critical, d.job_no,
       u_up.name AS uploader_name,
       pc.user_id  AS pc_uid,  pc.created_at  AS pc_date,  u_pc.name  AS pc_name,
       mc.user_id  AS mc_uid,  mc.created_at  AS mc_date,  u_mc.name  AS mc_name,
       sc.user_id  AS sc_uid,  sc.created_at  AS sc_date,  u_sc.name  AS sc_name,
       gl.user_id  AS gl_uid,  gl.created_at  AS gl_date,  u_gl.name  AS gl_name,
       sgl.user_id AS sgl_uid, sgl.created_at AS sgl_date, u_sgl.name AS sgl_name,
       mod.user_id AS mod_uid, mod.created_at AS mod_date, u_mod.name AS mod_name
     FROM drawings d
     LEFT JOIN users u_up  ON u_up.id  = d.uploaded_by
     -- Each LATERAL subquery is scoped to rev_no = d.rev_no (the CURRENT
     -- revision) — without this, "most recent comment ever" would credit a
     -- role for a PAST revision's work even when the current revision hasn't
     -- been touched by that role yet, making the report look more complete
     -- than it actually is. rev_no is stamped on each comment at write time.
     LEFT JOIN LATERAL (
       SELECT user_id, created_at FROM drawing_comments
       WHERE drawing_id = d.id AND 'PC' = ANY(roles) AND rev_no = d.rev_no
       ORDER BY created_at DESC LIMIT 1
     ) pc  ON TRUE LEFT JOIN users u_pc  ON u_pc.id  = pc.user_id
     LEFT JOIN LATERAL (
       SELECT user_id, created_at FROM drawing_comments
       WHERE drawing_id = d.id AND 'MC' = ANY(roles) AND rev_no = d.rev_no
       ORDER BY created_at DESC LIMIT 1
     ) mc  ON TRUE LEFT JOIN users u_mc  ON u_mc.id  = mc.user_id
     LEFT JOIN LATERAL (
       SELECT user_id, created_at FROM drawing_comments
       WHERE drawing_id = d.id AND 'SC' = ANY(roles) AND rev_no = d.rev_no
       ORDER BY created_at DESC LIMIT 1
     ) sc  ON TRUE LEFT JOIN users u_sc  ON u_sc.id  = sc.user_id
     LEFT JOIN LATERAL (
       SELECT user_id, created_at FROM drawing_comments
       WHERE drawing_id = d.id AND 'GL' = ANY(roles) AND rev_no = d.rev_no
       ORDER BY created_at DESC LIMIT 1
     ) gl  ON TRUE LEFT JOIN users u_gl  ON u_gl.id  = gl.user_id
     LEFT JOIN LATERAL (
       SELECT user_id, created_at FROM drawing_comments
       WHERE drawing_id = d.id AND 'SGL' = ANY(roles) AND rev_no = d.rev_no
       ORDER BY created_at DESC LIMIT 1
     ) sgl ON TRUE LEFT JOIN users u_sgl ON u_sgl.id = sgl.user_id
     LEFT JOIN LATERAL (
       SELECT user_id, created_at FROM drawing_comments
       WHERE drawing_id = d.id AND 'Modeller' = ANY(roles) AND rev_no = d.rev_no
       ORDER BY created_at DESC LIMIT 1
     ) mod ON TRUE LEFT JOIN users u_mod ON u_mod.id = mod.user_id
     WHERE d.job_no = $1 AND d.unit_no = ANY($2)
       ${onlyInProgress ? "AND d.status NOT IN ('Ready for EDMS','Final','Superseded')" : "AND d.status != 'Superseded'"}
     ORDER BY d.unit_no, d.line_no`,
    [jobNo, units]
  );

  return rows.map((r, i) => ({
    slNo: i + 1,
    lineId: r.line_no,
    zone: r.zone || "-",
    unitNo: r.unit_no,
    critical: r.stress_critical === "Y" ? "YES" : "NO",
    status: r.status || "Uploaded",
    revNo: `R${r.rev_no ?? 0}`,
    uploadedBy: r.uploader_name || r.uploaded_by || "-",
    uploadedOn: fmtDate(r.uploaded_on),
    processCheckBy: r.pc_name || r.pc_uid || "-",
    processCheckDate: r.pc_date ? fmtDate(r.pc_date) : "-",
    materialCheckBy: r.mc_name || r.mc_uid || "-",
    materialCheckDate: r.mc_date ? fmtDate(r.mc_date) : "-",
    supportBy: r.sc_name || r.sc_uid || "-",
    supportDate: r.sc_date ? fmtDate(r.sc_date) : "-",
    modellerIncorporation: r.mod_name || r.mod_uid || "-",
    incorporatedDate: r.mod_date ? fmtDate(r.mod_date) : "-",
    glCheck: r.gl_name || r.gl_uid || "-",
    glCheckDate: r.gl_date ? fmtDate(r.gl_date) : "-",
    sglCheck: r.sgl_name || r.sgl_uid || "-",
    sglCheckDate: r.sgl_date ? fmtDate(r.sgl_date) : "-",
    pending: pendingLabel(r.status),
  }));
}

// POST /api/report/all-lines
async function getAllLines(req, res) {
  try {
    const { jobNo, units } = req.body;
    if (!jobNo || !units?.length)
      return res.status(400).json({ success: false, error: "jobNo and units required" });
    const data = await buildReportData(jobNo, units, false);
    if (!data.length)
      return res.status(404).json({ success: false, error: "No drawings found" });
    res.json({ success: true, jobNo, units, totalLines: data.length, data, generatedOn: new Date().toISOString() });
  } catch (err) {
    console.error("getAllLines error:", err);
    res.status(500).json({ success: false, error: "Failed to generate report" });
  }
}

// POST /api/report/under-progress
async function getUnderProgress(req, res) {
  try {
    const { jobNo, units } = req.body;
    if (!jobNo || !units?.length)
      return res.status(400).json({ success: false, error: "jobNo and units required" });
    const data = await buildReportData(jobNo, units, true);
    if (!data.length)
      return res.status(404).json({ success: false, error: "No in-progress drawings found" });
    res.json({ success: true, jobNo, units, totalLines: data.length, data, generatedOn: new Date().toISOString() });
  } catch (err) {
    console.error("getUnderProgress error:", err);
    res.status(500).json({ success: false, error: "Failed to generate report" });
  }
}

// POST /api/report/batch-query
// Body: { lineIds: ['L-101', 'L-102', ...] }
async function batchQuery(req, res) {
  const { lineIds } = req.body;
  if (!Array.isArray(lineIds) || lineIds.length === 0)
    return res.status(400).json({ ok: false, error: "lineIds array required" });

  const ids = lineIds.map(s => String(s).trim()).filter(Boolean);

  try {
    // Fetch all matching drawings (latest non-superseded per line_no)
    const { rows } = await pool.query(
      `SELECT
         d.id, d.line_no, d.job_no, d.unit_no, d.zone,
         d.status, d.rev_no, d.stress_critical,
         d.uploaded_on, d.uploaded_by,
         u_up.name AS uploader_name,
         -- active claimer (completed_at IS NULL) — person currently holding it
         string_agg(DISTINCT u_cl.name ORDER BY u_cl.name) FILTER (WHERE dc.completed_at IS NULL) AS pending_with,
         string_agg(DISTINCT array_to_string(dc.roles, '+') ORDER BY array_to_string(dc.roles, '+')) FILTER (WHERE dc.completed_at IS NULL) AS pending_roles
       FROM drawings d
       LEFT JOIN users u_up ON u_up.id = d.uploaded_by
       LEFT JOIN drawing_claims dc ON dc.drawing_id = d.id
       LEFT JOIN users u_cl ON u_cl.id = dc.user_id
       WHERE d.line_no = ANY($1) AND d.status != 'Superseded'
       GROUP BY d.id, u_up.name
       ORDER BY d.unit_no, d.line_no`,
      [ids]
    );

    // Map found rows
    const foundMap = new Map();
    for (const r of rows) {
      const prev = foundMap.get(r.line_no);
      // keep latest uploaded_on if duplicate line_no across projects
      if (!prev || new Date(r.uploaded_on) > new Date(prev.uploaded_on)) {
        foundMap.set(r.line_no, r);
      }
    }

    const results = ids.map(lineId => {
      const r = foundMap.get(lineId);
      if (!r) return { lineId, found: false, status: 'Not Found', pendingLabel: '-', pendingWith: '-', pendingRoles: '-', jobNo: '-', unitNo: '-', revNo: '-', stressCritical: '-', uploadedOn: '-' };
      const isComplete = ['Final', 'Ready for EDMS'].includes(r.status);
      return {
        lineId: r.line_no,
        found: true,
        jobNo: r.job_no,
        unitNo: r.unit_no,
        zone: r.zone || '-',
        status: r.status,
        revNo: `R${r.rev_no ?? 0}`,
        stressCritical: r.stress_critical === 'Y' ? 'YES' : 'NO',
        uploadedOn: fmtDate(r.uploaded_on),
        isComplete,
        pendingLabel: pendingLabel(r.status),
        pendingWith: r.pending_with || (isComplete ? '—' : 'None (Pool)'),
        pendingRoles: r.pending_roles || (isComplete ? '—' : '-'),
      };
    });

    const total     = results.length;
    const completed = results.filter(r => r.isComplete).length;
    const notFound  = results.filter(r => !r.found).length;
    const inProgress = total - completed - notFound;

    res.json({ ok: true, total, completed, inProgress, notFound, results });
  } catch (err) {
    console.error("batchQuery error:", err);
    res.status(500).json({ ok: false, error: "Query failed: " + err.message });
  }
}

// GET /api/report/lots?jobNo=X&units=A,B,C
// Returns all planned (unissued) lots for the job+units with full per-line detail.
// Read-only — no workflow state is touched.
async function getLotsReport(req, res) {
  const { jobNo, units: unitsStr } = req.query;
  if (!jobNo || !unitsStr)
    return res.status(400).json({ ok: false, error: 'jobNo and units required' });
  const units = unitsStr.split(',').filter(Boolean);

  try {
    const { rows } = await pool.query(
      `SELECT
         l.id          AS lot_id,
         l.lot_number,
         l.unit_no,
         l.created_at,
         u_cr.name     AS created_by_name,
         d.id          AS drawing_id,
         d.zone,
         d.line_no,
         d.rev_no,
         d.status,
         d.tags,
         d.stress_critical,
         COALESCE(
           json_agg(
             json_build_object('name', u.name, 'roles', dc.roles)
           ) FILTER (WHERE dc.id IS NOT NULL),
           '[]'::json
         ) AS claimers
       FROM lots l
       JOIN lot_lines ll ON ll.lot_id = l.id
       JOIN drawings d   ON d.id = ll.drawing_id
       LEFT JOIN drawing_claims dc ON dc.drawing_id = d.id
       LEFT JOIN users u    ON u.id::text = dc.user_id
       LEFT JOIN users u_cr ON u_cr.id::text = l.created_by
       WHERE l.job_no = $1 AND l.unit_no = ANY($2) AND l.issued_at IS NULL
       GROUP BY l.id, l.lot_number, l.unit_no, l.created_at, u_cr.name,
                d.id, d.zone, d.line_no, d.rev_no, d.status, d.tags, d.stress_critical
       ORDER BY l.lot_number, l.unit_no, d.zone, d.line_no`,
      [jobNo, units]
    );

    // Group flat rows → lots with nested lines
    const lotMap = new Map();
    for (const r of rows) {
      if (!lotMap.has(r.lot_id)) {
        lotMap.set(r.lot_id, {
          lotId:     r.lot_id,
          lotNumber: r.lot_number,
          unitNo:    r.unit_no,
          createdBy: r.created_by_name || String(r.lot_id),
          createdAt: fmtDate(r.created_at),
          lines:     [],
        });
      }
      lotMap.get(r.lot_id).lines.push({
        zone:           r.zone           || '-',
        lineNo:         r.line_no,
        revNo:          r.rev_no         || 0,
        status:         r.status         || 'Uploaded',
        stressCritical: r.stress_critical || 'N',
        tags:           r.tags           || [],
        claimers:       r.claimers       || [],
      });
    }

    res.json({ ok: true, lots: [...lotMap.values()] });
  } catch (err) {
    console.error('getLotsReport error:', err);
    res.status(500).json({ ok: false, error: 'Failed to generate lot report' });
  }
}

module.exports = { getAllLines, getUnderProgress, getSummary, getUserActivity, batchQuery, getLotsReport };
