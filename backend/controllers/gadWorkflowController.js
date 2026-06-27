const path = require("path");
const fs   = require("fs");
const fsp  = fs.promises;
const { pool } = require("../db/pool");
const gadQ = require("../db/queries/gadQueries");
const userQ = require("../db/queries/userQueries");
const { pushNotification, pushToRoleUsers, gadStorageDir, extractUploadCount } = require("./gadController");

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

// ── Build "Comments Received from PC, MC" status string ───────────────────

async function buildCommentsReceivedStatus(gadId) {
  const { rows } = await pool.query(
    `SELECT roles FROM gad_claims
     WHERE gad_id=$1 AND comment_type IS NOT NULL AND comment_type != 'none'
       AND completed_at IS NOT NULL`,
    [gadId]
  );
  const seen = new Set();
  rows.forEach(r => (r.roles || []).filter(x => ["PC","MC","SC"].includes(x)).forEach(x => seen.add(x)));
  const ordered = ["PC","MC","SC"].filter(r => seen.has(r));
  return ordered.length ? `Comments Received from ${ordered.join(", ")}` : "Comments Received";
}

// ── GET /api/gad/notifications  (By/Check pool for PC/MC/SC) ─────────────

async function getGADNotifications(req, res) {
  const userId = req.session.user.id;
  try {
    // Show GADs available to claim as By (Uploaded, unclaimed) or Check (Ready for Check, unclaimed)
    // User must have a PC/MC/SC assignment for that job+unit
    const { rows } = await pool.query(
      `SELECT g.*, u.name AS from_name
       FROM gads g
       LEFT JOIN users u ON u.id::text = g.uploaded_by
       WHERE (
         (g.status = 'Uploaded'         AND g.by_user_id IS NULL)
         OR (g.status = 'Ready for Check' AND g.checked_user_id IS NULL)
       )
       AND EXISTS (
         SELECT 1 FROM user_role_assignments ura
         WHERE ura.project_id = g.job_no
           AND ura.unit_no    = g.unit_no
           AND ura.user_id    = $1
           AND ura.role IN ('Process Checker','Material Checker','Stress Checker')
       )
       ORDER BY g.uploaded_on DESC`,
      [userId]
    );

    const notifications = rows.map(g => ({
      gad_id:      g.id,
      job_no:      g.job_no,
      unit_no:     g.unit_no,
      area_no:     g.area_no,
      gad_no:      g.gad_no,
      rev_no:      g.rev_no || 'R0-1',
      from_name:   g.from_name || g.uploaded_by || '—',
      created_at:  g.uploaded_on,
      status:      g.status,
      claim_role:  g.status === 'Uploaded' ? 'By' : 'Check',
    }));

    res.json({ ok: true, notifications });
  } catch (err) {
    console.error("getGADNotifications error:", err);
    res.json({ ok: false, notifications: [] });
  }
}

// ── GET /api/gad/notifications-by-role?role= ─────────────────────────────

async function getGADNotificationsByRole(req, res) {
  const { role } = req.query;
  const userId = req.session.user.id;
  if (!role) return res.status(400).json({ ok: false, error: "role required" });

  try {
    let rows = [];

    if (role === 'GL' || role === 'SGL') {
      // GL pool: Ready for GL, unclaimed
      const dbRole = role === 'GL' ? 'GL' : 'SGL';
      const poolStatus = role === 'GL' ? 'Ready for GL' : 'Ready for SGL';
      const result = await pool.query(
        `SELECT g.*, u.name AS from_name
         FROM gads g
         LEFT JOIN users u ON u.id::text = g.uploaded_by
         WHERE g.status = $1
           AND g.gl_user_id IS NULL
           AND EXISTS (
             SELECT 1 FROM user_role_assignments ura
             WHERE ura.project_id = g.job_no
               AND ura.unit_no    = g.unit_no
               AND ura.user_id    = $2
               AND ura.role       = $3
           )
         ORDER BY g.uploaded_on DESC`,
        [poolStatus, userId, dbRole]
      );
      rows = result.rows;

    } else if (role === 'Modeller') {
      // Modeller task pool: GADs returned with comments
      const result = await pool.query(
        `SELECT g.*, u.name AS from_name
         FROM gads g
         LEFT JOIN users u ON u.id::text = g.uploaded_by
         WHERE g.uploaded_by = $1::text
           AND g.status IN ('Returned (By)', 'Returned (Check)', 'Returned (GL)')
         ORDER BY g.uploaded_on DESC`,
        [userId]
      );
      rows = result.rows;
    }

    const notifications = rows.map(g => ({
      gad_id:      g.id,
      job_no:      g.job_no,
      unit_no:     g.unit_no,
      area_no:     g.area_no,
      gad_no:      g.gad_no,
      rev_no:      g.rev_no || 'R0-1',
      from_name:   g.from_name || g.uploaded_by || '—',
      created_at:  g.uploaded_on,
      status:      g.status,
    }));

    res.json({ ok: true, notifications });
  } catch (err) {
    console.error("getGADNotificationsByRole error:", err);
    res.json({ ok: false, notifications: [] });
  }
}

// ── POST /api/gad/claim-notifications ────────────────────────────────────

async function claimGADNotifications(req, res) {
  const { claims } = req.body || {};
  const userId = req.session.user.id;
  if (!Array.isArray(claims)) return res.status(400).json({ ok: false, error: "claims[] required" });

  const results = [];
  try {
    for (const claim of claims) {
      const { gadId, gadNo, jobNo, unitNo, areaNno, claimType } = claim;

      let id = gadId;
      if (!id) {
        const { rows } = await pool.query(
          `SELECT id FROM gads WHERE job_no=$1 AND unit_no=$2 AND area_no=$3 AND gad_no=$4`,
          [jobNo, unitNo, areaNno, gadNo]
        );
        if (!rows[0]) { results.push({ skipped: true, reason: 'not found' }); continue; }
        id = rows[0].id;
      }

      const gad = await gadQ.findById(id);
      if (!gad) { results.push({ skipped: true, reason: 'not found' }); continue; }

      const uid = String(userId);

      if (gad.status === 'Uploaded' && !gad.by_user_id) {
        if (claimType === 'By+Check') {
          // User claims both By and Check at once — single combined review task
          await gadQ.updateStatus(id, 'By+Check Review', { byUserId: uid, checkedUserId: uid });
          results.push({ gadId: id, role: 'By+Check', gadNo: gad.gad_no });
        } else {
          // Default: By only
          await gadQ.updateStatus(id, 'By Review', { byUserId: uid });
          results.push({ gadId: id, role: 'By', gadNo: gad.gad_no });
        }

      } else if (gad.status === 'Ready for Check' && !gad.checked_user_id) {
        await gadQ.updateStatus(id, 'Check Review', { checkedUserId: uid });
        results.push({ gadId: id, role: 'Check', gadNo: gad.gad_no });

      } else if (gad.status === 'Ready for GL' && !gad.gl_user_id) {
        await gadQ.updateStatus(id, 'GL Review', { glUserId: uid });
        results.push({ gadId: id, role: 'GL', gadNo: gad.gad_no });

      } else {
        results.push({ gadId: id, skipped: true, reason: `Status "${gad.status}" or already claimed` });
      }
    }

    const claimed = results.filter(r => !r.skipped).length;
    res.json({ ok: true, message: `${claimed} GAD(s) claimed`, results });
  } catch (err) {
    console.error("claimGADNotifications error:", err);
    res.status(500).json({ ok: false, error: "Failed to claim" });
  }
}

// ── GET /api/gad/my-claimed-tasks ─────────────────────────────────────────

async function getClaimedGADTasks(req, res) {
  const userId = req.session.user.id;
  try {
    const tasks = await gadQ.getClaimedTasks(userId);
    res.json({
      ok: true,
      tasks: tasks.map(g => ({
        id:                  g.id,
        job_no:              g.job_no,
        unit_no:             g.unit_no,
        area_no:             g.area_no,
        gad_no:              g.gad_no,
        rev_no:              g.rev_no || 'R0-1',
        status:              g.status,
        claimed_role:        g.claimed_role,
        is_combined:         g.status === 'Check Review' && g.by_user_id === g.checked_user_id,
        by_user_id:          g.by_user_id,
        checked_user_id:     g.checked_user_id,
        planned_lot_number:  g.planned_lot_number || null,
        uploaded_by:         g.uploaded_by,
        mainFile:            g.stored_file
          ? `uploads/${g.job_no}/${g.unit_no}/gad/${g.area_no}/${g.stored_file}`
          : null,
      })),
    });
  } catch (err) {
    console.error("getClaimedGADTasks error:", err);
    res.json({ ok: false, tasks: [] });
  }
}

// ── GET /api/gad/my-modeller-tasks ────────────────────────────────────────

