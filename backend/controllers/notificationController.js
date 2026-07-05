const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const { pool } = require("../db/pool");
const drawingQ = require("../db/queries/drawingQueries");
const userQ = require("../db/queries/userQueries");
const s3dExportQ = require("../db/queries/s3dExportQueries");
const sse = require("../utils/sse");

const UPLOADS_ROOT = path.join(__dirname, "..", "uploads");

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function extractUploadCount(f) { const m = (f || "").match(/_R\d+-(\d+)\.pdf$/); return m ? parseInt(m[1]) : 1; }

// ── Live notification helpers ──────────────────────────────────────────────

// Ensure table exists on startup
pool.query(`
  CREATE TABLE IF NOT EXISTS live_notifications (
    id          SERIAL PRIMARY KEY,
    user_id     VARCHAR(50) NOT NULL,
    drawing_id  INTEGER,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL,
    type        VARCHAR(50) DEFAULT 'task',
    is_read     BOOLEAN DEFAULT FALSE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_ln_user ON live_notifications(user_id, is_read);
`).catch(console.error);

// Add checker_reroute column if not exists — stores PC/MC claimant snapshot so
// modellerResubmit can restore their claims even when drawing_claims is overwritten
// by the Modeller role upsert (happens when checker and modeller are the same user).
pool.query(`ALTER TABLE drawings ADD COLUMN IF NOT EXISTS checker_reroute JSONB DEFAULT '[]';`)
  .catch(console.error);

pool.query(`
  ALTER TABLE drawing_comments ADD COLUMN IF NOT EXISTS hold_type        VARCHAR(10) DEFAULT NULL;
  ALTER TABLE drawing_comments ADD COLUMN IF NOT EXISTS hold_description TEXT        DEFAULT NULL;
  ALTER TABLE drawing_comments ADD COLUMN IF NOT EXISTS cycle_no         INTEGER     DEFAULT NULL;
  ALTER TABLE drawing_comments ADD COLUMN IF NOT EXISTS rev_no           INTEGER     DEFAULT NULL;
`).catch(console.error);

// One-time backfill: rev_no didn't exist when older comments were written, so
// they're all NULL. cycle_no alone can't disambiguate revisions — it resets to
// 1 for every new revision, so a comment from R0's cycle 1 and R1's cycle 1
// are otherwise indistinguishable by cycle_no, which is exactly the bug this
// column exists to close (drawing_comments queries scoped by cycle_no alone
// could match a same-numbered cycle from a PAST revision). Backfill by
// bucketing each comment's created_at against the upload timestamps in
// drawing_history, same approach as getRevisionHistory. Idempotent — only
// touches rows still NULL, so it's a no-op after the first run.
async function backfillCommentRevNos() {
  try {
    const { rows: drawingsWithComments } = await pool.query(
      `SELECT DISTINCT drawing_id FROM drawing_comments WHERE rev_no IS NULL`
    );
    for (const { drawing_id } of drawingsWithComments) {
      const { rows: history } = await pool.query(
        `SELECT file_name, created_at FROM drawing_history WHERE drawing_id=$1 ORDER BY created_at`,
        [drawing_id]
      );
      const revStarts = []; // [{ revNo, startAt }], ascending by startAt
      for (const h of history) {
        const m = h.file_name.match(/_R(\d+)-\d+\.pdf$/i);
        if (!m) continue;
        const revNo = parseInt(m[1], 10);
        if (!revStarts.some(r => r.revNo === revNo)) revStarts.push({ revNo, startAt: h.created_at });
      }
      if (revStarts.length === 0) continue;
      revStarts.sort((a, b) => new Date(a.startAt) - new Date(b.startAt));

      const { rows: comments } = await pool.query(
        `SELECT id, created_at FROM drawing_comments WHERE drawing_id=$1 AND rev_no IS NULL`,
        [drawing_id]
      );
      for (const c of comments) {
        const t = new Date(c.created_at).getTime();
        // Last revision whose start is <= this comment's time; if the comment
        // predates the earliest known upload, fall back to the earliest revision.
        let match = revStarts[0].revNo;
        for (const r of revStarts) {
          if (new Date(r.startAt).getTime() <= t) match = r.revNo;
        }
        await pool.query(`UPDATE drawing_comments SET rev_no=$1 WHERE id=$2`, [match, c.id]);
      }
    }
  } catch (e) {
    console.error('[backfillCommentRevNos] error:', e.message);
  }
}
setTimeout(backfillCommentRevNos, 2000); // let the ALTER TABLE above land first

// Records which modeller (if any) each checker picked this cycle, so a later
// checker's submission can warn if their own pick — or the no-pick default —
// diverges from what an earlier-completed checker already chose.
pool.query(`ALTER TABLE drawing_claims ADD COLUMN IF NOT EXISTS target_modeller_id VARCHAR(50) DEFAULT NULL;`)
  .catch(console.error);

async function pushNotification(userId, drawingId, title, body, type = 'task') {
  try {
    const { rows } = await pool.query(
      `INSERT INTO live_notifications (user_id, drawing_id, title, body, type) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [userId, drawingId, title, body, type]
    );
    sse.emitToUser(userId, 'notification', rows[0]);
  } catch (e) { console.error('pushNotification error:', e.message); }
}

async function pushToRoleUsers(jobNo, unitNo, role, drawingId, title, body, type = 'pool') {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT u.id FROM users u
       JOIN user_role_assignments ura ON ura.user_id = u.id
       WHERE ura.project_id = $1 AND ura.unit_no = $2 AND ura.role = $3`,
      [jobNo, unitNo, role]
    );
    await Promise.all(rows.map(r => pushNotification(r.id, drawingId, title, body, type)));
  } catch (e) { console.error('pushToRoleUsers error:', e.message); }
}

