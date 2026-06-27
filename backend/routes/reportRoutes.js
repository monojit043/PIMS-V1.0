const router = require("express").Router();
const ctrl = require("../controllers/reportController");
const { requireLogin } = require("../middleware/auth");

router.get("/report/summary",         requireLogin, ctrl.getSummary);
router.get("/report/user-activity",   requireLogin, ctrl.getUserActivity);
router.post("/report/all-lines",      requireLogin, ctrl.getAllLines);
router.post("/report/under-progress", requireLogin, ctrl.getUnderProgress);
router.post("/report/batch-query",    requireLogin, ctrl.batchQuery);

module.exports = router;