async function getModellerGADTasks(req, res) {
  const userId = req.session.user.id;
  try {
    const tasks = await gadQ.getModellerTasks(userId);
    res.json({
      ok: true,
      tasks: tasks.map(g => ({
        id:               g.id,
        job_no:           g.job_no,
        unit_no:          g.unit_no,
        area_no:          g.area_no,
        gad_no:           g.gad_no,
        rev_no:           g.rev_no || 'R0-1',
        status:           g.status,
        uploaded_on:      g.uploaded_on,
        uploaded_by:      g.uploaded_by,
        by_user_id:       g.by_user_id,
        checked_user_id:  g.checked_user_id,
        gl_user_id:       g.gl_user_id,
        returned_by_role: g.status === 'Returned (By)'    ? 'By Reviewer'
                        : g.status === 'Returned (Check)' ? 'Checker'
                        : g.status === 'Returned (GL)'    ? 'GL/Approver'
                        : null,
        mainFile:         g.stored_file
          ? `uploads/${g.job_no}/${g.unit_no}/gad/${g.area_no}/${g.stored_file}`
          : null,
      })),
    });
  } catch (err) {
    console.error("getModellerGADTasks error:", err);
    res.json({ ok: false, tasks: [] });
  }
}

// ── GET /api/gad/my-gl-tasks ──────────────────────────────────────────────

async function getGLGADTasks(req, res) {
  const userId = req.session.user.id;
  try {
    const raw   = await gadQ.getGLTasks(userId);
    const tasks = raw.map(g => ({
      id:       g.id,
      job_no:   g.job_no,
      unit_no:  g.unit_no,
      area_no:  g.area_no,
      gad_no:   g.gad_no,
      rev_no:   g.rev_no || 'R0-1',
      status:   g.status,
      in_pool:  !g.gl_user_id,  // true = Ready for GL pool, false = my active GL Review task
      gl_user_id:      g.gl_user_id,
      uploaded_by:     g.uploaded_by,
      uploaded_on:     g.uploaded_on,
      mainFile: g.stored_file
        ? `uploads/${g.job_no}/${g.unit_no}/gad/${g.area_no}/${g.stored_file}`
        : null,
    }));
    res.json({ ok: true, tasks });
  } catch (err) {
    res.json({ ok: false, tasks: [] });
  }
}

// ── GET /api/gad/claimers?jobNo=&unitNo=&gadNo= ───────────────────────────

async function getGADClaimers(req, res) {
  const { jobNo, unitNo, gadNo } = req.query;
  if (!jobNo || !unitNo || !gadNo) return res.json({ ok: false, error: "Missing params" });
  try {
    const { rows } = await pool.query(
      `SELECT g.by_user_id, g.checked_user_id, g.gl_user_id, g.approved_by_id,
              u_by.name AS by_name,
              u_ch.name AS checked_name,
              u_gl.name AS gl_name,
              u_ap.name AS approved_by_name
       FROM gads g
       LEFT JOIN users u_by ON u_by.id::text = g.by_user_id
       LEFT JOIN users u_ch ON u_ch.id::text = g.checked_user_id
       LEFT JOIN users u_gl ON u_gl.id::text = g.gl_user_id
       LEFT JOIN users u_ap ON u_ap.id::text = g.approved_by_id
       WHERE g.job_no=$1 AND g.unit_no=$2 AND g.gad_no=$3 LIMIT 1`,
      [jobNo, unitNo, gadNo]
    );
    const g = rows[0];
    if (!g) return res.json({ ok: true, claimedBy: {} });

    const claimedBy = {};
    const isCombined = g.by_user_id && g.by_user_id === g.checked_user_id;
    if (g.by_user_id)
      claimedBy[g.by_user_id] = { role: isCombined ? 'By+Check' : 'By', name: g.by_name };
    if (g.checked_user_id && !isCombined)
      claimedBy[g.checked_user_id] = { role: 'Check', name: g.checked_name };
    if (g.gl_user_id)
      claimedBy[g.gl_user_id] = { role: 'GL', name: g.gl_name };

    res.json({ ok: true, claimedBy });
  } catch (err) {
    res.json({ ok: false, claimedBy: {} });
  }
}

// ── GET /api/gad/area-claims?project=&unit=&area= ─────────────────────────

async function getAreaClaims(req, res) {
  const { project, unit, area } = req.query;
  if (!project || !unit || !area)
    return res.status(400).json({ ok: false, error: "project, unit, area required" });
  try {
    const { rows } = await pool.query(
      `SELECT g.gad_no, g.status, g.by_user_id, g.checked_user_id, g.gl_user_id,
              u_by.name AS by_name, u_ch.name AS checked_name
       FROM gads g
       LEFT JOIN users u_by ON u_by.id::text = g.by_user_id
       LEFT JOIN users u_ch ON u_ch.id::text = g.checked_user_id
       WHERE g.job_no=$1 AND g.unit_no=$2 AND g.area_no=$3`,
      [project, unit, area]
    );
    const claims = {};
    for (const g of rows) {
      claims[g.gad_no] = {
        status:        g.status,
        byUserId:      g.by_user_id      || null,
        byName:        g.by_name         || null,
        checkedUserId: g.checked_user_id || null,
        checkedName:   g.checked_name    || null,
        glUserId:      g.gl_user_id      || null,
      };
    }
    res.json({ ok: true, claims });
  } catch (err) {
    console.error("getAreaClaims error:", err);
    res.status(500).json({ ok: false, error: "Failed to load area claims" });
  }
}

// ── POST /api/gad/unclaim ──────────────────────────────────────────────────

async function unclaimGAD(req, res) {
  const { gadNo, jobNo, gadId } = req.body || {};
  const userId = req.session.user.id;
  if (!gadNo && !gadId) return res.status(400).json({ ok: false, error: "gadNo or gadId required" });

  try {
    let gad;
    if (gadId) {
      gad = await gadQ.findById(gadId);
    } else {
      const { rows } = await pool.query(
        `SELECT * FROM gads WHERE gad_no=$1 ${jobNo ? "AND job_no=$2" : ""} ORDER BY uploaded_on DESC LIMIT 1`,
        jobNo ? [gadNo, jobNo] : [gadNo]
      );
      gad = rows[0];
    }
    if (!gad) return res.status(404).json({ ok: false, error: "GAD not found" });

    const uid = String(userId);

    if (gad.status === 'By Review' && gad.by_user_id === uid) {
      await gadQ.updateStatus(gad.id, 'Uploaded', { byUserId: null });
    } else if (gad.status === 'Check Review' && gad.checked_user_id === uid) {
      await gadQ.updateStatus(gad.id, 'Ready for Check', { checkedUserId: null });
    } else if (gad.status === 'GL Review' && gad.gl_user_id === uid) {
      await gadQ.updateStatus(gad.id, 'Ready for GL', { glUserId: null });
    } else {
      return res.status(403).json({ ok: false, error: "You are not the active reviewer for this GAD" });
    }

    res.json({ ok: true, message: "GAD unclaimed successfully" });
  } catch (err) {
    console.error("unclaimGAD error:", err);
    res.status(500).json({ ok: false, error: "Failed to unclaim" });
  }
}

// ── POST /api/gad/send-for-supporting ─────────────────────────────────────

async function sendGADForSupporting(req, res) {
  const { jobNo, unitNo, gadNo, assignedScUserId } = req.body;
  const userId = req.session.user.id;
  if (!jobNo || !unitNo || !gadNo) return res.status(400).json({ ok: false, error: "Missing fields" });

  try {
    const { rows } = await pool.query(
      `SELECT id FROM gads WHERE job_no=$1 AND unit_no=$2 AND gad_no=$3`,
      [jobNo, unitNo, gadNo]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "GAD not found" });
    const gadId = rows[0].id;

    await pool.query(`UPDATE gads SET status='Sent for Supporting Check' WHERE id=$1`, [gadId]);

    if (assignedScUserId) {
      await gadQ.upsertClaim(gadId, assignedScUserId, ["SC"]);
      await pushNotification(assignedScUserId, gadId,
        "Supporting Check Assigned",
        `GAD ${gadNo} (${jobNo}/${unitNo}) has been sent directly to you for supporting check.`);
      return res.json({ ok: true, message: "Sent directly to SC engineer" });
    }

    const { rows: prevSC } = await pool.query(
      `SELECT DISTINCT user_id FROM gad_comments WHERE gad_id=$1 AND 'SC'=ANY(roles)`, [gadId]
    );
    if (prevSC.length > 0) {
      for (const sc of prevSC) {
        await gadQ.upsertClaim(gadId, sc.user_id, ["SC"]);
        await pushNotification(sc.user_id, gadId,
          "Good for Supporting — Stress Check Required",
          `GAD ${gadNo} (${jobNo}/${unitNo}) has been sent to you for supporting check.`);
      }
      return res.json({ ok: true, message: "Sent to previous SC engineer(s)" });
    }

    await pushToRoleUsers(jobNo, unitNo, "Stress Checker", gadId,
      "GAD Available for Stress Check",
      `GAD ${gadNo} (${jobNo}/${unitNo}) has been marked good for supporting and is available for stress check.`);
    res.json({ ok: true, message: "Sent to SC pool" });
  } catch (err) {
    console.error("sendGADForSupporting error:", err);
    res.status(500).json({ ok: false, error: "Failed" });
  }
}

