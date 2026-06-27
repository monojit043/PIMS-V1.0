const { pool } = require("../pool");

async function findByCredentials(employeeId, password) {
  const { rows } = await pool.query(
    `SELECT id, name, is_hod FROM users WHERE id = $1 AND password = $2`,
    [employeeId, password]
  );
  return rows[0] || null;
}

async function findById(id) {
  const { rows } = await pool.query(
    `SELECT id, name, is_hod FROM users WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function getAllNonHOD() {
  const { rows } = await pool.query(
    `SELECT id, name FROM users WHERE is_hod = FALSE ORDER BY name`
  );
  return rows;
}

async function getAll() {
  const { rows } = await pool.query(
    `SELECT id, name, is_hod FROM users ORDER BY name`
  );
  return rows;
}

// Returns all roles a user has across all projects and units
async function getRoleAssignments(userId) {
  const { rows } = await pool.query(
    `SELECT project_id, unit_no, role
     FROM user_role_assignments
     WHERE user_id = $1`,
    [userId]
  );
  return rows;
}

// Returns roles a user has for a specific project+unit
async function getRolesForUnit(userId, projectId, unitNo) {
  const { rows } = await pool.query(
    `SELECT role FROM user_role_assignments
     WHERE user_id = $1 AND project_id = $2 AND unit_no = $3`,
    [userId, projectId, unitNo]
  );
  return rows.map((r) => r.role);
}

// Returns distinct projects a user is assigned to (via role or SGL)
async function getAssignedProjectIds(userId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT project_id FROM user_role_assignments WHERE user_id = $1
     UNION
     SELECT project_id FROM project_sgls WHERE user_id = $1`,
    [userId]
  );
  return rows.map((r) => r.project_id);
}

// Returns project IDs where user has Modeller role
async function getModellerProjectIds(userId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT project_id FROM user_role_assignments
     WHERE user_id = $1 AND role = 'Modeller'`,
    [userId]
  );
  return rows.map((r) => r.project_id);
}

// Returns unit numbers where user has Modeller role in a specific project
async function getModellerUnitsForProject(userId, projectId) {
  const { rows } = await pool.query(
    `SELECT unit_no FROM user_role_assignments
     WHERE user_id = $1 AND project_id = $2 AND role = 'Modeller'`,
    [userId, projectId]
  );
  return rows.map((r) => r.unit_no);
}

// Returns all users with any role in a given project+unit, grouped by user
async function getUsersForProjectUnit(projectId, unitNo) {
  const { rows } = await pool.query(
    `SELECT u.id, u.name, array_agg(ura.role ORDER BY ura.role) AS roles
     FROM user_role_assignments ura
     JOIN users u ON u.id = ura.user_id
     WHERE ura.project_id = $1 AND ura.unit_no = $2
     GROUP BY u.id, u.name
     ORDER BY u.name`,
    [projectId, unitNo]
  );
  return rows;
}

// Returns users with a specific role in a project+unit
async function getUsersByRole(projectId, unitNo, role) {
  const { rows } = await pool.query(
    `SELECT u.id, u.name
     FROM user_role_assignments ura
     JOIN users u ON u.id = ura.user_id
     WHERE ura.project_id = $1 AND ura.unit_no = $2 AND ura.role = $3
     ORDER BY u.name`,
    [projectId, unitNo, role]
  );
  return rows;
}

module.exports = {
  findByCredentials,
  findById,
  getAllNonHOD,
  getAll,
  getRoleAssignments,
  getRolesForUnit,
  getAssignedProjectIds,
  getModellerProjectIds,
  getModellerUnitsForProject,
  getUsersForProjectUnit,
  getUsersByRole,
};