// GET /api/notif/stream — SSE endpoint
async function sseStream(req, res) {
  const userId = req.session.user.id;
  console.log(`[SSE] Client connected: userId=${userId}`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  sse.addClient(userId, res);

  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM live_notifications WHERE user_id=$1 AND is_read=FALSE`,
      [userId]
    );
    const unread = rows[0].cnt;
    console.log(`[SSE] Init for ${userId}: ${unread} unread`);
    res.write(`event: init\ndata: ${JSON.stringify({ unread })}\n\n`);
  } catch (e) { console.error('[SSE] init query error:', e.message); }

  const hb = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(hb); }
  }, 25000);

  req.on('close', () => {
    clearInterval(hb);
    sse.removeClient(userId, res);
    console.log(`[SSE] Client disconnected: userId=${userId}`);
  });
}

// GET /api/notif
async function getNotifList(req, res) {
  const userId = req.session.user.id;
  try {
    const { rows } = await pool.query(
      `SELECT n.*, d.line_no, d.job_no, d.unit_no
       FROM live_notifications n
       LEFT JOIN drawings d ON d.id = n.drawing_id
       WHERE n.user_id = $1
       ORDER BY n.created_at DESC LIMIT 50`,
      [userId]
    );
    res.json({ ok: true, notifications: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
}

// PUT /api/notif/read-all
async function markAllRead(req, res) {
  const userId = req.session.user.id;
  try {
    await pool.query(`UPDATE live_notifications SET is_read=TRUE WHERE user_id=$1 AND is_read=FALSE`, [userId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
}

// PUT /api/notif/:id/read
async function markOneRead(req, res) {
  const userId = req.session.user.id;
  const id = parseInt(req.params.id);
  try {
    await pool.query(`UPDATE live_notifications SET is_read=TRUE WHERE id=$1 AND user_id=$2`, [id, userId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
}

function extractClaimedRoles(claims) {
  return [...new Set(claims.flatMap((c) => c.roles || []))];
}

function uploadCountOf(storedFile) {
  const m = (storedFile || "").match(/_R\d+-(\d+)\.pdf$/);
  return m ? parseInt(m[1], 10) : 1;
}

// Build dynamic "Comments Received from PC, MC" status based on which roles submitted comments
async function buildCommentsReceivedStatus(drawingId) {
  const { rows } = await pool.query(
    `SELECT roles FROM drawing_claims
     WHERE drawing_id=$1 AND comment_type IS NOT NULL AND comment_type != 'none'
       AND completed_at IS NOT NULL`,
    [drawingId]
  );
  const seen = new Set();
  rows.forEach(r => (r.roles || []).filter(x => ['PC','MC','SC'].includes(x)).forEach(x => seen.add(x)));
  const ordered = ['PC','MC','SC'].filter(r => seen.has(r));
  return ordered.length ? `Comments Received from ${ordered.join(', ')}` : 'Comments Received';
}

// Check if a drawing should show in checker notifications
function shouldShowToChecker(drawing, userRoles, claimedRoles) {
  const roleMap = { "Process Checker": "PC", "Material Checker": "MC", "Stress Checker": "SC" };
  const checkerCodes = userRoles.map((r) => roleMap[r]).filter(Boolean);

  const stressCritical = drawing.stress_critical === "Y";
  const blockingStatuses = ["Ready for GL", "Ready for SGL",
    "GL Commented", "SGL Commented", "Superseded", "Ready for EDMS", "Final",
    "Checker Hold", "GL Hold", "SGL Hold"];
  if (blockingStatuses.includes(drawing.status) || drawing.status?.startsWith('Comments Received')) return false;
  if (drawing.notify_gl || drawing.notify_modeller) return false;
  if (claimedRoles.some((r) => ["GL", "SGL", "Modeller"].includes(r))) return false;

  // Stress-critical lines hide SC by default; 'Sent for Supporting Check' opens SC
  // eligibility ADDITIVELY on top of the normal PC/MC roles — not as a replacement —
  // so PC/MC stay independently claimable in parallel (e.g. MC hasn't closed yet
  // when PC marks the line good-for-supporting / no-comments).
  const baseRoles = stressCritical ? ["PC", "MC"] : ["PC", "MC", "SC"];
  const roles = drawing.status === "Sent for Supporting Check"
    ? [...new Set([...baseRoles, "SC"])]
    : baseRoles;

  const available = roles.filter((r) => checkerCodes.includes(r) && !claimedRoles.includes(r));
  return available.length > 0;
}

// GET /api/notifications  (checker pool — unclaimed drawing cards)
async function getNotifications(req, res) {
  const userId = req.session.user.id;
  try {
    const roleRows = await userQ.getRoleAssignments(userId);
    const notifications = [];

    const projectUnits = {};
    for (const r of roleRows) {
      if (!projectUnits[r.project_id]) projectUnits[r.project_id] = new Set();
      projectUnits[r.project_id].add(r.unit_no);
    }

    for (const [projectId, units] of Object.entries(projectUnits)) {
      for (const unitNo of units) {
        const userRoles = roleRows.filter((r) => r.project_id === projectId && r.unit_no === unitNo).map((r) => r.role);
        const hasChecker = userRoles.some((r) => ["Process Checker", "Material Checker", "Stress Checker"].includes(r));
        if (!hasChecker) continue;

        const { rows: drawings } = await pool.query(
          `SELECT d.*,
             array_agg(DISTINCT r) FILTER (WHERE r IS NOT NULL) AS all_claim_roles,
             (SELECT l.lot_number FROM lot_lines ll JOIN lots l ON l.id = ll.lot_id
              WHERE ll.drawing_id = d.id AND l.issued_at IS NULL LIMIT 1) AS planned_lot_number
           FROM drawings d
           LEFT JOIN drawing_claims dc ON dc.drawing_id = d.id
           LEFT JOIN LATERAL unnest(dc.roles) AS r ON TRUE
           WHERE d.job_no=$1 AND d.unit_no=$2
           GROUP BY d.id ORDER BY d.uploaded_on DESC`,
          [projectId, unitNo]
        );

        // NOTE: previously also skipped drawings where the user had ANY open claim
        // on them (`claimed_by_me`), regardless of role. That hid still-open roles
        // (e.g. SC) on a line where this same multi-role user already claimed PC/MC.
        // shouldShowToChecker() below is already role-aware via claimedRoles, so the
        // drawing-level skip was both redundant and wrong for multi-role checkers.
        for (const d of drawings) {
          const claimedRoles = (d.all_claim_roles || []).flat().filter(Boolean);
          if (shouldShowToChecker(d, userRoles, claimedRoles)) {
            notifications.push({
              select: false, jobNo: d.job_no, unitNo: d.unit_no, lineNo: d.line_no,
              zone: d.zone, revNo: `R${d.rev_no || 0}`,
              uploadCount: uploadCountOf(d.stored_file),
              stressCritical: d.stress_critical || "N",
              from: d.uploaded_by || "System", status: d.status,
              uploadedOn: d.uploaded_on, userRoles, claimedRoles,
              scTagged: d.sc_tagged || false, drawingId: d.line_no,
              plannedLotNumber: d.planned_lot_number || null,
            });
          }
        }
      }
    }
    res.json({ ok: true, notifications });
  } catch (err) {
    console.error("getNotifications error:", err);
    res.json({ ok: false, notifications: [] });
  }
}

// GET /api/notifications-by-role?role=&project=&unit=
async function getNotificationsByRole(req, res) {
  const { role, project, unit } = req.query;
  const userId = req.session.user.id;
  if (!role || !project || !unit)
    return res.status(400).json({ ok: false, error: "role, project, unit required" });

  try {
    const statusMap = {
      GL: "Ready for GL", SGL: "Ready for SGL", Modeller: "Comments Received%",
    };
    const targetStatus = statusMap[role];

    if (targetStatus) {
      // GL / SGL / Modeller path
      const extraCondition =
        role === "GL"       ? "OR d.notify_gl=TRUE" :
        role === "Modeller" ? "OR d.notify_modeller=TRUE" : "";

      // For GL/SGL/Modeller pool: hide lines already claimed/directly assigned
      // to someone in this role (e.g. routed straight to a previous reviewer's
      // inbox instead of broadcast, or already claimed by another modeller from
      // the pool). Makes a Modeller claim exclusive the same way GL/SGL already
      // are — and since unclaiming just deletes that same claim row, this one
      // condition is also what makes the line reappear for everyone else the
      // moment it's unclaimed, with no separate "release" step needed.
      const directClaimExclusion = (role === "GL" || role === "SGL" || role === "Modeller")
        ? `AND NOT EXISTS (
             SELECT 1 FROM drawing_claims dc2
             WHERE dc2.drawing_id=d.id AND $2=ANY(dc2.roles) AND dc2.completed_at IS NULL
           )`
        : "";

      // Modeller uses LIKE to match "Comments Received from PC" etc; GL/SGL use exact match
      const statusClause = role === "Modeller" ? `d.status LIKE $3` : `d.status=$3`;

      const { rows } = await pool.query(
        `SELECT d.*,
                (SELECT l.lot_number FROM lot_lines ll JOIN lots l ON l.id = ll.lot_id
                 WHERE ll.drawing_id = d.id AND l.issued_at IS NULL LIMIT 1) AS planned_lot_number
         FROM drawings d
         JOIN user_role_assignments ura ON ura.project_id=d.job_no AND ura.unit_no=d.unit_no
           AND ura.user_id=$1 AND ura.role=$2
         WHERE (${statusClause} ${extraCondition})
           AND NOT EXISTS (
             SELECT 1 FROM drawing_claims dc
             WHERE dc.drawing_id=d.id AND dc.user_id=$1 AND dc.completed_at IS NULL
           )
           ${directClaimExclusion}
         ORDER BY d.uploaded_on DESC`,
        [userId, role, targetStatus]
      );

      const notifications = [];
      for (const d of rows) {
        let noCommentsFrom = [];
        if (role === "GL") {
          const { rows: claims } = await pool.query(
            `SELECT dc.roles, u.name
             FROM drawing_claims dc
             JOIN users u ON u.id = dc.user_id
             WHERE dc.drawing_id = $1 AND dc.comment_type = 'none' AND dc.completed_at IS NOT NULL`,
            [d.id]
          );
          noCommentsFrom = claims.map((c) => {
            const roleLabels = { PC: "PC", MC: "MC", SC: "SC" };
            const shortRoles = (c.roles || []).map(r => roleLabels[r] || r).join("+");
            return `${c.name} (${shortRoles})`;
          });
        }
        notifications.push({
          select: false, jobNo: d.job_no, unitNo: d.unit_no, lineNo: d.line_no,
          zone: d.zone, revNo: `R${d.rev_no || 0}`,
          uploadCount: uploadCountOf(d.stored_file),
          stressCritical: d.stress_critical || "N",
          from: d.uploaded_by || "System", status: d.status,
          uploadedOn: d.uploaded_on, drawingId: d.line_no,
          noCommentsFrom,
          uploadType: d.upload_type || null,
          plannedLotNumber: d.planned_lot_number || null,
          tags: d.tags || [],
        });
      }
      return res.json({ ok: true, notifications });
    }

    // Checker path
    const userRoles = await userQ.getRolesForUnit(userId, project, unit);
    const { rows: drawings } = await pool.query(
      `SELECT d.*,
         array_agg(DISTINCT r) FILTER (WHERE r IS NOT NULL) AS all_claim_roles,
         (SELECT l.lot_number FROM lot_lines ll JOIN lots l ON l.id = ll.lot_id
          WHERE ll.drawing_id = d.id AND l.issued_at IS NULL LIMIT 1) AS planned_lot_number
       FROM drawings d
       LEFT JOIN drawing_claims dc ON dc.drawing_id = d.id
       LEFT JOIN LATERAL unnest(dc.roles) AS r ON TRUE
       WHERE d.job_no=$1 AND d.unit_no=$2
       GROUP BY d.id ORDER BY d.uploaded_on DESC`,
      [project, unit]
    );
    const notifications = [];
    for (const d of drawings) {
      const claimedRoles = (d.all_claim_roles || []).flat().filter(Boolean);
      if (shouldShowToChecker(d, userRoles, claimedRoles)) {
        notifications.push({
          select: false, jobNo: d.job_no, unitNo: d.unit_no, lineNo: d.line_no,
          zone: d.zone, revNo: `R${d.rev_no || 0}`,
          uploadCount: uploadCountOf(d.stored_file),
          stressCritical: d.stress_critical || "N",
          from: d.uploaded_by || "System", status: d.status,
          uploadedOn: d.uploaded_on, userRoles, claimedRoles,
          scTagged: d.sc_tagged || false, drawingId: d.line_no,
          plannedLotNumber: d.planned_lot_number || null,
          tags: d.tags || [],
        });
      }
    }
    res.json({ ok: true, notifications });
  } catch (err) {
    console.error("getNotificationsByRole error:", err);
    res.json({ ok: false, notifications: [] });
  }
}

// POST /api/claim-notifications
async function claimNotifications(req, res) {
  const { claims } = req.body || {};
  const userId = req.session.user.id;
  if (!Array.isArray(claims)) return res.status(400).json({ ok: false, error: "claims[] required" });

  try {
    for (const claim of claims) {
      const { lineNo, roles, jobNo, unitNo } = claim;
      const { rows } = await pool.query(
        `SELECT id FROM drawings WHERE job_no=$1 AND unit_no=$2 AND line_no=$3`,
        [jobNo, unitNo, lineNo]
      );
      if (!rows[0]) continue;
      // GL/SGL claims use the additive upsert so completed checker records are preserved
      const isGLClaim = (roles || []).some(r => r === 'GL' || r === 'SGL');
      if (isGLClaim) {
        await drawingQ.upsertGLClaim(rows[0].id, userId, roles);
      } else {
        await drawingQ.upsertClaim(rows[0].id, userId, roles);
      }
    }
    res.json({ ok: true, message: `${claims.length} line(s) claimed` });
  } catch (err) {
    console.error("claimNotifications error:", err);
    res.status(500).json({ ok: false, error: "Failed to claim" });
  }
}

// GET /api/my-claimed-tasks
async function getClaimedTasks(req, res) {
  const userId = req.session.user.id;
  try {
    const tasks = await drawingQ.getClaimedTasks(userId);
    res.json({
      ok: true,
      tasks: tasks.filter((d) => !["Superseded"].includes(d.status)).map((d) => ({
        jobNo: d.job_no, unitNo: d.unit_no, lineNo: d.line_no, zone: d.zone,
        revNo: `R${d.rev_no || 0}`, uploadCount: uploadCountOf(d.stored_file),
        stressCritical: d.stress_critical || "N", from: d.uploaded_by || "System",
        status: d.status, claimedOn: d.claimed_at, claimedRoles: d.claimed_roles || [],
        assignedBy: d.delegated_by_role || null,
        plannedLotNumber: d.planned_lot_number || null,
        tags: d.tags || [],
      })),
    });
  } catch (err) {
    console.error("getClaimedTasks error:", err);
    res.json({ ok: false, tasks: [] });
  }
}

// GET /api/my-modeller-tasks
async function getModellerTasks(req, res) {
  const userId = req.session.user.id;
  try {
    const tasks = await drawingQ.getModellerTasks(userId);
    res.json({
      ok: true,
      tasks: tasks.map((d) => ({
        jobNo: d.job_no, unitNo: d.unit_no, lineNo: d.line_no, zone: d.zone,
        revNo: `R${d.rev_no || 0}`, uploadCount: uploadCountOf(d.stored_file),
        stressCritical: d.stress_critical || "N", status: d.status,
        uploadedOn: d.uploaded_on,
      })),
    });
  } catch (err) {
    console.error("getModellerTasks error:", err);
    res.json({ ok: false, tasks: [] });
  }
}

// GET /api/my-gl-tasks
async function getGLTasks(req, res) {
  const userId = req.session.user.id;
  try {
    const tasks = await drawingQ.getGLTasks(userId);
    res.json({ ok: true, tasks });
  } catch (err) {
    res.json({ ok: false, tasks: [] });
  }
}

// GET /api/my-all-tasks
async function getAllTasks(req, res) {
  const userId = req.session.user.id;
  try {
    const tasks = await drawingQ.getAllTasks(userId);
    res.json({ ok: true, tasks });
  } catch (err) {
    res.json({ ok: false, tasks: [] });
  }
}

// GET /api/my-final-isometrics — Final drawings for GL user
async function getGLFinalIsometrics(req, res) {
  const userId = req.session.user.id;
  try {
    const { rows } = await pool.query(
      `SELECT d.*
       FROM drawings d
       WHERE d.status = 'Final'
         AND NOT EXISTS (
           -- Only treat as "already issued" if the issued snapshot is THIS
           -- exact revision/upload. drawing_id alone isn't enough — a line
           -- re-uploaded after being issued (Final+issued allows a new
           -- revision) keeps the same drawing_id, but the new revision was
           -- never actually issued, so it must reappear here.
           SELECT 1 FROM lot_lines ll
           JOIN lots l ON l.id = ll.lot_id
           WHERE ll.drawing_id = d.id AND l.issued_at IS NOT NULL
             AND ll.file_path = 'uploads/' || d.job_no || '/' || d.unit_no || '/' || d.zone || '/' || d.stored_file
         )
         AND (
           EXISTS (
             SELECT 1 FROM user_role_assignments ura
             WHERE ura.project_id = d.job_no
               AND ura.unit_no    = d.unit_no
               AND ura.user_id    = $1
               AND ura.role       = 'GL'
           )
           OR EXISTS (
             SELECT 1 FROM drawing_claims dc
             WHERE dc.drawing_id   = d.id
               AND dc.user_id      = $1
               AND 'GL' = ANY(dc.roles)
               AND dc.completed_at IS NOT NULL
           )
         )
       ORDER BY d.uploaded_on DESC`,
      [userId]
    );
    res.json({ ok: true, tasks: rows });
  } catch (err) {
    console.error("getGLFinalIsometrics error:", err);
    res.json({ ok: false, tasks: [] });
  }
}

// GET /api/drawing-claimers?jobNo=&unitNo=&lineNo=
async function getDrawingClaimers(req, res) {
  const { jobNo, unitNo, lineNo } = req.query;
  if (!jobNo || !unitNo || !lineNo) return res.json({ ok: false, error: "Missing params" });
  try {
    const claimers = await drawingQ.getDrawingClaimers(jobNo, unitNo, lineNo);
    const claimedBy = {};
    for (const c of claimers) claimedBy[c.user_id] = { roles: c.roles, name: c.name };
    res.json({ ok: true, claimedBy });
  } catch (err) {
    res.json({ ok: false, claimedBy: {} });
  }
}

// POST /api/forward-iso-lines
// assignments: [{ type: 'specific', userId, roles } | { type: 'pool', roles }]
async function forwardIsoLines(req, res) {
  const { lines, assignments = [] } = req.body;
  const userId = req.session.user.id;
  const processedLines = [];
  const skippedLines = [];

  try {
    for (const line of (lines || [])) {
      const { rows } = await pool.query(
        `SELECT id FROM drawings WHERE job_no=$1 AND unit_no=$2 AND line_no=$3`,
        [line.project, line.unit, line.lineNo]
      );
      if (!rows[0]) continue;
      const drawingId = rows[0].id;

      // Refuse to touch a line already issued in a lot — resetting it to a fresh
      // checker cycle would silently contradict its issued/Final state, since
      // nothing else in the system reconciles "issued in Lot N" against "back in
      // active checker review." The UI already disables selecting these rows;
      // this is the server-side backstop in case that's ever bypassed.
      // Same revision-aware check as getGLFinalIsometrics: only count it as
      // issued if the snapshot matches the CURRENT file, not a past revision.
      const { rows: issuedRows } = await pool.query(
        `SELECT l.lot_number FROM lot_lines ll
         JOIN lots l ON l.id = ll.lot_id
         JOIN drawings d ON d.id = ll.drawing_id
         WHERE ll.drawing_id=$1 AND l.issued_at IS NOT NULL
           AND ll.file_path = 'uploads/' || d.job_no || '/' || d.unit_no || '/' || d.zone || '/' || d.stored_file
         ORDER BY l.issued_at DESC LIMIT 1`,
        [drawingId]
      );
      if (issuedRows[0]) {
        skippedLines.push({ lineNo: line.lineNo, reason: `Already issued in Lot ${issuedRows[0].lot_number}` });
        continue;
      }

      // 1. Clear all existing PC/MC/SC claims — fresh start
      await pool.query(
        `DELETE FROM drawing_claims WHERE drawing_id=$1 AND roles && ARRAY['PC','MC','SC']::text[]`,
        [drawingId]
      );

      // 2. Reset drawing to fresh checker state
      await pool.query(
        `UPDATE drawings SET status='Uploaded', notify_gl=FALSE, notify_modeller=FALSE,
         all_roles_claimed=FALSE, checker_reroute='[]',
         delegated_by_user=$2, delegated_by_role='GL/SGL', delegated_at=NOW()
         WHERE id=$1`,
        [drawingId, userId]
      );

      // 3. Create specific claims (merge same user's roles into one row)
      const mergedMap = {};
      for (const a of assignments.filter(a => a.type === 'specific')) {
        if (!a.userId || !Array.isArray(a.roles) || !a.roles.length) continue;
        if (!mergedMap[a.userId]) mergedMap[a.userId] = [];
        for (const r of a.roles) {
          if (!mergedMap[a.userId].includes(r)) mergedMap[a.userId].push(r);
        }
      }
      for (const [uid, roles] of Object.entries(mergedMap)) {
        await drawingQ.upsertClaim(drawingId, uid, roles);
      }

      processedLines.push({ ...line, drawingId });
    }

    // 4. Notify specific assignees once (not per line)
    const notifMap = {};
    for (const a of assignments.filter(a => a.type === 'specific')) {
      if (!a.userId) continue;
      if (!notifMap[a.userId]) notifMap[a.userId] = [];
      for (const r of a.roles || []) {
        if (!notifMap[a.userId].includes(r)) notifMap[a.userId].push(r);
      }
    }
    for (const [uid, roles] of Object.entries(notifMap)) {
      await pushNotification(uid, null,
        'Lines Assigned to You',
        `${processedLines.length} line(s) assigned to you for ${roles.join(', ')} review by GL/SGL.`);
    }

    // 5. Pool notifications — one push per role per line
    const poolAssignments = assignments.filter(a => a.type === 'pool');
    const roleNameMap = { PC: 'Process Checker', MC: 'Material Checker', SC: 'Stress Checker' };
    for (const pl of processedLines) {
      for (const a of poolAssignments) {
        for (const role of (a.roles || [])) {
          const roleName = roleNameMap[role];
          if (!roleName) continue;
          await pushToRoleUsers(pl.project, pl.unit, roleName, pl.drawingId,
            'Line Available for Review',
            `Line ${pl.lineNo} (${pl.project}/${pl.unit}) is available for ${role} review.`);
        }
      }
    }

    const skipMsg = skippedLines.length
      ? `; skipped ${skippedLines.length} line(s) already issued (${skippedLines.map(s => `${s.lineNo}: ${s.reason}`).join(', ')})`
      : '';
    res.json({ ok: true, message: `Assigned ${processedLines.length} line(s)${skipMsg}`, skippedLines });
  } catch (err) {
    console.error("forwardIsoLines error:", err);
    res.json({ ok: false, error: "Failed to assign checkers" });
  }
}

// GET /api/sc-users?jobNo=X&unitNo=Y
async function getScUsers(req, res) {
  const { jobNo, unitNo } = req.query;
  if (!jobNo || !unitNo) return res.status(400).json({ ok: false, error: "jobNo and unitNo required" });
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name FROM users u
       JOIN user_role_assignments ura ON ura.user_id = u.id
       WHERE ura.project_id = $1 AND ura.unit_no = $2 AND ura.role = 'Stress Checker'
       ORDER BY u.name`,
      [jobNo, unitNo]
    );
    res.json({ ok: true, users: rows });
  } catch (err) {
    console.error("getScUsers error:", err);
    res.status(500).json({ ok: false, error: "Failed" });
  }
}