// ── Helper: save GL/SGL comment file ──────────────────────────────────────

// revNo is the full revision string, e.g. 'R0-1'
async function saveApproverCommentFile(jobNo, unitNo, areaNno, gadNo, revNo, suffix, gad, reqFile, commentType) {
  const baseFileName    = `${gadNo}_${revNo}`;
  const commentFileName = `${baseFileName}_${suffix}.pdf`;
  const commentsDir     = path.join(gadStorageDir(jobNo, unitNo, areaNno), "comments");
  ensureDir(commentsDir);
  const finalPath = path.join(commentsDir, commentFileName);

  if (commentType === "file" && reqFile) {
    await fsp.rename(reqFile.path, finalPath);
  } else if (commentType === "annotation") {
    const tempPath = path.join(gadStorageDir(jobNo, unitNo, areaNno), `${baseFileName}_temp.pdf`);
    if (fs.existsSync(tempPath)) await fsp.rename(tempPath, finalPath);
  } else {
    const basePath = path.join(gadStorageDir(jobNo, unitNo, areaNno), gad.stored_file);
    if (fs.existsSync(basePath)) await fsp.copyFile(basePath, finalPath);
  }

  return {
    commentFileName,
    filePath: `uploads/${jobNo}/${unitNo}/gad/${areaNno}/comments/${commentFileName}`,
  };
}

// ── POST /api/gad/submit-checker-comments ────────────────────────────────

async function submitGADCheckerComments(req, res) {
  const { jobNo, unitNo, gadNo, commentType, roles } = req.body;
  const userId = req.session.user.id;
  if (!gadNo || !commentType) return res.status(400).json({ ok: false, error: "Missing fields" });

  try {
    const parsedRoles = roles ? (Array.isArray(roles) ? roles : JSON.parse(roles)) : [];
    const { rows } = await pool.query(
      `SELECT * FROM gads WHERE job_no=$1 AND unit_no=$2 AND gad_no=$3`,
      [jobNo, unitNo, gadNo]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "GAD not found" });
    const gad = rows[0];
    const uploadCount      = extractUploadCount(gad.stored_file);
    const areaNno          = gad.area_no;
    const baseFileName     = `${gadNo}_${gad.rev_no || 'R0-1'}`;
    const holdType         = req.body.holdType        || null;
    const holdDescription  = req.body.holdDescription || null;

    const roleSortOrder = ["PC","MC","SC"];
    const sorted = parsedRoles.filter(r => roleSortOrder.includes(r))
      .sort((a, b) => roleSortOrder.indexOf(a) - roleSortOrder.indexOf(b));
    const suffix = sorted.map(r => r[0]).join("") || parsedRoles[0]?.[0] || "C";
    let commentFileName = null, filePath = null;

    if (commentType !== "none") {
      commentFileName = `${baseFileName}_${suffix}.pdf`;
      const commentsDir = path.join(gadStorageDir(jobNo, unitNo, areaNno), "comments");
      ensureDir(commentsDir);
      const finalPath = path.join(commentsDir, commentFileName);
      filePath = `uploads/${jobNo}/${unitNo}/gad/${areaNno}/comments/${commentFileName}`;

      if (commentType === "file" && req.file) {
        await fsp.rename(req.file.path, finalPath);
      } else if (commentType === "annotation") {
        const tempPath = path.join(gadStorageDir(jobNo, unitNo, areaNno), `${baseFileName}_temp.pdf`);
        if (fs.existsSync(tempPath)) await fsp.rename(tempPath, finalPath);
      } else {
        const basePath = path.join(gadStorageDir(jobNo, unitNo, areaNno), gad.stored_file);
        if (fs.existsSync(basePath)) await fsp.copyFile(basePath, finalPath);
      }

      await gadQ.upsertCommentFile(gad.id, commentFileName, filePath, parsedRoles, [userId], commentType);
    }

    await gadQ.addComment(gad.id, userId, parsedRoles, commentType, req.body.comment || null, commentFileName, filePath, null, holdType, holdDescription, uploadCount);

    await pool.query(
      `UPDATE gad_claims SET comment_type=$1, completed_at=NOW() WHERE gad_id=$2 AND user_id=$3`,
      [commentType, gad.id, userId]
    );

    // PC "no comments" → route to SC (non-stress-critical only)
    if (parsedRoles.includes("PC") && !parsedRoles.includes("SC") && commentType === "none" && gad.stress_critical !== "Y") {
      const { rows: scExisting } = await pool.query(
        `SELECT 1 FROM gad_claims WHERE gad_id=$1 AND 'SC'=ANY(roles) AND completed_at IS NULL LIMIT 1`,
        [gad.id]
      );
      if (scExisting.length === 0) {
        const { rows: prevSC } = await pool.query(
          `SELECT DISTINCT user_id FROM gad_comments WHERE gad_id=$1 AND 'SC'=ANY(roles)`,
          [gad.id]
        );
        if (prevSC.length > 0) {
          for (const sc of prevSC) {
            await gadQ.upsertClaim(gad.id, sc.user_id, ["SC"]);
            await pushNotification(sc.user_id, gad.id,
              "GAD Ready for Stress Check",
              `GAD ${gad.gad_no} (${gad.job_no}/${gad.unit_no}) has no checker comments. Please review.`);
          }
        } else {
          await pushToRoleUsers(gad.job_no, gad.unit_no, "Stress Checker", gad.id,
            "GAD Available for Stress Check",
            `GAD ${gad.gad_no} (${gad.job_no}/${gad.unit_no}) is available for supporting check.`);
        }
      }
    }

    // Check if all checker claims are done
    const { rows: allClaims } = await pool.query(
      `SELECT comment_type, completed_at FROM gad_claims
       WHERE gad_id=$1 AND roles && ARRAY['PC','MC','SC']::text[]`,
      [gad.id]
    );
    const trulyAllDone = allClaims.length > 0 && allClaims.every(c => c.completed_at !== null);

    if (trulyAllDone) {
      // Blocking hold gate
      const { rows: blockingRows } = await pool.query(
        `SELECT 1 FROM gad_comments WHERE gad_id=$1 AND cycle_no=$2 AND hold_type='blocking' LIMIT 1`,
        [gad.id, uploadCount]
      );
      if (blockingRows.length > 0) {
        const { rows: pcmcSnapshot } = await pool.query(
          `SELECT user_id, roles FROM gad_claims WHERE gad_id=$1 AND roles && ARRAY['PC','MC']::text[]`,
          [gad.id]
        );
        await pool.query(
          `UPDATE gads SET checker_reroute=$1, status='Checker Hold',
           notify_gl=FALSE, notify_modeller=FALSE, all_roles_claimed=FALSE WHERE id=$2`,
          [JSON.stringify(pcmcSnapshot), gad.id]
        );
        const targetModellerId = gad.uploaded_by && gad.uploaded_by !== "SYSTEM" ? gad.uploaded_by : null;
        if (targetModellerId) {
          await pushNotification(targetModellerId, gad.id,
            "GAD Placed on Checker Hold",
            `GAD ${gad.gad_no} (${gad.job_no}/${gad.unit_no}) has a blocking hold. Please review and re-upload.`);
        } else {
          await pushToRoleUsers(gad.job_no, gad.unit_no, "Modeller", gad.id,
            "GAD Placed on Checker Hold",
            `GAD ${gad.gad_no} (${gad.job_no}/${gad.unit_no}) has been placed on Checker Hold.`);
        }
        if (req.file?.path && fs.existsSync(req.file.path)) await fsp.unlink(req.file.path).catch(() => {});
        return res.json({ ok: true, message: "Comment submitted. GAD placed on Checker Hold." });
      }

      const hasActualComments = allClaims.some(c => c.comment_type && c.comment_type !== "none");

      if (hasActualComments) {
        const { rows: pcmcSnapshot } = await pool.query(
          `SELECT user_id, roles FROM gad_claims WHERE gad_id=$1 AND roles && ARRAY['PC','MC']::text[]`,
          [gad.id]
        );
        await pool.query(`UPDATE gads SET checker_reroute=$1 WHERE id=$2`, [JSON.stringify(pcmcSnapshot), gad.id]);

        const targetModellerId = req.body.targetModellerId ||
          (gad.uploaded_by && gad.uploaded_by !== "SYSTEM" ? gad.uploaded_by : null);
        const commentsStatus = await buildCommentsReceivedStatus(gad.id);

        if (targetModellerId) {
          await pool.query(
            `UPDATE gads SET status=$2, notify_modeller=FALSE, notify_gl=FALSE, all_roles_claimed=FALSE WHERE id=$1`,
            [gad.id, commentsStatus]
          );
          await pool.query(
            `INSERT INTO gad_claims (gad_id, user_id, roles) VALUES ($1,$2,ARRAY['Modeller'])
             ON CONFLICT (gad_id, user_id)
             DO UPDATE SET roles=ARRAY['Modeller'], claimed_at=NOW(), completed_at=NULL, comment_type=NULL`,
            [gad.id, targetModellerId]
          );
          await pushNotification(targetModellerId, gad.id,
            "Incorporation Required",
            `GAD ${gad.gad_no} (${gad.job_no}/${gad.unit_no}) has been returned to you with checker comments for incorporation.`);
        } else {
          await pool.query(
            `UPDATE gads SET status=$2, notify_modeller=TRUE, notify_gl=FALSE, all_roles_claimed=FALSE WHERE id=$1`,
            [gad.id, commentsStatus]
          );
          await pushToRoleUsers(gad.job_no, gad.unit_no, "Modeller", gad.id,
            "Comments Received — Action Required",
            `GAD ${gad.gad_no} (${gad.job_no}/${gad.unit_no}) has checker comments and is awaiting incorporation.`);
        }
      } else {
        // All no-comments — check SC gate then route to GL
        const isStressCritical = gad.stress_critical === "Y";
        if (!isStressCritical) {
          const [{ rows: scDone }, { rows: scUsers }] = await Promise.all([
            pool.query(`SELECT 1 FROM gad_claims WHERE gad_id=$1 AND 'SC'=ANY(roles) AND completed_at IS NOT NULL LIMIT 1`, [gad.id]),
            pool.query(`SELECT 1 FROM user_role_assignments WHERE project_id=$1 AND unit_no=$2 AND role='Stress Checker' LIMIT 1`, [gad.job_no, gad.unit_no]),
          ]);
          if (scUsers.length > 0 && scDone.length === 0) {
            if (req.file?.path && fs.existsSync(req.file.path)) await fsp.unlink(req.file.path).catch(() => {});
            return res.json({ ok: true, message: "Comment submitted. Awaiting SC review before GL." });
          }
        }

        const { rows: prevGL } = await pool.query(
          `SELECT DISTINCT user_id FROM gad_claims WHERE gad_id=$1 AND 'GL'=ANY(roles) AND completed_at IS NOT NULL`,
          [gad.id]
        );
        if (prevGL.length > 0) {
          await pool.query(
            `UPDATE gads SET status='Ready for GL', notify_gl=FALSE, notify_modeller=FALSE, all_roles_claimed=FALSE WHERE id=$1`,
            [gad.id]
          );
          for (const gl of prevGL) {
            await gadQ.upsertClaim(gad.id, gl.user_id, ["GL"]);
            await pushNotification(gl.user_id, gad.id,
              "GAD Ready for GL Review",
              `GAD ${gad.gad_no} (${gad.job_no}/${gad.unit_no}) has no checker comments and is ready for your GL review.`);
          }
        } else {
          await pool.query(
            `UPDATE gads SET status='Ready for GL', notify_gl=TRUE, notify_modeller=FALSE, all_roles_claimed=FALSE WHERE id=$1`,
            [gad.id]
          );
          await pushToRoleUsers(gad.job_no, gad.unit_no, "GL", gad.id,
            "GAD Ready for GL Review",
            `GAD ${gad.gad_no} (${gad.job_no}/${gad.unit_no}) has no checker comments and is ready for GL review.`);
        }
      }
    }

    if (req.file?.path && fs.existsSync(req.file.path)) await fsp.unlink(req.file.path).catch(() => {});
    res.json({ ok: true, message: "Comment submitted" });
  } catch (err) {
    console.error("submitGADCheckerComments error:", err);
    if (req.file?.path) await fsp.unlink(req.file.path).catch(() => {});
    res.status(500).json({ ok: false, error: "Failed to submit comment" });
  }
}

