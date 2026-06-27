const router = require("express").Router();
const ctrl = require("../controllers/userController");
const { requireLogin } = require("../middleware/auth");

router.get("/", requireLogin, ctrl.getUsers);
router.get("/employees", requireLogin, ctrl.getEmployees);
router.get("/sgls", requireLogin, ctrl.getSGLCandidates);
router.get("/my-roles", requireLogin, ctrl.getMyRoles);
router.get("/my-modeller-projects", requireLogin, ctrl.getMyModellerProjects);

module.exports = router;