// GET /api/modellers?jobNo=X&unitNo=Y
async function getModellerUsers(req, res) {
  const { jobNo, unitNo } = req.query;
  if (!jobNo || !unitNo) return res.status(400).json({ ok: false, error: "jobNo and unitNo required" });
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name FROM users u
       JOIN user_role_assignments ura ON ura.user_id = u.id
       WHERE ura.project_id = $1 AND ura.unit_no = $2 AND ura.role = 'Modeller'
       ORDER BY u.name`,
      [jobNo, unitNo]
    );
    res.json({ ok: true, users: rows });
  } catch (err) {
    console.error("getModellerUsers error:", err);
    res.status(500).json({ ok: false, error: "Failed" });
  }
}

// POST /api/send-for-supporting
async function sendForSupporting(req, res) {
  const { jobNo, unitNo, lineNo, assignedScUserId } = req.body;
  const userId = req.session.user.id;
  if (!jobNo || !unitNo || !lineNo) return res.status(400).json({ ok: false, error: "Missing fields" });

  try {
    const { rows } = await pool.query(
      `SELECT id, rev_no FROM drawings WHERE job_no=$1 AND unit_no=$2 AND line_no=$3`,
      [jobNo, unitNo, lineNo]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "Drawing not found" });
    const drawingId = rows[0].id;
    const revNo = rows[0].rev_no;

    // PC's own claim stays active — PC still reviews in parallel with SC.
    // Only update the drawing status so SC can see/claim the line.
    await pool.query(
      `UPDATE drawings SET status='Sent for Supporting Check' WHERE id=$1`,
      [drawingId]
    );

    if (assignedScUserId) {
      // Specific SC selected → always direct to their inbox regardless of cycle
      await drawingQ.upsertClaim(drawingId, assignedScUserId, ["SC"]);
      await pushNotification(assignedScUserId, drawingId,
        'Supporting Check Assigned',
        `Line ${lineNo} (${jobNo}/${unitNo}) has been sent directly to you for supporting check.`);
      res.json({ ok: true, message: "Sent directly to SC engineer" });
    } else {
      // No specific SC — check if SC has reviewed THIS REVISION before. Exclude
      // the caller themselves: if the PC invoking this is also a previous SC
      // reviewer, auto-assigning SC back to them would upsertClaim onto their
      // own current row — safe today since this path never completes the
      // caller's own claim first, but excluding self keeps this consistent
      // with the other previous-reviewer lookups below, which do.
      // Scoped to rev_no=current revision — a line's 2nd+ CYCLE within the
      // same revision routes directly to the previous holder, but a brand
      // new revision's 1st cycle must behave like the very first time (pool),
      // even if a past revision was reviewed by someone. Without this, SC
      // would be auto-assigned to whoever reviewed an OLDER revision forever,
      // and a new revision's first cycle would never reach the open pool.
      const { rows: prevSC } = await pool.query(
        `SELECT DISTINCT user_id FROM drawing_comments WHERE drawing_id=$1 AND 'SC'=ANY(roles) AND user_id != $2 AND rev_no=$3`,
        [drawingId, userId, revNo]
      );
      if (prevSC.length > 0) {
        // 2nd+ cycle this revision: SC has been involved before → direct to previous SC inbox
        for (const sc of prevSC) {
          await drawingQ.upsertClaim(drawingId, sc.user_id, ['SC']);
          await pushNotification(sc.user_id, drawingId,
            'Good for Supporting — Stress Check Required',
            `Line ${lineNo} (${jobNo}/${unitNo}) has been sent to you for supporting check.`);
        }
        res.json({ ok: true, message: "Sent directly to previous SC engineer(s)" });
      } else {
        // 1st time: SC pool — notify all SC engineers, they claim voluntarily
        await pushToRoleUsers(jobNo, unitNo, 'Stress Checker', drawingId,
          'Line Available for Stress Check',
          `Line ${lineNo} (${jobNo}/${unitNo}) has been marked good for supporting and is available for stress check.`);
        res.json({ ok: true, message: "Sent to SC pool" });
      }
    }
  } catch (err) {
    console.error("sendForSupporting error:", err);
    res.status(500).json({ ok: false, error: "Failed" });
  }
}

// Helper: handle GL/SGL comment file creation
async function saveApproverCommentFile(jobNo, unitNo, zone, lineNo, revNo, uploadCount, suffix, drawing, userId, reqFile, commentType, fspRef) {
  const baseFileName = `${lineNo}_R${revNo}-${uploadCount}`;
  const commentFileName = `${baseFileName}_${suffix}.pdf`;
  const commentsDir = path.join(UPLOADS_ROOT, jobNo, unitNo, zone, "comments");
  ensureDir(commentsDir);
  const finalPath = path.join(commentsDir, commentFileName);

  if (commentType === "file" && reqFile) {
    await fspRef.rename(reqFile.path, finalPath);
  } else if (commentType === "annotation") {
    const tempPath = path.join(UPLOADS_ROOT, jobNo, unitNo, zone, `${baseFileName}_temp.pdf`);
    if (fs.existsSync(tempPath)) await fspRef.rename(tempPath, finalPath);
  } else {
    // text or none: copy base file
    const basePath = path.join(UPLOADS_ROOT, jobNo, unitNo, zone, drawing.stored_file);
    if (fs.existsSync(basePath)) await fspRef.copyFile(basePath, finalPath);
  }

  return { commentFileName, filePath: `uploads/${jobNo}/${unitNo}/${zone}/comments/${commentFileName}` };
}

// POST /api/submit-gl-comments
async function submitGLComments(req, res) {
  // commentType: 'approve' | 'sgl' | 'text' | 'file' | 'annotation'
  const { jobNo, unitNo, lineNo, commentType } = req.body;
  const userId = req.session.user.id;
  if (!lineNo || !commentType) return res.status(400).json({ ok: false, error: "Missing fields" });

  try {
    const { rows } = await pool.query(
      `SELECT * FROM drawings WHERE job_no=$1 AND unit_no=$2 AND line_no=$3`,
      [jobNo, unitNo, lineNo]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "Drawing not found" });
    const drawing = rows[0];

    const holdType        = req.body.holdType        || null;
    const holdDescription = req.body.holdDescription || null;
    const cycleNo         = extractUploadCount(drawing.stored_file);

    // ── Approve + blocking hold is a contradiction — reject before completing claim ──
    if (commentType === "approve" && holdType === "blocking") {
      if (req.file?.path && fs.existsSync(req.file.path)) await fsp.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ ok: false, error: "Cannot approve a line with a blocking hold declared. Remove the hold or route to SGL Hold instead." });
    }

    // Complete GL's own claim
    await pool.query(
      `UPDATE drawing_claims SET completed_at=NOW(), comment_type=$2
       WHERE drawing_id=$1 AND user_id=$3 AND completed_at IS NULL`,
      [drawing.id, commentType, userId]
    );

    // ── ACTION 1: Approve → Final ──────────────────────────────────────────
    if (commentType === "approve") {
      // Always record the approval event so lot export can find approver + timestamp
      await drawingQ.addComment(drawing.id, userId, ["GL"], "approve",
        holdType ? null : "GL Approved — Final",
        null, null, null, holdType, holdDescription, cycleNo);
      await pool.query(
        `UPDATE drawings SET status='Final', notify_gl=FALSE WHERE id=$1`,
        [drawing.id]
      );
      return res.json({ ok: true, message: "Line approved and moved to Final Isometrics" });
    }

    // ── ACTION 2: Send to SGL ──────────────────────────────────────────────
    if (commentType === "sgl") {
      if (holdType === "blocking") {
        // Record the hold then park as GL Hold — do NOT route to SGL
        await drawingQ.addComment(drawing.id, userId, ["GL"], "sgl", req.body.comment || null, null, null, null, holdType, holdDescription, cycleNo);
        await pool.query(
          `UPDATE drawings SET status='GL Hold', notify_gl=FALSE WHERE id=$1`,
          [drawing.id]
        );
        const targetModellerId = drawing.uploaded_by && drawing.uploaded_by !== "SYSTEM"
          ? drawing.uploaded_by : null;
        if (targetModellerId) {
          await pushNotification(targetModellerId, drawing.id,
            "Line Held at GL — Re-upload Required",
            `Line ${lineNo} (${jobNo}/${unitNo}) has been placed on GL Hold. Please review and re-upload to restart the cycle.`);
        } else {
          await pushToRoleUsers(jobNo, unitNo, "Modeller", drawing.id,
            "Line Held at GL — Re-upload Required",
            `Line ${lineNo} (${jobNo}/${unitNo}) has been placed on GL Hold.`);
        }
        if (req.file?.path && fs.existsSync(req.file.path)) await fsp.unlink(req.file.path).catch(() => {});
        return res.json({ ok: true, message: "Line placed on GL Hold" });
      }
      // Minor hold or no hold — record if present, then route normally
      if (holdType) {
        await drawingQ.addComment(drawing.id, userId, ["GL"], "sgl", req.body.comment || null, null, null, null, holdType, holdDescription, cycleNo);
      }
      await pool.query(
        `UPDATE drawings SET status='Ready for SGL', notify_gl=FALSE WHERE id=$1`,
        [drawing.id]
      );

      // 1st cycle this revision → SGL pool; 2nd+ cycle this revision → directly
      // to the previous SGL's inbox. Reads from drawing_comments (never
      // cleared), not drawing_claims (wiped by clearAllClaims on every
      // Modeller resubmit) — same reasoning as the GL routing logic above this
      // function. Scoped to rev_no=current revision so a brand new revision's
      // first cycle opens to the pool, same as the very first revision did —
      // without this, SGL would auto-route to whoever reviewed a PAST revision
      // forever, even on a revision they've never seen.
      // Excludes the caller: this GL's own claim was already marked completed
      // earlier in this same request, so if they're also a previous SGL
      // reviewer, auto-assigning SGL back to them would overwrite that
      // completion on their single shared claims row — fall through to the
      // SGL pool for them instead.
      const { rows: prevSGL } = await pool.query(
        `SELECT DISTINCT user_id FROM drawing_comments WHERE drawing_id=$1 AND 'SGL'=ANY(roles) AND user_id != $2 AND rev_no=$3`,
        [drawing.id, userId, drawing.rev_no]
      );
      if (prevSGL.length > 0) {
        for (const sgl of prevSGL) {
          await drawingQ.upsertClaim(drawing.id, sgl.user_id, ['SGL']);
          await pushNotification(sgl.user_id, drawing.id,
            'Line Ready for SGL Review',
            `Line ${lineNo} (${jobNo}/${unitNo}) has been forwarded by GL and is ready for your SGL review.`
          );
        }
        return res.json({ ok: true, message: "Line sent directly to previous SGL's inbox" });
      }

      await pushToRoleUsers(jobNo, unitNo, 'SGL', drawing.id,
        'Line Ready for SGL Review',
        `Line ${lineNo} (${jobNo}/${unitNo}) has been forwarded by GL and is ready for SGL review.`);
      return res.json({ ok: true, message: "Line sent to SGL notification pool" });
    }

    // ── ACTION 3: Comment → back to a checker (PC/MC/SC), or direct to Modeller ──
    // Save comment file for file/annotation types
    let commentFileName = null, commentFilePath = null;
    if (commentType === "file" || commentType === "annotation") {
      const saved = await saveApproverCommentFile(
        jobNo, unitNo, drawing.zone, lineNo,
        drawing.rev_no || 0, cycleNo, "GL",
        drawing, userId, req.file, commentType, fsp
      );
      commentFileName = saved.commentFileName;
      commentFilePath = saved.filePath;
      await drawingQ.upsertCommentFile(drawing.id, commentFileName, commentFilePath, ["GL"], [userId], `gl_${commentType}`);
    }

    await drawingQ.addComment(
      drawing.id, userId, ["GL"], commentType,
      req.body.comment || null, commentFileName, commentFilePath, null,
      holdType, holdDescription, cycleNo
    );

    const routeTo = (req.body.routeTo || 'pc').toLowerCase(); // 'pc' | 'mc' | 'sc' | 'modeller'

    if (routeTo === 'modeller') {
      // ── Route directly to Modeller — bypasses the checker loop entirely.
      // No 'GL Commented' intermediate state; status goes straight to the
      // Modeller-inbox status the same way PC/SC's "Send to Modeller" does.
      const targetModellerId = req.body.targetModellerId || null;
      await routeDrawingToModeller(drawing, jobNo, unitNo, lineNo,
        'Incorporation Required — GL Comments',
        `GL has sent comments directly on line ${lineNo} (${jobNo}/${unitNo}). Please incorporate and re-upload.`,
        targetModellerId,
        'Comments Received from GL'
      );

      // S3D lock feed — line is no longer approved, revert to working.
      await s3dExportQ.markWorking({ jobNo, unitNo, zone: drawing.zone, lineNo })
        .catch(e => console.error("[S3D] markWorking error:", e.message));

      if (req.file?.path && fs.existsSync(req.file.path)) await fsp.unlink(req.file.path).catch(() => {});
      return res.json({ ok: true, message: "GL comments sent directly to Modeller" });
    }

    // Set drawing status (PC/MC/SC routes only)
    await pool.query(
      `UPDATE drawings SET status='GL Commented', notify_gl=FALSE WHERE id=$1`,
      [drawing.id]
    );

    // S3D lock feed — line is no longer approved, revert to working.
    await s3dExportQ.markWorking({ jobNo, unitNo, zone: drawing.zone, lineNo })
      .catch(e => console.error("[S3D] markWorking error:", e.message));

    if (routeTo === 'sc') {
      // ── Route to SC ──────────────────────────────────────────────────────
      // Reads drawing_comments (permanent log), not drawing_claims — a same
      // person who is also GL/SGL now gets a clean ['GL']/['SGL'] row (the
      // merge that used to keep 'SC' discoverable there was removed), so the
      // checker to reopen must be found from history instead. upsertClaim
      // safely reopens/merges their claim and clears completed_at/comment_type.
      // No self-exclusion here (unlike prevSC/prevGL/prevSGL above): GL's own
      // completion was already written to drawing_claims AND permanently
      // logged to drawing_comments earlier in this same request, so if GL is
      // also the SC being routed to, reopening their own row is correct, not
      // a collision. Scoped to rev_no=current revision — GL is only ever
      // acting on the current revision's checker cycle, so this must find
      // THIS revision's SC, not a stale one from a past revision.
      const { rows: prevSC } = await pool.query(
        `SELECT DISTINCT user_id FROM drawing_comments WHERE drawing_id=$1 AND 'SC'=ANY(roles) AND rev_no=$2`,
        [drawing.id, drawing.rev_no]
      );
      if (prevSC.length > 0) {
        for (const sc of prevSC) {
          await drawingQ.upsertClaim(drawing.id, sc.user_id, ['SC']);
          await pushNotification(sc.user_id, drawing.id,
            'GL Commented — SC Review Required',
            `GL has commented on line ${lineNo} (${jobNo}/${unitNo}). Please re-check as Stress Checker.`);
        }
      } else {
        await pushToRoleUsers(jobNo, unitNo, 'Stress Checker', drawing.id,
          'GL Commented — SC Review Required',
          `GL has commented on line ${lineNo} (${jobNo}/${unitNo}). SC review required.`);
      }
      if (req.file?.path && fs.existsSync(req.file.path)) await fsp.unlink(req.file.path).catch(() => {});
      return res.json({ ok: true, message: "GL comments sent to Stress Checker" });
    }

    if (routeTo === 'mc') {
      // ── Route to MC ──────────────────────────────────────────────────────
      // Reads drawing_comments, not drawing_claims — see SC branch above
      // (same "no self-exclusion" reasoning applies, same rev_no scoping).
      const { rows: mcClaims } = await pool.query(
        `SELECT user_id FROM drawing_comments
         WHERE drawing_id=$1 AND 'MC'=ANY(roles) AND rev_no=$2
         ORDER BY created_at DESC LIMIT 1`,
        [drawing.id, drawing.rev_no]
      );
      if (mcClaims[0]) {
        await drawingQ.upsertClaim(drawing.id, mcClaims[0].user_id, ['MC']);
        await pushNotification(mcClaims[0].user_id, drawing.id,
          'GL Commented — Review Required',
          `GL has commented on line ${lineNo} (${jobNo}/${unitNo}). Please re-check and address comments as Material Checker.`);
      }
      if (req.file?.path && fs.existsSync(req.file.path)) await fsp.unlink(req.file.path).catch(() => {});
      return res.json({ ok: true, message: "GL comments sent to Material Checker's My Tasks" });
    }

    // ── Default: route to PC ─────────────────────────────────────────────
    // Reads drawing_comments, not drawing_claims — see SC branch above
    // (same "no self-exclusion" reasoning applies, same rev_no scoping).
    const { rows: pcClaims } = await pool.query(
      `SELECT user_id FROM drawing_comments
       WHERE drawing_id=$1 AND 'PC'=ANY(roles) AND rev_no=$2
       ORDER BY created_at DESC LIMIT 1`,
      [drawing.id, drawing.rev_no]
    );
    if (pcClaims[0]) {
      await drawingQ.upsertClaim(drawing.id, pcClaims[0].user_id, ['PC']);
      await pushNotification(pcClaims[0].user_id, drawing.id,
        'GL Commented — Review Required',
        `GL has commented on line ${lineNo} (${jobNo}/${unitNo}). Please re-check and address comments.`);
    }

    if (req.file?.path && fs.existsSync(req.file.path)) await fsp.unlink(req.file.path).catch(() => {});
    res.json({ ok: true, message: "GL comments sent to Process Checker's My Tasks" });
  } catch (err) {
    console.error("submitGLComments error:", err);
    if (req.file?.path) await fsp.unlink(req.file.path).catch(() => {});
    res.status(500).json({ ok: false, error: err.message || "Failed" });
  }
}

// POST /api/declare-gl-blocking-hold
// Independent escalation action for GL — same rationale as
// declareCheckerBlockingHold: a blocking hold is not a side-effect of choosing
// "Send to SGL", it's its own action. GL has no one else to wait for (GL is a
// solo step), so this is purely a UI-consistency addition, not a latency fix —
// the existing nested "sgl + holdType=blocking" branch already parks
// immediately and is left untouched as a dormant fallback.
async function declareGLBlockingHold(req, res) {
  const { jobNo, unitNo, lineNo, holdDescription } = req.body;
  const userId = req.session.user.id;
  if (!jobNo || !unitNo || !lineNo || !holdDescription || !holdDescription.trim())
    return res.status(400).json({ ok: false, error: "jobNo, unitNo, lineNo, and a hold description are required" });

  try {
    const { rows } = await pool.query(
      `SELECT * FROM drawings WHERE job_no=$1 AND unit_no=$2 AND line_no=$3`,
      [jobNo, unitNo, lineNo]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "Drawing not found" });
    const drawing = rows[0];
    const cycleNo = extractUploadCount(drawing.stored_file);
    const desc = holdDescription.trim();

    await drawingQ.addComment(
      drawing.id, userId, ["GL"], "blocking_hold", desc,
      null, null, null, "blocking", desc, cycleNo
    );

    await pool.query(
      `UPDATE drawing_claims SET completed_at=NOW(), comment_type='blocking_hold'
       WHERE drawing_id=$1 AND user_id=$2 AND completed_at IS NULL`,
      [drawing.id, userId]
    );

    await pool.query(
      `UPDATE drawings SET status='GL Hold', notify_gl=FALSE WHERE id=$1`,
      [drawing.id]
    );

    const targetModellerId = drawing.uploaded_by && drawing.uploaded_by !== "SYSTEM"
      ? drawing.uploaded_by : null;
    if (targetModellerId) {
      await pushNotification(targetModellerId, drawing.id,
        "Line Held at GL — Re-upload Required",
        `Line ${lineNo} (${jobNo}/${unitNo}) has been placed on GL Hold. Please review and re-upload to restart the cycle.`);
    } else {
      await pushToRoleUsers(jobNo, unitNo, "Modeller", drawing.id,
        "Line Held at GL — Re-upload Required",
        `Line ${lineNo} (${jobNo}/${unitNo}) has been placed on GL Hold.`);
    }

    res.json({ ok: true, message: "Blocking hold declared. Line placed on GL Hold." });
  } catch (err) {
    console.error("declareGLBlockingHold error:", err);
    res.status(500).json({ ok: false, error: "Failed to declare blocking hold" });
  }
}

// POST /api/submit-sgl-comments
async function submitSGLComments(req, res) {
  const { jobNo, unitNo, lineNo, commentType } = req.body;
  const userId = req.session.user.id;
  if (!lineNo || !commentType) return res.status(400).json({ ok: false, error: "Missing fields" });

  try {
    const { rows } = await pool.query(
      `SELECT * FROM drawings WHERE job_no=$1 AND unit_no=$2 AND line_no=$3`,
      [jobNo, unitNo, lineNo]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "Drawing not found" });
    const drawing = rows[0];

    const holdType        = req.body.holdType        || null;
    const holdDescription = req.body.holdDescription || null;
    const cycleNo         = extractUploadCount(drawing.stored_file);

    // Complete SGL's own claim — unconditional, same as submitGLComments. Runs
    // before any action branch (approve, hold, or route-to-checker) so SGL's
    // claim always drops out of their own My Tasks regardless of what they did.
    await pool.query(
      `UPDATE drawing_claims SET completed_at=NOW(), comment_type=$2
       WHERE drawing_id=$1 AND user_id=$3 AND completed_at IS NULL`,
      [drawing.id, commentType, userId]
    );

    // ── APPROVE ─────────────────────────────────────────────────────────────
    if (commentType === "approve") {
      if (holdType === "blocking") {
        // SGL Hold — blocking issue prevents Final; park line instead of approving
        await drawingQ.addComment(drawing.id, userId, ["SGL"], "approve",
          req.body.comment || "SGL Hold Declared", null, null, null,
          holdType, holdDescription, cycleNo);
        // Do NOT clearAllClaims — uploadIsometric needs completed PC/MC claims to re-route
        await pool.query(
          `UPDATE drawings SET status='SGL Hold', notify_gl=FALSE, notify_modeller=FALSE,
           all_roles_claimed=FALSE, delegated_by_user=NULL, delegated_by_role=NULL WHERE id=$1`,
          [drawing.id]
        );
        const targetModellerId = drawing.uploaded_by && drawing.uploaded_by !== "SYSTEM"
          ? drawing.uploaded_by : null;
        if (targetModellerId) {
          await pushNotification(targetModellerId, drawing.id,
            "Line Held at SGL — Re-upload Required",
            `Line ${lineNo} (${jobNo}/${unitNo}) has been placed on SGL Hold. Please review and re-upload to restart the cycle.`);
        } else {
          await pushToRoleUsers(jobNo, unitNo, "Modeller", drawing.id,
            "Line Held at SGL — Re-upload Required",
            `Line ${lineNo} (${jobNo}/${unitNo}) has been placed on SGL Hold.`);
        }
        if (req.file?.path && fs.existsSync(req.file.path)) await fsp.unlink(req.file.path).catch(() => {});
        return res.json({ ok: true, message: "Line placed on SGL Hold" });
      }

      // Normal approve (no hold or minor hold)
      await pool.query(
        `UPDATE drawings SET status='Final', notify_gl=FALSE, notify_modeller=FALSE,
         all_roles_claimed=FALSE, delegated_by_user=NULL, delegated_by_role=NULL WHERE id=$1`,
        [drawing.id]
      );
      await drawingQ.clearAllClaims(drawing.id);
      await drawingQ.addComment(drawing.id, userId, ["SGL"], "approve", "SGL Approved — Final",
        null, null, null, holdType, holdDescription, cycleNo);
      if (req.file?.path && fs.existsSync(req.file.path)) await fsp.unlink(req.file.path).catch(() => {});
      return res.json({ ok: true, message: "Line approved — added to Final Isometrics" });
    }

    // ── Comment → back to a checker (PC/MC/SC), or direct to Modeller ──────
    // Same routeTo mechanism as submitGLComments: the backend finds the
    // current reviewer itself (revision-scoped drawing_comments lookup) and
    // claims them directly. Replaces the old rolePerformers/clearAllClaims
    // design, which depended on the frontend supplying a performer map that
    // was never actually sent — the line just fell back into the open pool.
    const { commentFileName, filePath } = await saveApproverCommentFile(
      jobNo, unitNo, drawing.zone, lineNo,
      drawing.rev_no || 0, cycleNo, "PMSAA",
      drawing, userId, req.file, commentType, fsp
    );

    await drawingQ.upsertCommentFile(drawing.id, commentFileName, filePath, ["SGL"], [userId], `sgl_${commentType}`);
    await drawingQ.addComment(drawing.id, userId, ["SGL"], commentType,
      req.body.comment || null, commentFileName, filePath, null,
      holdType, holdDescription, cycleNo);

    const routeTo = (req.body.routeTo || 'pc').toLowerCase(); // 'pc' | 'mc' | 'sc' | 'modeller'

    if (routeTo === 'modeller') {
      // ── Route directly to Modeller — bypasses the checker loop entirely.
      const targetModellerId = req.body.targetModellerId || null;
      await routeDrawingToModeller(drawing, jobNo, unitNo, lineNo,
        'Incorporation Required — SGL Comments',
        `SGL has sent comments directly on line ${lineNo} (${jobNo}/${unitNo}). Please incorporate and re-upload.`,
        targetModellerId,
        'Comments Received from SGL'
      );
      if (req.file?.path && fs.existsSync(req.file.path)) await fsp.unlink(req.file.path).catch(() => {});
      return res.json({ ok: true, message: "SGL comments sent directly to Modeller" });
    }

    // Set drawing status (PC/MC/SC routes only)
    await pool.query(
      `UPDATE drawings SET status='SGL Commented', notify_gl=FALSE, notify_modeller=FALSE WHERE id=$1`,
      [drawing.id]
    );

    if (routeTo === 'sc') {
      // ── Route to SC ──────────────────────────────────────────────────────
      // Scoped to rev_no=current revision — same reasoning as submitGLComments.
      const { rows: prevSC } = await pool.query(
        `SELECT DISTINCT user_id FROM drawing_comments WHERE drawing_id=$1 AND 'SC'=ANY(roles) AND rev_no=$2`,
        [drawing.id, drawing.rev_no]
      );
      if (prevSC.length > 0) {
        for (const sc of prevSC) {
          await drawingQ.upsertClaim(drawing.id, sc.user_id, ['SC']);
          await pushNotification(sc.user_id, drawing.id,
            'SGL Commented — SC Review Required',
            `SGL has commented on line ${lineNo} (${jobNo}/${unitNo}). Please re-check as Stress Checker.`);
        }
      } else {
        await pushToRoleUsers(jobNo, unitNo, 'Stress Checker', drawing.id,
          'SGL Commented — SC Review Required',
          `SGL has commented on line ${lineNo} (${jobNo}/${unitNo}). SC review required.`);
      }
      if (req.file?.path && fs.existsSync(req.file.path)) await fsp.unlink(req.file.path).catch(() => {});
      return res.json({ ok: true, message: "SGL comments sent to Stress Checker" });
    }

    if (routeTo === 'mc') {
      // ── Route to MC ──────────────────────────────────────────────────────
      const { rows: mcClaims } = await pool.query(
        `SELECT user_id FROM drawing_comments
         WHERE drawing_id=$1 AND 'MC'=ANY(roles) AND rev_no=$2
         ORDER BY created_at DESC LIMIT 1`,
        [drawing.id, drawing.rev_no]
      );
      if (mcClaims[0]) {
        await drawingQ.upsertClaim(drawing.id, mcClaims[0].user_id, ['MC']);
        await pushNotification(mcClaims[0].user_id, drawing.id,
          'SGL Commented — Review Required',
          `SGL has commented on line ${lineNo} (${jobNo}/${unitNo}). Please re-check and address comments as Material Checker.`);
      }
      if (req.file?.path && fs.existsSync(req.file.path)) await fsp.unlink(req.file.path).catch(() => {});
      return res.json({ ok: true, message: "SGL comments sent to Material Checker's My Tasks" });
    }

    // ── Default: route to PC ─────────────────────────────────────────────
    const { rows: pcClaims } = await pool.query(
      `SELECT user_id FROM drawing_comments
       WHERE drawing_id=$1 AND 'PC'=ANY(roles) AND rev_no=$2
       ORDER BY created_at DESC LIMIT 1`,
      [drawing.id, drawing.rev_no]
    );
    if (pcClaims[0]) {
      await drawingQ.upsertClaim(drawing.id, pcClaims[0].user_id, ['PC']);
      await pushNotification(pcClaims[0].user_id, drawing.id,
        'SGL Commented — Review Required',
        `SGL has commented on line ${lineNo} (${jobNo}/${unitNo}). Please re-check and address comments.`);
    }

    if (req.file?.path && fs.existsSync(req.file.path)) await fsp.unlink(req.file.path).catch(() => {});
    res.json({ ok: true, message: "SGL comments sent to Process Checker's My Tasks" });
  } catch (err) {
    console.error("submitSGLComments error:", err);
    if (req.file?.path) await fsp.unlink(req.file.path).catch(() => {});
    res.status(500).json({ ok: false, error: "Failed to submit SGL comments" });
  }
}

// POST /api/declare-sgl-blocking-hold
// Independent escalation action for SGL — same rationale as the GL version.
// SGL is also a solo step, so this is a UI-consistency addition; the existing
// nested "approve + holdType=blocking" branch already parks immediately as
// 'SGL Hold' and is left untouched as a dormant fallback.
async function declareSGLBlockingHold(req, res) {
  const { jobNo, unitNo, lineNo, holdDescription } = req.body;
  const userId = req.session.user.id;
  if (!jobNo || !unitNo || !lineNo || !holdDescription || !holdDescription.trim())
    return res.status(400).json({ ok: false, error: "jobNo, unitNo, lineNo, and a hold description are required" });

  try {
    const { rows } = await pool.query(
      `SELECT * FROM drawings WHERE job_no=$1 AND unit_no=$2 AND line_no=$3`,
      [jobNo, unitNo, lineNo]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "Drawing not found" });
    const drawing = rows[0];
    const cycleNo = extractUploadCount(drawing.stored_file);
    const desc = holdDescription.trim();

    await drawingQ.addComment(
      drawing.id, userId, ["SGL"], "blocking_hold", desc,
      null, null, null, "blocking", desc, cycleNo
    );

    await pool.query(
      `UPDATE drawing_claims SET completed_at=NOW(), comment_type='blocking_hold'
       WHERE drawing_id=$1 AND user_id=$2 AND completed_at IS NULL`,
      [drawing.id, userId]
    );

    // Mirrors the existing SGL-approve-blocking-hold path: do NOT clearAllClaims —
    // uploadIsometric/modellerResubmit needs completed PC/MC/SC claims to re-route.
    await pool.query(
      `UPDATE drawings SET status='SGL Hold', notify_gl=FALSE, notify_modeller=FALSE,
       all_roles_claimed=FALSE, delegated_by_user=NULL, delegated_by_role=NULL WHERE id=$1`,
      [drawing.id]
    );

    const targetModellerId = drawing.uploaded_by && drawing.uploaded_by !== "SYSTEM"
      ? drawing.uploaded_by : null;
    if (targetModellerId) {
      await pushNotification(targetModellerId, drawing.id,
        "Line Held at SGL — Re-upload Required",
        `Line ${lineNo} (${jobNo}/${unitNo}) has been placed on SGL Hold. Please review and re-upload to restart the cycle.`);
    } else {
      await pushToRoleUsers(jobNo, unitNo, "Modeller", drawing.id,
        "Line Held at SGL — Re-upload Required",
        `Line ${lineNo} (${jobNo}/${unitNo}) has been placed on SGL Hold.`);
    }

    res.json({ ok: true, message: "Blocking hold declared. Line placed on SGL Hold." });
  } catch (err) {
    console.error("declareSGLBlockingHold error:", err);
    res.status(500).json({ ok: false, error: "Failed to declare blocking hold" });
  }
}

// POST /api/submit-checker-comments (multer for file in route)
async function submitCheckerComments(req, res) {
  const { jobNo, unitNo, lineNo, commentType, roles } = req.body;
  const userId = req.session.user.id;
  if (!lineNo || !commentType) return res.status(400).json({ ok: false, error: "Missing fields" });

  try {
    const parsedRoles = roles ? (Array.isArray(roles) ? roles : JSON.parse(roles)) : [];
    const { rows } = await pool.query(
      `SELECT * FROM drawings WHERE job_no=$1 AND unit_no=$2 AND line_no=$3`,
      [jobNo, unitNo, lineNo]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "Drawing not found" });
    const drawing = rows[0];

    // GL/SGL-Commented lines must go through "Send to Modeller" / "Edit & Send to
    // Modeller" (forwardGLToModeller) instead. The conventional "all claims
    // completed" gate below can be satisfied by stale completed_at values left
    // over from before GL/SGL's comment (MC/SC claims nobody reset), letting a
    // line through without genuine re-confirmation from MC/SC on the actual feedback.
    if (drawing.status === 'GL Commented' || drawing.status === 'SGL Commented') {
      return res.status(400).json({
        ok: false,
        error: `This line has ${drawing.status === 'SGL Commented' ? 'SGL' : 'GL'} comments pending. Use "Send to Modeller" or "Edit & Send to Modeller" instead.`,
      });
    }

    const uploadCount = extractUploadCount(drawing.stored_file);
    const revNo = drawing.rev_no || 0;
    const baseFileName = `${lineNo}_R${revNo}-${uploadCount}`;
    const holdType        = req.body.holdType        || null;
    const holdDescription = req.body.holdDescription || null;

    // Determine suffix from roles (PC→P, MC→M, SC→S → sorted → "PM","PS","MS","PMS" etc)
    const roleSortOrder = ["PC", "MC", "SC"];
    const sorted = parsedRoles.filter((r) => roleSortOrder.includes(r)).sort((a, b) => roleSortOrder.indexOf(a) - roleSortOrder.indexOf(b));
    const suffix = sorted.map((r) => r[0]).join("") || parsedRoles[0]?.[0] || "C";
    let commentFileName = null, filePath = null;

    if (commentType !== "none") {
      commentFileName = `${baseFileName}_${suffix}.pdf`;
      const commentsDir = path.join(UPLOADS_ROOT, jobNo, unitNo, drawing.zone, "comments");
      ensureDir(commentsDir);
      const finalPath = path.join(commentsDir, commentFileName);
      filePath = `uploads/${jobNo}/${unitNo}/${drawing.zone}/comments/${commentFileName}`;

      if (commentType === "file" && req.file) {
        await fsp.rename(req.file.path, finalPath);
      } else if (commentType === "annotation") {
        const tempPath = path.join(UPLOADS_ROOT, jobNo, unitNo, drawing.zone, `${baseFileName}_temp.pdf`);
        if (fs.existsSync(tempPath)) await fsp.rename(tempPath, finalPath);
      } else {
        // text: copy base as reference
        const basePath = path.join(UPLOADS_ROOT, jobNo, unitNo, drawing.zone, drawing.stored_file);
        if (fs.existsSync(basePath)) await fsp.copyFile(basePath, finalPath);
      }

      await drawingQ.upsertCommentFile(drawing.id, commentFileName, filePath, parsedRoles, [userId], commentType);
    }

    await drawingQ.addComment(drawing.id, userId, parsedRoles, commentType, req.body.comment || null, commentFileName, filePath, null, holdType, holdDescription, uploadCount);

    // Mark this user's claim as completed — also record their modeller pick (if
    // any) so a later checker's submission can detect a divergence and warn.
    await pool.query(
      `UPDATE drawing_claims SET comment_type=$1, completed_at=NOW(), target_modeller_id=$4 WHERE drawing_id=$2 AND user_id=$3`,
      [commentType, drawing.id, userId, req.body.targetModellerId || null]
    );

    // If this is an SC completion, clear any OTHER still-open SC claims on this
    // drawing. Multiple historical SC reviewers (reviewer changed between past
    // cycles) get directly claimed together by the auto-route/GFS/GL-route-back
    // paths below and elsewhere — only one of them needs to actually review it.
    // Without this, the other(s) are left with a permanent dangling claim that
    // never gets completed or cleared, even though SC was genuinely satisfied.
    if (parsedRoles.includes('SC')) {
      const { rows: otherOpenSC } = await pool.query(
        `SELECT user_id, roles FROM drawing_claims
         WHERE drawing_id=$1 AND 'SC'=ANY(roles) AND completed_at IS NULL AND user_id != $2`,
        [drawing.id, userId]
      );
      for (const o of otherOpenSC) {
        const remainingRoles = o.roles.filter((r) => r !== 'SC');
        if (remainingRoles.length === 0) {
          await pool.query(`DELETE FROM drawing_claims WHERE drawing_id=$1 AND user_id=$2`, [drawing.id, o.user_id]);
        } else {
          await pool.query(`UPDATE drawing_claims SET roles=$1 WHERE drawing_id=$2 AND user_id=$3`, [remainingRoles, drawing.id, o.user_id]);
        }
        await pushNotification(o.user_id, drawing.id,
          'Stress Check No Longer Needed',
          `Line ${drawing.line_no} (${drawing.job_no}/${drawing.unit_no}) has already been stress-checked by another reviewer this cycle. No action needed.`);
      }
    }

    // ── PC "no comments" → independently route to SC (does not wait for MC) ──
    // SC routing is PC's responsibility alone. MC has no role in SC allocation.
    // Guard checks for ANY SC claim this cycle (pending OR completed) — not just
    // pending. Checking only "pending" incorrectly re-opened SC's claim (resetting
    // completed_at to NULL) when PC submitted "none" AFTER SC had already finished
    // their review, which silently blocked the line from ever reaching GL.
    if (parsedRoles.includes('PC') && !parsedRoles.includes('SC') && commentType === 'none') {
      const { rows: scExistingClaim } = await pool.query(
        `SELECT 1 FROM drawing_claims WHERE drawing_id=$1 AND 'SC'=ANY(roles) LIMIT 1`,
        [drawing.id]
      );
      if (scExistingClaim.length === 0) {
        // Stress-critical lines hide SC from the pool by default (shouldShowToChecker's
        // "Sent for Supporting Check" gate) — flip status now that PC has cleared it,
        // so SC actually becomes visible/claimable.
        if (drawing.stress_critical === 'Y') {
          await pool.query(`UPDATE drawings SET status='Sent for Supporting Check' WHERE id=$1`, [drawing.id]);
          drawing.status = 'Sent for Supporting Check';
        }
        // Find previous SC reviewer from comment history (same drawing_id),
        // scoped to THIS revision (rev_no=drawing.rev_no). A line's 2nd+
        // cycle within the same revision correctly routes directly to the
        // previous holder, but a brand new revision's 1st cycle must behave
        // like the very first time (open pool) — without this scope, SC
        // would auto-route to whoever reviewed an OLDER revision forever,
        // even on a revision they've never seen.
        // Excludes the caller (PC, submitting "none" right now): their own
        // claim was already marked completed earlier in this same request —
        // if they're also a previous SC reviewer, auto-assigning SC back to
        // them would upsertClaim onto that same just-completed row and wipe
        // it out, making their own PC submission vanish from drawing_claims.
        // Falling through to the SC pool instead keeps it correctly open for
        // them (or anyone else) to claim afterward, without self-overwriting.
        const { rows: prevSC } = await pool.query(
          `SELECT DISTINCT user_id FROM drawing_comments WHERE drawing_id=$1 AND 'SC'=ANY(roles) AND user_id != $2 AND rev_no=$3`,
          [drawing.id, userId, drawing.rev_no]
        );
        if (prevSC.length > 0) {
          // SC has reviewed this revision before → direct claim to previous SC inbox
          for (const sc of prevSC) {
            await drawingQ.upsertClaim(drawing.id, sc.user_id, ['SC']);
            await pushNotification(sc.user_id, drawing.id,
              'Line Ready for Stress Check',
              `Line ${drawing.line_no} (${drawing.job_no}/${drawing.unit_no}) has no checker comments. Please review.`
            );
          }
        } else {
          // First time SC involved → notify SC pool (SC engineers claim voluntarily)
          await pushToRoleUsers(drawing.job_no, drawing.unit_no, 'Stress Checker', drawing.id,
            'Line Available for Stress Check',
            `Line ${drawing.line_no} (${drawing.job_no}/${drawing.unit_no}) is available for supporting check.`
          );
        }
      }
    }

    // ── Check if ALL expected checker roles are now completed ─────────────
    // "Expected" means someone is actually assigned that role in this unit —
    // a unit with nobody assigned as MC, for example, should never block
    // waiting for a review that can never happen. SC is excluded entirely for
    // stress-critical lines — those route SC through the separate "Sent for
    // Supporting Check" flow, not this checker pool.
    //
    // Previously this only checked whichever drawing_claims rows happened to
    // already exist ("every row that exists is completed"), with no concept
    // of "all three roles must have engaged at all." A role that never even
    // claimed (e.g. MC simply never picked up the line) was silently treated
    // as nothing-to-wait-for, and the line could reach GL having only ever
    // been seen by whichever single role acted first. SC alone had a
    // dedicated guard against this; PC and MC had none. This generalizes that
    // guard to all three instead of special-casing just SC.
    // SC is "expected" on a stress-critical line once it's been engaged this
    // cycle — either status flipped to 'Sent for Supporting Check' (PC
    // no-comment auto-route or explicit Good for Supporting), OR an SC claim
    // row already exists. The claim-row check covers a claim restored via
    // checker_reroute (after a Blocking Hold or a Modeller resubmit): status
    // resets to 'Uploaded' on resubmit, and the no-comment auto-route's own
    // guard then skips re-flipping it because it sees SC already has a claim
    // row — without this fallback, that restored, still-open SC claim would
    // be silently skipped and the line would route to GL with SC abandoned.
    let scExpected = drawing.stress_critical !== 'Y' || drawing.status === 'Sent for Supporting Check';
    if (!scExpected) {
      const { rows: scClaimRows } = await pool.query(
        `SELECT 1 FROM drawing_claims WHERE drawing_id=$1 AND 'SC'=ANY(roles) LIMIT 1`,
        [drawing.id]
      );
      scExpected = scClaimRows.length > 0;
    }
    const roleChecks = [
      { code: 'PC', fullName: 'Process Checker' },
      { code: 'MC', fullName: 'Material Checker' },
      ...(scExpected ? [{ code: 'SC', fullName: 'Stress Checker' }] : []),
    ];

    let trulyAllDone = true;
    const stillWaitingOn = [];
    for (const { code, fullName } of roleChecks) {
      const { rows: assigned } = await pool.query(
        `SELECT 1 FROM user_role_assignments WHERE project_id=$1 AND unit_no=$2 AND role=$3 LIMIT 1`,
        [drawing.job_no, drawing.unit_no, fullName]
      );
      if (assigned.length === 0) continue; // nobody assigned this role here — don't wait for it

      // Reads from drawing_comments (this cycle only), NOT drawing_claims.
      // drawing_claims rows get overwritten the moment the same user claims
      // an additional role afterward — upsertClaim either merges into an
      // active row or replaces a completed one (it can't track "PC done,
      // newly-added MC pending" within a single completed_at flag), so a
      // role that already said "none"/left a comment this cycle can vanish
      // from drawing_claims entirely if its claimant later claims something
      // else. drawing_comments is append-only and never touched by that —
      // every submission this cycle is permanently recorded there regardless
      // of what subsequently happens to the claims row.
      // cycle_no alone isn't enough: it resets to 1 for every new revision, so
      // a real comment from a PAST revision's cycle 1 would otherwise be
      // mistaken for this revision's cycle 1. rev_no disambiguates.
      const { rows: done } = await pool.query(
        `SELECT 1 FROM drawing_comments WHERE drawing_id=$1 AND $2=ANY(roles) AND cycle_no=$3 AND rev_no=$4 LIMIT 1`,
        [drawing.id, code, uploadCount, drawing.rev_no]
      );
      if (done.length === 0) { trulyAllDone = false; stillWaitingOn.push(code); }
    }

    // Only PC/MC/SC comments THIS cycle (and THIS revision — see rev_no note
    // above) are considered — same reasoning as above (drawing_comments, not
    // the mutable drawing_claims rows), so a real comment already left this
    // cycle can't be silently forgotten just because its claimant later
    // claimed a different role too.
    const { rows: allClaimsRefresh } = await pool.query(
      `SELECT type FROM drawing_comments
       WHERE drawing_id=$1 AND roles && ARRAY['PC','MC','SC']::text[] AND cycle_no=$2 AND rev_no=$3`,
      [drawing.id, uploadCount, drawing.rev_no]
    );

    let modellerWarning = null;

    if (trulyAllDone) {
      // ── Blocking hold gate — checked before any routing decision ──────────
      // If ANY checker in this cycle declared a blocking hold, park the line.
      // Minor holds do not interrupt the flow.
      const { rows: blockingRows } = await pool.query(
        `SELECT 1 FROM drawing_comments
         WHERE drawing_id=$1 AND cycle_no=$2 AND rev_no=$3 AND hold_type='blocking' LIMIT 1`,
        [drawing.id, uploadCount, drawing.rev_no]
      );

      if (blockingRows.length > 0) {
        // Snapshot PC/MC/SC claimants so uploadIsometric can restore them on re-upload.
        // Unions drawing_claims (catches still-pending, not-yet-submitted claims)
        // with this cycle's drawing_comments (catches roles that already submitted
        // but were since overwritten in drawing_claims by the same user claiming
        // something else afterward) — drawing_claims alone can silently drop a
        // role the moment its claimant reclaims a different one on this drawing.
        const { rows: pcmcSnapshot } = await pool.query(
          `SELECT user_id, array_agg(DISTINCT role) AS roles FROM (
             SELECT user_id, unnest(roles) AS role FROM drawing_claims
             WHERE drawing_id=$1 AND roles && ARRAY['PC','MC','SC']::text[]
             UNION
             SELECT user_id, unnest(roles) AS role FROM drawing_comments
             WHERE drawing_id=$1 AND cycle_no=$2 AND rev_no=$3 AND roles && ARRAY['PC','MC','SC']::text[]
           ) combined WHERE role IN ('PC','MC','SC') GROUP BY user_id`,
          [drawing.id, uploadCount, drawing.rev_no]
        );
        await pool.query(
          `UPDATE drawings SET checker_reroute=$1, status='Checker Hold',
           notify_gl=FALSE, notify_modeller=FALSE, all_roles_claimed=FALSE WHERE id=$2`,
          [JSON.stringify(pcmcSnapshot), drawing.id]
        );
        const targetModellerId = drawing.uploaded_by && drawing.uploaded_by !== 'SYSTEM'
          ? drawing.uploaded_by : null;
        if (targetModellerId) {
          await pushNotification(targetModellerId, drawing.id,
            'Line Placed on Checker Hold',
            `Line ${drawing.line_no} (${drawing.job_no}/${drawing.unit_no}) has a blocking hold. Please review and re-upload.`);
        } else {
          await pushToRoleUsers(drawing.job_no, drawing.unit_no, 'Modeller', drawing.id,
            'Line Placed on Checker Hold',
            `Line ${drawing.line_no} (${drawing.job_no}/${drawing.unit_no}) has been placed on Checker Hold.`);
        }
        if (req.file?.path && fs.existsSync(req.file.path)) await fsp.unlink(req.file.path).catch(() => {});
        return res.json({ ok: true, message: 'Comment submitted. Line placed on Checker Hold.' });
      }

      const hasActualComments = allClaimsRefresh.some((c) => c.type && c.type !== "none");

      if (hasActualComments) {
        // Snapshot current PC/MC/SC claimants NOW — before the Modeller upsert below can
        // overwrite a checker's drawing_claims row (happens when the same person is both
        // PC/MC and the target Modeller, e.g. D351 who is Modeller+PC+MC).
        // modellerResubmit reads this snapshot to restore their checker claims on re-upload.
        // Unions drawing_claims with this cycle's drawing_comments for the same
        // reason as the blocking-hold snapshot above: drawing_claims alone loses
        // a role the instant its claimant reclaims a different role on this
        // drawing — drawing_comments is append-only and still has it.
        const { rows: pcmcSnapshot } = await pool.query(
          `SELECT user_id, array_agg(DISTINCT role) AS roles FROM (
             SELECT user_id, unnest(roles) AS role FROM drawing_claims
             WHERE drawing_id=$1 AND roles && ARRAY['PC','MC','SC']::text[]
             UNION
             SELECT user_id, unnest(roles) AS role FROM drawing_comments
             WHERE drawing_id=$1 AND cycle_no=$2 AND rev_no=$3 AND roles && ARRAY['PC','MC','SC']::text[]
           ) combined WHERE role IN ('PC','MC','SC') GROUP BY user_id`,
          [drawing.id, uploadCount, drawing.rev_no]
        );
        await pool.query(
          `UPDATE drawings SET checker_reroute=$1 WHERE id=$2`,
          [JSON.stringify(pcmcSnapshot), drawing.id]
        );

        // Route back to modeller:
        // 1. If checker explicitly selected a modeller → use that
        // 2. Else if line was uploaded manually (uploaded_by != 'SYSTEM') → auto-route to uploader
        // 3. Else (SYSTEM upload, no selection) → broadcast to modeller pool
        const targetModellerId = req.body.targetModellerId || null;
        const effectiveModellerId = targetModellerId ||
          (drawing.uploaded_by && drawing.uploaded_by !== 'SYSTEM' ? drawing.uploaded_by : null);

        // Warn (don't block) if an earlier-completed checker this cycle picked a
        // different modeller than the one actually being used now. Only the last
        // submission's pick ever takes effect — this just surfaces the divergence
        // instead of silently discarding someone else's explicit choice.
        const { rows: siblingPicks } = await pool.query(
          `SELECT dc.user_id, dc.roles, dc.target_modeller_id, u.name
           FROM drawing_claims dc JOIN users u ON u.id = dc.user_id
           WHERE dc.drawing_id=$1 AND dc.roles && ARRAY['PC','MC','SC']::text[]
             AND dc.user_id != $2 AND dc.target_modeller_id IS NOT NULL
             AND dc.target_modeller_id != $3`,
          [drawing.id, userId, effectiveModellerId || '']
        );
        if (siblingPicks.length > 0) {
          const { rows: effNameRows } = effectiveModellerId
            ? await pool.query(`SELECT name FROM users WHERE id=$1`, [effectiveModellerId])
            : { rows: [] };
          const effName = effNameRows[0]?.name || effectiveModellerId || 'the modeller pool';
          const diffs = siblingPicks.map((s) => `${s.roles.join('+')} chose ${s.name} (${s.target_modeller_id})`).join('; ');
          modellerWarning = `Routed to ${effName} (${effectiveModellerId || 'pool'}) — note: ${diffs}, but only the last submission's choice is used.`;
        }

        const commentsStatus = await buildCommentsReceivedStatus(drawing.id);

        if (effectiveModellerId) {
          await pool.query(
            `UPDATE drawings SET status=$2, notify_modeller=FALSE, notify_gl=FALSE, all_roles_claimed=FALSE WHERE id=$1`,
            [drawing.id, commentsStatus]
          );
          await pool.query(
            `INSERT INTO drawing_claims (drawing_id, user_id, roles)
             VALUES ($1, $2, ARRAY['Modeller'])
             ON CONFLICT (drawing_id, user_id)
             DO UPDATE SET roles=ARRAY['Modeller'], claimed_at=NOW(), completed_at=NULL, comment_type=NULL`,
            [drawing.id, effectiveModellerId]
          );
          await pushNotification(effectiveModellerId, drawing.id,
            'Incorporation Required',
            `Line ${drawing.line_no} (${drawing.job_no}/${drawing.unit_no}) has been returned to you with checker comments for incorporation.`);
        } else {
          await pool.query(
            `UPDATE drawings SET status=$2, notify_modeller=TRUE, notify_gl=FALSE, all_roles_claimed=FALSE WHERE id=$1`,
            [drawing.id, commentsStatus]
          );
          await pushToRoleUsers(drawing.job_no, drawing.unit_no, 'Modeller', drawing.id,
            'Comments Received — Action Required',
            `Line ${drawing.line_no} (${drawing.job_no}/${drawing.unit_no}) has checker comments and is awaiting incorporation.`);
        }
      } else {
        // All expected roles (including SC, when applicable) gave "no comments" —
        // trulyAllDone above already confirmed every assigned role completed,
        // so it's safe to route to GL without re-checking SC specifically here.
        // SC reviewed (or stress-critical or no SC in unit) → route to GL
        // 1st cycle this revision → GL pool; 2nd+ cycle this revision →
        // directly to the previous GL's inbox.
        //
        // Reads from drawing_comments, NOT drawing_claims — a Modeller resubmit calls
        // clearAllClaims() and wipes every drawing_claims row (GL's included; only
        // PC/MC/SC survive via the checker_reroute snapshot). drawing_comments is never
        // cleared anywhere, so it's the only reliable record of "has GL reviewed this
        // line before" once at least one resubmit cycle has happened.
        // Scoped to rev_no=current revision — a brand new revision's 1st
        // cycle must reach the open GL pool, same as the very first revision
        // did, not auto-route to whoever approved a PAST revision.
        // Excludes the caller: whichever checker role just completed this
        // submission was already marked completed earlier in this same
        // request — if that same person is also a previous GL reviewer,
        // auto-assigning GL back to them would overwrite that completion on
        // their shared claims row. Fall through to the GL pool for them.
        const { rows: prevGL } = await pool.query(
          `SELECT DISTINCT user_id FROM drawing_comments WHERE drawing_id=$1 AND 'GL'=ANY(roles) AND user_id != $2 AND rev_no=$3`,
          [drawing.id, userId, drawing.rev_no]
        );
        if (prevGL.length > 0) {
          await pool.query(
            `UPDATE drawings SET status='Ready for GL', notify_gl=FALSE, notify_modeller=FALSE, all_roles_claimed=FALSE WHERE id=$1`,
            [drawing.id]
          );
          for (const gl of prevGL) {
            await drawingQ.upsertClaim(drawing.id, gl.user_id, ['GL']);
            await pushNotification(gl.user_id, drawing.id,
              'Line Ready for GL Review',
              `Line ${drawing.line_no} (${drawing.job_no}/${drawing.unit_no}) has no checker comments and is ready for your GL review.`
            );
          }
        } else {
          await pool.query(
            `UPDATE drawings SET status='Ready for GL', notify_gl=TRUE, notify_modeller=FALSE, all_roles_claimed=FALSE WHERE id=$1`,
            [drawing.id]
          );
          await pushToRoleUsers(drawing.job_no, drawing.unit_no, 'GL', drawing.id,
            'Line Ready for GL Review',
            `Line ${drawing.line_no} (${drawing.job_no}/${drawing.unit_no}) has no checker comments and is ready for GL review.`);
        }

        // S3D lock feed — line is ready for GL, mark pending-lock for tonight's export.
        await s3dExportQ.markPendingLock({
          jobNo: drawing.job_no, unitNo: drawing.unit_no,
          zone: drawing.zone, lineNo: drawing.line_no,
        }).catch(e => console.error("[S3D] markPendingLock error:", e.message));
      }
    }

    if (req.file?.path && fs.existsSync(req.file.path)) await fsp.unlink(req.file.path).catch(() => {});
    res.json({
      ok: true,
      message: stillWaitingOn.length > 0
        ? `Comment submitted. Awaiting ${stillWaitingOn.join(', ')} review before proceeding.`
        : "Comment submitted",
      ...(modellerWarning ? { warning: modellerWarning } : {}),
    });
  } catch (err) {
    console.error("submitCheckerComments error:", err);
    if (req.file?.path) await fsp.unlink(req.file.path).catch(() => {});
    res.status(500).json({ ok: false, error: "Failed to submit comment" });
  }
}

