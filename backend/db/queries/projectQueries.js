const { pool } = require("../pool");

async function getAll() {
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.created_by, p.created_at,
            array_agg(DISTINCT ps.user_id) FILTER (WHERE ps.user_id IS NOT NULL) AS sgls,
            array_agg(DISTINCT pu.unit_no)  FILTER (WHERE pu.unit_no IS NOT NULL)  AS units
     FROM projects p
     LEFT JOIN project_sgls ps ON ps.project_id = p.id
     LEFT JOIN project_units pu ON pu.project_id = p.id
     GROUP BY p.id, p.name, p.created_by, p.created_at
     ORDER BY p.created_at DESC`
  );
  return rows;
}

async function getById(projectId) {
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.created_by, p.created_at,
            array_agg(DISTINCT ps.user_id) FILTER (WHERE ps.user_id IS NOT NULL) AS sgls,
            array_agg(DISTINCT pu.unit_no)  FILTER (WHERE pu.unit_no IS NOT NULL)  AS units
     FROM projects p
     LEFT JOIN project_sgls ps ON ps.project_id = p.id
     LEFT JOIN project_units pu ON pu.project_id = p.id
     WHERE p.id = $1
     GROUP BY p.id, p.name, p.created_by, p.created_at`,
    [projectId]
  );
  return rows[0] || null;
}

async function create(id, name, createdBy) {
  const { rows } = await pool.query(
    `INSERT INTO projects (id, name, created_by) VALUES ($1, $2, $3) RETURNING *`,
    [id, name, createdBy]
  );
  // auto-add creator as SGL
  await pool.query(
    `INSERT INTO project_sgls (project_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [id, createdBy]
  );
  return rows[0];
}

async function exists(projectId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM projects WHERE id = $1`,
    [projectId]
  );
  return rows.length > 0;
}

// ---- SGLs ----

async function getSGLs(projectId) {
  const { rows } = await pool.query(
    `SELECT ps.user_id AS id, u.name
     FROM project_sgls ps
     JOIN users u ON u.id = ps.user_id
     WHERE ps.project_id = $1`,
    [projectId]
  );
  return rows;
}

async function addSGLs(projectId, sglIds) {
  for (const sglId of sglIds) {
    await pool.query(
      `INSERT INTO project_sgls (project_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [projectId, sglId]
    );
  }
}

async function removeSGLs(projectId, sglIds, keepUserId) {
  for (const sglId of sglIds) {
    if (sglId === keepUserId) continue;
    await pool.query(
      `DELETE FROM project_sgls WHERE project_id = $1 AND user_id = $2`,
      [projectId, sglId]
    );
    // Also remove their role assignments for this project
    await pool.query(
      `DELETE FROM user_role_assignments WHERE project_id = $1 AND user_id = $2`,
      [projectId, sglId]
    );
  }
}

async function isSGL(projectId, userId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM project_sgls WHERE project_id = $1 AND user_id = $2`,
    [projectId, userId]
  );
  return rows.length > 0;
}

// ---- Units ----

async function getUnits(projectId) {
  const { rows } = await pool.query(
    `SELECT unit_no FROM project_units WHERE project_id = $1 ORDER BY unit_no`,
    [projectId]
  );
  return rows.map((r) => r.unit_no);
}

async function addUnits(projectId, unitNumbers) {
  for (const unitNo of unitNumbers) {
    await pool.query(
      `INSERT INTO project_units (project_id, unit_no) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [projectId, unitNo]
    );
  }
}

// Auto-assign all roles to SGLs for given units
async function autoAssignSGLRoles(projectId, unitNumbers) {
  const allRoles = ["Modeller", "Process Checker", "Material Checker", "Stress Checker", "GL", "SGL"];
  const { rows: sgls } = await pool.query(
    `SELECT user_id FROM project_sgls WHERE project_id = $1`,
    [projectId]
  );
  for (const { user_id } of sgls) {
    for (const unitNo of unitNumbers) {
      for (const role of allRoles) {
        await pool.query(
          `INSERT INTO user_role_assignments (user_id, project_id, unit_no, role)
           VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [user_id, projectId, unitNo, role]
        );
      }
    }
  }
}

// ---- Role assignments ----

const VALID_ROLES = ["Modeller", "Process Checker", "Material Checker", "Stress Checker", "GL", "SGL"];

async function assignRoles(projectId, unitNumbers, assignments) {
  for (const [employeeId, roles] of Object.entries(assignments)) {
    const validRoles = roles.filter((r) => VALID_ROLES.includes(r));
    for (const unitNo of unitNumbers) {
      for (const role of validRoles) {
        await pool.query(
          `INSERT INTO user_role_assignments (user_id, project_id, unit_no, role)
           VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [employeeId, projectId, unitNo, role]
        );
      }
    }
  }
}

async function removeRoles(projectId, unitNumbers, rolesToRemove) {
  for (const [employeeId, roles] of Object.entries(rolesToRemove)) {
    for (const unitNo of unitNumbers) {
      for (const role of roles) {
        await pool.query(
          `DELETE FROM user_role_assignments
           WHERE user_id = $1 AND project_id = $2 AND unit_no = $3 AND role = $4`,
          [employeeId, projectId, unitNo, role]
        );
      }
    }
  }
}

// Returns { unitNo: { userId: [roles] } } shape for a project
async function getAssignments(projectId) {
  const { rows } = await pool.query(
    `SELECT user_id, unit_no, array_agg(role ORDER BY role) AS roles
     FROM user_role_assignments
     WHERE project_id = $1
     GROUP BY user_id, unit_no`,
    [projectId]
  );
  const result = {};
  for (const row of rows) {
    if (!result[row.unit_no]) result[row.unit_no] = {};
    result[row.unit_no][row.user_id] = row.roles;
  }
  return result;
}

module.exports = {
  getAll,
  getById,
  create,
  exists,
  getSGLs,
  addSGLs,
  removeSGLs,
  isSGL,
  getUnits,
  addUnits,
  autoAssignSGLRoles,
  assignRoles,
  removeRoles,
  getAssignments,
  VALID_ROLES,
};
