const path = require("path");
const fs   = require("fs");
const fsp  = fs.promises;
const gadQ = require("../db/queries/gadQueries");
const userQ = require("../db/queries/userQueries");
const { pool } = require("../db/pool");
const sse  = require("../utils/sse");

const UPLOADS_ROOT = path.join(__dirname, "..", "uploads");

// ── Helpers ────────────────────────────────────────────────────────────────

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function extractUploadCount(storedFile) {
  const m = (storedFile || "").match(/_R\d+-(\d+)\.pdf$/);
  return m ? parseInt(m[1], 10) : 1;
}

// GAD files live under a dedicated "gad" subfolder so they never collide with ISO files.
// Path: uploads/{jobNo}/{unitNo}/gad/{areaNno}/{fileName}
function gadStorageDir(jobNo, unitNo, areaNno) {
  return path.join(UPLOADS_ROOT, jobNo, unitNo, "gad", areaNno);
}

async function pushNotification(userId, gadId, title, body, type = "task") {
  try {
    const { rows } = await pool.query(
      `INSERT INTO live_notifications (user_id, gad_id, title, body, type)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [userId, gadId, title, body, type]
    );
    sse.emitToUser(userId, "notification", rows[0]);
  } catch (e) { console.error("[GAD NOTIF]", e.message); }
}

async function pushToRoleUsers(jobNo, unitNo, role, gadId, title, body, type = "pool") {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT u.id FROM users u
       JOIN user_role_assignments ura ON ura.user_id = u.id
       WHERE ura.project_id = $1 AND ura.unit_no = $2 AND ura.role = $3`,
      [jobNo, unitNo, role]
    );
    await Promise.all(rows.map(r => pushNotification(r.id, gadId, title, body, type)));
  } catch (e) { console.error("[GAD NOTIF ROLE]", e.message); }
}

// Add gad_id column to live_notifications if not already present.
// Purely additive — existing ISO rows have gad_id = NULL, all existing queries unaffected.
pool.query(`ALTER TABLE live_notifications ADD COLUMN IF NOT EXISTS gad_id INTEGER;`)
  .catch(console.error);

// checker_reroute on gads — snapshot of PC/MC claimants so resubmit can restore them
pool.query(`ALTER TABLE gads ADD COLUMN IF NOT EXISTS checker_reroute JSONB DEFAULT '[]';`)
  .catch(console.error);

// Hold columns on gad_comments (mirrors drawing_comments)
pool.query(`
  ALTER TABLE gad_comments ADD COLUMN IF NOT EXISTS hold_type        VARCHAR(10) DEFAULT NULL;
  ALTER TABLE gad_comments ADD COLUMN IF NOT EXISTS hold_description TEXT        DEFAULT NULL;
  ALTER TABLE gad_comments ADD COLUMN IF NOT EXISTS cycle_no         INTEGER     DEFAULT NULL;
`).catch(console.error);

// ── Parse GAD number ───────────────────────────────────────────────────────
// Input : "B862-101-16-43-02203"
// Returns: { valid, jobNo, unitNo, gadTypeSeq, serialNo, areaNno } or { valid: false, error }

const GAD_PATTERN = /^([A-Z]\d+)-(\d+)-(\d{2}-\d{2})-(\d{5})$/;

function parseGADNumber(gadNo) {
  const m = (gadNo || "").trim().toUpperCase().match(GAD_PATTERN);
  if (!m) return { valid: false, error: `Invalid GAD number format. Expected: B862-101-16-43-02203, got: ${gadNo}` };
  const [, jobNo, unitNo, gadTypeSeq, serialNo] = m;
  const areaNno = String(parseInt(serialNo.substring(0, 3), 10)); // "022" → "22"
  return { valid: true, jobNo, unitNo, gadTypeSeq, serialNo, areaNno };
}

// ── GET /api/gad/tree ──────────────────────────────────────────────────────

async function getTree(req, res) {
  try {
    const tree = await gadQ.getTree(req.query.jobNo || null);
    res.json({ ok: true, projects: tree });
  } catch (err) {
    console.error("GAD getTree error:", err);
    res.json({ ok: false, projects: {} });
  }
}

// ── GET /api/gads?project=&unit=&area= ────────────────────────────────────