// POST /api/declare-checker-blocking-hold
// Independent escalation action for PC/MC/SC — deliberately NOT routed through
// submitCheckerComments. A blocking hold is not a "comment type" (it's not
// compatible with "No Comments", which is what motivated pulling it out): it
// parks the line immediately, without waiting for trulyAllDone, and clears any
// other checker's still-open claim on this line (their review is now moot).
// This is intentionally a separate, additive function — it does not touch or
// replace the existing blocking-hold handling nested inside submitCheckerComments,
// which is left as a dormant fallback in case it's ever reached some other way.
async function declareCheckerBlockingHold(req, res) {
  const { jobNo, unitNo, lineNo, roles, holdDescription } = req.body;
  const userId = req.session.user.id;
  if (!jobNo || !unitNo || !lineNo || !holdDescription || !holdDescription.trim())
    return res.status(400).json({ ok: false, error: "jobNo, unitNo, lineNo, and a hold description are required" });

  try {
    const parsedRoles = roles ? (Array.isArray(roles) ? roles : JSON.parse(roles)) : [];
    if (parsedRoles.length === 0)
      return res.status(400).json({ ok: false, error: "roles[] required" });

    const { rows } = await pool.query(
      `SELECT * FROM drawings WHERE job_no=$1 AND unit_no=$2 AND line_no=$3`,
      [jobNo, unitNo, lineNo]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "Drawing not found" });
    const drawing = rows[0];
    const cycleNo = extractUploadCount(drawing.stored_file);
    const desc = holdDescription.trim();

    // Record the hold itself — shows in both line History and Hold History
    // (getLineHolds reads purely off hold_type IS NOT NULL, independent of `type`).
    await drawingQ.addComment(
      drawing.id, userId, parsedRoles, "blocking_hold", desc,
      null, null, null, "blocking", desc, cycleNo
    );

    // Snapshot ALL PC/MC/SC claimants — completed or still open — BEFORE clearing
    // anything, so checker_reroute can restore everyone correctly on next resubmit.
    // Unions drawing_claims with this cycle's drawing_comments: drawing_claims
    // alone loses a role the instant its claimant reclaims a different role on
    // this drawing, since each user has only one row with one completed_at —
    // drawing_comments is append-only and still has every role they touched.
    const { rows: pcmcSnapshot } = await pool.query(
      `SELECT user_id, array_agg(DISTINCT role) AS roles FROM (
         SELECT user_id, unnest(roles) AS role FROM drawing_claims
         WHERE drawing_id=$1 AND roles && ARRAY['PC','MC','SC']::text[]
         UNION
         SELECT user_id, unnest(roles) AS role FROM drawing_comments
         WHERE drawing_id=$1 AND cycle_no=$2 AND rev_no=$3 AND roles && ARRAY['PC','MC','SC']::text[]
       ) combined WHERE role IN ('PC','MC','SC') GROUP BY user_id`,
      [drawing.id, cycleNo, drawing.rev_no]
    );

    // Complete the declarer's own claim — their job this cycle is done.
    await pool.query(
      `UPDATE drawing_claims SET completed_at=NOW(), comment_type='blocking_hold'
       WHERE drawing_id=$1 AND user_id=$2 AND completed_at IS NULL`,
      [drawing.id, userId]
    );

    // Anyone else with a still-open PC/MC/SC claim: their review is now moot —
    // clear it and let them know, rather than leaving a dead task in their queue.
    const { rows: otherOpenClaims } = await pool.query(
      `SELECT user_id FROM drawing_claims
       WHERE drawing_id=$1 AND roles && ARRAY['PC','MC','SC']::text[]
         AND completed_at IS NULL AND user_id != $2`,
      [drawing.id, userId]
    );
    for (const c of otherOpenClaims) {
      await pool.query(`DELETE FROM drawing_claims WHERE drawing_id=$1 AND user_id=$2`, [drawing.id, c.user_id]);
      await pushNotification(c.user_id, drawing.id,
        "Line Parked — No Action Needed",
        `Line ${lineNo} (${jobNo}/${unitNo}) was placed on hold by another checker. No action needed this cycle.`);
    }

    await pool.query(
      `UPDATE drawings SET checker_reroute=$1, status='Checker Hold',
       notify_gl=FALSE, notify_modeller=FALSE, all_roles_claimed=FALSE WHERE id=$2`,
      [JSON.stringify(pcmcSnapshot), drawing.id]
    );

    const targetModellerId = drawing.uploaded_by && drawing.uploaded_by !== 'SYSTEM'
      ? drawing.uploaded_by : null;
    if (targetModellerId) {
      await pushNotification(targetModellerId, drawing.id,
        'Line Placed on Checker Hold',
        `Line ${lineNo} (${jobNo}/${unitNo}) has a blocking hold. Please review and re-upload.`);
    } else {
      await pushToRoleUsers(jobNo, unitNo, 'Modeller', drawing.id,
        'Line Placed on Checker Hold',
        `Line ${lineNo} (${jobNo}/${unitNo}) has been placed on Checker Hold.`);
    }

    res.json({ ok: true, message: 'Blocking hold declared. Line placed on Checker Hold.' });
  } catch (err) {
    console.error("declareCheckerBlockingHold error:", err);
    res.status(500).json({ ok: false, error: "Failed to declare blocking hold" });
  }
}