// ── POST /api/gad/submit-gl-comments ──────────────────────────────────────

async function submitGADGLComments(req, res) {
  const { jobNo, unitNo, gadNo, commentType } = req.body;
  const userId = req.session.user.id;
  if (!gadNo || !commentType) return res.status(400).json({ ok: false, error: "Missing fields" });

  try {
    const { rows } = await pool.query(
      `SELECT * FROM gads WHERE job_no=$1 AND unit_no=$2 AND gad_no=$3`,
      [jobNo, unitNo, gadNo]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "GAD not found" });
    const gad = rows[0];
    const holdType        = req.body.holdType        || null;
    const holdDescription = req.body.holdDescription || null;
    const cycleNo         = extractUploadCount(gad.stored_file);
    const areaNno         = gad.area_no;

    if (commentType === "approve" && holdType === "blocking") {
      if (req.file?.path) await fsp.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ ok: false, error: "Cannot approve a GAD with a blocking hold. Remove the hold or route to SGL Hold instead." });
    }

    await pool.query(
      `UPDATE gad_claims SET completed_at=NOW(), comment_type=$2 WHERE gad_id=$1 AND user_id=$3 AND completed_at IS NULL`,
      [gad.id, commentType, userId]
    );

    // ── Approve → Final ────────────────────────────────────────────────────
    if (commentType === "approve") {
      await gadQ.addComment(gad.id, userId, ["GL"], "approve", "GL Approved — Final", null, null, null, holdType, holdDescription, cycleNo);
      await pool.query(`UPDATE gads SET status='Final', notify_gl=FALSE WHERE id=$1`, [gad.id]);
      return res.json({ ok: true, message: "GAD approved and moved to Final" });
    }

    // ── Send to SGL ────────────────────────────────────────────────────────
    if (commentType === "sgl") {
      if (holdType === "blocking") {
        await gadQ.addComment(gad.id, userId, ["GL"], "sgl", req.body.comment || null, null, null, null, holdType, holdDescription, cycleNo);
        await pool.query(`UPDATE gads SET status='GL Hold', notify_gl=FALSE WHERE id=$1`, [gad.id]);
        const targetModellerId = gad.uploaded_by && gad.uploaded_by !== "SYSTEM" ? gad.uploaded_by : null;
        if (targetModellerId) {
          await pushNotification(targetModellerId, gad.id,
            "GAD Held at GL — Re-upload Required",
            `GAD ${gadNo} (${jobNo}/${unitNo}) has been placed on GL Hold. Please review and re-upload.`);
        } else {
          await pushToRoleUsers(jobNo, unitNo, "Modeller", gad.id,
            "GAD Held at GL — Re-upload Required",
            `GAD ${gadNo} (${jobNo}/${unitNo}) has been placed on GL Hold.`);
        }
        if (req.file?.path) await fsp.unlink(req.file.path).catch(() => {});
        return res.json({ ok: true, message: "GAD placed on GL Hold" });
      }
      if (holdType) await gadQ.addComment(gad.id, userId, ["GL"], "sgl", req.body.comment || null, null, null, null, holdType, holdDescription, cycleNo);
      await pool.query(`UPDATE gads SET status='Ready for SGL', notify_gl=FALSE WHERE id=$1`, [gad.id]);
      await pushToRoleUsers(jobNo, unitNo, "SGL", gad.id,
        "GAD Ready for SGL Review",
        `GAD ${gadNo} (${jobNo}/${unitNo}) has been forwarded by GL and is ready for SGL review.`);
      return res.json({ ok: true, message: "GAD sent to SGL" });
    }

    // ── Comment → route to PC ──────────────────────────────────────────────
    let commentFileName = null, commentFilePath = null;
    if (commentType === "file" || commentType === "annotation") {
      const saved = await saveApproverCommentFile(jobNo, unitNo, areaNno, gadNo, gad.rev_no || 'R0-1', "GL", gad, req.file, commentType);
      commentFileName = saved.commentFileName;
      commentFilePath = saved.filePath;
      await gadQ.upsertCommentFile(gad.id, commentFileName, commentFilePath, ["GL"], [userId], `gl_${commentType}`);
    }

    await gadQ.addComment(gad.id, userId, ["GL"], commentType, req.body.comment || null, commentFileName, commentFilePath, null, holdType, holdDescription, cycleNo);
    await pool.query(`UPDATE gads SET status='GL Commented', notify_gl=FALSE WHERE id=$1`, [gad.id]);

    const routeToSC = req.body.routeToSC === "true";
    if (routeToSC) {
      const { rows: prevSC } = await pool.query(
        `SELECT DISTINCT user_id FROM gad_claims WHERE gad_id=$1 AND 'SC'=ANY(roles) AND completed_at IS NOT NULL`,
        [gad.id]
      );
      if (prevSC.length > 0) {
        for (const sc of prevSC) {
          await pool.query(`UPDATE gad_claims SET completed_at=NULL, comment_type=NULL WHERE gad_id=$1 AND user_id=$2`, [gad.id, sc.user_id]);
          await pushNotification(sc.user_id, gad.id,
            "GL Commented — SC Review Required",
            `GL has commented on GAD ${gadNo} (${jobNo}/${unitNo}). Please re-check as Stress Checker.`);
        }
      } else {
        await pushToRoleUsers(jobNo, unitNo, "Stress Checker", gad.id,
          "GL Commented — SC Review Required",
          `GL has commented on GAD ${gadNo} (${jobNo}/${unitNo}). SC review required.`);
      }
      if (req.file?.path) await fsp.unlink(req.file.path).catch(() => {});
      return res.json({ ok: true, message: "GL comments sent to Stress Checker" });
    }

    const { rows: pcClaims } = await pool.query(
      `SELECT user_id FROM gad_claims WHERE gad_id=$1 AND 'PC'=ANY(roles) ORDER BY claimed_at DESC LIMIT 1`,
      [gad.id]
    );
    if (pcClaims[0]) {
      await pool.query(`UPDATE gad_claims SET completed_at=NULL, comment_type=NULL WHERE gad_id=$1 AND user_id=$2`, [gad.id, pcClaims[0].user_id]);
      await pushNotification(pcClaims[0].user_id, gad.id,
        "GL Commented — Review Required",
        `GL has commented on GAD ${gadNo} (${jobNo}/${unitNo}). Please re-check and address comments.`);
    }

    if (req.file?.path) await fsp.unlink(req.file.path).catch(() => {});
    res.json({ ok: true, message: "GL comments sent to Process Checker" });
  } catch (err) {
    console.error("submitGADGLComments error:", err);
    if (req.file?.path) await fsp.unlink(req.file.path).catch(() => {});
    res.status(500).json({ ok: false, error: err.message || "Failed" });
  }
}

