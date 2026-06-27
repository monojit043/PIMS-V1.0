const userQ = require("../db/queries/userQueries");

async function getUsers(req, res) {
  const roleFilter = (req.query.role || "").toLowerCase().trim();
  let users = await userQ.getAll();
  if (!req.session.user?.isHod) users = users.filter((u) => !u.is_hod);
  if (roleFilter) {
    // role filter not commonly used but kept for backward compat
    users = users.filter((u) => (u.is_hod ? "hod" : "").includes(roleFilter));
  }
  res.json(users.map((u) => ({ id: u.id, name: u.name, roles: u.is_hod ? ["hod"] : [] })));
}

async function getEmployees(req, res) {
  const users = await userQ.getAllNonHOD();
  res.json({ success: true, users });
}

async function getSGLCandidates(req, res) {
  const users = await userQ.getAllNonHOD();
  res.json({ success: true, users });
}

async function getMyRoles(req, res) {
  const userId = req.session.user.id;
  const rows = await userQ.getRoleAssignments(userId);
  const roles = rows.map((r) => ({ role: r.role, project: r.project_id, unit: r.unit_no }));
  res.json({ ok: true, roles });
}

async function getMyModellerProjects(req, res) {
  const userId = req.session.user.id;
  const projectIds = await userQ.getModellerProjectIds(userId);
  res.json({ jobs: projectIds });
}

module.exports = { getUsers, getEmployees, getSGLCandidates, getMyRoles, getMyModellerProjects };
