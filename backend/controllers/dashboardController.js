const { pool } = require('../db/pool');

async function roleSummary(req, res) {
  const userId = req.session.user.id;

  try {
    const { rows: roleRows } = await pool.query(
      `SELECT role, project_id, unit_no FROM user_role_assignments WHERE user_id = $1 ORDER BY role`,
      [userId]
    );

    const uniqueRoles  = [...new Set(roleRows.map(r => r.role))];
    const checkerRoles = uniqueRoles.filter(r => r.includes('Checker'));

    // Every role the user holds gets its own stacked section on the home
    // dashboard (fixed pipeline order) — a Modeller+Checker user sees both,
    // not just whichever role used to win the old single-winner priority.
    const sections = [];
    if (uniqueRoles.includes('Modeller')) sections.push('Modeller');
    if (checkerRoles.length)              sections.push('Checker');
    if (uniqueRoles.includes('GL'))        sections.push('GL');
    if (uniqueRoles.includes('SGL'))       sections.push('SGL');

    let data = { sections, allRoles: uniqueRoles, checkerRoles };

    // ── Shared recent activity query (feeds every section's Task Movement card) ─
    const activityQ = `
      SELECT dc.drawing_id, d.line_no, d.job_no, d.unit_no,
             dc.roles, dc.claimed_at, dc.completed_at, dc.comment_type
      FROM drawing_claims dc
      JOIN drawings d ON d.id = dc.drawing_id
      WHERE dc.user_id = $1
      ORDER BY COALESCE(dc.completed_at, dc.claimed_at) DESC
      LIMIT 15`;
    const activity = await pool.query(activityQ, [userId]);
    data.recentActivity = activity.rows;

    // Modeller and Checker stat cards now live in their own per-job tab
    // widgets (modellerSummary/checkerSummary below) — nothing else needed here.

    if (uniqueRoles.includes('GL')) {
      const glAssignments = roleRows.filter(r => r.role === 'GL');
      let pendingGLCount = 0;

      if (glAssignments.length > 0) {
        const conditions = glAssignments
          .map((_, i) => `(job_no = $${i * 2 + 1} AND unit_no = $${i * 2 + 2})`)
          .join(' OR ');
        const params = glAssignments.flatMap(a => [a.project_id, a.unit_no]);
        const { rows } = await pool.query(
          `SELECT COUNT(*) FROM drawings WHERE notify_gl = TRUE AND (${conditions})`,
          params
        );
        pendingGLCount = parseInt(rows[0].count);
      }

      const [approvedToday, claimed, jobs] = await Promise.all([
        pool.query(
          `SELECT COUNT(*) FROM drawing_claims
           WHERE user_id = $1 AND comment_type IS NOT NULL AND DATE(completed_at) = CURRENT_DATE`,
          [userId]
        ),
        pool.query(
          `SELECT COUNT(*) FROM drawing_claims WHERE user_id = $1 AND completed_at IS NULL`,
          [userId]
        ),
        pool.query(
          `SELECT COUNT(*) FROM (
             SELECT DISTINCT project_id, unit_no FROM user_role_assignments
             WHERE user_id = $1 AND role = 'GL'
           ) t`,
          [userId]
        ),
      ]);

      data.gl = {
        pendingGLReview: pendingGLCount,
        approvedToday:   parseInt(approvedToday.rows[0].count),
        claimedLines:    parseInt(claimed.rows[0].count),
        assignedJobs:    parseInt(jobs.rows[0].count),
      };
    }

    if (uniqueRoles.includes('SGL')) {
      const [pending, approvedToday, jobs] = await Promise.all([
        pool.query(
          `SELECT COUNT(*) FROM drawings d
           JOIN user_role_assignments ura ON ura.project_id = d.job_no AND ura.unit_no = d.unit_no
           WHERE ura.user_id = $1 AND ura.role = 'SGL' AND d.notify_gl = TRUE`,
          [userId]
        ),
        pool.query(
          `SELECT COUNT(*) FROM drawing_claims
           WHERE user_id = $1 AND comment_type IS NOT NULL AND DATE(completed_at) = CURRENT_DATE`,
          [userId]
        ),
        pool.query(
          `SELECT COUNT(*) FROM (
             SELECT DISTINCT project_id, unit_no FROM user_role_assignments
             WHERE user_id = $1 AND role = 'SGL'
           ) t`,
          [userId]
        ),
      ]);

      data.sgl = {
        pendingSGLReview: parseInt(pending.rows[0].count),
        approvedToday:    parseInt(approvedToday.rows[0].count),
        assignedJobs:     parseInt(jobs.rows[0].count),
      };
    }

    if (!sections.length) {
      const [claimed, projects] = await Promise.all([
        pool.query(
          `SELECT COUNT(*) FROM drawing_claims WHERE user_id = $1 AND completed_at IS NULL`,
          [userId]
        ),
        pool.query(
          `SELECT COUNT(DISTINCT project_id) FROM user_role_assignments WHERE user_id = $1`,
          [userId]
        ),
      ]);
      data.generic = { claimedLines: parseInt(claimed.rows[0].count), projects: parseInt(projects.rows[0].count) };
    }

    res.json({ ok: true, ...data });
  } catch (err) {
    console.error('Dashboard summary error:', err);
    res.status(500).json({ ok: false, message: 'Failed to load dashboard summary.' });
  }
}

function isValidDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s || '');
}

async function computeModellerJobStats(userId, jobNo, date) {
  const dateParam = isValidDate(date) ? date : null;
  const [newQ, incQ, inchQ, glQ, pendQ, stressQ] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) FROM drawings
       WHERE uploaded_by = $1 AND job_no = $2 AND rev_no = 0
         AND DATE(uploaded_on) = COALESCE($3::date, CURRENT_DATE)`,
      [userId, jobNo, dateParam]
    ),
    pool.query(
      `SELECT COUNT(*) FROM drawings
       WHERE uploaded_by = $1 AND job_no = $2 AND rev_no > 0
         AND DATE(uploaded_on) = COALESCE($3::date, CURRENT_DATE)`,
      [userId, jobNo, dateParam]
    ),
    pool.query(
      `SELECT COALESCE(SUM(inch.inch_dia), 0) AS total
       FROM drawings d
       JOIN inch_data inch
         ON inch.job_no = d.job_no AND inch.unit_no = d.unit_no AND inch.line_no = d.line_no
       WHERE d.uploaded_by = $1 AND d.job_no = $2
         AND DATE(d.uploaded_on) = COALESCE($3::date, CURRENT_DATE)`,
      [userId, jobNo, dateParam]
    ),
    pool.query(
      `SELECT COUNT(*) FROM drawings
       WHERE uploaded_by = $1 AND job_no = $2 AND rev_no > 0
         AND DATE(uploaded_on) = COALESCE($3::date, CURRENT_DATE)
         AND (notify_gl = TRUE OR status = 'Ready for GL')`,
      [userId, jobNo, dateParam]
    ),
    pool.query(
      `SELECT COUNT(*) FROM drawings
       WHERE uploaded_by = $1 AND job_no = $2 AND notify_modeller = TRUE`,
      [userId, jobNo]
    ),
    pool.query(
      `SELECT COUNT(*) FROM drawings
       WHERE uploaded_by = $1 AND job_no = $2 AND notify_modeller = TRUE AND stress_critical = 'Y'`,
      [userId, jobNo]
    ),
  ]);

  return {
    jobNo,
    newToday:              parseInt(newQ.rows[0].count),
    incorporatedToday:     parseInt(incQ.rows[0].count),
    inchDiaToday:          Math.round(parseFloat(inchQ.rows[0].total) * 100) / 100,
    glReadyToday:          parseInt(glQ.rows[0].count),
    pendingRevisions:      parseInt(pendQ.rows[0].count),
    stressCriticalPending: parseInt(stressQ.rows[0].count),
  };
}

async function modellerJobs(req, res) {
  const userId = req.session.user.id;
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ura.project_id AS job_no, p.name AS job_name
       FROM user_role_assignments ura
       LEFT JOIN projects p ON p.id = ura.project_id
       WHERE ura.user_id = $1 AND ura.role = 'Modeller'
       ORDER BY ura.project_id`,
      [userId]
    );
    res.json({ ok: true, jobs: rows.map(r => ({ jobNo: r.job_no, jobName: r.job_name })) });
  } catch (err) {
    console.error('modellerJobs error:', err);
    res.status(500).json({ ok: false, message: 'Failed to load jobs.' });
  }
}

