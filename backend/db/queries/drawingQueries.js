const { pool } = require("../pool");

// ---- Core drawing lookups ----

async function findByKey(jobNo, unitNo, zone, lineNo) {
  const { rows } = await pool.query(
    `SELECT * FROM drawings
     WHERE job_no=$1 AND unit_no=$2 AND zone=$3 AND line_no=$4`,
    [jobNo, unitNo, zone, lineNo]
  );
  return rows[0] || null;
}

async function findById(id) {
  const { rows } = await pool.query(`SELECT * FROM drawings WHERE id=$1`, [id]);
  return rows[0] || null;
}

async function getByJobUnit(jobNo, unitNo) {
  const { rows } = await pool.query(
    `SELECT * FROM drawings WHERE job_no=$1 AND unit_no=$2 ORDER BY line_no`,
    [jobNo, unitNo]
  );
  return rows;
}

async function getAll() {
  const { rows } = await pool.query(
    `SELECT * FROM drawings ORDER BY job_no, unit_no, line_no`
  );
  return rows;
}

// ---- Create / Update ----

async function upsert(data) {
  const {
    jobNo, unitNo, zone, lineNo, fileName, filePath, storedFile,
    uploadedBy, revNo = 0, status = "Uploaded", uploadType,
    stressCritical = "N", notifyModeller = false, notifyGL = false,
    allRolesClaimed = false, delegatedByUser = null,
    delegatedByRole = null, delegatedAt = null,
  } = data;

  const { rows } = await pool.query(
    `INSERT INTO drawings
       (job_no, unit_no, zone, line_no, file_name, file_path, stored_file,
        uploaded_by, uploaded_on, rev_no, status, upload_type, stress_critical,
        notify_modeller, notify_gl, all_roles_claimed,
        delegated_by_user, delegated_by_role, delegated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (job_no, unit_no, zone, line_no) DO UPDATE SET
       file_name       = EXCLUDED.file_name,
       file_path       = EXCLUDED.file_path,
       stored_file     = EXCLUDED.stored_file,
       uploaded_by     = EXCLUDED.uploaded_by,
       uploaded_on     = NOW(),
       status          = EXCLUDED.status,
       stress_critical = EXCLUDED.stress_critical,
       notify_modeller = EXCLUDED.notify_modeller,
       notify_gl       = EXCLUDED.notify_gl,
       all_roles_claimed = EXCLUDED.all_roles_claimed,
       delegated_by_user = EXCLUDED.delegated_by_user,
       delegated_by_role = EXCLUDED.delegated_by_role,
       delegated_at    = EXCLUDED.delegated_at
     RETURNING *`,
    [
      jobNo, unitNo, zone, lineNo, fileName, filePath, storedFile,
      uploadedBy, revNo, status, uploadType, stressCritical,
      notifyModeller, notifyGL, allRolesClaimed,
      delegatedByUser, delegatedByRole, delegatedAt,
    ]
  );
  return rows[0];
}

async function updateStatus(id, status, extras = {}) {
  const fields = ["status=$2"];
  const values = [id, status];
  let i = 3;

  if ("notifyModeller" in extras) { fields.push(`notify_modeller=$${i++}`); values.push(extras.notifyModeller); }
  if ("notifyGL" in extras)       { fields.push(`notify_gl=$${i++}`);       values.push(extras.notifyGL); }
  if ("allRolesClaimed" in extras) { fields.push(`all_roles_claimed=$${i++}`); values.push(extras.allRolesClaimed); }

  await pool.query(`UPDATE drawings SET ${fields.join(",")} WHERE id=$1`, values);
}

async function updateFile(id, storedFile, filePath, fileName) {
  await pool.query(
    `UPDATE drawings SET stored_file=$2, file_path=$3, file_name=$4, uploaded_on=NOW(),
     status='Uploaded', notify_modeller=FALSE, notify_gl=FALSE,
     comments_cleared=TRUE
     WHERE id=$1`,
    [id, storedFile, filePath, fileName]
  );
}

async function setDelegation(id, byUser, byRole) {
  await pool.query(
    `UPDATE drawings SET delegated_by_user=$2, delegated_by_role=$3, delegated_at=NOW() WHERE id=$1`,
    [id, byUser, byRole]
  );
}

// ---- Drawing history ----

async function addHistory(drawingId, fileName) {
  await pool.query(
    `INSERT INTO drawing_history (drawing_id, file_name) VALUES ($1,$2)`,
    [drawingId, fileName]
  );
}

async function getHistory(drawingId) {
  const { rows } = await pool.query(
    `SELECT file_name, created_at FROM drawing_history WHERE drawing_id=$1 ORDER BY created_at`,
    [drawingId]
  );
  return rows;
}