async function getGADs(req, res) {
  const { project, unit, area } = req.query;
  if (!project || !unit || !area)
    return res.status(400).json({ ok: false, error: "project, unit, area required" });

  try {
    const { rows } = await pool.query(
      `SELECT g.*,
              u_up.name AS uploader_name,
              u_by.name AS by_name,
              u_ch.name AS checked_name,
              u_gl.name AS gl_name,
              u_ap.name AS approved_by_name,
              (SELECT gl.lot_number FROM gad_lot_lines gll JOIN gad_lots gl ON gl.id = gll.lot_id
               WHERE gll.gad_id = g.id AND gl.issued_at IS NOT NULL LIMIT 1) AS issued_lot_number,
              (SELECT gl.lot_number FROM gad_lot_lines gll JOIN gad_lots gl ON gl.id = gll.lot_id
               WHERE gll.gad_id = g.id AND gl.issued_at IS NULL LIMIT 1) AS planned_lot_number
       FROM gads g
       LEFT JOIN users u_up ON u_up.id::text = g.uploaded_by
       LEFT JOIN users u_by ON u_by.id::text = g.by_user_id
       LEFT JOIN users u_ch ON u_ch.id::text = g.checked_user_id
       LEFT JOIN users u_gl ON u_gl.id::text = g.gl_user_id
       LEFT JOIN users u_ap ON u_ap.id::text = g.approved_by_id
       WHERE g.job_no=$1 AND g.unit_no=$2 AND g.area_no=$3
       ORDER BY g.gad_no`,
      [project, unit, area]
    );
    const gads = rows.map(g => ({
      id:               g.id,
      job_no:           g.job_no,
      unit_no:          g.unit_no,
      area_no:          g.area_no,
      gad_no:           g.gad_no,
      rev_no:           g.rev_no           || 'R0-1',
      status:           g.status           || 'Uploaded',
      issue_cycle:      g.issue_cycle      || 0,
      upload_count:     g.upload_count     || 1,
      stress_critical:  g.stress_critical  || 'N',
      file_name:        g.file_name,
      stored_file:      g.stored_file,
      uploaded_by:      g.uploaded_by,
      uploaded_on:      g.uploaded_on,
      uploader_name:    g.uploader_name    || g.uploaded_by || '—',
      by_user_id:       g.by_user_id       || null,
      by_name:          g.by_name          || null,
      checked_user_id:  g.checked_user_id  || null,
      checked_name:     g.checked_name     || null,
      gl_user_id:       g.gl_user_id       || null,
      gl_name:          g.gl_name          || null,
      approved_by_id:    g.approved_by_id    || null,
      approved_by_name:  g.approved_by_name  || null,
      issued_lot_number: g.issued_lot_number || null,
      planned_lot_number: g.planned_lot_number || null,
      mainFile: g.stored_file
        ? `uploads/${g.job_no}/${g.unit_no}/gad/${g.area_no}/${g.stored_file}`
        : null,
    }));
    res.json({ ok: true, gads });
  } catch (err) {
    console.error("getGADs error:", err);
    res.json({ ok: false, gads: [] });
  }
}

// ── GET /api/gad/get-base-file?jobNo=&unitNo=&gadNo= ──────────────────────

async function getBaseFile(req, res) {
  const { jobNo, unitNo, gadNo } = req.query;
  if (!jobNo || !unitNo || !gadNo)
    return res.json({ ok: false, error: "Missing parameters" });

  try {
    const parsed = parseGADNumber(gadNo);
    if (!parsed.valid) return res.json({ ok: false, error: parsed.error });

    const { rows } = await pool.query(
      `SELECT area_no, stored_file FROM gads WHERE job_no=$1 AND unit_no=$2 AND gad_no=$3`,
      [jobNo, unitNo, gadNo]
    );
    if (!rows[0]?.stored_file) return res.json({ ok: false, error: "Base file not found" });

    const baseFilePath = `uploads/${jobNo}/${unitNo}/gad/${rows[0].area_no}/${rows[0].stored_file}`;
    res.json({ ok: true, baseFilePath });
  } catch (err) {
    console.error("GAD getBaseFile error:", err);
    res.json({ ok: false, error: "Server error" });
  }
}

// ── POST /api/gad/upload  (multer applied in route) ───────────────────────