async function modellerSummary(req, res) {
  const userId = req.session.user.id;
  const date  = isValidDate(req.query.date) ? req.query.date : null;
  const jobNo = req.query.job || 'ALL';

  try {
    if (jobNo === 'ALL') {
      const { rows: jobRows } = await pool.query(
        `SELECT DISTINCT project_id AS job_no FROM user_role_assignments
         WHERE user_id = $1 AND role = 'Modeller' ORDER BY project_id`,
        [userId]
      );
      const jobNos = jobRows.map(r => r.job_no);
      const perJob = await Promise.all(jobNos.map(jn => computeModellerJobStats(userId, jn, date)));

      const totals = perJob.reduce((acc, j) => ({
        newToday:              acc.newToday + j.newToday,
        incorporatedToday:     acc.incorporatedToday + j.incorporatedToday,
        inchDiaToday:          Math.round((acc.inchDiaToday + j.inchDiaToday) * 100) / 100,
        glReadyToday:          acc.glReadyToday + j.glReadyToday,
        pendingRevisions:      acc.pendingRevisions + j.pendingRevisions,
        stressCriticalPending: acc.stressCriticalPending + j.stressCriticalPending,
      }), { newToday: 0, incorporatedToday: 0, inchDiaToday: 0, glReadyToday: 0, pendingRevisions: 0, stressCriticalPending: 0 });

      res.json({ ok: true, date: date || 'today', jobNo: 'ALL', totals, perJob });
    } else {
      const stats = await computeModellerJobStats(userId, jobNo, date);
      const { rows: units } = await pool.query(
        `SELECT unit_no,
                COUNT(*) AS total_lines,
                COUNT(*) FILTER (WHERE notify_modeller = TRUE) AS pending,
                COUNT(*) FILTER (WHERE rev_no = 0 AND DATE(uploaded_on) = COALESCE($3::date, CURRENT_DATE)) AS new_today,
                COUNT(*) FILTER (WHERE rev_no > 0 AND DATE(uploaded_on) = COALESCE($3::date, CURRENT_DATE)) AS incorporated_today
         FROM drawings
         WHERE uploaded_by = $1 AND job_no = $2
         GROUP BY unit_no
         ORDER BY unit_no`,
        [userId, jobNo, date]
      );

      res.json({
        ok: true,
        date: date || 'today',
        ...stats,
        units: units.map(u => ({
          unitNo:             u.unit_no,
          totalLines:         parseInt(u.total_lines),
          pending:            parseInt(u.pending),
          newToday:           parseInt(u.new_today),
          incorporatedToday:  parseInt(u.incorporated_today),
        })),
      });
    }
  } catch (err) {
    console.error('modellerSummary error:', err);
    res.status(500).json({ ok: false, message: 'Failed to load summary.' });
  }
}

// Checker claims/comments use short role codes ('PC','MC','SC'), not the
// full user_role_assignments names ('Process Checker', etc).
const CHECKER_CODES = ['PC', 'MC', 'SC'];

async function computeCheckerJobStats(userId, jobNo, date) {
  const dateParam = isValidDate(date) ? date : null;
  const [commentsQ, noCommentsQ, glReadyQ, openQ, stressOpenQ] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) FROM drawing_comments dc
       JOIN drawings d ON d.id = dc.drawing_id
       WHERE dc.user_id = $1 AND d.job_no = $2 AND dc.type != 'none'
         AND dc.roles && $4::text[]
         AND DATE(dc.created_at) = COALESCE($3::date, CURRENT_DATE)`,
      [userId, jobNo, dateParam, CHECKER_CODES]
    ),
    pool.query(
      `SELECT COUNT(*) FROM drawing_comments dc
       JOIN drawings d ON d.id = dc.drawing_id
       WHERE dc.user_id = $1 AND d.job_no = $2 AND dc.type = 'none'
         AND dc.roles && $4::text[]
         AND DATE(dc.created_at) = COALESCE($3::date, CURRENT_DATE)`,
      [userId, jobNo, dateParam, CHECKER_CODES]
    ),
    pool.query(
      `SELECT COUNT(DISTINCT dc.drawing_id) FROM drawing_comments dc
       JOIN drawings d ON d.id = dc.drawing_id
       WHERE dc.user_id = $1 AND d.job_no = $2
         AND dc.roles && $4::text[]
         AND DATE(dc.created_at) = COALESCE($3::date, CURRENT_DATE)
         AND d.status = 'Ready for GL' AND d.notify_gl = TRUE`,
      [userId, jobNo, dateParam, CHECKER_CODES]
    ),
    pool.query(
      `SELECT COUNT(*) FROM drawing_claims dc
       JOIN drawings d ON d.id = dc.drawing_id
       WHERE dc.user_id = $1 AND d.job_no = $2 AND dc.completed_at IS NULL
         AND dc.roles && $3::text[]`,
      [userId, jobNo, CHECKER_CODES]
    ),
    pool.query(
      `SELECT COUNT(*) FROM drawing_claims dc
       JOIN drawings d ON d.id = dc.drawing_id
       WHERE dc.user_id = $1 AND d.job_no = $2 AND dc.completed_at IS NULL
         AND dc.roles && $3::text[] AND d.stress_critical = 'Y'`,
      [userId, jobNo, CHECKER_CODES]
    ),
  ]);

  const commentsGiven = parseInt(commentsQ.rows[0].count);
  const noComments    = parseInt(noCommentsQ.rows[0].count);

  return {
    jobNo,
    commentsGivenToday: commentsGiven,
    noCommentsToday:    noComments,
    totalReviewedToday: commentsGiven + noComments,
    glReadyToday:       parseInt(glReadyQ.rows[0].count),
    openClaims:         parseInt(openQ.rows[0].count),
    stressCriticalOpen: parseInt(stressOpenQ.rows[0].count),
  };
}

async function checkerJobs(req, res) {
  const userId = req.session.user.id;
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ura.project_id AS job_no, p.name AS job_name
       FROM user_role_assignments ura
       LEFT JOIN projects p ON p.id = ura.project_id
       WHERE ura.user_id = $1 AND ura.role LIKE '%Checker'
       ORDER BY ura.project_id`,
      [userId]
    );
    res.json({ ok: true, jobs: rows.map(r => ({ jobNo: r.job_no, jobName: r.job_name })) });
  } catch (err) {
    console.error('checkerJobs error:', err);
    res.status(500).json({ ok: false, message: 'Failed to load jobs.' });
  }
}