// POST /api/unclaim
async function unclaimLine(req, res) {
  const { lineNo, jobNo, roles } = req.body || {};
  const userId = req.session.user.id;
  if (!lineNo) return res.status(400).json({ ok: false, error: "lineNo required" });

  try {
    const { rows } = await pool.query(
      `SELECT id, status FROM drawings WHERE line_no=$1 ${jobNo ? "AND job_no=$2" : ""} ORDER BY uploaded_on DESC LIMIT 1`,
      jobNo ? [lineNo, jobNo] : [lineNo]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: "Drawing not found" });

    const drawing = rows[0];
    const rolesToDrop = Array.isArray(roles) ? roles.filter(Boolean) : [];

    if (rolesToDrop.length > 0) {
      // Partial unclaim — drop only the named roles from this user's claim,
      // leaving any other roles in the same combined row (e.g. PC+MC+SC held
      // together) untouched. Only meaningful while the claim is still active;
      // "My Tasks" never shows a completed claim anyway, so there's nothing
      // pending left to partially unclaim once completed_at is set.
      const { rows: claimRows } = await pool.query(
        `SELECT roles FROM drawing_claims WHERE drawing_id=$1 AND user_id=$2 AND completed_at IS NULL`,
        [drawing.id, userId]
      );
      if (!claimRows.length) {
        return res.status(404).json({ ok: false, error: "No active claim found for this line" });
      }
      const remainingRoles = claimRows[0].roles.filter((r) => !rolesToDrop.includes(r));
      if (remainingRoles.length === 0) {
        await drawingQ.deleteClaim(drawing.id, userId);
      } else {
        await pool.query(
          `UPDATE drawing_claims SET roles=$1 WHERE drawing_id=$2 AND user_id=$3`,
          [remainingRoles, drawing.id, userId]
        );
      }
    } else {
      // Full unclaim — drop the entire claim row (unchanged from before; this
      // is what every existing caller that doesn't pass `roles` still gets).
      await drawingQ.deleteClaim(drawing.id, userId);
    }

    const remainingClaims = await drawingQ.getActiveClaims(drawing.id);
    if (!remainingClaims.length && drawing.status === "Under Review") {
      await pool.query(`UPDATE drawings SET status='Uploaded' WHERE id=$1`, [drawing.id]);
    }

    res.json({ ok: true, message: "Line unclaimed successfully" });
  } catch (err) {
    console.error("unclaimLine error:", err);
    res.status(500).json({ ok: false, error: "Failed to unclaim line" });
  }
}

