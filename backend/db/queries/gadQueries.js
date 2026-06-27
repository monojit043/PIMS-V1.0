const { pool } = require("../pool");

// ── Core GAD lookups ───────────────────────────────────────────────────────

async function findByKey(jobNo, unitNo, areaNno, gadNo) {
  const { rows } = await pool.query(
    `SELECT * FROM gads WHERE job_no=$1 AND unit_no=$2 AND area_no=$3 AND gad_no=$4`,
    [jobNo, unitNo, areaNno, gadNo]
  );
  return rows[0] || null;
}

async function findById(id) {
  const { rows } = await pool.query(`SELECT * FROM gads WHERE id=$1`, [id]);
  return rows[0] || null;
}

async function getByJobUnit(jobNo, unitNo) {
  const { rows } = await pool.query(
    `SELECT * FROM gads WHERE job_no=$1 AND unit_no=$2 ORDER BY area_no, gad_no`,
    [jobNo, unitNo]
  );
  return rows;
}

// ── Create / Update ────────────────────────────────────────────────────────

async function upsert(data) {
  const {
    jobNo, unitNo, areaNno, gadTypeSeq = null, serialNo, gadNo,
    fileName, filePath, storedFile, uploadedBy,
    revNo = 0, status = "Uploaded", uploadType,
    stressCritical = "N", notifyModeller = false, notifyGL = false,
    allRolesClaimed = false,
    delegatedByUser = null, delegatedByRole = null, delegatedAt = null,
  } = data;

  const { rows } = await pool.query(
    `INSERT INTO gads
       (job_no, unit_no, area_no, gad_type_seq, serial_no, gad_no,
        file_name, file_path, stored_file, uploaded_by, uploaded_on,
        rev_no, status, upload_type, stress_critical,
        notify_modeller, notify_gl, all_roles_claimed,
        delegated_by_user, delegated_by_role, delegated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     ON CONFLICT (job_no, unit_no, area_no, gad_no) DO UPDATE SET
       file_name         = EXCLUDED.file_name,
       file_path         = EXCLUDED.file_path,
       stored_file       = EXCLUDED.stored_file,
       uploaded_by       = EXCLUDED.uploaded_by,
       uploaded_on       = NOW(),
       status            = EXCLUDED.status,
       stress_critical   = EXCLUDED.stress_critical,
       notify_modeller   = EXCLUDED.notify_modeller,
       notify_gl         = EXCLUDED.notify_gl,
       all_roles_claimed = EXCLUDED.all_roles_claimed,
       delegated_by_user = EXCLUDED.delegated_by_user,
       delegated_by_role = EXCLUDED.delegated_by_role,
       delegated_at      = EXCLUDED.delegated_at
     RETURNING *`,
    [
      jobNo, unitNo, areaNno, gadTypeSeq, serialNo, gadNo,
      fileName, filePath, storedFile, uploadedBy,
      revNo, status, uploadType, stressCritical,
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
  const colMap = {
    notifyModeller:  'notify_modeller',
    notifyGL:        'notify_gl',
    allRolesClaimed: 'all_roles_claimed',
    byUserId:        'by_user_id',
    checkedUserId:   'checked_user_id',
    glUserId:        'gl_user_id',
    approvedById:    'approved_by_id',
    issueCycle:      'issue_cycle',
    uploadCount:     'upload_count',
    revNo:           'rev_no',
  };
  for (const [key, col] of Object.entries(colMap)) {
    if (key in extras) { fields.push(`${col}=$${i++}`); values.push(extras[key]); }
  }
  await pool.query(`UPDATE gads SET ${fields.join(",")} WHERE id=$1`, values);
}

// ── History ────────────────────────────────────────────────────────────────

async function addHistory(gadId, fileName, opts = {}) {
  const { revNo = null, uploadedBy = null, action = 'upload' } = opts;
  await pool.query(
    `INSERT INTO gad_history (gad_id, file_name, rev_no, uploaded_by, action) VALUES ($1,$2,$3,$4,$5)`,
    [gadId, fileName, revNo, uploadedBy, action]
  );
}

async function getHistory(gadId) {
  const { rows } = await pool.query(
    `SELECT file_name, rev_no, uploaded_by, action, created_at
     FROM gad_history WHERE gad_id=$1 ORDER BY created_at`,
    [gadId]
  );
  return rows;
}

// ── Claims ─────────────────────────────────────────────────────────────────

async function getClaims(gadId) {
  const { rows } = await pool.query(
    `SELECT gc.user_id, gc.roles, gc.claimed_at, u.name
     FROM gad_claims gc
     JOIN users u ON u.id = gc.user_id
     WHERE gc.gad_id = $1`,
    [gadId]
  );
  return rows;
}

async function getActiveClaims(gadId) {
  const { rows } = await pool.query(
    `SELECT gc.user_id, gc.roles, u.name
     FROM gad_claims gc
     JOIN users u ON u.id = gc.user_id
     WHERE gc.gad_id = $1 AND gc.completed_at IS NULL`,
    [gadId]
  );
  return rows;
}

async function upsertClaim(gadId, userId, roles) {
  await pool.query(
    `INSERT INTO gad_claims (gad_id, user_id, roles)
     VALUES ($1,$2,$3)
     ON CONFLICT (gad_id, user_id)
     DO UPDATE SET roles=$3, claimed_at=NOW(), completed_at=NULL, comment_type=NULL`,
    [gadId, userId, roles]
  );
}

// Used when GL or SGL claims — merges GL role into an existing completed checker record
// so the checker history is not lost when the same person holds multiple roles.
async function upsertGLClaim(gadId, userId, roles) {
  await pool.query(
    `INSERT INTO gad_claims (gad_id, user_id, roles)
     VALUES ($1, $2, $3)
     ON CONFLICT (gad_id, user_id) DO UPDATE SET
       roles = CASE
                 WHEN gad_claims.completed_at IS NOT NULL
                      AND gad_claims.roles && ARRAY['PC','MC','SC']::text[]
                 THEN array(SELECT DISTINCT unnest(gad_claims.roles || EXCLUDED.roles))
                 ELSE EXCLUDED.roles
               END,
       claimed_at   = NOW(),
       completed_at = NULL,
       comment_type = NULL`,
    [gadId, userId, roles]
  );
}

async function deleteClaim(gadId, userId) {
  await pool.query(
    `DELETE FROM gad_claims WHERE gad_id=$1 AND user_id=$2`,
    [gadId, userId]
  );
}

async function clearAllClaims(gadId) {
  await pool.query(`DELETE FROM gad_claims WHERE gad_id=$1`, [gadId]);
}

// ── Comments ───────────────────────────────────────────────────────────────

async function getComments(gadId) {
  const { rows } = await pool.query(
    `SELECT * FROM gad_comments WHERE gad_id=$1 ORDER BY created_at`,
    [gadId]
  );
  return rows;
}

async function addComment(gadId, userId, roles, type, body, fileName, filePath, delegatedTo, holdType = null, holdDescription = null, cycleNo = null) {
  const { rows } = await pool.query(
    `INSERT INTO gad_comments
       (gad_id, user_id, roles, type, body, file_name, file_path, delegated_to,
        hold_type, hold_description, cycle_no)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      gadId, userId, roles, type,
      body || null, fileName || null, filePath || null, delegatedTo || null,
      holdType || null, holdDescription || null, cycleNo || null,
    ]
  );
  return rows[0];
}

// ── Comment files ──────────────────────────────────────────────────────────

async function getCommentFiles(gadId) {
  const { rows } = await pool.query(
    `SELECT * FROM gad_comment_files WHERE gad_id=$1 ORDER BY created_at`,
    [gadId]
  );
  return rows;
}

async function upsertCommentFile(gadId, fileName, filePath, roles, uploadedBy, type) {
  const { rows: existing } = await pool.query(
    `SELECT id FROM gad_comment_files WHERE gad_id=$1 AND file_name=$2`,
    [gadId, fileName]
  );
  if (existing.length) {
    await pool.query(
      `UPDATE gad_comment_files SET file_path=$3, roles=$4, uploaded_by=$5, type=$6, created_at=NOW()
       WHERE gad_id=$1 AND file_name=$2`,
      [gadId, fileName, filePath, roles, uploadedBy, type]
    );
  } else {
    await pool.query(
      `INSERT INTO gad_comment_files (gad_id, file_name, file_path, roles, uploaded_by, type)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [gadId, fileName, filePath, roles, uploadedBy, type]
    );
  }
}

// ── Task views ─────────────────────────────────────────────────────────────

async function getModellerTasks(userId) {
  const { rows } = await pool.query(
    `SELECT g.*
     FROM gads g
     WHERE g.uploaded_by = $1::text
       AND g.status IN ('Returned (By)', 'Returned (Check)', 'Returned (GL)')
     ORDER BY g.uploaded_on DESC`,
    [userId]
  );
  return rows;
}

async function getClaimedTasks(userId) {
  const { rows } = await pool.query(
    `SELECT g.*,
       CASE
         WHEN g.status = 'By Review'                                          THEN 'By'
         WHEN g.status = 'By+Check Review'                                    THEN 'By+Check'
         WHEN g.status = 'Check Review'                                       THEN 'Check'
         WHEN g.status = 'GL Review'                                          THEN 'GL'
         WHEN g.status IN ('Returned (By)','Returned (Check)','Returned (GL)') THEN 'Modeller'
       END AS claimed_role,
       (SELECT gl.lot_number FROM gad_lot_lines gll JOIN gad_lots gl ON gl.id = gll.lot_id
        WHERE gll.gad_id = g.id AND gl.issued_at IS NULL LIMIT 1) AS planned_lot_number
     FROM gads g
     WHERE (g.status = 'By Review'       AND g.by_user_id      = $1::text)
        OR (g.status = 'By+Check Review' AND g.by_user_id      = $1::text)
        OR (g.status = 'Check Review'    AND g.checked_user_id = $1::text)
        OR (g.status = 'GL Review'       AND g.gl_user_id      = $1::text)
        OR (g.status IN ('Returned (By)','Returned (Check)','Returned (GL)') AND g.uploaded_by = $1::text)
     ORDER BY g.uploaded_on DESC`,
    [userId]
  );
  return rows;
}

async function getGLTasks(userId) {
  const { rows } = await pool.query(
    `SELECT g.*
     FROM gads g
     JOIN user_role_assignments ura
       ON ura.project_id = g.job_no
      AND ura.unit_no    = g.unit_no
      AND ura.user_id    = $1
      AND ura.role       = 'GL'
     WHERE g.status IN ('Ready for GL', 'GL Review')
       AND (g.gl_user_id IS NULL OR g.gl_user_id = $1::text)
     ORDER BY g.uploaded_on DESC`,
    [userId]
  );
  return rows;
}

// ── Full GAD detail ────────────────────────────────────────────────────────

async function getGADDetails(jobNo, unitNo, gadNo) {
  const { rows } = await pool.query(
    `SELECT * FROM gads WHERE job_no=$1 AND unit_no=$2 AND gad_no=$3`,
    [jobNo, unitNo, gadNo]
  );
  if (!rows[0]) return null;
  const g = rows[0];

  const [history, claims, comments, commentFiles] = await Promise.all([
    getHistory(g.id),
    getClaims(g.id),
    getComments(g.id),
    getCommentFiles(g.id),
  ]);

  return { ...g, history, claims, comments, commentFiles };
}

async function getFinalGADs(jobNo) {
  const where = jobNo ? `WHERE job_no=$1 AND status='Final'` : `WHERE status='Final'`;
  const params = jobNo ? [jobNo] : [];
  const { rows } = await pool.query(
    `SELECT * FROM gads ${where} ORDER BY unit_no, area_no, gad_no`, params
  );
  return rows;
}

async function getGADClaimers(jobNo, unitNo, gadNo) {
  const { rows } = await pool.query(
    `SELECT gc.user_id, u.name, gc.roles, gc.claimed_at
     FROM gads g
     JOIN gad_claims gc ON gc.gad_id = g.id AND gc.completed_at IS NULL
     JOIN users u ON u.id = gc.user_id
     WHERE g.job_no=$1 AND g.unit_no=$2 AND g.gad_no=$3`,
    [jobNo, unitNo, gadNo]
  );
  return rows;
}

// ── Tree: Job → Unit → Area → GADs ────────────────────────────────────────

async function getTree(jobNo) {
  const where  = jobNo ? `WHERE g.job_no=$1` : "";
  const params = jobNo ? [jobNo] : [];
  const { rows } = await pool.query(
    `SELECT g.id, g.job_no, g.unit_no, g.area_no, g.gad_no, g.status,
            g.stress_critical, g.stored_file, g.uploaded_by, g.rev_no,
            (SELECT gl.lot_number FROM gad_lot_lines gll JOIN gad_lots gl ON gl.id = gll.lot_id
             WHERE gll.gad_id = g.id AND gl.issued_at IS NOT NULL
             ORDER BY gl.issued_at DESC LIMIT 1) AS issued_lot_number,
            (SELECT gl2.id FROM gad_lot_lines gll2 JOIN gad_lots gl2 ON gl2.id = gll2.lot_id
             WHERE gll2.gad_id = g.id AND gl2.issued_at IS NULL LIMIT 1) AS planned_lot_id,
            (SELECT gl2.lot_number FROM gad_lot_lines gll2 JOIN gad_lots gl2 ON gl2.id = gll2.lot_id
             WHERE gll2.gad_id = g.id AND gl2.issued_at IS NULL LIMIT 1) AS planned_lot_number
     FROM gads g
     ${where}
     ORDER BY g.job_no, g.unit_no, g.area_no, g.gad_no`,
    params
  );

  const tree = {};
  for (const row of rows) {
    if (!tree[row.job_no]) tree[row.job_no] = {};
    if (!tree[row.job_no][row.unit_no]) tree[row.job_no][row.unit_no] = {};
    if (!tree[row.job_no][row.unit_no][row.area_no]) tree[row.job_no][row.unit_no][row.area_no] = [];
    tree[row.job_no][row.unit_no][row.area_no].push({
      gadId:            row.id,
      gadNo:            row.gad_no,
      status:           row.status,
      stressCritical:   row.stress_critical,
      storedFile:       row.stored_file,
      uploadedBy:       row.uploaded_by || "System",
      revNo:            row.rev_no            || 'R0-1',
      issuedLotNumber:  row.issued_lot_number || null,
      plannedLotId:     row.planned_lot_id    || null,
      plannedLotNumber: row.planned_lot_number || null,
    });
  }
  return tree;
}

module.exports = {
  findByKey, findById, getByJobUnit,
  upsert, updateStatus,
  addHistory, getHistory,
  getClaims, getActiveClaims,
  upsertClaim, upsertGLClaim, deleteClaim, clearAllClaims,
  getComments, addComment,
  getCommentFiles, upsertCommentFile,
  getModellerTasks, getClaimedTasks, getGLTasks,
  getGADDetails, getFinalGADs, getGADClaimers,
  getTree,
};