async function checkerSummary(req, res) {
  const userId = req.session.user.id;
  const date  = isValidDate(req.query.date) ? req.query.date : null;
  const jobNo = req.query.job || 'ALL';

  try {
    if (jobNo === 'ALL') {
      const { rows: jobRows } = await pool.query(
        `SELECT DISTINCT project_id AS job_no FROM user_role_assignments
         WHERE user_id = $1 AND role LIKE '%Checker' ORDER BY project_id`,
        [userId]
      );
      const jobNos = jobRows.map(r => r.job_no);
      const perJob = await Promise.all(jobNos.map(jn => computeCheckerJobStats(userId, jn, date)));

      const totals = perJob.reduce((acc, j) => ({
        commentsGivenToday: acc.commentsGivenToday + j.commentsGivenToday,
        noCommentsToday:    acc.noCommentsToday + j.noCommentsToday,
        totalReviewedToday: acc.totalReviewedToday + j.totalReviewedToday,
        glReadyToday:       acc.glReadyToday + j.glReadyToday,
        openClaims:         acc.openClaims + j.openClaims,
        stressCriticalOpen: acc.stressCriticalOpen + j.stressCriticalOpen,
      }), { commentsGivenToday: 0, noCommentsToday: 0, totalReviewedToday: 0, glReadyToday: 0, openClaims: 0, stressCriticalOpen: 0 });

      res.json({ ok: true, date: date || 'today', jobNo: 'ALL', totals, perJob });
    } else {
      const stats = await computeCheckerJobStats(userId, jobNo, date);
      const { rows: revisions } = await pool.query(
        `SELECT dc.rev_no,
                COUNT(*) FILTER (WHERE 'PC' = ANY(dc.roles)) AS pc_count,
                COUNT(*) FILTER (WHERE 'MC' = ANY(dc.roles)) AS mc_count,
                COUNT(*) FILTER (WHERE 'SC' = ANY(dc.roles)) AS sc_count
         FROM drawing_comments dc
         JOIN drawings d ON d.id = dc.drawing_id
         WHERE dc.user_id = $1 AND d.job_no = $2 AND dc.type != 'none'
           AND dc.roles && ARRAY['PC','MC','SC']::text[]
           AND DATE(dc.created_at) = COALESCE($3::date, CURRENT_DATE)
         GROUP BY dc.rev_no
         ORDER BY dc.rev_no`,
        [userId, jobNo, date]
      );

      res.json({
        ok: true,
        date: date || 'today',
        ...stats,
        revisions: revisions.map(r => ({
          revNo:   r.rev_no,
          pcCount: parseInt(r.pc_count),
          mcCount: parseInt(r.mc_count),
          scCount: parseInt(r.sc_count),
        })),
      });
    }
  } catch (err) {
    console.error('checkerSummary error:', err);
    res.status(500).json({ ok: false, message: 'Failed to load summary.' });
  }
}

module.exports = { roleSummary, modellerJobs, modellerSummary, checkerJobs, checkerSummary };