// ---- Claims ----

async function getClaims(drawingId) {
  const { rows } = await pool.query(
    `SELECT dc.user_id, dc.roles, dc.claimed_at, u.name
     FROM drawing_claims dc
     JOIN users u ON u.id = dc.user_id
     WHERE dc.drawing_id = $1`,
    [drawingId]
  );
  return rows;
}

// Active (incomplete) claims only — used for in-cycle detection
async function getActiveClaims(drawingId) {
  const { rows } = await pool.query(
    `SELECT dc.user_id, dc.roles, u.name
     FROM drawing_claims dc
     JOIN users u ON u.id = dc.user_id
     WHERE dc.drawing_id = $1 AND dc.completed_at IS NULL`,
    [drawingId]
  );
  return rows;
}

// If this user already has an ACTIVE (uncompleted) claim on this drawing —
// e.g. they hold MC+SC after partially unclaiming PC, and are now reclaiming
// PC separately — merge the new roles into the existing ones instead of
// replacing the row outright. Without this, claiming an additional role wipes
// out whatever roles you already held active on the same drawing. If the
// existing row was already completed, replace as before (matches the
// pre-existing behavior — that combination isn't reachable through normal
// claim flows today, but keeps this safe either way).
async function upsertClaim(drawingId, userId, roles) {
  await pool.query(
    `INSERT INTO drawing_claims (drawing_id, user_id, roles)
     VALUES ($1,$2,$3)
     ON CONFLICT (drawing_id, user_id) DO UPDATE SET
       roles = CASE
                 WHEN drawing_claims.completed_at IS NULL
                 THEN array(SELECT DISTINCT unnest(drawing_claims.roles || EXCLUDED.roles))
                 ELSE EXCLUDED.roles
               END,
       claimed_at = NOW(),
       completed_at = NULL,
       comment_type = NULL`,
    [drawingId, userId, roles]
  );
}

// Used when GL or SGL claims a line. Always a clean, standalone claim — even
// if the same user already has a completed checker claim (PC/MC/SC) on this
// drawing, that record is preserved permanently in drawing_comments, so it no
// longer needs to be kept alive on this row. Replacing outright avoids a
// confusing mixed-role claim like ['GL','PC'] once the checker cycle is closed.
async function upsertGLClaim(drawingId, userId, roles) {
  await pool.query(
    `INSERT INTO drawing_claims (drawing_id, user_id, roles)
     VALUES ($1, $2, $3)
     ON CONFLICT (drawing_id, user_id) DO UPDATE SET
       roles        = EXCLUDED.roles,
       claimed_at   = NOW(),
       completed_at = NULL,
       comment_type = NULL`,
    [drawingId, userId, roles]
  );
}

async function deleteClaim(drawingId, userId) {
  await pool.query(
    `DELETE FROM drawing_claims WHERE drawing_id=$1 AND user_id=$2`,
    [drawingId, userId]
  );
}

async function clearAllClaims(drawingId) {
  await pool.query(`DELETE FROM drawing_claims WHERE drawing_id=$1`, [drawingId]);
}

// ---- Comments ----

async function getComments(drawingId) {
  const { rows } = await pool.query(
    `SELECT * FROM drawing_comments WHERE drawing_id=$1 ORDER BY created_at`,
    [drawingId]
  );
  return rows;
}

// rev_no is pulled live from the drawings row at insert time (not passed by
// the caller) so every comment is automatically tagged with whatever revision
// was current the moment it was written — callers can't get this wrong or
// forget to pass it.
async function addComment(drawingId, userId, roles, type, body, fileName, filePath, delegatedTo, holdType = null, holdDescription = null, cycleNo = null) {
  const { rows } = await pool.query(
    `INSERT INTO drawing_comments
       (drawing_id, user_id, roles, type, body, file_name, file_path, delegated_to,
        hold_type, hold_description, cycle_no, rev_no)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, d.rev_no
     FROM drawings d WHERE d.id=$1
     RETURNING *`,
    [
      drawingId, userId, roles, type,
      body || null, fileName || null, filePath || null, delegatedTo || null,
      holdType || null, holdDescription || null, cycleNo || null,
    ]
  );
  return rows[0];
}

async function clearComments(drawingId) {
  await pool.query(`DELETE FROM drawing_comments WHERE drawing_id=$1`, [drawingId]);
}

// ---- Comment files (PM, S, PMS annotation files) ----

async function getCommentFiles(drawingId) {
  const { rows } = await pool.query(
    `SELECT * FROM drawing_comment_files WHERE drawing_id=$1 ORDER BY created_at`,
    [drawingId]
  );
  return rows;
}

