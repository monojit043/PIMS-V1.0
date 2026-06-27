const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const drawingQ = require("../db/queries/drawingQueries");
const stressQ = require("../db/queries/stressQueries");
const userQ = require("../db/queries/userQueries");
const { pool } = require("../db/pool");
const sse = require("../utils/sse");
const isoPreCheck = require("../services/isoPreCheckService");

const UPLOADS_ROOT = path.join(__dirname, "..", "uploads");

async function pushNotification(userId, drawingId, title, body, type = 'task') {
  try {
    const { rows } = await pool.query(
      `INSERT INTO live_notifications (user_id, drawing_id, title, body, type) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [userId, drawingId, title, body, type]
    );
    sse.emitToUser(userId, 'notification', rows[0]);
    console.log(`[NOTIF] Inserted id=${rows[0].id} for user ${userId}: "${title}"`);
  } catch (e) { console.error('[NOTIF ERROR] pushNotification:', e.message); }
}

async function pushToRoleUsers(jobNo, unitNo, role, drawingId, title, body, type = 'pool') {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT u.id FROM users u
       JOIN user_role_assignments ura ON ura.user_id = u.id
       WHERE ura.project_id = $1 AND ura.unit_no = $2 AND ura.role = $3`,
      [jobNo, unitNo, role]
    );
    console.log(`[NOTIF] pushToRoleUsers(${jobNo}/${unitNo}, ${role}): found ${rows.length} users`);
    await Promise.all(rows.map(r => pushNotification(r.id, drawingId, title, body, type)));
  } catch (e) { console.error('[NOTIF ERROR] pushToRoleUsers:', e.message); }
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function extractUploadCount(storedFile) {
  if (!storedFile) return 1;
  const m = storedFile.match(/_R\d+-(\d+)\.pdf$/);
  return m ? parseInt(m[1], 10) : 1;
}

// GET /api/tree
async function getTree(req, res) {
  try {
    const tree = await drawingQ.getTree(req.query.jobNo || null);
    res.json({ ok: true, projects: tree });
  } catch (err) {
    console.error("getTree error:", err);
    res.json({ ok: false, projects: {} });
  }
}

// GET /api/isos?project=&unit=&zone=
async function getISOs(req, res) {
  const { project, unit, zone } = req.query;
  if (!project || !unit || !zone)
    return res.status(400).json({ ok: false, error: "project, unit, zone required" });

  try {
    const { rows } = await require("../db/pool").pool.query(
      `SELECT d.*,
         (SELECT CASE
            WHEN bool_or(dc.hold_type = 'blocking') THEN 'blocking'
            WHEN bool_or(dc.hold_type = 'minor')    THEN 'minor'
            ELSE NULL
          END
          FROM drawing_comments dc
          WHERE dc.drawing_id = d.id
            AND dc.hold_type IS NOT NULL
            AND dc.cycle_no = (regexp_match(d.stored_file, '_R\\d+-(\\d+)\\.pdf$'))[1]::int
            AND dc.rev_no = d.rev_no
         ) AS hold_severity,
         -- Revision-aware: only show as issued if the issued snapshot matches the
         -- CURRENT file, not a past revision's (same fix as getGLFinalIsometrics).
         (SELECT l.lot_number FROM lot_lines ll JOIN lots l ON l.id = ll.lot_id
          WHERE ll.drawing_id = d.id AND l.issued_at IS NOT NULL
            AND ll.file_path = 'uploads/' || d.job_no || '/' || d.unit_no || '/' || d.zone || '/' || d.stored_file
          ORDER BY l.issued_at DESC LIMIT 1) AS issued_lot_number,
         (SELECT l2.id FROM lot_lines ll2 JOIN lots l2 ON l2.id = ll2.lot_id
          WHERE ll2.drawing_id = d.id AND l2.issued_at IS NULL LIMIT 1) AS planned_lot_id,
         (SELECT l2.lot_number FROM lot_lines ll2 JOIN lots l2 ON l2.id = ll2.lot_id
          WHERE ll2.drawing_id = d.id AND l2.issued_at IS NULL LIMIT 1) AS planned_lot_number
       FROM drawings d
       WHERE d.job_no=$1 AND d.unit_no=$2 AND UPPER(d.zone)=UPPER($3)
       ORDER BY d.line_no`,
      [project, unit, zone]
    );
    const isos = rows.map((d) => ({
      job_no: d.job_no, unit_no: d.unit_no, zone: d.zone, line_no: d.line_no,
      rev_no: d.rev_no || 0, critical: d.stress_critical || "N",
      document_title: d.file_name || "Uploaded File",
      from: d.uploaded_by || "System", uploaded_on: d.uploaded_on,
      mainFile: `uploads/${d.job_no}/${d.unit_no}/${d.zone}/${d.stored_file}`,
      status: d.status || "Uploaded",
      tags: d.tags || [],
      holdSeverity: d.hold_severity || null,
      drawingId: d.id || null,
      issuedLotNumber: d.issued_lot_number || null,
      plannedLotId: d.planned_lot_id || null,
      plannedLotNumber: d.planned_lot_number || null,
    }));
    res.json({ ok: true, isos });
  } catch (err) {
    console.error("getISOs error:", err);
    res.json({ ok: false, isos: [] });
  }
}

// GET /api/get-base-file?jobNo=&unitNo=&lineNo=
async function getBaseFile(req, res) {
  const { jobNo, unitNo, lineNo } = req.query;
  if (!jobNo || !unitNo || !lineNo)
    return res.json({ ok: false, error: "Missing parameters" });

  try {
    const { rows } = await require("../db/pool").pool.query(
      `SELECT zone, stored_file FROM drawings WHERE job_no=$1 AND unit_no=$2 AND line_no=$3`,
      [jobNo, unitNo, lineNo]
    );
    if (!rows[0]?.stored_file) return res.json({ ok: false, error: "Base file not found" });
    const baseFilePath = `uploads/${jobNo}/${unitNo}/${rows[0].zone}/${rows[0].stored_file}`;
    res.json({ ok: true, baseFilePath });
  } catch (err) {
    console.error("getBaseFile error:", err);
    res.json({ ok: false, error: "Server error" });
  }
}

// Maps short claim role codes to display names for Excel reporting
const ROLE_CODE_FULL = {
  PC: 'Process Checker', MC: 'Material Checker', SC: 'Stress Checker',
  GL: 'Group Leader', SGL: 'SGL', Modeller: 'Modeller',
};

// Builds a specific, human-readable reason string for why an upload was blocked.
async function buildInCycleReason(existing, activeClaims, jobNo, unitNo) {
  // Case 1: someone is actively holding the drawing right now
  if (activeClaims.length > 0) {
    const holders = activeClaims.map(c => {
      const roleNames = (c.roles || []).map(r => ROLE_CODE_FULL[r] || r).join(', ');
      return `${c.name} (${roleNames})`;
    });
    return `Upload blocked — currently under active review by: ${holders.join('; ')}`;
  }

  const status = existing.status;

  // Case 2: checkers done, waiting in GL queue
  if (status === 'Ready for GL' || existing.notify_gl) {
    const { rows } = await pool.query(
      `SELECT u.name FROM users u
       JOIN user_role_assignments ura ON ura.user_id = u.id
       WHERE ura.project_id=$1 AND ura.unit_no=$2 AND ura.role='GL'
       ORDER BY u.name`,
      [jobNo, unitNo]
    );
    const names = rows.map(r => r.name).join(', ') || 'assigned GL engineers';
    return `Upload blocked — checkers have cleared this line and it is awaiting GL review (GL engineers: ${names})`;
  }

  // Case 3: GL done, waiting in SGL queue
  if (status === 'Ready for SGL') {
    const { rows } = await pool.query(
      `SELECT u.name FROM users u
       JOIN user_role_assignments ura ON ura.user_id = u.id
       WHERE ura.project_id=$1 AND ura.unit_no=$2 AND ura.role='SGL'
       ORDER BY u.name`,
      [jobNo, unitNo]
    );
    const names = rows.map(r => r.name).join(', ') || 'assigned SGL engineers';
    return `Upload blocked — GL has reviewed this line and it is awaiting SGL approval (SGL engineers: ${names})`;
  }

  // Case 4: sent out for SC supporting check
  if (status === 'Sent for Supporting Check') {
    return `Upload blocked — line is sent out for Stress Critical supporting check`;
  }

  // Case 5: Final but not yet issued in a lot
  if (existing.status === 'Final') {
    return `Upload blocked — line has completed review but has not been issued in a lot yet. Issue the lot first, then the next revision can be uploaded.`;
  }

  // Case 6: partial checker work done — some checkers submitted, others not yet claimed
  if (existing.status === 'Uploaded') {
    const { rows: done } = await pool.query(
      `SELECT DISTINCT unnest(roles) AS role FROM drawing_claims
       WHERE drawing_id=$1 AND completed_at IS NOT NULL`,
      [existing.id]
    );
    const doneRoles = done.map(r => r.role).filter(r => ['PC','MC','SC'].includes(r));
    if (doneRoles.length > 0)
      return `Upload blocked — partial checker review in progress (${doneRoles.join(', ')} submitted; awaiting remaining checkers)`;
  }

  return `Upload blocked — line is in cycle [${status}]`;
}

// POST /api/upload-isometric  (multer applied in route)
async function uploadIsometric(req, res) {
  const userId = req.session?.user?.id;
  const jobNo = req.body.project;
  const file = req.file;

  if (!file) return res.status(400).json({ ok: false, error: "No file uploaded" });
  if (!jobNo) return res.status(400).json({ ok: false, error: "No project specified" });

  let info;
  try { info = JSON.parse(req.body.fileInfo || "{}"); }
  catch { return res.status(400).json({ ok: false, error: "Invalid fileInfo" }); }
  if (!info.valid) return res.status(400).json({ ok: false, error: info.error || "Invalid file format" });

  // Verify user has Modeller role for this unit (unless HOD)
  if (!req.session.user.isHod) {
    const roles = await userQ.getRolesForUnit(userId, jobNo, info.unit);
    if (!roles.includes("Modeller")) {
      if (file?.path) await fsp.unlink(file.path).catch(() => {});
      return res.status(403).json({ ok: false, error: `Not authorised to upload for unit ${info.unit}` });
    }
  }

  try {
    const existing = await drawingQ.findByKey(jobNo, info.unit, info.zone, info.lineNo);
    const stressCritical = await stressQ.isLineCritical(info.lineNo) ? "Y" : "N";

    let newStoredFile = info.newFilename;
    let isReplacement = false;
    let isNewRevision = false;
    let newRevNo = 0;

    if (existing) {
      // --- IN-CYCLE GUARD ---
      // Reject upload if the drawing is currently being worked on by anyone.
      // "Comments Received" and "GL Commented" are intentionally excluded — those
      // are the states where the Modeller is expected to re-upload after feedback.
      const rawActiveClaims = await drawingQ.getActiveClaims(existing.id);
      // Exclude the calling Modeller's OWN claim, but only when it's a clean,
      // single-role 'Modeller' claim — exactly what routeDrawingToModeller
      // creates the moment a comment is routed to them. That claim exists
      // specifically so they CAN respond; without this exclusion it would
      // permanently block them from ever using this endpoint to do so (it's
      // always still "active" until the very re-upload that's supposed to
      // resolve it). Any OTHER active claim — their own unrelated one (a
      // different role/shape), or anyone else's — still blocks normally.
      const activeClaims = rawActiveClaims.filter(c =>
        !(c.user_id === userId && c.roles.length === 1 && c.roles[0] === 'Modeller')
      );
      const IN_CYCLE_STATUSES = [
        'Under Review',               // checker actively reviewing
        'Sent for Supporting Check',  // SC reviewer has it
        'Ready for GL',               // checkers done, in GL queue
        'Ready for SGL',              // GL done, in SGL queue
      ];
      // Catch the gap: PC has submitted but MC/SC haven't claimed yet.
      // Status is still 'Uploaded' but partial checker work exists — blocking is correct.
      const { rows: partialCheckerRows } = await pool.query(
        `SELECT 1 FROM drawing_claims
         WHERE drawing_id=$1 AND roles && ARRAY['PC','MC','SC']::text[]
         AND completed_at IS NOT NULL LIMIT 1`,
        [existing.id]
      );
      const hasPartialCheckerWork = partialCheckerRows.length > 0 && existing.status === 'Uploaded';

      // Block if Final but not yet issued in a lot — workflow not complete until lot is issued.
      // Revision-aware: drawing_id alone isn't enough, since a line keeps the same
      // drawing_id across every revision. A line issued at R0 would otherwise look
      // "already issued" forever, silently defeating this gate for R1, R2, ... —
      // same fix as getGLFinalIsometrics / forwardIsoLines earlier.
      const { rows: issuedLotRows } = await pool.query(
        `SELECT 1 FROM lot_lines ll JOIN lots l ON l.id = ll.lot_id
         WHERE ll.drawing_id=$1 AND l.issued_at IS NOT NULL
           AND ll.file_path = 'uploads/' || $2 || '/' || $3 || '/' || $4 || '/' || $5
         LIMIT 1`,
        [existing.id, jobNo, info.unit, info.zone, existing.stored_file]
      );
      const finalNotIssued = existing.status === 'Final' && issuedLotRows.length === 0;

      const inCycle = activeClaims.length > 0
        || hasPartialCheckerWork
        || finalNotIssued
        || IN_CYCLE_STATUSES.includes(existing.status)
        || existing.notify_gl;
      // notify_modeller = true means drawing is back with Modeller for revision — allow upload

      if (inCycle) {
        if (file?.path) await fsp.unlink(file.path).catch(() => {});
        const reason = await buildInCycleReason(existing, activeClaims, jobNo, info.unit);
        return res.status(409).json({ ok: false, inCycle: true, error: reason });
      }

      // Not in cycle — determine whether to replace or bump revision.
      // "Has this line ever actually been engaged with" can't be answered from
      // drawing_claims alone — it's live state, and gets wiped by clearAllClaims
      // (e.g. SGL's approve handler clears it once a critical line reaches
      // Final). A fully-reviewed, issued line would then look indistinguishable
      // from one nobody has ever touched, and the next upload would silently
      // overwrite the issued file in place instead of starting a new revision.
      // drawing_comments is permanent and never cleared anywhere, so union it
      // in as a durable fallback signal.
      const history = await drawingQ.getHistory(existing.id);
      const { rows: everEngagedRows } = await pool.query(
        `SELECT 1 FROM drawing_claims WHERE drawing_id=$1
         UNION
         SELECT 1 FROM drawing_comments WHERE drawing_id=$1
         LIMIT 1`,
        [existing.id]
      );
      const hasHistoricalClaims = everEngagedRows.length > 0;

      if (!hasHistoricalClaims) {
        // Never been claimed — silent replacement (same filename, overwrite file)
        isReplacement = true;
        newStoredFile = existing.stored_file;
        const oldPath = path.join(UPLOADS_ROOT, jobNo, info.unit, info.zone, existing.stored_file || "");
        if (existing.stored_file && fs.existsSync(oldPath)) await fsp.unlink(oldPath).catch(() => {});
      } else {
        // Has historical claims — determine if new revision or same-cycle re-upload
        // Guard already confirmed: if status='Final' then it IS in an issued lot
        isNewRevision = existing.status === 'Final';
        newRevNo = isNewRevision ? (existing.rev_no || 0) + 1 : (existing.rev_no || 0);

        // Find max upload count already used for this target revision
        const revPattern = new RegExp(`_R${newRevNo}-(\\d+)\\.pdf$`);
        const maxSuffix = history.reduce((max, h) => {
          const m = h.file_name.match(revPattern);
          return m ? Math.max(max, parseInt(m[1])) : max;
        }, 0);

        newStoredFile = `${info.lineNo}_R${newRevNo}-${maxSuffix + 1}.pdf`;
      }
    }

    const finalPath = path.join(UPLOADS_ROOT, jobNo, info.unit, info.zone, newStoredFile);
    ensureDir(path.dirname(finalPath));
    await fsp.rename(file.path, finalPath);

    const drawing = await drawingQ.upsert({
      jobNo, unitNo: info.unit, zone: info.zone, lineNo: info.lineNo,
      fileName: info.originalName, filePath: finalPath.replace(/\\/g, "/"),
      storedFile: newStoredFile, uploadedBy: userId,
      status: "Uploaded", uploadType: "Modeller", stressCritical,
      notifyModeller: false, notifyGL: false,
    });

    await drawingQ.addHistory(drawing.id, newStoredFile);

    // Persist the new revision number (upsert ON CONFLICT does not update rev_no)
    if (isNewRevision) {
      await pool.query(`UPDATE drawings SET rev_no=$1 WHERE id=$2`, [newRevNo, drawing.id]);
    }

    // Fire-and-forget pre-check — runs in background, never blocks upload response
    isoPreCheck.triggerPreCheck({
      drawingId:  drawing.id,
      revNo:      isNewRevision ? newRevNo : (drawing.rev_no || 0),
      lineNo:     info.lineNo,
      storedFile: newStoredFile,
      filePath:   finalPath,
      uploadedBy: userId,
    }).catch(e => console.error("[PRECHECK] uploadIsometric:", e.message));

    // Declared outside if(existing) so the pool-notification block below can read it.
    let returningToCheckers = false;
    if (existing) {
      returningToCheckers = existing.status?.startsWith('Comments Received')
        || existing.status === 'GL Commented'
        || existing.status === 'SGL Commented'
        || existing.status === 'Checker Hold'
        || existing.status === 'GL Hold'
        || existing.status === 'SGL Hold';

      if (returningToCheckers) {
        // Read from drawings.checker_reroute (saved by submitCheckerComments
        // immediately before routing to modeller) instead of querying live
        // drawing_claims directly. This survives the case where a checker who
        // is also the target modeller (e.g. D151 = Modeller+PC) would
        // otherwise have their PC drawing_claims row overwritten by the
        // Modeller upsert — querying drawing_claims directly would then find
        // nothing for them and silently drop their checker role on re-upload.
        // Same pattern already used by modellerResubmit.
        const saved = existing.checker_reroute;
        let prevCheckerClaims = Array.isArray(saved) && saved.length > 0
          ? saved
          : (saved && typeof saved === 'string'
              ? (() => { try { return JSON.parse(saved); } catch (_) { return []; } })()
              : []);

        // Fallback: if the snapshot is empty (drawings created before this
        // feature, or a status reached without ever going through a routing
        // step that saves one), query claims directly as a best effort.
        if (prevCheckerClaims.length === 0) {
          const { rows: fallback } = await pool.query(
            `SELECT DISTINCT user_id, roles FROM drawing_claims
             WHERE drawing_id=$1 AND roles && ARRAY['PC','MC','SC']::text[]`,
            [existing.id]
          );
          prevCheckerClaims = fallback;
        }

        // Clear all old claims
        await drawingQ.clearAllClaims(existing.id);
        // Clear the snapshot — it will be re-saved on the next checker→modeller routing
        await pool.query(`UPDATE drawings SET checker_reroute='[]'::jsonb WHERE id=$1`, [existing.id]);

        // Re-create active claims for each PC/MC/SC so the line appears in their My Tasks
        for (const c of prevCheckerClaims) {
          await drawingQ.upsertClaim(drawing.id, c.user_id, c.roles);
          await pushNotification(c.user_id, drawing.id,
            'Line Re-uploaded for Re-check',
            `Modeller has re-uploaded line ${info.lineNo} (${jobNo}/${info.unit}). Please re-check.`);
        }
      } else {
        // Fresh upload or same-cycle replacement — clear all claims
        await drawingQ.clearAllClaims(existing.id);
      }
    }

    // Pool notifications are only sent when NOT returning to previously-assigned checkers.
    // For the returningToCheckers path the specific PC/MC checkers were already notified
    // personally above — broadcasting to the whole unit pool would be misleading.
    if (!returningToCheckers) {
      const notifTitle = isNewRevision ? `Rev ${newRevNo} Available for Review` : 'New Line in Checker Pool';
      const notifBody  = isNewRevision
        ? `Line ${info.lineNo} (${jobNo}/${info.unit}) Rev ${newRevNo} is now available for checker review.`
        : `Line ${info.lineNo} (${jobNo}/${info.unit}) has been uploaded and is available for review.`;
      await Promise.all([
        pushToRoleUsers(jobNo, info.unit, 'Process Checker', drawing.id, notifTitle, notifBody),
        pushToRoleUsers(jobNo, info.unit, 'Material Checker', drawing.id, notifTitle, notifBody),
        stressCritical !== 'Y'
          ? pushToRoleUsers(jobNo, info.unit, 'Stress Checker', drawing.id, notifTitle, notifBody)
          : Promise.resolve(),
      ]);
    }

    let message;
    if (!existing) {
      message = `First upload — stored as ${newStoredFile}`;
    } else if (isReplacement) {
      message = `File replaced (review cycle not yet started) — stored as ${newStoredFile}`;
    } else if (returningToCheckers) {
      const wasHold = existing.status === 'Checker Hold'
        || existing.status === 'GL Hold'
        || existing.status === 'SGL Hold';
      message = wasHold
        ? `Re-uploaded after hold resolution — stored as ${newStoredFile}`
        : `Re-uploaded after checker feedback — stored as ${newStoredFile}`;
    } else if (isNewRevision) {
      message = `Revision ${newRevNo} uploaded — stored as ${newStoredFile}`;
    } else {
      message = `New upload — stored as ${newStoredFile}`;
    }

    res.json({
      ok: true,
      storedAs: newStoredFile,
      message,
      isReplacement,
      filePath: `uploads/${jobNo}/${info.unit}/${info.zone}/${newStoredFile}`,
    });
  } catch (err) {
    console.error("uploadIsometric error:", err);
    if (file?.path) await fsp.unlink(file.path).catch(() => {});
    res.status(500).json({ ok: false, error: "Upload failed: " + err.message });
  }
}

// POST /api/save-annotated
async function saveAnnotated(req, res) {
  if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded" });
  const { originalPath } = req.body;
  if (!originalPath) return res.status(400).json({ ok: false, error: "originalPath missing" });

  const parts = originalPath.replace(/\\/g, "/").replace(/^\//, "").split("/");
  if (parts.length < 5) return res.status(400).json({ ok: false, error: "Invalid originalPath format" });

  const [, jobNo, unitNo, zone, filename] = parts;
  const lineNo = filename.split("_")[0];

  try {
    const drawing = await drawingQ.findByKey(jobNo, unitNo, zone, lineNo);
    if (!drawing) return res.status(404).json({ ok: false, error: "Drawing not found" });

    const uploadCount = extractUploadCount(drawing.stored_file);
    const tempFileName = `${lineNo}_R${drawing.rev_no || 0}-${uploadCount}_temp.pdf`;
    const targetDir = path.join(UPLOADS_ROOT, jobNo, unitNo, zone);
    ensureDir(targetDir);

    await fsp.rename(req.file.path, path.join(targetDir, tempFileName));
    res.json({ ok: true, savedPath: `uploads/${jobNo}/${unitNo}/${zone}/${tempFileName}` });
  } catch (err) {
    console.error("saveAnnotated error:", err);
    res.status(500).json({ ok: false, error: "Internal error" });
  }
}

// POST /api/finalize-annotation
async function finalizeAnnotation(req, res) {
  const { jobNo, unitNo, lineNo, roles } = req.body;
  if (!jobNo || !unitNo || !lineNo || !roles)
    return res.status(400).json({ ok: false, error: "Missing data" });

  try {
    const drawing = await drawingQ.findByKey(jobNo, unitNo, null, lineNo) ||
      (await require("../db/pool").pool.query(
        `SELECT * FROM drawings WHERE job_no=$1 AND unit_no=$2 AND line_no=$3`,
        [jobNo, unitNo, lineNo]
      )).rows[0];

    if (!drawing) return res.status(404).json({ ok: false, error: "Drawing not found" });

    const parsedRoles = Array.isArray(roles) ? roles : JSON.parse(roles);
    let suffix;
    if (parsedRoles.includes("SGL")) suffix = "PMSAA";
    else if (parsedRoles.includes("GL")) suffix = "PMSA";
    else {
      const sorted = parsedRoles.sort((a, b) => ["PC", "MC", "SC"].indexOf(a) - ["PC", "MC", "SC"].indexOf(b));
      suffix = "_" + sorted.map((r) => r[0]).join("");
    }

    const uploadCount = extractUploadCount(drawing.stored_file);
    const baseName = `${lineNo}_R${drawing.rev_no || 0}-${uploadCount}`;
    const zone = drawing.zone;
    const tempFile = path.join(UPLOADS_ROOT, jobNo, unitNo, zone, `${baseName}_temp.pdf`);
    const commentsDir = path.join(UPLOADS_ROOT, jobNo, unitNo, zone, "comments");
    ensureDir(commentsDir);
    const finalFile = path.join(commentsDir, `${baseName}_${suffix}.pdf`);

    if (!fs.existsSync(tempFile))
      return res.status(404).json({ ok: false, error: "Temp annotated file not found" });

    await fsp.rename(tempFile, finalFile);
    const fileName = `${baseName}_${suffix}.pdf`;
    const filePath = `uploads/${jobNo}/${unitNo}/${zone}/comments/${fileName}`;

    await drawingQ.upsertCommentFile(drawing.id, fileName, filePath, parsedRoles, [req.session.user.id], "annotation");
    res.json({ ok: true, savedAs: fileName });
  } catch (err) {
    console.error("finalizeAnnotation error:", err);
    res.status(500).json({ ok: false, error: "Failed to finalize annotation" });
  }
}

// GET /api/check-iso-roles?project=&unit=
async function checkIsoRoles(req, res) {
  const { project, unit } = req.query;
  const userId = req.session.user.id;
  if (!project || !unit) return res.json({ ok: false, error: "project and unit required" });

  try {
    const roles = await userQ.getRolesForUnit(userId, project, unit);
    const canForward  = roles.some((r) => ["GL", "SGL"].includes(r));
    const canCheckbox = roles.some((r) => ["GL", "SGL"].includes(r));
    res.json({ ok: true, canForward, canCheckbox, userRoles: roles });
  } catch (err) {
    res.json({ ok: false, error: "Error checking roles", canForward: false, canCheckbox: false });
  }
}

// GET /api/process-checkers?project=&unit=&role=PC|MC|SC
async function getProcessCheckers(req, res) {
  const { project, unit, role } = req.query;
  const roleMap = { PC: "Process Checker", MC: "Material Checker", SC: "Stress Checker" };
  const dbRole = roleMap[role] || "Process Checker";
  try {
    const checkers = await userQ.getUsersByRole(project, unit, dbRole);
    res.json({ ok: true, checkers });
  } catch (err) {
    res.json({ ok: false, checkers: [] });
  }
}

// GET /api/checker-roles?checkerId=&project=&unit=&stressCritical=
async function getCheckerRoles(req, res) {
  const { checkerId, project, unit, stressCritical } = req.query;
  try {
    const assigned = await userQ.getRolesForUnit(checkerId, project, unit);
    const display = [];
    if (assigned.includes("Process Checker")) display.push("PC");
    if (assigned.includes("Material Checker")) display.push("MC");
    if (assigned.includes("Stress Checker") && stressCritical === "N") display.push("SC");
    res.json({ ok: true, roles: display });
  } catch (err) {
    res.json({ ok: false, roles: [] });
  }
}

// GET /api/line-details?jobNo=&unitNo=&lineNo=
async function getLineDetails(req, res) {
  const { jobNo, unitNo, lineNo } = req.query;
  if (!jobNo || !unitNo || !lineNo)
    return res.status(400).json({ ok: false, error: "Missing parameters" });

  try {
    const detail = await drawingQ.getLineDetails(jobNo, unitNo, lineNo);
    if (!detail) return res.status(404).json({ ok: false, error: "Drawing not found" });

    const rolePerformers = { PC: null, MC: null, SC: null, GL: null, SGL: null };

    for (const claim of detail.claims) {
      for (const role of claim.roles) {
        const key = role === "Process Checker" ? "PC" : role === "Material Checker" ? "MC" :
          role === "Stress Checker" ? "SC" : role;
        if (rolePerformers.hasOwnProperty(key) && !rolePerformers[key])
          rolePerformers[key] = { id: claim.user_id, name: claim.name };
      }
    }
    // Scoped to the CURRENT revision only — detail.comments spans every
    // revision ever, and this loop overwrites unconditionally (latest comment
    // wins), so without this filter a role performer from a past revision
    // would still show here even when the current revision hasn't been
    // touched by that role yet. rev_no is stamped on each comment at write
    // time (see addComment), so it's a reliable per-row filter.
    const currentRevComments = detail.comments.filter(c => c.rev_no === detail.rev_no);
    for (const c of currentRevComments) {
      const uid = c.user_id;
      for (const role of (c.roles || [])) {
        const key = role === "Process Checker" ? "PC" : role === "Material Checker" ? "MC" :
          role === "Stress Checker" ? "SC" : role;
        if (rolePerformers.hasOwnProperty(key)) {
          const user = await userQ.findById(uid);
          if (user) rolePerformers[key] = { id: user.id, name: user.name };
        }
      }
    }

    // Fetch engineering data from the normalized line list.
    // Composite key: service + '-' + numeric_prefix(unit_no) + '-' + line_no
    // e.g. service='P', unit_no='101 (PDH Unit)', line_no='12453' → 'P-101-12453'
    // Drawing lineNo is 'P-101-12453-B' — match exact or with trailing suffix.
    const { rows: llRows } = await pool.query(
      `SELECT ll.design_temp, ll.design_temp_unit,
              ll.operating_temp, ll.operating_temp_unit,
              ll.min_design_temp, ll.min_design_temp_unit,
              ll.insulation, ll.insulation_thickness,
              ll.fluid_state, ll.line_class, ll.service
       FROM linelist_lines ll
       JOIN linelist_uploads lu ON lu.id = ll.upload_id
       WHERE lu.job_no = $1 AND lu.is_latest = TRUE
         AND (
           $2 = ll.service || '-' || REGEXP_REPLACE(ll.unit_no, '\\s.*$', '') || '-' || ll.line_no
           OR $2 ILIKE ll.service || '-' || REGEXP_REPLACE(ll.unit_no, '\\s.*$', '') || '-' || ll.line_no || '-%'
         )
       LIMIT 1`,
      [jobNo, lineNo]
    );
    const linelistData = llRows[0] || null;

    const activeClaims = await drawingQ.getActiveClaims(detail.id);
    const match = (detail.stored_file || "").match(/_R(\d+)-(\d+)\.pdf$/);
    res.json({
      ok: true,
      lineInfo: {
        jobNo, unitNo,
        lineNo: detail.line_no, revNo: match ? `R${match[1]}` : "R0",
        uploadCount: match ? match[2] : "1",
        uploader: { id: detail.uploaded_by, name: detail.uploaded_by },
        status: detail.status,
        stressCritical: detail.stress_critical,
      },
      rolePerformers,
      activeClaims: activeClaims.map(c => ({ userId: c.user_id, name: c.name, roles: c.roles })),
      linelistData,
    });
  } catch (err) {
    console.error("getLineDetails error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
}

// Extract cycle number from filename e.g. "P-101-12345-A_R0-2.pdf" → 2
function extractCycleNum(fileName) {
  const m = (fileName || "").match(/_R\d+-(\d+)\.pdf$/i);
  return m ? parseInt(m[1], 10) : 0;
}

// Extract the revision number (the R<n> itself, not the upload count) from a
// stored filename, e.g. "LINE_R1-3.pdf" -> 1.
function extractRevNum(fileName) {
  const m = (fileName || "").match(/_R(\d+)-\d+\.pdf$/i);
  return m ? parseInt(m[1], 10) : null;
}

// GET /api/drawing-revision-history?jobNo=&unitNo=&lineNo=
// Read-only rollup of every revision (R0, R1, ...) this line has gone
// through: uploads in that revision, who approved it to Final and when, and
// which lot (if any) it was issued in. Does not touch any workflow state.
async function getRevisionHistory(req, res) {
  const { jobNo, unitNo, lineNo } = req.query;
  if (!jobNo || !unitNo || !lineNo)
    return res.status(400).json({ ok: false, error: "jobNo, unitNo, lineNo required" });

  try {
    const { rows: drawingRows } = await pool.query(
      `SELECT * FROM drawings WHERE job_no=$1 AND unit_no=$2 AND line_no=$3`,
      [jobNo, unitNo, lineNo]
    );
    const drawing = drawingRows[0];
    if (!drawing) return res.status(404).json({ ok: false, error: "Drawing not found" });

    const history = await drawingQ.getHistory(drawing.id); // [{file_name, created_at}], created_at ASC

    // Group uploads by the revision number encoded in the filename.
    const revMap = new Map();
    for (const h of history) {
      const m = h.file_name.match(/_R(\d+)-(\d+)\.pdf$/i);
      if (!m) continue;
      const revNo = parseInt(m[1], 10);
      if (!revMap.has(revNo)) revMap.set(revNo, []);
      revMap.get(revNo).push({ fileName: h.file_name, uploadedOn: h.created_at });
    }
    const revNos = [...revMap.keys()].sort((a, b) => a - b);
    if (revNos.length === 0) {
      return res.json({ ok: true, jobNo, unitNo, lineNo, zone: drawing.zone, currentRevNo: drawing.rev_no || 0, revisions: [] });
    }
    revMap.forEach(files => files.sort((a, b) => new Date(a.uploadedOn) - new Date(b.uploadedOn)));

    const { rows: approveComments } = await pool.query(
      `SELECT dc.created_at, dc.roles, u.name AS approved_by_name
       FROM drawing_comments dc JOIN users u ON u.id = dc.user_id
       WHERE dc.drawing_id=$1 AND dc.type='approve' ORDER BY dc.created_at`,
      [drawing.id]
    );

    const { rows: issuedLots } = await pool.query(
      `SELECT l.lot_number, l.issued_at, ll.file_path
       FROM lot_lines ll JOIN lots l ON l.id = ll.lot_id
       WHERE ll.drawing_id=$1 AND l.issued_at IS NOT NULL`,
      [drawing.id]
    );

    const revisions = revNos.map((revNo, i) => {
      const files = revMap.get(revNo);
      const startAt = files[0].uploadedOn;
      const nextRevNo = revNos[i + 1];
      const endAt = nextRevNo !== undefined ? revMap.get(nextRevNo)[0].uploadedOn : null;

      const approve = approveComments.find(c => {
        const t = new Date(c.created_at).getTime();
        return t >= new Date(startAt).getTime() && (endAt === null || t < new Date(endAt).getTime());
      });

      const filePaths = files.map(f => `uploads/${drawing.job_no}/${drawing.unit_no}/${drawing.zone}/${f.fileName}`);
      const lotMatch = issuedLots.find(l => filePaths.includes(l.file_path));

      let status;
      if (lotMatch) status = "Issued";
      else if (approve) status = "Final (not yet issued)";
      else if (nextRevNo !== undefined) status = "Superseded";
      else status = drawing.status;

      return {
        revNo,
        uploadCount: files.length,
        files,
        startedAt: startAt,
        approvedBy: approve ? approve.approved_by_name : null,
        approvedByRole: approve ? approve.roles : null,
        approvedAt: approve ? approve.created_at : null,
        issuedLotNumber: lotMatch ? lotMatch.lot_number : null,
        issuedAt: lotMatch ? lotMatch.issued_at : null,
        status,
        latestFile: files[files.length - 1].fileName,
        latestFilePath: filePaths[filePaths.length - 1],
      };
    }).reverse(); // latest revision first

    res.json({ ok: true, jobNo, unitNo, lineNo, zone: drawing.zone, currentRevNo: drawing.rev_no || 0, revisions });
  } catch (err) {
    console.error("getRevisionHistory error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
}

// GET /api/task-history?lineNo=&jobNo=
async function getTaskHistory(req, res) {
  const { lineNo, jobNo } = req.query;
  if (!lineNo) return res.status(400).json({ ok: false, error: "lineNo required" });

  try {
    const { rows: drawings } = await require("../db/pool").pool.query(
      `SELECT d.*, u.name AS uploader_name
       FROM drawings d
       LEFT JOIN users u ON u.id = d.uploaded_by
       WHERE d.line_no = $1 ${jobNo ? "AND d.job_no = $2" : ""}
       ORDER BY d.uploaded_on`,
      jobNo ? [lineNo, jobNo] : [lineNo]
    );

    if (!drawings.length) return res.json({ ok: true, history: [] });

    const history = [];

    for (const d of drawings) {
      const currentCycle = extractCycleNum(d.stored_file);

      // Current upload — always shown once
      history.push({
        fileName: d.stored_file,
        fileType: "base",
        commentType: currentCycle > 0 ? `Cycle ${currentCycle} Upload (Current)` : "Current Upload",
        revNo: `R${d.rev_no || 0}`,
        comment: "",
        uploadedBy: d.uploader_name || d.uploaded_by,
        uploadedOn: d.uploaded_on,
        filePath: d.stored_file
          ? `uploads/${d.job_no}/${d.unit_no}/${d.zone}/${d.stored_file}`
          : null,
        role: "Modeller",
      });

      // History records — one row per UNIQUE cycle, skipping current cycle
      // (same-cycle unclaimed re-uploads are collapsed into the current row above)
      const histRecs = await drawingQ.getHistory(d.id);
      // Sort newest-first so we keep the most recent entry per cycle
      const sorted = [...histRecs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      const seenCycles = new Set([currentCycle]);
      for (const h of sorted) {
        const hCycle = extractCycleNum(h.file_name);
        if (seenCycles.has(hCycle)) continue; // duplicate same cycle — skip
        seenCycles.add(hCycle);
        // Each historical file's OWN revision, parsed from its own filename —
        // not d.rev_no, which is the drawing's CURRENT revision and would
        // otherwise relabel every past row with whatever revision is live now.
        const hRevNo = extractRevNum(h.file_name);
        history.push({
          fileName: h.file_name,
          fileType: "base",
          commentType: `Cycle ${hCycle} Upload`,
          revNo: `R${hRevNo !== null ? hRevNo : (d.rev_no || 0)}`,
          comment: "",
          uploadedBy: d.uploader_name || d.uploaded_by,
          uploadedOn: h.created_at,
          filePath: `uploads/${d.job_no}/${d.unit_no}/${d.zone}/${h.file_name}`,
          role: "Modeller",
        });
      }

      // Comments — drawing_comments is the single source of truth.
      // drawing_comment_files is intentionally skipped to avoid duplicate rows.
      const comments = await drawingQ.getComments(d.id);
      for (const c of comments) {
        const commenter = await userQ.findById(c.user_id);
        const name = commenter ? commenter.name : c.user_id;
        const roles = (c.roles || []).join(", ");
        // Each comment's OWN revision (rev_no is stamped on the row at write
        // time — see addComment) — same reasoning as hRevNo above, not d.rev_no.
        const cRevNo = c.rev_no !== null && c.rev_no !== undefined ? c.rev_no : (d.rev_no || 0);

        if (c.type === "no-comment" || c.type === "none") {
          history.push({
            fileName: null, fileType: "text",
            commentType: "No Comment",
            revNo: `R${cRevNo}`,
            comment: "No comments",
            uploadedBy: name, uploadedOn: c.created_at,
            filePath: null, role: roles,
          });
        } else if (c.type === "blocking_hold") {
          history.push({
            fileName: null, fileType: "text",
            commentType: "Blocking Hold Declared",
            revNo: `R${cRevNo}`,
            comment: c.body || c.hold_description || "",
            uploadedBy: name, uploadedOn: c.created_at,
            filePath: null, role: roles,
          });
        } else if (c.type === "text") {
          history.push({
            fileName: null, fileType: "text",
            commentType: "Commented: Text",
            revNo: `R${cRevNo}`,
            comment: c.body || "",
            uploadedBy: name, uploadedOn: c.created_at,
            filePath: null, role: roles,
          });
        } else {
          // file, annotation, or any type that has a file attached
          const label = c.type === "annotation" ? "Commented: Annotated" : "Commented: File";
          history.push({
            fileName: c.file_name, fileType: "comment",
            commentType: label,
            revNo: `R${cRevNo}`,
            comment: c.body || "",
            uploadedBy: name, uploadedOn: c.created_at,
            filePath: c.file_path || null, role: roles,
          });
        }
      }
    }

    history.sort((a, b) => new Date(b.uploadedOn) - new Date(a.uploadedOn));
    res.json({ ok: true, history });
  } catch (err) {
    console.error("getTaskHistory error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
}

// POST /api/modeller-resubmit  (multer temp applied in route)
async function modellerResubmit(req, res) {
  const userId = req.session?.user?.id;
  const file = req.file;
  const { jobNo, unitNo, lineNo, zone, comment } = req.body;

  if (!file) return res.status(400).json({ ok: false, error: "No file uploaded" });
  if (!jobNo || !unitNo || !lineNo || !zone) return res.status(400).json({ ok: false, error: "jobNo, unitNo, zone, lineNo required" });

  try {
    const existing = await drawingQ.findByKey(jobNo, unitNo, zone, lineNo);
    if (!existing) {
      await fsp.unlink(file.path).catch(() => {});
      return res.status(404).json({ ok: false, error: "Drawing not found" });
    }

    // Verify modeller role
    if (!req.session.user.isHod) {
      const roles = await userQ.getRolesForUnit(userId, jobNo, unitNo);
      if (!roles.includes("Modeller")) {
        await fsp.unlink(file.path).catch(() => {});
        return res.status(403).json({ ok: false, error: "Not authorised to resubmit for this unit" });
      }
    }

    // Determine next version suffix — use existing rev_no so R1 resubmits produce R1-2, not R0-n
    const currentRevNo = existing.rev_no || 0;
    const history = await drawingQ.getHistory(existing.id);
    const revPattern = new RegExp(`_R${currentRevNo}-(\\d+)\\.pdf$`, 'i');
    const maxSuffix = history.reduce((max, h) => {
      const m = h.file_name.match(revPattern);
      return m ? Math.max(max, parseInt(m[1])) : max;
    }, 0);
    const newStoredFile = `${lineNo}_R${currentRevNo}-${maxSuffix + 1}.pdf`;

    // Move file to correct location
    const destDir = path.join(UPLOADS_ROOT, jobNo, unitNo, existing.zone);
    await fsp.mkdir(destDir, { recursive: true });
    const destPath = path.join(destDir, newStoredFile);
    await fsp.rename(file.path, destPath);

    // Upsert drawing record
    const drawing = await drawingQ.upsert({
      jobNo, unitNo, zone: existing.zone, lineNo,
      fileName: file.originalname || newStoredFile,
      filePath: destPath.replace(/\\/g, "/"),
      storedFile: newStoredFile, uploadedBy: userId,
      status: "Uploaded", uploadType: "Modeller",
      stressCritical: existing.stress_critical || "N",
      notifyModeller: false, notifyGL: false,
    });

    await drawingQ.addHistory(drawing.id, newStoredFile);

    // Fire-and-forget pre-check — runs in background, never blocks resubmit response
    isoPreCheck.triggerPreCheck({
      drawingId:  drawing.id,
      revNo:      currentRevNo,
      lineNo:     lineNo,
      storedFile: newStoredFile,
      filePath:   destPath,
      uploadedBy: userId,
    }).catch(e => console.error("[PRECHECK] modellerResubmit:", e.message));

    // Save optional text comment as a modeller note visible in history
    if (comment && comment.trim()) {
      await drawingQ.addComment(drawing.id, userId, ["Modeller"], "text", comment.trim(), null, null, null);
    }

    // Re-create claims for the PC/MC/SC checkers who reviewed in the previous cycle.
    //
    // We read from drawings.checker_reroute (saved by submitCheckerComments immediately
    // before routing to modeller). This survives the case where a checker who is also
    // the target modeller (e.g. D351 = Modeller+PC+MC) would otherwise have their
    // {PC,MC} drawing_claims row overwritten by the Modeller upsert, making the
    // drawing_claims query return nothing and incorrectly sending the line to pool.
    const saved = existing.checker_reroute;
    let prevClaims = Array.isArray(saved) && saved.length > 0
      ? saved
      : (saved && typeof saved === 'string'
          ? (() => { try { return JSON.parse(saved); } catch (_) { return []; } })()
          : []);

    // Fallback: if snapshot is empty (drawings created before this feature), query claims directly
    if (prevClaims.length === 0) {
      const { rows: fallback } = await pool.query(
        `SELECT DISTINCT user_id, roles FROM drawing_claims
         WHERE drawing_id=$1 AND roles && ARRAY['PC','MC','SC']::text[]`,
        [existing.id]
      );
      prevClaims = fallback;
    }

    await drawingQ.clearAllClaims(existing.id);
    // Clear the snapshot — it will be re-saved on the next checker→modeller routing
    await pool.query(`UPDATE drawings SET checker_reroute='[]'::jsonb WHERE id=$1`, [existing.id]);

    for (const c of prevClaims) {
      await drawingQ.upsertClaim(drawing.id, c.user_id, c.roles);
      await pushNotification(c.user_id, drawing.id,
        "Line Re-uploaded for Re-check",
        `Modeller has re-uploaded line ${lineNo} (${jobNo}/${unitNo}). Please re-check.`);
    }

    res.json({ ok: true, message: "Re-submission successful", storedAs: newStoredFile });
  } catch (err) {
    if (file?.path) await fsp.unlink(file.path).catch(() => {});
    console.error("modellerResubmit error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
}

// Ensure tags column exists
pool.query(`ALTER TABLE drawings ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}'`).catch(console.error);

// POST /api/drawings/tag  — set tags on a line (GL only by convention)
async function tagDrawing(req, res) {
  const { jobNo, unitNo, lineNo, tags } = req.body;
  if (!jobNo || !unitNo || !lineNo || !Array.isArray(tags))
    return res.status(400).json({ ok: false, error: "jobNo, unitNo, lineNo, tags[] required" });

  // Normalise: trim, uppercase, deduplicate, remove blanks
  const cleaned = [...new Set(tags.map(t => t.trim().toUpperCase()).filter(Boolean))];

  try {
    const { rows } = await pool.query(
      `UPDATE drawings SET tags=$1 WHERE job_no=$2 AND unit_no=$3 AND line_no=$4 RETURNING tags`,
      [cleaned, jobNo, unitNo, lineNo]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "Line not found" });
    res.json({ ok: true, tags: rows[0].tags });
  } catch (err) {
    console.error("tagDrawing error:", err);
    res.status(500).json({ ok: false, error: "Failed to update tags" });
  }
}

module.exports = {
  getTree, getISOs, getBaseFile,
  uploadIsometric, saveAnnotated, finalizeAnnotation,
  checkIsoRoles, getProcessCheckers, getCheckerRoles, getLineDetails, getTaskHistory,
  modellerResubmit, tagDrawing, getRevisionHistory,
};