async function uploadGAD(req, res) {
  const userId = req.session?.user?.id;
  const file   = req.file;

  if (!file) return res.status(400).json({ ok: false, error: "No file uploaded" });

  let info;
  try { info = JSON.parse(req.body.fileInfo || "{}"); }
  catch { return res.status(400).json({ ok: false, error: "Invalid fileInfo" }); }

  if (!info.valid) return res.status(400).json({ ok: false, error: info.error || "Invalid GAD number" });

  const { jobNo, unitNo, areaNno, gadTypeSeq, serialNo, gadNo, originalName } = info;

  try {
    const existing = await gadQ.findByKey(jobNo, unitNo, areaNno, gadNo);

    // uploadMode: 'first' | 'replace' | 'new-cycle'
    let uploadMode;
    let newStoredFile;
    let newIssueCycle  = 0;
    let newUploadCount = 1;

    if (!existing) {
      uploadMode     = 'first';
      newStoredFile  = `${gadNo}_R0-1.pdf`;

    } else {
      const status = existing.status;

      // Block any status where the GAD is with a reviewer (use Modeller Task panel instead)
      const BLOCKED = [
        'By Review', 'Ready for Check', 'Check Review',
        'Ready for GL', 'GL Review',
        'Returned (By)', 'Returned (Check)', 'Returned (GL)',
      ];
      if (BLOCKED.includes(status)) {
        if (file?.path) await fsp.unlink(file.path).catch(() => {});
        const stage = status.includes('By') ? 'By reviewer' :
                      status.includes('Check') ? 'Checker' : 'GL/approver';
        return res.status(409).json({
          ok: false, inCycle: true,
          error: `Upload blocked — GAD is currently with ${stage} (${status}). Use your Modeller task panel to resubmit.`,
        });
      }

      if (status === 'Final') {
        // Allow new cycle only after the GAD has been issued in a lot
        const { rows: lotRows } = await pool.query(
          `SELECT 1 FROM gad_lot_lines gll JOIN gad_lots gl ON gl.id = gll.lot_id
           WHERE gll.gad_id=$1 AND gl.issued_at IS NOT NULL LIMIT 1`,
          [existing.id]
        );
        if (!lotRows.length) {
          if (file?.path) await fsp.unlink(file.path).catch(() => {});
          return res.status(409).json({
            ok: false, inCycle: true,
            error: 'Upload blocked — GAD is finalized but not yet issued in a lot. Issue the lot first.',
          });
        }
        uploadMode     = 'new-cycle';
        newIssueCycle  = (existing.issue_cycle || 0) + 1;
        newUploadCount = 1;
        newStoredFile  = `${gadNo}_R${newIssueCycle}-1.pdf`;

      } else {
        // Status is 'Uploaded' — silent replacement if never claimed (by_user_id is null)
        uploadMode     = 'replace';
        newIssueCycle  = existing.issue_cycle  || 0;
        newUploadCount = existing.upload_count || 1;
        newStoredFile  = existing.stored_file;
        const oldPath  = path.join(gadStorageDir(jobNo, unitNo, areaNno), existing.stored_file || '');
        if (existing.stored_file && fs.existsSync(oldPath)) await fsp.unlink(oldPath).catch(() => {});
      }
    }

    const newRevNo = `R${newIssueCycle}-${newUploadCount}`;
    const destDir  = gadStorageDir(jobNo, unitNo, areaNno);
    const destPath = path.join(destDir, newStoredFile);
    ensureDir(destDir);
    await fsp.rename(file.path, destPath);

    const gad = await gadQ.upsert({
      jobNo, unitNo, areaNno, gadTypeSeq, serialNo, gadNo,
      fileName: originalName || newStoredFile,
      filePath: destPath.replace(/\\/g, '/'),
      storedFile: newStoredFile,
      uploadedBy: userId,
      status: 'Uploaded',
      uploadType: 'Modeller',
      stressCritical: existing?.stress_critical || 'N',
      notifyModeller: false, notifyGL: false,
    });

    // Set new workflow columns (upsert ON CONFLICT does not touch these)
    if (uploadMode === 'new-cycle') {
      await gadQ.updateStatus(gad.id, 'Uploaded', {
        revNo: newRevNo, issueCycle: newIssueCycle, uploadCount: newUploadCount,
        byUserId: null, checkedUserId: null, glUserId: null, approvedById: null,
      });
    } else {
      await gadQ.updateStatus(gad.id, 'Uploaded', {
        revNo: newRevNo, issueCycle: newIssueCycle, uploadCount: newUploadCount,
      });
    }

    await gadQ.addHistory(gad.id, newStoredFile, {
      revNo: newRevNo, uploadedBy: userId,
      action: uploadMode === 'replace' ? 'replace' : 'upload',
    });

    // Fire-and-forget pre-check
    try {
      const gadPreCheck = require('../services/gadPreCheckService');
      gadPreCheck.triggerPreCheck({
        gadId: gad.id, revNo: newRevNo,
        gadNo, storedFile: newStoredFile, filePath: destPath, uploadedBy: userId,
      }).catch(e => console.error('[GAD PRECHECK]', e.message));
    } catch (_) {}

    // Notify PC/MC/SC pool on first upload or new cycle; silent on replace
    if (uploadMode !== 'replace') {
      const notifTitle = uploadMode === 'new-cycle'
        ? `GAD ${newRevNo} Available for Review`
        : 'New GAD in Checker Pool';
      const notifBody = uploadMode === 'new-cycle'
        ? `GAD ${gadNo} (${jobNo}/${unitNo}) ${newRevNo} is now available for By/Checker review.`
        : `GAD ${gadNo} (${jobNo}/${unitNo}) has been uploaded and is available for review.`;
      await Promise.all([
        pushToRoleUsers(jobNo, unitNo, 'Process Checker',  gad.id, notifTitle, notifBody),
        pushToRoleUsers(jobNo, unitNo, 'Material Checker', gad.id, notifTitle, notifBody),
        pushToRoleUsers(jobNo, unitNo, 'Stress Checker',   gad.id, notifTitle, notifBody),
      ]);
    }

    const message = uploadMode === 'first'     ? `First upload — ${newStoredFile}`
                  : uploadMode === 'replace'   ? `File replaced (unclaimed) — ${newStoredFile}`
                  : `New cycle ${newRevNo} uploaded — ${newStoredFile}`;

    res.json({
      ok: true, storedAs: newStoredFile, message,
      isReplacement: uploadMode === 'replace',
      filePath: `uploads/${jobNo}/${unitNo}/gad/${areaNno}/${newStoredFile}`,
    });
  } catch (err) {
    console.error('uploadGAD error:', err);
    if (file?.path) await fsp.unlink(file.path).catch(() => {});
    res.status(500).json({ ok: false, error: 'Upload failed: ' + err.message });
  }
}