// GET /api/zone-claims?project=&unit=&zone=
// Returns per-line, per-role state: 'active' | 'no-comments' | absent (= in pool)
async function getZoneClaims(req, res) {
  const { project, unit, zone } = req.query;
  if (!project || !unit || !zone)
    return res.status(400).json({ ok: false, error: "project, unit, zone required" });
  try {
    const { rows } = await pool.query(
      `SELECT d.line_no, dc.roles, dc.completed_at, dc.comment_type
       FROM drawing_claims dc
       JOIN drawings d ON d.id = dc.drawing_id
       WHERE d.job_no=$1 AND d.unit_no=$2 AND UPPER(d.zone)=UPPER($3)
         AND dc.roles && ARRAY['PC','MC','SC']::text[]`,
      [project, unit, zone]
    );
    // Build map: lineNo → { PC: 'active'|'no-comments'|'done', MC: ..., SC: ... }
    // Priority: active > done > no-comments
    const priority = { active: 3, done: 2, 'no-comments': 1 };
    const claims = {};
    rows.forEach(row => {
      if (!claims[row.line_no]) claims[row.line_no] = {};
      // If the same person is both checker and GL/SGL, their claim row will have
      // comment_type='approve' after GL approval — treat that as 'no-comments' for
      // the checker columns since 'approve' reflects the GL action, not a checker comment.
      const hasGLRole = (row.roles || []).some(r => r === 'GL' || r === 'SGL');
      const state = !row.completed_at                                      ? 'active'
                  : row.comment_type === 'none'                            ? 'no-comments'
                  : (row.comment_type === 'approve' && hasGLRole)          ? 'no-comments'
                  : 'done';
      (row.roles || []).forEach(role => {
        if (['PC','MC','SC'].includes(role)) {
          const cur = claims[row.line_no][role];
          if (!cur || (priority[state] || 0) > (priority[cur] || 0))
            claims[row.line_no][role] = state;
        }
      });
    });
    res.json({ ok: true, claims });
  } catch (err) {
    console.error("getZoneClaims error:", err);
    res.status(500).json({ ok: false, error: "Failed to load zone claims" });
  }
}

