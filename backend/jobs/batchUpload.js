"use strict";
const path  = require("path");
const fs    = require("fs");
const fsp   = fs.promises;

const { pool }   = require("../db/pool");
const drawingQ   = require("../db/queries/drawingQueries");
const stressQ    = require("../db/queries/stressQueries");
const isoPreCheck = require("../services/isoPreCheckService");

const UPLOADS_ROOT   = path.join(__dirname, "..", "uploads");
const BATCH_LOGS_DIR = path.join(__dirname, "..", "batch_logs");

// BATCH_INPUT_DIR in .env can be an absolute path (e.g. a UNC network share \\server\share\pims-batch)
// or a relative path resolved from the backend folder. Defaults to backend/batch_input.
const _batchEnv = process.env.BATCH_INPUT_DIR;
const BATCH_INPUT = (_batchEnv && path.isAbsolute(_batchEnv))
  ? _batchEnv
  : path.join(__dirname, "..", _batchEnv || "batch_input");

const LINE_PATTERN = /^([A-Za-z]+)-(\d+)-([A-Za-z0-9]{1,7})(?:-(\d{1,3}))?-([A-Za-z]+)$/;

// Same role-code map used in drawingController for consistent messaging
const ROLE_CODE_FULL = {
  PC: "Process Checker", MC: "Material Checker", SC: "Stress Checker",
  GL: "Group Leader",    SGL: "SGL",             Modeller: "Modeller",
};

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function purgeLogs() {
  if (!fs.existsSync(BATCH_LOGS_DIR)) return;
  const cutoff = Date.now() - 15 * 24 * 60 * 60 * 1000;
  try {
    for (const entry of fs.readdirSync(BATCH_LOGS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const jobDir = path.join(BATCH_LOGS_DIR, entry.name);
      for (const file of fs.readdirSync(jobDir)) {
        if (!file.endsWith(".json")) continue;
        const fp = path.join(jobDir, file);
        try { if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp); } catch {}
      }
    }
  } catch {}
}

// ── Validation helpers ────────────────────────────────────────────────────────

function parseLineFilename(filename) {
  const base  = filename.replace(/\.pdf$/i, "");
  const match = base.match(LINE_PATTERN);
  if (!match) return { valid: false, error: `Invalid filename — expected P-{UNIT}-{SEQ}-{ZONE}.pdf, got "${filename}"` };
  return {
    valid:    true,
    lineNo:   match[0],
    unit:     match[2],
    zone:     match[5].toUpperCase(),
    newFilename: `${match[0]}_R0-1.pdf`,
    originalName: filename,
  };
}

async function projectExists(jobNo) {
  const { rows } = await pool.query(
    `SELECT 1 FROM projects WHERE id = $1`, [jobNo]
  );
  return rows.length > 0;
}

async function unitExistsUnderProject(jobNo, unitNo) {
  const { rows } = await pool.query(
    `SELECT 1 FROM project_units WHERE project_id = $1 AND unit_no = $2`,
    [jobNo, unitNo]
  );
  return rows.length > 0;
}

// ── In-cycle detection (mirrors drawingController logic exactly) ──────────────

const IN_CYCLE_STATUSES = [
  "Under Review",
  "Sent for Supporting Check",
  "Ready for GL",
  "Ready for SGL",
];

async function getActiveClaims(drawingId) {
  return drawingQ.getActiveClaims(drawingId);
}