// ── POST /api/gad/save-annotated ──────────────────────────────────────────

async function saveAnnotated(req, res) {
  if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded" });
  const { originalPath } = req.body;
  if (!originalPath) return res.status(400).json({ ok: false, error: "originalPath missing" });

  // originalPath format: uploads/{job}/{unit}/gad/{area}/{filename}
  const parts = originalPath.replace(/\\/g, "/").replace(/^\//, "").split("/");
  if (parts.length < 6) return res.status(400).json({ ok: false, error: "Invalid originalPath format" });

  const [, jobNo, unitNo, , areaNno, filename] = parts;
  const gadNo = filename.split("_R")[0];

  try {
    const parsed = parseGADNumber(gadNo);
    if (!parsed.valid) return res.status(400).json({ ok: false, error: parsed.error });

    const gad = await gadQ.findByKey(jobNo, unitNo, areaNno, gadNo);
    if (!gad) return res.status(404).json({ ok: false, error: "GAD not found" });

    const tempFileName = `${gadNo}_${gad.rev_no || 'R0-1'}_temp.pdf`;
    const targetDir = gadStorageDir(jobNo, unitNo, areaNno);
    ensureDir(targetDir);

    await fsp.rename(req.file.path, path.join(targetDir, tempFileName));
    res.json({ ok: true, savedPath: `uploads/${jobNo}/${unitNo}/gad/${areaNno}/${tempFileName}` });
  } catch (err) {
    console.error("GAD saveAnnotated error:", err);
    res.status(500).json({ ok: false, error: "Internal error" });
  }
}

// ── POST /api/gad/finalize-annotation ────────────────────────────────────

async function finalizeAnnotation(req, res) {
  const { jobNo, unitNo, gadNo, roles } = req.body;
  if (!jobNo || !unitNo || !gadNo || !roles)
    return res.status(400).json({ ok: false, error: "Missing data" });

  try {
    const parsed = parseGADNumber(gadNo);
    if (!parsed.valid) return res.status(400).json({ ok: false, error: parsed.error });

    const gad = await gadQ.findByKey(jobNo, unitNo, parsed.areaNno, gadNo);
    if (!gad) return res.status(404).json({ ok: false, error: "GAD not found" });

    const parsedRoles = Array.isArray(roles) ? roles : JSON.parse(roles);
    let suffix;
    if (parsedRoles.includes("SGL"))      suffix = "PMSAA";
    else if (parsedRoles.includes("GL"))  suffix = "PMSA";
    else {
      const sorted = parsedRoles.sort((a, b) => ["PC","MC","SC"].indexOf(a) - ["PC","MC","SC"].indexOf(b));
      suffix = "_" + sorted.map(r => r[0]).join("");
    }

    const baseName = `${gadNo}_${gad.rev_no || 'R0-1'}`;
    const areaNno     = gad.area_no;
    const tempFile    = path.join(gadStorageDir(jobNo, unitNo, areaNno), `${baseName}_temp.pdf`);
    const commentsDir = path.join(gadStorageDir(jobNo, unitNo, areaNno), "comments");
    ensureDir(commentsDir);
    const finalFile   = path.join(commentsDir, `${baseName}_${suffix}.pdf`);

    if (!fs.existsSync(tempFile))
      return res.status(404).json({ ok: false, error: "Temp annotated file not found" });

    await fsp.rename(tempFile, finalFile);
    const fileName = `${baseName}_${suffix}.pdf`;
    const filePath = `uploads/${jobNo}/${unitNo}/gad/${areaNno}/comments/${fileName}`;

    await gadQ.upsertCommentFile(gad.id, fileName, filePath, parsedRoles, [req.session.user.id], "annotation");
    res.json({ ok: true, savedAs: fileName });
  } catch (err) {
    console.error("GAD finalizeAnnotation error:", err);
    res.status(500).json({ ok: false, error: "Failed to finalize annotation" });
  }
}

// ── GET /api/gad/check-roles?project=&unit= ───────────────────────────────

async function checkGADRoles(req, res) {
  const { project, unit } = req.query;
  const userId = req.session.user.id;
  if (!project || !unit) return res.json({ ok: false, error: "project and unit required" });
  try {
    const roles = await userQ.getRolesForUnit(userId, project, unit);
    const canForward  = roles.some(r => ["GL","SGL"].includes(r));
    const canCheckbox = roles.some(r => ["GL","SGL"].includes(r));
    res.json({ ok: true, canForward, canCheckbox, userRoles: roles });
  } catch (err) {
    res.json({ ok: false, error: "Error checking roles", canForward: false, canCheckbox: false });
  }
}

// ── GET /api/gad/process-checkers?project=&unit=&role= ────────────────────

async function getProcessCheckers(req, res) {
  const { project, unit, role } = req.query;
  const roleMap = { PC: "Process Checker", MC: "Material Checker", SC: "Stress Checker" };
  const dbRole  = roleMap[role] || "Process Checker";
  try {
    const checkers = await userQ.getUsersByRole(project, unit, dbRole);
    res.json({ ok: true, checkers });
  } catch (err) {
    res.json({ ok: false, checkers: [] });
  }
}

// ── GET /api/gad/checker-roles?checkerId=&project=&unit= ─────────────────

async function getCheckerRoles(req, res) {
  const { checkerId, project, unit } = req.query;
  try {
    const assigned = await userQ.getRolesForUnit(checkerId, project, unit);
    const display = [];
    if (assigned.includes("Process Checker")) display.push("PC");
    if (assigned.includes("Material Checker")) display.push("MC");
    if (assigned.includes("Stress Checker"))  display.push("SC");
    res.json({ ok: true, roles: display });
  } catch (err) {
    res.json({ ok: false, roles: [] });
  }
}

// ── GET /api/gad/details?jobNo=&unitNo=&gadNo= ────────────────────────────

async function getGADDetails(req, res) {
  const { jobNo, unitNo, gadNo, gadId } = req.query;
  if (!gadId && (!jobNo || !unitNo || !gadNo))
    return res.status(400).json({ ok: false, error: "gadId or (jobNo + unitNo + gadNo) required" });

  try {
    const userJoinSQL = `
      SELECT g.*,
             u_up.name AS uploader_name,
             u_by.name AS by_name,
             u_ch.name AS checked_name,
             u_gl.name AS gl_name,
             u_ap.name AS approved_by_name
      FROM gads g
      LEFT JOIN users u_up ON u_up.id::text = g.uploaded_by
      LEFT JOIN users u_by ON u_by.id::text = g.by_user_id
      LEFT JOIN users u_ch ON u_ch.id::text = g.checked_user_id
      LEFT JOIN users u_gl ON u_gl.id::text = g.gl_user_id
      LEFT JOIN users u_ap ON u_ap.id::text = g.approved_by_id
    `;
    let gad;
    if (gadId) {
      const { rows } = await pool.query(`${userJoinSQL} WHERE g.id=$1`, [gadId]);
      gad = rows[0];
    } else {
      const { rows } = await pool.query(
        `${userJoinSQL} WHERE g.job_no=$1 AND g.unit_no=$2 AND g.gad_no=$3`,
        [jobNo, unitNo, gadNo]
      );
      gad = rows[0];
    }
    if (!gad) return res.status(404).json({ ok: false, error: "GAD not found" });

    const rolePerformers = {
      By:       gad.by_user_id      ? { id: gad.by_user_id,      name: gad.by_name      || gad.by_user_id }      : null,
      Check:    gad.checked_user_id ? { id: gad.checked_user_id, name: gad.checked_name || gad.checked_user_id } : null,
      GL:       gad.gl_user_id      ? { id: gad.gl_user_id,      name: gad.gl_name      || gad.gl_user_id }      : null,
      Modeller: { id: gad.uploaded_by, name: gad.uploader_name || gad.uploaded_by || '—' },
    };

    const activeClaims = [];
    if (gad.status === 'By Review'    && gad.by_user_id)
      activeClaims.push({ userId: gad.by_user_id,      name: gad.by_name,      role: 'By' });
    if (gad.status === 'Check Review' && gad.checked_user_id)
      activeClaims.push({ userId: gad.checked_user_id, name: gad.checked_name, role: 'Check' });
    if (gad.status === 'GL Review'    && gad.gl_user_id)
      activeClaims.push({ userId: gad.gl_user_id,      name: gad.gl_name,      role: 'GL' });

    const comments = await gadQ.getComments(gad.id);

    res.json({
      ok: true,
      gadInfo: {
        id:             gad.id,
        jobNo:          gad.job_no,
        unitNo:         gad.unit_no,
        gadNo:          gad.gad_no,
        areaNno:        gad.area_no,
        revNo:          gad.rev_no       || 'R0-1',
        issueCycle:     gad.issue_cycle  || 0,
        uploadCount:    gad.upload_count || 1,
        uploader:       { id: gad.uploaded_by, name: gad.uploader_name || gad.uploaded_by || '—' },
        status:         gad.status,
        stressCritical: gad.stress_critical,
        mainFile:       gad.stored_file
          ? `uploads/${gad.job_no}/${gad.unit_no}/gad/${gad.area_no}/${gad.stored_file}`
          : null,
      },
      rolePerformers,
      activeClaims,
      comments,
    });
  } catch (err) {
    console.error("getGADDetails error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
}

// ── GET /api/gad/task-history?gadNo=&jobNo= ───────────────────────────────

async function getTaskHistory(req, res) {
  const { gadNo, jobNo, gadId } = req.query;
  if (!gadNo && !gadId) return res.status(400).json({ ok: false, error: "gadNo or gadId required" });

  try {
    let whereClause, params;
    if (gadId) {
      whereClause = 'WHERE g.id = $1';
      params = [gadId];
    } else {
      whereClause = `WHERE g.gad_no = $1 ${jobNo ? "AND g.job_no = $2" : ""}`;
      params = jobNo ? [gadNo, jobNo] : [gadNo];
    }

    const { rows: gads } = await pool.query(
      `SELECT g.*, u.name AS uploader_name
       FROM gads g
       LEFT JOIN users u ON u.id::text = g.uploaded_by
       ${whereClause}
       ORDER BY g.uploaded_on`,
      params
    );
    if (!gads.length) return res.json({ ok: true, history: [] });

    const history = [];
    for (const g of gads) {
      history.push({
        file_name:    g.stored_file,
        file_path:    g.stored_file ? `uploads/${g.job_no}/${g.unit_no}/gad/${g.area_no}/${g.stored_file}` : null,
        rev_no:       g.rev_no || 'R0-1',
        from_name:    g.uploader_name || g.uploaded_by || '—',
        comment_type: 'Current Upload',
        type:         'base',
        comment:      '',
        created_at:   g.uploaded_on,
        role:         'Modeller',
      });

      const histRecs = await gadQ.getHistory(g.id);
      for (const h of histRecs) {
        if (h.file_name === g.stored_file) continue;
        let uploaderName = '—';
        if (h.uploaded_by) {
          const upUser = await userQ.findById(h.uploaded_by);
          uploaderName = upUser ? upUser.name : h.uploaded_by;
        }
        const label = h.action === 'resubmit'
          ? `Resubmit (${h.rev_no || ''})`
          : `Upload (${h.rev_no || ''})`;
        history.push({
          file_name:    h.file_name,
          file_path:    `uploads/${g.job_no}/${g.unit_no}/gad/${g.area_no}/${h.file_name}`,
          rev_no:       h.rev_no || g.rev_no || 'R0-1',
          from_name:    uploaderName,
          comment_type: label,
          type:         'base',
          comment:      '',
          created_at:   h.created_at,
          role:         'Modeller',
        });
      }

      const comments = await gadQ.getComments(g.id);
      for (const c of comments) {
        const commenter = await userQ.findById(c.user_id);
        const name  = commenter ? commenter.name : String(c.user_id);
        const roles = (c.roles || []).join(', ');
        if (c.type === 'no-comment' || c.type === 'none') {
          history.push({ file_name: null, file_path: null, rev_no: g.rev_no || 'R0-1',
            from_name: name, comment_type: 'No Comment', type: 'text',
            comment: 'No comments', created_at: c.created_at, role: roles });
        } else if (c.type === 'text') {
          history.push({ file_name: null, file_path: null, rev_no: g.rev_no || 'R0-1',
            from_name: name, comment_type: 'Commented: Text', type: 'text',
            comment: c.body || '', created_at: c.created_at, role: roles });
        } else {
          const label = c.type === 'annotation' ? 'Commented: Annotated' : 'Commented: File';
          history.push({ file_name: c.file_name, file_path: c.file_path || null,
            rev_no: g.rev_no || 'R0-1', from_name: name,
            comment_type: label, type: 'comment',
            comment: c.body || '', created_at: c.created_at, role: roles });
        }
      }
    }

    history.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    res.json({ ok: true, history });
  } catch (err) {
    console.error('GAD getTaskHistory error:', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
}

// ── POST /api/gad/modeller-resubmit ──────────────────────────────────────

async function modellerResubmit(req, res) {
  const userId = req.session?.user?.id;
  const file   = req.file;
  const { jobNo, unitNo, gadNo, areaNno, comment } = req.body;

  if (!file) return res.status(400).json({ ok: false, error: "No file uploaded" });
  if (!jobNo || !unitNo || !gadNo || !areaNno)
    return res.status(400).json({ ok: false, error: "jobNo, unitNo, areaNno, gadNo required" });

  try {
    const existing = await gadQ.findByKey(jobNo, unitNo, areaNno, gadNo);
    if (!existing) {
      await fsp.unlink(file.path).catch(() => {});
      return res.status(404).json({ ok: false, error: "GAD not found" });
    }

    if (!req.session.user.isHod) {
      const roles = await userQ.getRolesForUnit(userId, jobNo, unitNo);
      if (!roles.includes("Modeller")) {
        await fsp.unlink(file.path).catch(() => {});
        return res.status(403).json({ ok: false, error: "Not authorised to resubmit for this unit" });
      }
    }

    const status  = existing.status;
    const ALLOWED = ['Returned (By)', 'Returned (Check)', 'Returned (GL)'];
    if (!ALLOWED.includes(status)) {
      await fsp.unlink(file.path).catch(() => {});
      return res.status(409).json({
        ok: false,
        error: `Cannot resubmit — GAD status is "${status}". Resubmit is only allowed when Returned by By/Checker/GL.`,
      });
    }

    // Increment upload_count within the same issue_cycle
    const issueCycle     = existing.issue_cycle  || 0;
    const newUploadCount = (existing.upload_count || 1) + 1;
    const newRevNo       = `R${issueCycle}-${newUploadCount}`;
    const newStoredFile  = `${gadNo}_${newRevNo}.pdf`;

    const destDir  = gadStorageDir(jobNo, unitNo, areaNno);
    const destPath = path.join(destDir, newStoredFile);
    ensureDir(destDir);
    await fsp.rename(file.path, destPath);

    const gad = await gadQ.upsert({
      jobNo, unitNo, areaNno,
      gadTypeSeq: existing.gad_type_seq,
      serialNo:   existing.serial_no,
      gadNo,
      fileName:   file.originalname || newStoredFile,
      filePath:   destPath.replace(/\\/g, '/'),
      storedFile: newStoredFile,
      uploadedBy: userId,
      status:     'Uploaded', // placeholder — overwritten below
      uploadType: 'Modeller',
      stressCritical: existing.stress_critical || 'N',
      notifyModeller: false, notifyGL: false,
    });

    // Determine the correct new status and which reviewer to notify
    let newStatus, notifyUserId;
    if (status === 'Returned (By)') {
      // Restore combined status if it was a By+Check claim
      newStatus    = (existing.checked_user_id && existing.by_user_id === existing.checked_user_id)
        ? 'By+Check Review' : 'By Review';
      notifyUserId = existing.by_user_id;
    } else if (status === 'Returned (Check)') {
      newStatus    = 'Check Review';
      notifyUserId = existing.checked_user_id;
    } else {
      // Returned (GL) — must go back through By/Check path, not directly to GL
      newStatus    = (existing.checked_user_id && existing.by_user_id === existing.checked_user_id)
        ? 'By+Check Review'
        : (existing.by_user_id ? 'By Review' : 'Uploaded');
      notifyUserId = existing.by_user_id || null;
    }

    await gadQ.updateStatus(gad.id, newStatus, {
      revNo:         newRevNo,
      issueCycle:    issueCycle,
      uploadCount:   newUploadCount,
      byUserId:      existing.by_user_id,
      checkedUserId: existing.checked_user_id,
      glUserId:      existing.gl_user_id,
    });

    await gadQ.addHistory(gad.id, newStoredFile, {
      revNo: newRevNo, uploadedBy: userId, action: 'resubmit',
    });

    // Fire-and-forget pre-check
    try {
      const gadPreCheck = require('../services/gadPreCheckService');
      gadPreCheck.triggerPreCheck({
        gadId: gad.id, revNo: newRevNo,
        gadNo, storedFile: newStoredFile, filePath: destPath, uploadedBy: userId,
      }).catch(e => console.error('[GAD PRECHECK]', e.message));
    } catch (_) {}

    if (comment && comment.trim())
      await gadQ.addComment(gad.id, userId, ['Modeller'], 'text', comment.trim(), null, null, null);

    if (notifyUserId) {
      await pushNotification(
        notifyUserId, gad.id,
        'GAD Re-uploaded for Review',
        `Modeller has incorporated comments and re-uploaded GAD ${gadNo} (${jobNo}/${unitNo}) as ${newRevNo}.`
      );
    }

    res.json({ ok: true, message: 'Re-submission successful', storedAs: newStoredFile, revNo: newRevNo });
  } catch (err) {
    if (file?.path) await fsp.unlink(file.path).catch(() => {});
    console.error('GAD modellerResubmit error:', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
}

// ── GET /api/gads/final?jobNo= ────────────────────────────────────────────
async function getFinalGADs(req, res) {
  try {
    const { jobNo } = req.query;
    const { rows } = await pool.query(
      `SELECT g.*, u.name AS uploaded_by_name,
              (SELECT gl.id FROM gad_lot_lines gll JOIN gad_lots gl ON gl.id = gll.lot_id
               WHERE gll.gad_id = g.id AND gl.issued_at IS NULL LIMIT 1) AS planned_lot_id,
              (SELECT gl.lot_number FROM gad_lot_lines gll JOIN gad_lots gl ON gl.id = gll.lot_id
               WHERE gll.gad_id = g.id AND gl.issued_at IS NULL LIMIT 1) AS planned_lot_number
       FROM gads g LEFT JOIN users u ON u.id::text = g.uploaded_by
       WHERE g.status='Final'
         AND NOT EXISTS (
           SELECT 1 FROM gad_lot_lines gll2
           JOIN gad_lots gl2 ON gl2.id = gll2.lot_id
           WHERE gll2.gad_id = g.id AND gl2.issued_at IS NOT NULL
         )
         ${jobNo ? "AND g.job_no=$1" : ""}
       ORDER BY g.job_no, g.unit_no, g.area_no, g.gad_no`,
      jobNo ? [jobNo] : []
    );
    const gads = rows.map(g => ({
      id:               g.id,
      job_no:           g.job_no, unit_no: g.unit_no, area_no: g.area_no, gad_no: g.gad_no,
      rev_no:           g.rev_no || 'R0-1', status: g.status,
      mainFile:         `uploads/${g.job_no}/${g.unit_no}/gad/${g.area_no}/${g.stored_file}`,
      uploaded_by_name: g.uploaded_by_name,
      plannedLotNumber: g.planned_lot_number || null,
    }));
    res.json({ ok: true, gads });
  } catch(err) {
    console.error("getFinalGADs error:", err);
    res.json({ ok: false, gads: [] });
  }
}

module.exports = {
  getTree, getGADs, getBaseFile, getFinalGADs,
  uploadGAD, saveAnnotated, finalizeAnnotation,
  checkGADRoles, getProcessCheckers, getCheckerRoles,
  getGADDetails, getTaskHistory, modellerResubmit,
  pushNotification, pushToRoleUsers,
  parseGADNumber, gadStorageDir, extractUploadCount,
};