// ── POST /api/gad/submit-sgl-comments ────────────────────────────────────

async function submitGADSGLComments(req, res) {
  const { jobNo, unitNo, gadNo, commentType, roles } = req.body;
  const userId = req.session.user.id;
  if (!gadNo || !commentType || !roles) return res.status(400).json({ ok: false, error: "Missing fields" });

  try {
    const parsedRoles = Array.isArray(roles) ? roles : JSON.parse(roles);
    const { rows } = await pool.query(
      `SELECT * FROM gads WHERE job_no=$1 AND unit_no=$2 AND gad_no=$3`,
      [jobNo, unitNo, gadNo]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "GAD not found" });
    const gad = rows[0];
    const holdType        = req.body.holdType        || null;
    const holdDescription = req.body.holdDescription || null;
    const cycleNo         = extractUploadCount(gad.stored_file);
    const areaNno         = gad.area_no;

    // ── Approve ────────────────────────────────────────────────────────────
    if (commentType === "approve") {
      if (holdType === "blocking") {
        await gadQ.addComment(gad.id, userId, ["SGL"], "approve", req.body.comment || "SGL Hold Declared", null, null, null, holdType, holdDescription, cycleNo);
        await pool.query(
          `UPDATE gads SET status='SGL Hold', notify_gl=FALSE, notify_modeller=FALSE,
           all_roles_claimed=FALSE, delegated_by_user=NULL, delegated_by_role=NULL WHERE id=$1`,
          [gad.id]
        );
        const targetModellerId = gad.uploaded_by && gad.uploaded_by !== "SYSTEM" ? gad.uploaded_by : null;
        if (targetModellerId) {
          await pushNotification(targetModellerId, gad.id,
            "GAD Held at SGL — Re-upload Required",
            `GAD ${gadNo} (${jobNo}/${unitNo}) has been placed on SGL Hold. Please review and re-upload.`);
        } else {
          await pushToRoleUsers(jobNo, unitNo, "Modeller", gad.id,
            "GAD Held at SGL — Re-upload Required",
            `GAD ${gadNo} (${jobNo}/${unitNo}) has been placed on SGL Hold.`);
        }
        if (req.file?.path) await fsp.unlink(req.file.path).catch(() => {});
        return res.json({ ok: true, message: "GAD placed on SGL Hold" });
      }

      await pool.query(
        `UPDATE gads SET status='Final', notify_gl=FALSE, notify_modeller=FALSE,
         all_roles_claimed=FALSE, delegated_by_user=NULL, delegated_by_role=NULL WHERE id=$1`,
        [gad.id]
      );
      await gadQ.clearAllClaims(gad.id);
      await gadQ.addComment(gad.id, userId, ["SGL"], "approve", "SGL Approved — Final", null, null, null, holdType, holdDescription, cycleNo);
      if (req.file?.path) await fsp.unlink(req.file.path).catch(() => {});
      return res.json({ ok: true, message: "GAD approved — added to Final" });
    }

    // ── Post comments to PC ────────────────────────────────────────────────
    const { commentFileName, filePath } = await saveApproverCommentFile(
      jobNo, unitNo, areaNno, gadNo, gad.rev_no || 'R0-1', "PMSAA", gad, req.file, commentType
    );

    await gadQ.upsertCommentFile(gad.id, commentFileName, filePath, ["SGL"], [userId], `sgl_${commentType}`);
    await gadQ.addComment(gad.id, userId, ["SGL"], commentType, req.body.comment || null, commentFileName, filePath, parsedRoles, holdType, holdDescription, cycleNo);

    await gadQ.clearAllClaims(gad.id);
    const performers = req.body.rolePerformers ? JSON.parse(req.body.rolePerformers) : {};
    for (const roleStr of parsedRoles) {
      const key = roleStr === "Process Checker" ? "PC" : roleStr === "Material Checker" ? "MC" : roleStr === "Stress Checker" ? "SC" : roleStr;
      const performer = performers[key];
      if (performer?.id) {
        await gadQ.upsertClaim(gad.id, performer.id, [key]);
        await pushNotification(performer.id, gad.id,
          "SGL Comments — Action Required",
          `GAD ${gadNo} (${jobNo}/${unitNo}) has SGL comments awaiting your action.`);
      }
    }
    await pool.query(
      `UPDATE gads SET status='SGL Commented - Delegated', delegated_by_user=$2, delegated_by_role='SGL', delegated_at=NOW() WHERE id=$1`,
      [gad.id, userId]
    );

    if (req.file?.path) await fsp.unlink(req.file.path).catch(() => {});
    res.json({ ok: true, message: "SGL comments sent to Process Checker" });
  } catch (err) {
    console.error("submitGADSGLComments error:", err);
    if (req.file?.path) await fsp.unlink(req.file.path).catch(() => {});
    res.status(500).json({ ok: false, error: "Failed to submit SGL comments" });
  }
}

// ── GET /api/gad/holds?gadId= or ?gadNo=&jobNo= ───────────────────────────

async function getGADHolds(req, res) {
  let { gadId, gadNo, jobNo, unitNo } = req.query;
  if (!gadId && gadNo && jobNo) {
    const qp = unitNo ? [jobNo, unitNo, gadNo] : [jobNo, gadNo];
    const qs = unitNo
      ? `SELECT id FROM gads WHERE job_no=$1 AND unit_no=$2 AND gad_no=$3 LIMIT 1`
      : `SELECT id FROM gads WHERE job_no=$1 AND gad_no=$2 LIMIT 1`;
    const { rows } = await pool.query(qs, qp);
    if (!rows[0]) return res.status(404).json({ ok: false, error: "GAD not found" });
    gadId = rows[0].id;
  }
  if (!gadId) return res.status(400).json({ ok: false, error: "gadId or gadNo+jobNo required" });

  try {
    const { rows: gadRows } = await pool.query(`SELECT stored_file FROM gads WHERE id=$1`, [gadId]);
    if (!gadRows[0]) return res.status(404).json({ ok: false, error: "GAD not found" });
    const currentCycleNo = extractUploadCount(gadRows[0].stored_file);

    const { rows } = await pool.query(
      `SELECT gc.id, gc.user_id, u.name AS user_name, gc.roles,
              gc.hold_type, gc.hold_description, gc.cycle_no, gc.created_at
       FROM gad_comments gc
       JOIN users u ON u.id = gc.user_id
       WHERE gc.gad_id=$1 AND gc.hold_type IS NOT NULL
       ORDER BY gc.cycle_no DESC NULLS LAST, gc.created_at ASC`,
      [gadId]
    );

    const cycleMap = {};
    for (const row of rows) {
      const cn = row.cycle_no;
      if (!cycleMap[cn]) cycleMap[cn] = [];
      cycleMap[cn].push({
        commentId: row.id, userId: row.user_id, userName: row.user_name,
        roles: row.roles, holdType: row.hold_type, holdDescription: row.hold_description,
        cycleNo: cn, createdAt: row.created_at, canRemove: cn === currentCycleNo,
      });
    }

    const cycles = Object.keys(cycleMap)
      .map(k => (k === "null" ? null : Number(k)))
      .sort((a, b) => (b ?? -1) - (a ?? -1));
    const holdsByCycle = cycles.map(cn => ({ cycleNo: cn, isCurrent: cn === currentCycleNo, holds: cycleMap[cn] }));
    res.json({ ok: true, currentCycleNo, holdsByCycle });
  } catch (err) {
    console.error("getGADHolds error:", err);
    res.status(500).json({ ok: false, error: "Failed" });
  }
}