async function buildInCycleReason(existing, activeClaims, jobNo, unitNo) {
  if (activeClaims.length > 0) {
    const holders = activeClaims.map(c => {
      const roleNames = (c.roles || []).map(r => ROLE_CODE_FULL[r] || r).join(", ");
      return `${c.name} (${roleNames})`;
    });
    return `Upload blocked — currently under active review by: ${holders.join("; ")}`;
  }

  const status = existing.status;

  if (status === "Ready for GL" || existing.notify_gl) {
    const { rows } = await pool.query(
      `SELECT u.name FROM users u
       JOIN user_role_assignments ura ON ura.user_id = u.id
       WHERE ura.project_id=$1 AND ura.unit_no=$2 AND ura.role='GL'
       ORDER BY u.name`,
      [jobNo, unitNo]
    );
    const names = rows.map(r => r.name).join(", ") || "assigned GL engineers";
    return `Upload blocked — checkers have cleared this line and it is awaiting GL review (GL engineers: ${names})`;
  }

  if (status === "Ready for SGL") {
    const { rows } = await pool.query(
      `SELECT u.name FROM users u
       JOIN user_role_assignments ura ON ura.user_id = u.id
       WHERE ura.project_id=$1 AND ura.unit_no=$2 AND ura.role='SGL'
       ORDER BY u.name`,
      [jobNo, unitNo]
    );
    const names = rows.map(r => r.name).join(", ") || "assigned SGL engineers";
    return `Upload blocked — GL has reviewed this line and it is awaiting SGL approval (SGL engineers: ${names})`;
  }

  if (status === "Sent for Supporting Check") {
    return `Upload blocked — line is sent out for Stress Critical supporting check`;
  }

  // Case 5: Final but not yet issued in a lot
  if (existing.status === 'Final') {
    return `Upload blocked — line has completed review but has not been issued in a lot yet. Issue the lot first, then the next revision can be uploaded.`;
  }

  // Case 6: partial checker work — some submitted, others not yet claimed
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

// ── Notification helpers (same as drawingController) ─────────────────────────

async function pushToRoleUsers(jobNo, unitNo, role, drawingId, title, body) {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT u.id FROM users u
       JOIN user_role_assignments ura ON ura.user_id = u.id
       WHERE ura.project_id=$1 AND ura.unit_no=$2 AND ura.role=$3`,
      [jobNo, unitNo, role]
    );
    await Promise.all(rows.map(r =>
      pool.query(
        `INSERT INTO live_notifications (user_id, drawing_id, title, body, type)
         VALUES ($1,$2,$3,$4,'pool')`,
        [r.id, drawingId, title, body]
      )
    ));
  } catch (e) {
    console.error(`[BATCH] pushToRoleUsers(${role}) error:`, e.message);
  }
}

// ── Process a single PDF file ─────────────────────────────────────────────────

async function processFile(jobNo, filename, srcPath) {
  const result = { jobNo, filename, status: null };

  // Step 1: parse filename
  const parsed = parseLineFilename(filename);
  if (!parsed.valid) {
    result.status = "failed";
    result.reason = parsed.error;
    return result;
  }
  Object.assign(result, { lineNo: parsed.lineNo, unit: parsed.unit, zone: parsed.zone });

  // Step 2: validate project exists
  if (!(await projectExists(jobNo))) {
    result.status = "failed";
    result.reason = `Project "${jobNo}" does not exist in the system`;
    return result;
  }

  // Step 3: validate unit exists under project
  if (!(await unitExistsUnderProject(jobNo, parsed.unit))) {
    result.status = "failed";
    result.reason = `Unit "${parsed.unit}" is not configured under project "${jobNo}"`;
    return result;
  }

  // Step 4: in-cycle check
  const existing = await drawingQ.findByKey(jobNo, parsed.unit, parsed.zone, parsed.lineNo);
  if (existing) {
    const activeClaims = await getActiveClaims(existing.id);

    // Catch the gap: PC submitted but MC/SC not yet claimed — status still 'Uploaded'
    const { rows: partialCheckerRows } = await pool.query(
      `SELECT 1 FROM drawing_claims
       WHERE drawing_id=$1 AND roles && ARRAY['PC','MC','SC']::text[]
       AND completed_at IS NOT NULL LIMIT 1`,
      [existing.id]
    );
    const hasPartialCheckerWork = partialCheckerRows.length > 0 && existing.status === 'Uploaded';

    // Block if Final but not yet issued in a lot — workflow not complete until lot is issued
    const { rows: issuedLotRows } = await pool.query(
      `SELECT 1 FROM lot_lines ll JOIN lots l ON l.id = ll.lot_id
       WHERE ll.drawing_id=$1 AND l.issued_at IS NOT NULL LIMIT 1`,
      [existing.id]
    );
    const finalNotIssued = existing.status === 'Final' && issuedLotRows.length === 0;

    const inCycle = activeClaims.length > 0
      || hasPartialCheckerWork
      || finalNotIssued
      || IN_CYCLE_STATUSES.includes(existing.status)
      || existing.notify_gl;

    if (inCycle) {
      result.status = "failed";
      result.reason = await buildInCycleReason(existing, activeClaims, jobNo, parsed.unit);
      return result;
    }
  }

  // Step 5: determine stored filename (new upload vs same-cycle re-upload vs new revision)
  let newStoredFile = parsed.newFilename;
  let uploadMessage;
  let isNewRevision = false;
  let newRevNo = 0;

  if (existing) {
    const history = await drawingQ.getHistory(existing.id);
    const hasHistoricalClaims = (await drawingQ.getClaims(existing.id)).length > 0;

    if (!hasHistoricalClaims) {
      // Never been claimed — overwrite same file
      newStoredFile = existing.stored_file;
      uploadMessage = `File replaced (review cycle not yet started) — stored as ${newStoredFile}`;
      const oldPath = path.join(UPLOADS_ROOT, jobNo, parsed.unit, parsed.zone, existing.stored_file || "");
      if (existing.stored_file && fs.existsSync(oldPath)) await fsp.unlink(oldPath).catch(() => {});
    } else {
      // Guard already confirmed: if status='Final' then it IS in an issued lot
      isNewRevision = existing.status === 'Final';
      newRevNo = isNewRevision ? (existing.rev_no || 0) + 1 : (existing.rev_no || 0);

      const revPattern = new RegExp(`_R${newRevNo}-(\\d+)\\.pdf$`);
      const maxSuffix = history.reduce((max, h) => {
        const m = h.file_name.match(revPattern);
        return m ? Math.max(max, parseInt(m[1])) : max;
      }, 0);

      newStoredFile = `${parsed.lineNo}_R${newRevNo}-${maxSuffix + 1}.pdf`;
      uploadMessage = isNewRevision
        ? `Revision ${newRevNo} — stored as ${newStoredFile}`
        : `Same-cycle re-upload — stored as ${newStoredFile}`;
    }
  } else {
    uploadMessage = `First upload — stored as ${newStoredFile}`;
  }

  // Step 6: copy file to uploads folder
  const destDir  = path.join(UPLOADS_ROOT, jobNo, parsed.unit, parsed.zone);
  const destPath = path.join(destDir, newStoredFile);
  ensureDir(destDir);
  await fsp.copyFile(srcPath, destPath);

  // Step 7: DB upsert
  const stressCritical = await stressQ.isLineCriticalScoped(jobNo, parsed.unit, parsed.lineNo) ? "Y" : "N";

  const drawing = await drawingQ.upsert({
    jobNo,    unitNo:      parsed.unit,
    zone:     parsed.zone, lineNo:    parsed.lineNo,
    fileName: filename,    filePath:  destPath.replace(/\\/g, "/"),
    storedFile: newStoredFile, uploadedBy: "SYSTEM",
    status: "Uploaded",   uploadType: "System",
    stressCritical,       notifyModeller: false, notifyGL: false,
  });

  await drawingQ.addHistory(drawing.id, newStoredFile);
  if (existing) await drawingQ.clearAllClaims(existing.id);

  // Persist the new revision number (upsert ON CONFLICT does not update rev_no)
  if (isNewRevision) {
    await pool.query(`UPDATE drawings SET rev_no=$1 WHERE id=$2`, [newRevNo, drawing.id]);
  }

  // Fire-and-forget pre-check — runs in background, never blocks batch result
  isoPreCheck.triggerPreCheck({
    drawingId:  drawing.id,
    revNo:      isNewRevision ? newRevNo : (drawing.rev_no || 0),
    lineNo:     parsed.lineNo,
    storedFile: newStoredFile,
    filePath:   destPath,
    uploadedBy: "SYSTEM",
  }).catch(e => console.error("[PRECHECK] batchUpload:", e.message));

  // Step 8: notify checker pool
  const notifTitle = isNewRevision
    ? `Rev ${newRevNo} Available for Review (System Upload)`
    : "New Line in Checker Pool (System Upload)";
  const notifBody = isNewRevision
    ? `Line ${parsed.lineNo} (${jobNo}/${parsed.unit}) Rev ${newRevNo} is now available for checker review.`
    : `Line ${parsed.lineNo} (${jobNo}/${parsed.unit}) uploaded by system and available for review.`;
  await Promise.all([
    pushToRoleUsers(jobNo, parsed.unit, "Process Checker",  drawing.id, notifTitle, notifBody),
    pushToRoleUsers(jobNo, parsed.unit, "Material Checker", drawing.id, notifTitle, notifBody),
    stressCritical !== "Y"
      ? pushToRoleUsers(jobNo, parsed.unit, "Stress Checker", drawing.id, notifTitle, notifBody)
      : Promise.resolve(),
  ]);

  result.status  = "uploaded";
  result.storedAs = newStoredFile;
  result.message  = uploadMessage;
  return result;
}

// ── Move file after processing ────────────────────────────────────────────────

async function moveFile(srcPath, jobNo, filename, succeeded) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const destDir = succeeded
    ? path.join(BATCH_INPUT, "_done", jobNo, today)
    : path.join(BATCH_INPUT, "_failed", jobNo);
  ensureDir(destDir);
  const destPath = path.join(destDir, filename);
  // If a same-named file already exists in _failed, suffix with timestamp
  const finalDest = fs.existsSync(destPath)
    ? path.join(destDir, `${Date.now()}_${filename}`)
    : destPath;
  await fsp.rename(srcPath, finalDest);
}

// ── Main batch runner ─────────────────────────────────────────────────────────

async function runBatch(triggeredBy = "scheduler") {
  ensureDir(BATCH_INPUT);
  purgeLogs();

  const startedAt    = new Date();
  const runId        = startedAt.toISOString();
  const logTimestamp = startedAt.toISOString().slice(0, 19).replace("T", "_").replace(/:/g, "-");
  const jobResults   = {}; // { jobNo: [result, ...] }

  console.log(`[BATCH] Run started — triggered by: ${triggeredBy}`);
  console.log(`[BATCH] Scanning path: ${BATCH_INPUT}`);

  let jobFolders = [];
  try {
    const rawEntries = fs.readdirSync(BATCH_INPUT);
    console.log(`[BATCH] Raw entries in batch_input: [${rawEntries.join(', ') || 'none'}]`);
    jobFolders = rawEntries.filter(function (name) {
      if (name.startsWith("_")) return false;
      try {
        const isDir = fs.statSync(path.join(BATCH_INPUT, name)).isDirectory();
        console.log(`[BATCH] Entry "${name}" isDirectory=${isDir}`);
        return isDir;
      } catch (e) {
        console.log(`[BATCH] Entry "${name}" statSync error: ${e.message}`);
        return false;
      }
    });
  } catch (e) {
    console.error("[BATCH] Cannot read batch_input:", e.message);
  }

  console.log(`[BATCH] Job folders found: [${jobFolders.join(', ') || 'none'}]`);

  for (const jobNo of jobFolders) {
    const jobDir = path.join(BATCH_INPUT, jobNo);
    let files = [];
    try {
      files = fs.readdirSync(jobDir).filter(f => /\.pdf$/i.test(f));
    } catch (err) {
      console.error(`[BATCH] Cannot read job folder ${jobNo}:`, err.message);
      continue;
    }

    console.log(`[BATCH] Job ${jobNo}: found ${files.length} PDF(s)`);

    for (const filename of files) {
      const srcPath = path.join(jobDir, filename);
      let result = { jobNo, filename, status: "failed", reason: "Unknown error" };
      try {
        result = await processFile(jobNo, filename, srcPath);
      } catch (err) {
        result.reason = `Unexpected error: ${err.message}`;
        console.error(`[BATCH] Error processing ${jobNo}/${filename}:`, err.message);
      }
      if (!jobResults[jobNo]) jobResults[jobNo] = [];
      jobResults[jobNo].push(result);
      await moveFile(srcPath, jobNo, filename, result.status === "uploaded");
    }
  }

  // Write one log file per job
  const completedAt = new Date().toISOString();
  for (const [jobNo, results] of Object.entries(jobResults)) {
    const summary = {
      total:    results.length,
      uploaded: results.filter(r => r.status === "uploaded").length,
      failed:   results.filter(r => r.status === "failed").length,
    };
    const log = { runId, triggeredBy, startedAt: runId, completedAt, summary, results };
    const jobLogDir = path.join(BATCH_LOGS_DIR, jobNo);
    ensureDir(jobLogDir);
    await fsp.writeFile(path.join(jobLogDir, `${logTimestamp}.json`), JSON.stringify(log, null, 2), "utf8");
  }

  const allResults = Object.values(jobResults).flat();
  const summary = {
    total:    allResults.length,
    uploaded: allResults.filter(r => r.status === "uploaded").length,
    failed:   allResults.filter(r => r.status === "failed").length,
  };

  console.log(`[BATCH] Run complete — uploaded: ${summary.uploaded}, failed: ${summary.failed}`);
  return { runId, triggeredBy, startedAt: runId, completedAt, summary };
}

module.exports = { runBatch };