async function upsertCommentFile(drawingId, fileName, filePath, roles, uploadedBy, type) {
  // Replace existing file with same name, else insert
  const { rows: existing } = await pool.query(
    `SELECT id FROM drawing_comment_files WHERE drawing_id=$1 AND file_name=$2`,
    [drawingId, fileName]
  );
  if (existing.length) {
    await pool.query(
      `UPDATE drawing_comment_files SET file_path=$3, roles=$4, uploaded_by=$5, type=$6, created_at=NOW()
       WHERE drawing_id=$1 AND file_name=$2`,
      [drawingId, fileName, filePath, roles, uploadedBy, type]
    );
  } else {
    await pool.query(
      `INSERT INTO drawing_comment_files (drawing_id, file_name, file_path, roles, uploaded_by, type)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [drawingId, fileName, filePath, roles, uploadedBy, type]
    );
  }
}

async function deleteCommentFilesByPattern(drawingId, suffix) {
  await pool.query(
    `DELETE FROM drawing_comment_files WHERE drawing_id=$1 AND file_name LIKE $2`,
    [drawingId, `%${suffix}`]
  );
}

// ---- Notifications / task views ----

// Drawings where notifyModeller=true and uploader matches userId
async function getModellerTasks(userId) {
  const { rows } = await pool.query(
    `SELECT d.*, dc.roles AS claimed_roles
     FROM drawings d
     LEFT JOIN drawing_claims dc ON dc.drawing_id = d.id AND dc.user_id = $1
     WHERE d.notify_modeller = TRUE AND d.uploaded_by = $1
     ORDER BY d.uploaded_on DESC`,
    [userId]
  );
  return rows;
}

// Drawings claimed by userId
async function getClaimedTasks(userId) {
  const { rows } = await pool.query(
    `SELECT d.*, dc.roles AS claimed_roles, dc.claimed_at,
            (SELECT l.lot_number FROM lot_lines ll JOIN lots l ON l.id = ll.lot_id
             WHERE ll.drawing_id = d.id AND l.issued_at IS NULL LIMIT 1) AS planned_lot_number,
            EXISTS (
              SELECT 1 FROM drawing_claims sc_dc
              WHERE sc_dc.drawing_id = d.id AND 'SC' = ANY(sc_dc.roles)
            ) AS sc_claimed
     FROM drawing_claims dc
     JOIN drawings d ON d.id = dc.drawing_id
     WHERE dc.user_id = $1 AND dc.completed_at IS NULL
     ORDER BY dc.claimed_at DESC`,
    [userId]
  );
  return rows;
}

// Drawings available for checkers based on project/unit role assignments
async function getNotificationsByRole(userId, role) {
  // Drawings in projects/units where user has the given role, in 'Uploaded' status
  const { rows } = await pool.query(
    `SELECT DISTINCT d.*
     FROM drawings d
     JOIN user_role_assignments ura
       ON ura.project_id = d.job_no
      AND ura.unit_no    = d.unit_no
      AND ura.user_id    = $1
      AND ura.role       = $2
     WHERE d.status = 'Uploaded'
     ORDER BY d.uploaded_on DESC`,
    [userId, role]
  );
  return rows;
}

// Drawings awaiting GL review
async function getGLTasks(userId) {
  const { rows } = await pool.query(
    `SELECT d.*
     FROM drawings d
     JOIN user_role_assignments ura
       ON ura.project_id = d.job_no
      AND ura.unit_no    = d.unit_no
      AND ura.user_id    = $1
      AND ura.role       = 'GL'
     WHERE d.notify_gl = TRUE OR d.status = 'Ready for GL'
     ORDER BY d.uploaded_on DESC`,
    [userId]
  );
  return rows;
}

// All tasks visible to a user (union of modeller, claimed, GL)
async function getAllTasks(userId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT d.*, dc.roles AS claimed_roles
     FROM drawings d
     LEFT JOIN drawing_claims dc ON dc.drawing_id = d.id AND dc.user_id = $1
     WHERE
       (d.notify_modeller = TRUE AND d.uploaded_by = $1)
       OR dc.drawing_id IS NOT NULL
       OR (
         (d.notify_gl = TRUE OR d.status = 'Ready for GL')
         AND EXISTS (
           SELECT 1 FROM user_role_assignments ura
           WHERE ura.project_id = d.job_no
             AND ura.unit_no    = d.unit_no
             AND ura.user_id    = $1
             AND ura.role       = 'GL'
         )
       )
     ORDER BY d.uploaded_on DESC`,
    [userId]
  );
  return rows;
}

// Full line detail: drawing + history + claims + comments + comment files
async function getLineDetails(jobNo, unitNo, lineNo) {
  const drawing = await pool.query(
    `SELECT * FROM drawings WHERE job_no=$1 AND unit_no=$2 AND line_no=$3`,
    [jobNo, unitNo, lineNo]
  );
  if (!drawing.rows[0]) return null;
  const d = drawing.rows[0];

  const [history, claims, comments, commentFiles] = await Promise.all([
    getHistory(d.id),
    getClaims(d.id),
    getComments(d.id),
    getCommentFiles(d.id),
  ]);

  return { ...d, history, claims, comments, commentFiles };
}

// Final approved isometrics
async function getFinalIsometrics(jobNo) {
  const where = jobNo ? `WHERE job_no=$1 AND status='Final'` : `WHERE status='Final'`;
  const params = jobNo ? [jobNo] : [];
  const { rows } = await pool.query(
    `SELECT * FROM drawings ${where} ORDER BY unit_no, line_no`, params
  );
  return rows;
}

// Who claimed a specific line
async function getDrawingClaimers(jobNo, unitNo, lineNo) {
  const { rows } = await pool.query(
    `SELECT dc.user_id, u.name, dc.roles, dc.claimed_at
     FROM drawings d
     JOIN drawing_claims dc ON dc.drawing_id = d.id AND dc.completed_at IS NULL
     JOIN users u ON u.id = dc.user_id
     WHERE d.job_no=$1 AND d.unit_no=$2 AND d.line_no=$3`,
    [jobNo, unitNo, lineNo]
  );
  return rows;
}

// Tree view: hierarchical job → unit → zone → lines
async function getTree(jobNo) {
  const where = jobNo ? `WHERE d.job_no=$1` : "";
  const params = jobNo ? [jobNo] : [];
  const { rows } = await pool.query(
    `SELECT d.id, d.job_no, d.unit_no, d.zone, d.line_no, d.status, d.stress_critical, d.stored_file, d.uploaded_by, d.tags, d.rev_no,
            (SELECT l.lot_number FROM lot_lines ll  JOIN lots l  ON l.id  = ll.lot_id
             WHERE ll.drawing_id  = d.id AND l.issued_at IS NOT NULL
             ORDER BY l.issued_at DESC LIMIT 1) AS issued_lot_number,
            (SELECT l2.id        FROM lot_lines ll2 JOIN lots l2 ON l2.id = ll2.lot_id
             WHERE ll2.drawing_id = d.id AND l2.issued_at IS NULL
             LIMIT 1) AS planned_lot_id,
            (SELECT l2.lot_number FROM lot_lines ll2 JOIN lots l2 ON l2.id = ll2.lot_id
             WHERE ll2.drawing_id = d.id AND l2.issued_at IS NULL
             LIMIT 1) AS planned_lot_number
     FROM drawings d
     ${where}
     ORDER BY d.job_no, d.unit_no, d.zone, d.line_no`,
    params
  );
  const tree = {};
  for (const row of rows) {
    if (!tree[row.job_no]) tree[row.job_no] = {};
    if (!tree[row.job_no][row.unit_no]) tree[row.job_no][row.unit_no] = {};
    if (!tree[row.job_no][row.unit_no][row.zone]) tree[row.job_no][row.unit_no][row.zone] = [];
    tree[row.job_no][row.unit_no][row.zone].push({
      drawingId:        row.id,
      lineNo:           row.line_no,
      status:           row.status,
      stressCritical:   row.stress_critical,
      storedFile:       row.stored_file,
      uploadedBy:       row.uploaded_by || 'System',
      revNo:            row.rev_no             || 0,
      issuedLotNumber:  row.issued_lot_number  || null,
      plannedLotId:     row.planned_lot_id     || null,
      plannedLotNumber: row.planned_lot_number || null,
      tags:             row.tags               || [],
    });
  }
  return tree;
}

module.exports = {
  findByKey,
  findById,
  getByJobUnit,
  getAll,
  upsert,
  updateStatus,
  updateFile,
  setDelegation,
  addHistory,
  getHistory,
  getClaims,
  getActiveClaims,
  upsertClaim,
  upsertGLClaim,
  deleteClaim,
  clearAllClaims,
  getComments,
  addComment,
  clearComments,
  getCommentFiles,
  upsertCommentFile,
  deleteCommentFilesByPattern,
  getModellerTasks,
  getClaimedTasks,
  getNotificationsByRole,
  getGLTasks,
  getAllTasks,
  getLineDetails,
  getFinalIsometrics,
  getDrawingClaimers,
  getTree,
};