// ── PATCH /api/gad/comments/:id/hold ──────────────────────────────────────

async function removeGADHold(req, res) {
  const commentId = parseInt(req.params.id);
  const userId    = req.session.user.id;

  try {
    const { rows } = await pool.query(
      `SELECT gc.id, gc.user_id, gc.cycle_no, g.stored_file, g.job_no, g.unit_no
       FROM gad_comments gc JOIN gads g ON g.id = gc.gad_id
       WHERE gc.id=$1`,
      [commentId]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "Comment not found" });
    const comment = rows[0];

    if (comment.user_id !== userId) {
      const { rows: sglCheck } = await pool.query(
        `SELECT 1 FROM user_role_assignments WHERE user_id=$1 AND project_id=$2 AND unit_no=$3 AND role='SGL' LIMIT 1`,
        [userId, comment.job_no, comment.unit_no]
      );
      if (sglCheck.length === 0)
        return res.status(403).json({ ok: false, error: "Not authorised to remove this hold" });
    }

    const currentCycleNo = extractUploadCount(comment.stored_file);
    if (comment.cycle_no !== currentCycleNo)
      return res.status(400).json({ ok: false, error: "Cannot remove holds from past cycles" });

    await pool.query(`UPDATE gad_comments SET hold_type=NULL, hold_description=NULL WHERE id=$1`, [commentId]);
    res.json({ ok: true, message: "Hold removed" });
  } catch (err) {
    console.error("removeGADHold error:", err);
    res.status(500).json({ ok: false, error: "Failed" });
  }
}

// ── POST /api/gad/forward-gl-to-modeller ──────────────────────────────────

async function forwardGADGLToModeller(req, res) {
  const { jobNo, unitNo, gadNo, forwardType, comment, targetModellerId } = req.body;
  const userId = req.session.user.id;
  if (!gadNo || !forwardType) return res.status(400).json({ ok: false, error: "Missing fields" });

  try {
    const { rows } = await pool.query(
      `SELECT * FROM gads WHERE job_no=$1 AND unit_no=$2 AND gad_no=$3`,
      [jobNo, unitNo, gadNo]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "GAD not found" });
    const gad = rows[0];
    const areaNno = gad.area_no;

    if (gad.status !== "GL Commented")
      return res.status(400).json({ ok: false, error: "GAD is not in GL Commented status" });

    if (forwardType === "edit") {
      const baseFileName = `${gadNo}_${gad.rev_no || 'R0-1'}`;
      const { rows: userClaims } = await pool.query(
        `SELECT roles FROM gad_claims WHERE gad_id=$1 AND user_id=$2 AND completed_at IS NULL LIMIT 1`,
        [gad.id, userId]
      );
      const forwarderRole = userClaims[0]?.roles?.find(r => ["PC","SC"].includes(r)) || "PC";
      const suffix        = forwarderRole === "SC" ? "S" : "P";
      const commentFileName = `${baseFileName}_${suffix}_GL_FWD.pdf`;
      const commentsDir   = path.join(gadStorageDir(jobNo, unitNo, areaNno), "comments");
      ensureDir(commentsDir);
      const finalPath  = path.join(commentsDir, commentFileName);
      const filePath   = `uploads/${jobNo}/${unitNo}/gad/${areaNno}/comments/${commentFileName}`;
      if (req.file) {
        await fsp.rename(req.file.path, finalPath);
      } else {
        const basePath = path.join(gadStorageDir(jobNo, unitNo, areaNno), gad.stored_file);
        if (fs.existsSync(basePath)) await fsp.copyFile(basePath, finalPath);
      }
      await gadQ.addComment(gad.id, userId, [forwarderRole], "file",
        comment || "Forwarding GL comments to Modeller with notes", commentFileName, filePath, null);
    }

    const { rows: pcmcSnapshot } = await pool.query(
      `SELECT user_id, roles FROM gad_claims WHERE gad_id=$1 AND roles && ARRAY['PC','MC']::text[]`,
      [gad.id]
    );
    await pool.query(`UPDATE gads SET checker_reroute=$1 WHERE id=$2`, [JSON.stringify(pcmcSnapshot), gad.id]);

    const effectiveModellerId =
      (targetModellerId && targetModellerId !== "SYSTEM") ? targetModellerId :
      (gad.uploaded_by && gad.uploaded_by !== "SYSTEM" ? gad.uploaded_by : null);

    const notifTitle = "Incorporation Required — GL Comments";
    const notifMsg   = forwardType === "direct"
      ? `GL has commented on GAD ${gadNo} (${jobNo}/${unitNo}). Please incorporate GL's comments and re-upload.`
      : `GL has commented on GAD ${gadNo} (${jobNo}/${unitNo}). PC/SC have added notes. Please incorporate and re-upload.`;

    const commentsStatus = await buildCommentsReceivedStatus(gad.id);

    if (effectiveModellerId) {
      await pool.query(
        `UPDATE gads SET status=$2, notify_modeller=FALSE, notify_gl=FALSE, all_roles_claimed=FALSE WHERE id=$1`,
        [gad.id, commentsStatus]
      );
      await pool.query(
        `INSERT INTO gad_claims (gad_id, user_id, roles) VALUES ($1,$2,ARRAY['Modeller'])
         ON CONFLICT (gad_id, user_id)
         DO UPDATE SET roles=ARRAY['Modeller'], claimed_at=NOW(), completed_at=NULL, comment_type=NULL`,
        [gad.id, effectiveModellerId]
      );
      await pushNotification(effectiveModellerId, gad.id, notifTitle, notifMsg);
    } else {
      await pool.query(
        `UPDATE gads SET status=$2, notify_modeller=TRUE, notify_gl=FALSE, all_roles_claimed=FALSE WHERE id=$1`,
        [gad.id, commentsStatus]
      );
      await pushToRoleUsers(jobNo, unitNo, "Modeller", gad.id, notifTitle, notifMsg);
    }

    await pool.query(
      `UPDATE gad_claims SET completed_at=NOW(), comment_type=$1 WHERE gad_id=$2 AND user_id=$3 AND completed_at IS NULL`,
      [forwardType === "edit" ? "file" : "forward", gad.id, userId]
    );

    if (req.file?.path) await fsp.unlink(req.file.path).catch(() => {});
    res.json({ ok: true, message: "GL commented GAD forwarded to Modeller" });
  } catch (err) {
    console.error("forwardGADGLToModeller error:", err);
    if (req.file?.path) await fsp.unlink(req.file.path).catch(() => {});
    res.status(500).json({ ok: false, error: "Failed to forward to Modeller" });
  }
}

// ── POST /api/gad/submit-by-review ────────────────────────────────────────
// By reviewer submits their review. No comments → advances to Check Review
// (auto-assign same person if they're also a Checker) or Ready for Check pool.
// With comments → Returned (By), notifies modeller.