// Shared by forwardGLToModeller (PC/SC forwarding a GL-Commented line) and
// submitGLComments' direct-to-Modeller routing (GL bypassing the checker loop
// entirely). Snapshots PC/MC/SC claimants so a later Modeller resubmit can
// restore them via checker_reroute, resolves who the target Modeller actually
// is, and either personally claims+notifies them or broadcasts to the pool.
async function routeDrawingToModeller(drawing, jobNo, unitNo, lineNo, notifTitle, notifMsg, targetModellerId, statusOverride) {
  // Unions drawing_claims with this cycle's drawing_comments: drawing_claims
  // alone loses a role the instant its claimant reclaims a different role on
  // this drawing (one row, one completed_at, per user) — drawing_comments is
  // append-only and still has every role they actually touched this cycle.
  const cycleNo = extractUploadCount(drawing.stored_file);
  const { rows: pcmcSnapshot } = await pool.query(
    `SELECT user_id, array_agg(DISTINCT role) AS roles FROM (
       SELECT user_id, unnest(roles) AS role FROM drawing_claims
       WHERE drawing_id=$1 AND roles && ARRAY['PC','MC','SC']::text[]
       UNION
       SELECT user_id, unnest(roles) AS role FROM drawing_comments
       WHERE drawing_id=$1 AND cycle_no=$2 AND rev_no=$3 AND roles && ARRAY['PC','MC','SC']::text[]
     ) combined WHERE role IN ('PC','MC','SC') GROUP BY user_id`,
    [drawing.id, cycleNo, drawing.rev_no]
  );
  await pool.query(
    `UPDATE drawings SET checker_reroute=$1 WHERE id=$2`,
    [JSON.stringify(pcmcSnapshot), drawing.id]
  );

  const effectiveModellerId =
    (targetModellerId && targetModellerId !== 'SYSTEM') ? targetModellerId :
    (drawing.uploaded_by && drawing.uploaded_by !== 'SYSTEM' ? drawing.uploaded_by : null);

  const commentsStatus = statusOverride || await buildCommentsReceivedStatus(drawing.id);

  if (effectiveModellerId) {
    await pool.query(
      `UPDATE drawings SET status=$2, notify_modeller=FALSE, notify_gl=FALSE, all_roles_claimed=FALSE WHERE id=$1`,
      [drawing.id, commentsStatus]
    );
    await pool.query(
      `INSERT INTO drawing_claims (drawing_id, user_id, roles)
       VALUES ($1,$2,ARRAY['Modeller'])
       ON CONFLICT (drawing_id, user_id)
       DO UPDATE SET roles=ARRAY['Modeller'], claimed_at=NOW(), completed_at=NULL, comment_type=NULL`,
      [drawing.id, effectiveModellerId]
    );
    await pushNotification(effectiveModellerId, drawing.id, notifTitle, notifMsg);
  } else {
    await pool.query(
      `UPDATE drawings SET status=$2, notify_modeller=TRUE, notify_gl=FALSE, all_roles_claimed=FALSE WHERE id=$1`,
      [drawing.id, commentsStatus]
    );
    await pushToRoleUsers(jobNo, unitNo, 'Modeller', drawing.id, notifTitle, notifMsg);
  }
}

