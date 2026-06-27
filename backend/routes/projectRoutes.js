const router = require("express").Router();
const ctrl = require("../controllers/projectController");
const { requireLogin, requireHOD, requireSGL } = require("../middleware/auth");

router.post("/create", requireHOD, ctrl.createProject);
router.get("/", requireLogin, ctrl.getAllProjects);
router.get("/assigned", requireLogin, ctrl.getAssignedProjects);
router.get("/modeller-projects", requireLogin, ctrl.getModellerProjects);
router.get("/:projectId/modeller-units", requireLogin, ctrl.getModellerUnits);
router.post("/assign-sgls", requireHOD, ctrl.assignSGLs);
router.post("/remove-sgls", requireHOD, ctrl.removeSGLs);
router.get("/:projectId/sgls", requireLogin, ctrl.getProjectSGLs);
router.post("/add-units", requireSGL, ctrl.addUnits);
router.get("/:projectId/units", requireLogin, ctrl.getProjectUnits);
router.post("/assign-roles", requireSGL, ctrl.assignRoles);
router.post("/remove-roles", requireSGL, ctrl.removeRoles);
router.get("/:projectId/assignments", requireLogin, ctrl.getAssignments);

module.exports = router;