async function submitByReview(req, res) {
  const { gadId, commentType, comment } = req.body;
  const userId = req.session.user.id;
  if (!gadId || !commentType)
    return res.status(400).json({ ok: false, error: 'gadId and commentType required' });

  try {
    const gad = await gadQ.findById(gadId);
    if (!gad) return res.status(404).json({ ok: false, error: 'GAD not found' });

    if (gad.status !== 'By Review') {
      if (req.file?.path) await fsp.unlink(req.file.path).catch(() => {});
      return res.status(409).json({ ok: false, error: `GAD is not in By Review status (current: ${gad.status})` });
    }
    if (gad.by_user_id !== String(userId)) {
      if (req.file?.path) await fsp.unlink(req.file.path).catch(() => {});
      return res.status(403).json({ ok: false, error: 'You are not the By reviewer for this GAD' });
    }

    const { job_no: jobNo, unit_no: unitNo, area_no: areaNno, gad_no: gadNo } = gad;
    const revNo   = gad.rev_no   || 'R0-1';
    const cycleNo = gad.upload_count || 1;

    let commentFileName = null, filePath = null;
    if (commentType !== 'none' && commentType !== 'text') {
      commentFileName = `${gadNo}_${revNo}_By.pdf`;
      const commentsDir = path.join(gadStorageDir(jobNo, unitNo, areaNno), 'comments');
      ensureDir(commentsDir);
      const finalPath = path.join(commentsDir, commentFileName);
      filePath = `uploads/${jobNo}/${unitNo}/gad/${areaNno}/comments/${commentFileName}`;

      if (commentType === 'file' && req.file) {
        await fsp.rename(req.file.path, finalPath);
      } else if (commentType === 'annotation') {
        const tempPath = path.join(gadStorageDir(jobNo, unitNo, areaNno), `${gadNo}_${revNo}_temp.pdf`);
        if (fs.existsSync(tempPath)) await fsp.rename(tempPath, finalPath);
      } else {
        const basePath = path.join(gadStorageDir(jobNo, unitNo, areaNno), gad.stored_file);
        if (fs.existsSync(basePath)) await fsp.copyFile(basePath, finalPath);
      }
      await gadQ.upsertCommentFile(gad.id, commentFileName, filePath, ['By'], [userId], commentType);
    }

    await gadQ.addComment(gad.id, userId, ['By'], commentType, comment || null,
      commentFileName, filePath, null, null, null, cycleNo);

    const hasComments = commentType !== 'none';

    if (hasComments) {
      await gadQ.updateStatus(gad.id, 'Returned (By)', {});
      if (gad.uploaded_by) {
        await pushNotification(gad.uploaded_by, gad.id,
          'GAD Returned — By Comments',
          `GAD ${gadNo} (${jobNo}/${unitNo}) has been returned with By-reviewer comments. Please incorporate and re-upload.`);
      }
    } else {
      if (gad.checked_user_id) {
        // Cycle 2+: same checker already assigned — go directly to their task
        await gadQ.updateStatus(gad.id, 'Check Review', { checkedUserId: gad.checked_user_id });
        await pushNotification(gad.checked_user_id, gad.id,
          'GAD Ready for Check Review',
          `GAD ${gadNo} (${jobNo}/${unitNo}) By review complete — assigned directly to you for Check review.`);
      } else {
        // Cycle 1: no checker yet — go to Check pool
        await gadQ.updateStatus(gad.id, 'Ready for Check', {});
        const notifTitle = 'GAD Ready for Check Review';
        const notifBody  = `GAD ${gadNo} (${jobNo}/${unitNo}) By review complete — available for Checker to claim.`;
        await Promise.all([
          pushToRoleUsers(jobNo, unitNo, 'Process Checker',  gad.id, notifTitle, notifBody),
          pushToRoleUsers(jobNo, unitNo, 'Material Checker', gad.id, notifTitle, notifBody),
          pushToRoleUsers(jobNo, unitNo, 'Stress Checker',   gad.id, notifTitle, notifBody),
        ]);
      }
    }

    if (req.file?.path && fs.existsSync(req.file.path)) await fsp.unlink(req.file.path).catch(() => {});
    res.json({
      ok: true,
      message: hasComments ? 'Comments returned to modeller' : 'By review submitted — GAD ready for Check',
    });
  } catch (err) {
    console.error('submitByReview error:', err);
    if (req.file?.path) await fsp.unlink(req.file.path).catch(() => {});
    res.status(500).json({ ok: false, error: 'Failed to submit By review' });
  }
}

// ── POST /api/gad/submit-bycheckReview ──────────────────────────────────
// Combined By+Check reviewer submits. No comments → Ready for GL.
// With comments → Returned (By), both reviewer IDs kept so resubmit comes back here.

async function submitByCheckReview(req, res) {
  const { gadId, commentType, comment } = req.body;
  const userId = req.session.user.id;
  if (!gadId || !commentType)
    return res.status(400).json({ ok: false, error: 'gadId and commentType required' });

  try {
    const gad = await gadQ.findById(gadId);
    if (!gad) return res.status(404).json({ ok: false, error: 'GAD not found' });

    if (gad.status !== 'By+Check Review') {
      if (req.file?.path) await fsp.unlink(req.file.path).catch(() => {});
      return res.status(409).json({ ok: false, error: `GAD is not in By+Check Review status (current: ${gad.status})` });
    }
    if (gad.by_user_id !== String(userId)) {
      if (req.file?.path) await fsp.unlink(req.file.path).catch(() => {});
      return res.status(403).json({ ok: false, error: 'You are not the By+Check reviewer for this GAD' });
    }

    const { job_no: jobNo, unit_no: unitNo, area_no: areaNno, gad_no: gadNo } = gad;
    const revNo   = gad.rev_no   || 'R0-1';
    const cycleNo = gad.upload_count || 1;

    let commentFileName = null, filePath = null;
    if (commentType !== 'none' && commentType !== 'text') {
      commentFileName = `${gadNo}_${revNo}_ByChk.pdf`;
      const commentsDir = path.join(gadStorageDir(jobNo, unitNo, areaNno), 'comments');
      ensureDir(commentsDir);
      const finalPath = path.join(commentsDir, commentFileName);
      filePath = `uploads/${jobNo}/${unitNo}/gad/${areaNno}/comments/${commentFileName}`;

      if (commentType === 'file' && req.file) {
        await fsp.rename(req.file.path, finalPath);
      } else if (commentType === 'annotation') {
        const tempPath = path.join(gadStorageDir(jobNo, unitNo, areaNno), `${gadNo}_${revNo}_temp.pdf`);
        if (fs.existsSync(tempPath)) await fsp.rename(tempPath, finalPath);
      } else {
        const basePath = path.join(gadStorageDir(jobNo, unitNo, areaNno), gad.stored_file);
        if (fs.existsSync(basePath)) await fsp.copyFile(basePath, finalPath);
      }
      await gadQ.upsertCommentFile(gad.id, commentFileName, filePath, ['By', 'Check'], [userId], commentType);
    }

    await gadQ.addComment(gad.id, userId, ['By', 'Check'], commentType, comment || null,
      commentFileName, filePath, null, null, null, cycleNo);

    const hasComments = commentType !== 'none';

    if (hasComments) {
      // Both reviewer IDs stay set — resubmit will restore By+Check Review
      await gadQ.updateStatus(gad.id, 'Returned (By)', {});
      if (gad.uploaded_by) {
        await pushNotification(gad.uploaded_by, gad.id,
          'GAD Returned — By+Check Comments',
          `GAD ${gadNo} (${jobNo}/${unitNo}) has been returned with comments. Please incorporate and re-upload.`);
      }
    } else {
      if (gad.gl_user_id) {
        // Cycle 2+: same GL already assigned — go directly to their task
        await gadQ.updateStatus(gad.id, 'GL Review', { glUserId: gad.gl_user_id });
        await pushNotification(gad.gl_user_id, gad.id,
          'GAD Ready for GL Approval',
          `GAD ${gadNo} (${jobNo}/${unitNo}) has passed By+Check review and is ready for your approval.`);
      } else {
        // Cycle 1: no GL yet — go to Ready for GL pool
        await gadQ.updateStatus(gad.id, 'Ready for GL', {});
        await pushToRoleUsers(jobNo, unitNo, 'GL', gad.id,
          'GAD Ready for GL Approval',
          `GAD ${gadNo} (${jobNo}/${unitNo}) has passed By+Check review and is ready for GL approval.`);
      }
    }

    if (req.file?.path && fs.existsSync(req.file.path)) await fsp.unlink(req.file.path).catch(() => {});
    res.json({
      ok: true,
      message: hasComments ? 'Comments returned to modeller' : 'By+Check review submitted — GAD sent to GL',
    });
  } catch (err) {
    console.error('submitByCheckReview error:', err);
    if (req.file?.path) await fsp.unlink(req.file.path).catch(() => {});
    res.status(500).json({ ok: false, error: 'Failed to submit By+Check review' });
  }
}

// ── POST /api/gad/submit-check-review ────────────────────────────────────
// Checker submits their review. No comments → Ready for GL (notifies GL pool).
// With comments → Returned (Check), notifies modeller directly.