// POST /api/forward-gl-to-modeller
// PC or SC forwards a GL Commented line directly to the Modeller.
// forwardType='direct': forward GL's file as-is; 'edit': attach PC/SC additions first.
async function forwardGLToModeller(req, res) {
  const { jobNo, unitNo, lineNo, forwardType, comment, targetModellerId } = req.body;
  const userId = req.session.user.id;
  if (!lineNo || !forwardType)
    return res.status(400).json({ ok: false, error: 'Missing fields' });

  try {
    const { rows } = await pool.query(
      `SELECT * FROM drawings WHERE job_no=$1 AND unit_no=$2 AND line_no=$3`,
      [jobNo, unitNo, lineNo]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: 'Drawing not found' });
    const drawing = rows[0];

    // Same forward-to-modeller action regardless of whether GL or SGL is the
    // one holding the line — the checker's job (relay to Modeller) is identical.
    if (drawing.status !== 'GL Commented' && drawing.status !== 'SGL Commented')
      return res.status(400).json({ ok: false, error: 'Drawing is not in GL Commented or SGL Commented status' });

    // Forwarder's checker role — used for both modes (history attribution + file suffix).
    // Includes MC: GL/SGL can route a comment to any of PC/MC/SC, not just PC/SC.
    const { rows: userClaims } = await pool.query(
      `SELECT roles FROM drawing_claims WHERE drawing_id=$1 AND user_id=$2 AND completed_at IS NULL LIMIT 1`,
      [drawing.id, userId]
    );
    const forwarderRole = userClaims[0]?.roles?.find(r => ['PC','MC','SC'].includes(r)) || 'PC';

    if (forwardType === 'edit') {
      // ── Edit mode: save PC/MC/SC additions as a comment file ─────────────
      const uploadCount = extractUploadCount(drawing.stored_file);
      const revNo       = drawing.rev_no || 0;
      const baseFileName = `${lineNo}_R${revNo}-${uploadCount}`;
      const suffix        = forwarderRole === 'SC' ? 'S' : forwarderRole === 'MC' ? 'M' : 'P';

      const commentFileName = `${baseFileName}_${suffix}_GL_FWD.pdf`;
      const commentsDir     = path.join(UPLOADS_ROOT, jobNo, unitNo, drawing.zone, 'comments');
      ensureDir(commentsDir);
      const finalPath  = path.join(commentsDir, commentFileName);
      const filePath   = `uploads/${jobNo}/${unitNo}/${drawing.zone}/comments/${commentFileName}`;

      if (req.file) {
        await fsp.rename(req.file.path, finalPath);
      } else {
        const basePath = path.join(UPLOADS_ROOT, jobNo, unitNo, drawing.zone, drawing.stored_file);
        if (fs.existsSync(basePath)) await fsp.copyFile(basePath, finalPath);
      }

      const sourceLabel = drawing.status === 'SGL Commented' ? 'SGL' : 'GL';
      await drawingQ.addComment(drawing.id, userId, [forwarderRole], 'file',
        comment || `Forwarding ${sourceLabel} comments to Modeller with notes`,
        commentFileName, filePath, null);
    } else {
      // ── Direct mode: no file/notes of its own — still leave a history entry so the
      // History table isn't silently missing this routing decision.
      const sourceLabel = drawing.status === 'SGL Commented' ? 'SGL' : 'GL';
      await drawingQ.addComment(drawing.id, userId, [forwarderRole], 'text',
        `Forwarded ${sourceLabel} comments to Modeller directly (no additional notes)`,
        null, null, null);
    }

    // Mark forwarder's claim as completed — MUST happen before the Modeller-claim
    // upsert below. If the forwarder is also the target Modeller (e.g. D351 = both
    // PC and the line's uploader), that upsert overwrites this same (drawing_id,
    // user_id) row into roles=['Modeller']; completing it afterward would wrongly
    // mark the brand-new Modeller claim as already done instead of this checker claim.
    await pool.query(
      `UPDATE drawing_claims SET completed_at=NOW(), comment_type=$1
       WHERE drawing_id=$2 AND user_id=$3 AND completed_at IS NULL`,
      [forwardType === 'edit' ? 'file' : 'forward', drawing.id, userId]
    );

    const sourceLabel = drawing.status === 'SGL Commented' ? 'SGL' : 'GL';
    const notifTitle = `Incorporation Required — ${sourceLabel} Comments`;
    const notifMsg   = forwardType === 'direct'
      ? `${sourceLabel} has commented on line ${lineNo} (${jobNo}/${unitNo}). Please incorporate ${sourceLabel}'s comments and re-upload.`
      : `${sourceLabel} has commented on line ${lineNo} (${jobNo}/${unitNo}). The checker has added notes. Please incorporate and re-upload.`;

    await routeDrawingToModeller(drawing, jobNo, unitNo, lineNo, notifTitle, notifMsg, targetModellerId);

    if (req.file?.path && fs.existsSync(req.file.path)) await fsp.unlink(req.file.path).catch(() => {});
    res.json({ ok: true, message: `${sourceLabel} commented line forwarded to Modeller` });
  } catch (err) {
    console.error('forwardGLToModeller error:', err);
    if (req.file?.path) await fsp.unlink(req.file.path).catch(() => {});
    res.status(500).json({ ok: false, error: 'Failed to forward to Modeller' });
  }
}

// GET /api/track-line?jobNo=X&lineNo=Y — any user can look up any line
async function trackLine(req, res) {
  const { jobNo, lineNo } = req.query;
  if (!jobNo || !lineNo) return res.status(400).json({ ok: false, error: 'jobNo and lineNo required' });

  try {
    const { rows: drw } = await pool.query(
      `SELECT * FROM drawings WHERE job_no=$1 AND line_no=$2 LIMIT 1`,
      [jobNo, lineNo]
    );
    if (!drw[0]) return res.json({ ok: true, line: null });
    const d = drw[0];

    // Active claims (who currently holds it)
    const { rows: claims } = await pool.query(
      `SELECT dc.user_id, dc.roles, u.name
       FROM drawing_claims dc
       LEFT JOIN users u ON u.id = dc.user_id
       WHERE dc.drawing_id=$1 AND dc.completed_at IS NULL`,
      [d.id]
    );

    // Last 5 comments
    const { rows: history } = await pool.query(
      `SELECT dc.user_id, dc.roles, dc.type, dc.created_at, u.name
       FROM drawing_comments dc
       LEFT JOIN users u ON u.id = dc.user_id
       WHERE dc.drawing_id=$1
       ORDER BY dc.created_at DESC LIMIT 5`,
      [d.id]
    );

    // Lot info
    const { rows: lotRows } = await pool.query(
      `SELECT l.lot_number, l.issued_at
       FROM lot_lines ll JOIN lots l ON l.id = ll.lot_id
       WHERE ll.drawing_id=$1
       ORDER BY l.created_at DESC LIMIT 1`,
      [d.id]
    );

    res.json({
      ok: true,
      line: {
        jobNo: d.job_no, unitNo: d.unit_no, zone: d.zone, lineNo: d.line_no,
        status: d.status, revNo: d.rev_no,
      },
      holders: claims.map(c => ({ userId: c.user_id, name: c.name, roles: c.roles })),
      history: history.map(h => ({ userId: h.user_id, name: h.name, roles: h.roles, type: h.type, createdAt: h.created_at })),
      lot: lotRows[0] ? { lotNumber: lotRows[0].lot_number, issued: !!lotRows[0].issued_at } : null,
    });
  } catch (err) {
    console.error('trackLine error:', err);
    res.status(500).json({ ok: false, error: 'Failed' });
  }
}

// GET /api/line-holds?drawingId=X  (or ?lineNo=X&jobNo=Y&unitNo=Z)
// Returns all hold declarations for a line, grouped by cycle, newest cycle first.
async function getLineHolds(req, res) {
  let { drawingId, lineNo, jobNo, unitNo } = req.query;

  // Fallback: resolve drawingId from lineNo + jobNo when caller only has line identity
  if (!drawingId && lineNo && jobNo) {
    const qParams = unitNo ? [jobNo, unitNo, lineNo] : [jobNo, lineNo];
    const qSql = unitNo
      ? `SELECT id FROM drawings WHERE job_no=$1 AND unit_no=$2 AND line_no=$3 LIMIT 1`
      : `SELECT id FROM drawings WHERE job_no=$1 AND line_no=$2 LIMIT 1`;
    const { rows: drwLookup } = await pool.query(qSql, qParams);
    if (!drwLookup[0]) return res.status(404).json({ ok: false, error: 'Drawing not found' });
    drawingId = drwLookup[0].id;
  }

  if (!drawingId) return res.status(400).json({ ok: false, error: 'drawingId or lineNo+jobNo required' });

  try {
    const { rows: drwRows } = await pool.query(
      `SELECT stored_file FROM drawings WHERE id=$1`, [drawingId]
    );
    if (!drwRows[0]) return res.status(404).json({ ok: false, error: 'Drawing not found' });

    const currentCycleNo = extractUploadCount(drwRows[0].stored_file);

    const { rows } = await pool.query(
      `SELECT dc.id, dc.user_id, u.name AS user_name, dc.roles,
              dc.hold_type, dc.hold_description, dc.cycle_no, dc.created_at
       FROM drawing_comments dc
       JOIN users u ON u.id = dc.user_id
       WHERE dc.drawing_id=$1 AND dc.hold_type IS NOT NULL
       ORDER BY dc.cycle_no DESC NULLS LAST, dc.created_at ASC`,
      [drawingId]
    );

    // Group by cycle_no
    const cycleMap = {};
    for (const row of rows) {
      const cn = row.cycle_no;
      if (!cycleMap[cn]) cycleMap[cn] = [];
      cycleMap[cn].push({
        commentId:       row.id,
        userId:          row.user_id,
        userName:        row.user_name,
        roles:           row.roles,
        holdType:        row.hold_type,
        holdDescription: row.hold_description,
        cycleNo:         cn,
        createdAt:       row.created_at,
        canRemove:       cn === currentCycleNo,
      });
    }

    const cycles = Object.keys(cycleMap)
      .map(k => (k === 'null' ? null : Number(k)))
      .sort((a, b) => (b ?? -1) - (a ?? -1));

    const holdsByCycle = cycles.map(cn => ({
      cycleNo:   cn,
      isCurrent: cn === currentCycleNo,
      holds:     cycleMap[cn],
    }));

    res.json({ ok: true, currentCycleNo, holdsByCycle });
  } catch (err) {
    console.error('getLineHolds error:', err);
    res.status(500).json({ ok: false, error: 'Failed' });
  }
}

// PATCH /api/drawing-comments/:id/hold  — clears hold_type/hold_description on a current-cycle comment.
// Only the comment creator or an SGL user on the same unit may do this.
async function removeHold(req, res) {
  const commentId = parseInt(req.params.id);
  const userId    = req.session.user.id;

  try {
    const { rows } = await pool.query(
      `SELECT dc.id, dc.user_id, dc.cycle_no,
              d.stored_file, d.job_no, d.unit_no
       FROM drawing_comments dc
       JOIN drawings d ON d.id = dc.drawing_id
       WHERE dc.id=$1`,
      [commentId]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: 'Comment not found' });
    const comment = rows[0];

    // Authorisation: creator OR SGL for this unit
    if (comment.user_id !== userId) {
      const { rows: sglCheck } = await pool.query(
        `SELECT 1 FROM user_role_assignments
         WHERE user_id=$1 AND project_id=$2 AND unit_no=$3 AND role='SGL' LIMIT 1`,
        [userId, comment.job_no, comment.unit_no]
      );
      if (sglCheck.length === 0)
        return res.status(403).json({ ok: false, error: 'Not authorised to remove this hold' });
    }

    // Only current-cycle holds can be removed
    const currentCycleNo = extractUploadCount(comment.stored_file);
    if (comment.cycle_no !== currentCycleNo)
      return res.status(400).json({ ok: false, error: 'Cannot remove holds from past cycles' });

    await pool.query(
      `UPDATE drawing_comments SET hold_type=NULL, hold_description=NULL WHERE id=$1`,
      [commentId]
    );
    res.json({ ok: true, message: 'Hold removed' });
  } catch (err) {
    console.error('removeHold error:', err);
    res.status(500).json({ ok: false, error: 'Failed' });
  }
}

module.exports = {
  getNotifications, getNotificationsByRole,
  claimNotifications, getClaimedTasks, getModellerTasks, getGLTasks, getAllTasks,
  getDrawingClaimers, forwardIsoLines, sendForSupporting, getScUsers, getModellerUsers,
  submitCheckerComments, submitGLComments, submitSGLComments, unclaimLine,
  forwardGLToModeller, trackLine,
  declareCheckerBlockingHold, declareGLBlockingHold, declareSGLBlockingHold,
  getGLFinalIsometrics, getZoneClaims,
  getLineHolds, removeHold,
  sseStream, getNotifList, markAllRead, markOneRead,
};
