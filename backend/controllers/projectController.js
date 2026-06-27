const projectQ = require("../db/queries/projectQueries");
const userQ = require("../db/queries/userQueries");

async function createProject(req, res) {
  const { id, name } = req.body || {};
  if (!id || !name) return res.status(400).json({ success: false, message: "Project ID and name required" });
  if (await projectQ.exists(id)) return res.status(409).json({ success: false, message: "Project ID already exists" });

  const project = await projectQ.create(id, name, req.session.user.id);
  res.json({ success: true, project });
}

async function getAllProjects(req, res) {
  const projects = await projectQ.getAll();
  res.json({ success: true, projects });
}

async function getAssignedProjects(req, res) {
  const userId = req.session.user.id;
  const ids = await userQ.getAssignedProjectIds(userId);
  if (!ids.length) return res.json({ success: true, projects: [] });

  const all = await projectQ.getAll();
  res.json({ success: true, projects: all.filter((p) => ids.includes(p.id)) });
}

async function getModellerProjects(req, res) {
  const userId = req.session.user.id;
  const ids = await userQ.getModellerProjectIds(userId);
  if (!ids.length) return res.json({ success: true, projects: [] });

  const all = await projectQ.getAll();
  res.json({ success: true, projects: all.filter((p) => ids.includes(p.id)) });
}

async function getModellerUnits(req, res) {
  const userId = req.session.user.id;
  const { projectId } = req.params;
  const units = await userQ.getModellerUnitsForProject(userId, projectId);
  res.json({ success: true, units });
}

async function assignSGLs(req, res) {
  const { projectId, sgls } = req.body || {};
  if (!projectId || !Array.isArray(sgls))
    return res.status(400).json({ success: false, message: "projectId and sgls[] required" });
  if (!(await projectQ.exists(projectId)))
    return res.status(404).json({ success: false, message: "Project not found" });

  const allUsers = await userQ.getAll();
  const validIds = allUsers.map((u) => u.id);
  const valid = sgls.filter((id) => validIds.includes(id));
  if (valid.length !== sgls.length)
    return res.status(400).json({ success: false, message: "Some SGL IDs are invalid" });

  await projectQ.addSGLs(projectId, valid);
  res.json({ success: true, message: `${valid.length} SGL(s) assigned` });
}

async function removeSGLs(req, res) {
  const { projectId, sgls } = req.body || {};
  if (!projectId || !Array.isArray(sgls))
    return res.status(400).json({ success: false, message: "projectId and sgls[] required" });
  if (!(await projectQ.exists(projectId)))
    return res.status(404).json({ success: false, message: "Project not found" });

  await projectQ.removeSGLs(projectId, sgls, req.session.user.id);
  res.json({ success: true, message: `${sgls.length} SGL(s) removed` });
}

async function getProjectSGLs(req, res) {
  const { projectId } = req.params;
  if (!(await projectQ.exists(projectId)))
    return res.status(404).json({ success: false, message: "Project not found" });

  const sgls = await projectQ.getSGLs(projectId);
  res.json({ success: true, sgls: sgls.map((s) => s.id) });
}

async function addUnits(req, res) {
  const { projectId, units } = req.body || {};
  if (!projectId || !units || typeof units !== "object")
    return res.status(400).json({ success: false, message: "projectId and units required" });
  if (!(await projectQ.exists(projectId)))
    return res.status(404).json({ success: false, message: "Project not found" });

  // units can be { "typeName": ["101","111"] } or a flat array
  const unitNumbers = Array.isArray(units)
    ? units
    : Object.values(units).flat().filter((n) => /^\w{1,10}$/.test(n));

  if (!unitNumbers.length)
    return res.status(400).json({ success: false, message: "No valid unit numbers provided" });

  await projectQ.addUnits(projectId, unitNumbers);
  await projectQ.autoAssignSGLRoles(projectId, unitNumbers);
  res.json({ success: true, message: `${unitNumbers.length} unit(s) added` });
}

async function getProjectUnits(req, res) {
  const { projectId } = req.params;
  if (!(await projectQ.exists(projectId)))
    return res.status(404).json({ success: false, message: "Project not found" });

  const units = await projectQ.getUnits(projectId);
  res.json({ success: true, units: { units } });
}

async function assignRoles(req, res) {
  const { projectId, units, assignments } = req.body || {};
  if (!projectId || !Array.isArray(units) || !assignments)
    return res.status(400).json({ success: false, message: "projectId, units[], assignments required" });
  if (!(await projectQ.exists(projectId)))
    return res.status(404).json({ success: false, message: "Project not found" });

  await projectQ.assignRoles(projectId, units, assignments);
  res.json({ success: true, message: "Roles assigned successfully" });
}

async function removeRoles(req, res) {
  const { projectId, units, rolesToRemove } = req.body || {};
  if (!projectId || !Array.isArray(units) || !rolesToRemove)
    return res.status(400).json({ success: false, message: "projectId, units[], rolesToRemove required" });

  await projectQ.removeRoles(projectId, units, rolesToRemove);
  res.json({ success: true, message: "Roles removed successfully" });
}

async function getAssignments(req, res) {
  const { projectId } = req.params;
  const assignments = await projectQ.getAssignments(projectId);
  res.json({ success: true, assignments });
}

module.exports = {
  createProject, getAllProjects, getAssignedProjects, getModellerProjects, getModellerUnits,
  assignSGLs, removeSGLs, getProjectSGLs,
  addUnits, getProjectUnits,
  assignRoles, removeRoles, getAssignments,
};