async function submitCheckReview(req, res) {
  const { gadId, commentType, comment } = req.body;
  const userId = req.session.user.id;
  if (!gadId || !commentType)
    return res.status(400).json({ ok: false, error: 'gadId and commentType required' });

  try {
    const gad = await gadQ.findById(gadId);
    if (!gad) return res.status(404).json({ ok: false, error: 'GAD not found' });

    if (gad.status !== 'Check Review') {
      if (req.file?.path) await fsp.unlink(req.file.path).catch(() => {});
      return res.status(409).json({ ok: false, error: `GAD is not in Check Review status (current: ${gad.status})` });
    }
    if (gad.checked_user_id !== String(userId)) {
      if (req.file?.path) await fsp.unlink(req.file.path).catch(() => {});
      return res.status(403).json({ ok: false, error: 'You are not the Checker for this GAD' });
    }

    const { job_no: jobNo, unit_no: unitNo, area_no: areaNno, gad_no: gadNo } = gad;
    const revNo   = gad.rev_no   || 'R0-1';
    const cycleNo = gad.upload_count || 1;

    let commentFileName = null, filePath = null;
    if (commentType !== 'none' && commentType !== 'text') {
      commentFileName = `${gadNo}_${revNo}_Ch.pdf`;
      const commentsDir = path.join(gadStorageDir(jobNo, unitNo, areaNno), 'comments');
      ensureDir(commentsDir);
      const finalPath = path.join(commentsDir, commentFileName);
      filePath = `uploads/${jobNo}/${unitNo}/gad/${areaNno}/comments/${commentFileName}`;

      if (commentType === 'file' && req.file) {
        await fsp.rename(req.file.path, finalPath);
      } else if (commentType === 'annotation') {
        const tempPath = path.join(gadStorageDir(jobNo, unitNo, areaNno), `${gadNo}_${revNo}_temp.pdf`);
        if (fs.existsSync(tempPath)) await fsp.rename(tempPath, finalPath);
      } else {
        const basePath = path.join(gadStorageDir(jobNo, unitNo, areaNno), gad.stored_file);
        if (fs.existsSync(basePath)) await fsp.copyFile(basePath, finalPath);
      }
      await gadQ.upsertCommentFile(gad.id, commentFileName, filePath, ['Check'], [userId], commentType);
    }

    await gadQ.addComment(gad.id, userId, ['Check'], commentType, comment || null,
      commentFileName, filePath, null, null, null, cycleNo);

    const hasComments = commentType !== 'none';

    if (hasComments) {
      // Return directly to modeller — the same Checker will review again after resubmit
      await gadQ.updateStatus(gad.id, 'Returned (Check)', {});
      if (gad.uploaded_by) {
        await pushNotification(gad.uploaded_by, gad.id,
          'GAD Returned — Checker Comments',
          `GAD ${gadNo} (${jobNo}/${unitNo}) has been returned with Checker comments. Please incorporate and re-upload.`);
      }
    } else {
      if (gad.gl_user_id) {
        // Cycle 2+: same GL already assigned — go directly to their task
        await gadQ.updateStatus(gad.id, 'GL Review', { glUserId: gad.gl_user_id });
        await pushNotification(gad.gl_user_id, gad.id,
          'GAD Ready for GL Approval',
          `GAD ${gadNo} (${jobNo}/${unitNo}) has passed Checker review and is ready for your approval.`);
      } else {
        // Cycle 1: no GL yet — go to Ready for GL pool
        await gadQ.updateStatus(gad.id, 'Ready for GL', {});
        await pushToRoleUsers(jobNo, unitNo, 'GL', gad.id,
          'GAD Ready for GL Approval',
          `GAD ${gadNo} (${jobNo}/${unitNo}) has passed Checker review and is ready for GL approval.`);
      }
    }

    if (req.file?.path && fs.existsSync(req.file.path)) await fsp.unlink(req.file.path).catch(() => {});
    res.json({
      ok: true,
      message: hasComments ? 'Comments returned to modeller' : 'Check review submitted — GAD sent to GL',
    });
  } catch (err) {
    console.error('submitCheckReview error:', err);
    if (req.file?.path) await fsp.unlink(req.file.path).catch(() => {});
    res.status(500).json({ ok: false, error: 'Failed to submit Check review' });
  }
}

// ── POST /api/gad/submit-gl-review ───────────────────────────────────────
// GL submits approval or returns with comments.
// approve → Final (approved_by_id set).
// any comment type → Returned (GL), modeller notified; same GL reviews after resubmit.

async function submitGLReview(req, res) {
  const { gadId, commentType, comment } = req.body;
  const userId = req.session.user.id;
  if (!gadId || !commentType)
    return res.status(400).json({ ok: false, error: 'gadId and commentType required' });

  try {
    const gad = await gadQ.findById(gadId);
    if (!gad) return res.status(404).json({ ok: false, error: 'GAD not found' });

    const validStatuses = ['Ready for GL', 'GL Review'];
    if (!validStatuses.includes(gad.status)) {
      if (req.file?.path) await fsp.unlink(req.file.path).catch(() => {});
      return res.status(409).json({ ok: false, error: `GAD is not in GL Review or Ready for GL status (current: ${gad.status})` });
    }

    const uid = String(userId);

    // Verify GL role for this project+unit
    const { rows: glCheck } = await pool.query(
      `SELECT 1 FROM user_role_assignments
       WHERE project_id=$1 AND unit_no=$2 AND user_id=$3 AND role='GL' LIMIT 1`,
      [gad.job_no, gad.unit_no, userId]
    );
    if (!glCheck.length) {
      if (req.file?.path) await fsp.unlink(req.file.path).catch(() => {});
      return res.status(403).json({ ok: false, error: 'You are not assigned as GL for this project/unit' });
    }

    // If pool (Ready for GL, unclaimed) — auto-claim on submit
    if (!gad.gl_user_id) {
      await gadQ.updateStatus(gad.id, 'GL Review', { glUserId: uid });
    } else if (gad.gl_user_id !== uid) {
      if (req.file?.path) await fsp.unlink(req.file.path).catch(() => {});
      return res.status(403).json({ ok: false, error: 'This GAD is already claimed by a different GL reviewer' });
    }

    const { job_no: jobNo, unit_no: unitNo, area_no: areaNno, gad_no: gadNo } = gad;
    const revNo   = gad.rev_no   || 'R0-1';
    const cycleNo = gad.upload_count || 1;

    // ── Approve → Final ────────────────────────────────────────────────────
    if (commentType === 'approve') {
      await gadQ.addComment(gad.id, userId, ['GL'], 'approve', 'GL Approved — Final',
        null, null, null, null, null, cycleNo);
      await gadQ.updateStatus(gad.id, 'Final', { approvedById: uid, glUserId: uid });
      if (req.file?.path) await fsp.unlink(req.file.path).catch(() => {});
      return res.json({ ok: true, message: 'GAD approved — status set to Final' });
    }

    // ── Return with comments ───────────────────────────────────────────────
    let commentFileName = null, filePath = null;
    if (commentType !== 'text') {
      commentFileName = `${gadNo}_${revNo}_GL.pdf`;
      const commentsDir = path.join(gadStorageDir(jobNo, unitNo, areaNno), 'comments');
      ensureDir(commentsDir);
      const finalPath = path.join(commentsDir, commentFileName);
      filePath = `uploads/${jobNo}/${unitNo}/gad/${areaNno}/comments/${commentFileName}`;

      if (commentType === 'file' && req.file) {
        await fsp.rename(req.file.path, finalPath);
      } else if (commentType === 'annotation') {
        const tempPath = path.join(gadStorageDir(jobNo, unitNo, areaNno), `${gadNo}_${revNo}_temp.pdf`);
        if (fs.existsSync(tempPath)) await fsp.rename(tempPath, finalPath);
      } else {
        const basePath = path.join(gadStorageDir(jobNo, unitNo, areaNno), gad.stored_file);
        if (fs.existsSync(basePath)) await fsp.copyFile(basePath, finalPath);
      }
      await gadQ.upsertCommentFile(gad.id, commentFileName, filePath, ['GL'], [userId], commentType);
    }

    await gadQ.addComment(gad.id, userId, ['GL'], commentType, comment || null,
      commentFileName, filePath, null, null, null, cycleNo);

    // Keep gl_user_id intact so modellerResubmit routes back to this same GL
    await gadQ.updateStatus(gad.id, 'Returned (GL)', {});
    if (gad.uploaded_by) {
      await pushNotification(gad.uploaded_by, gad.id,
        'GAD Returned — GL Comments',
        `GAD ${gadNo} (${jobNo}/${unitNo}) has been returned with GL comments. Please incorporate and re-upload.`);
    }

    if (req.file?.path && fs.existsSync(req.file.path)) await fsp.unlink(req.file.path).catch(() => {});
    res.json({ ok: true, message: 'GL comments returned to modeller' });
  } catch (err) {
    console.error('submitGLReview error:', err);
    if (req.file?.path) await fsp.unlink(req.file.path).catch(() => {});
    res.status(500).json({ ok: false, error: 'Failed to submit GL review' });
  }
}

module.exports = {
  getGADNotifications, getGADNotificationsByRole,
  claimGADNotifications, getClaimedGADTasks, getModellerGADTasks, getGLGADTasks,
  getGADClaimers, getAreaClaims,
  unclaimGAD, sendGADForSupporting,
  submitGADCheckerComments, submitGADGLComments, submitGADSGLComments,
  forwardGADGLToModeller,
  submitByReview, submitByCheckReview, submitCheckReview, submitGLReview,
  getGADHolds, removeGADHold,
};
