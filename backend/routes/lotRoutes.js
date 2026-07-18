const router = require("express").Router();
const { requireLogin } = require("../middleware/auth");
const ctrl = require("../controllers/lotController");

router.post("/lots/create",                         requireLogin, ctrl.createLot);
router.post("/lots/issue-selected",                 requireLogin, ctrl.issueSelectedLines);
router.get("/lots/planned",                         requireLogin, ctrl.getPlannedLots);
router.get("/lots/status",                          requireLogin, ctrl.getLotStatus);
router.get("/lots/issued-jobs",                     requireLogin, ctrl.getIssuedJobsSummary);
router.get("/lots/issued-by-job",                   requireLogin, ctrl.getIssuedLotsByJob);
router.get("/lots",                                 requireLogin, ctrl.getLots);
router.get("/lots/:lotId/lines",                    requireLogin, ctrl.getLotLines);
router.post("/lots/:lotId/issue",                   requireLogin, ctrl.issueLot);
router.post("/lots/:lotId/lines",                   requireLogin, ctrl.assignLinesToLot);
router.delete("/lots/:lotId/lines/:drawingId",      requireLogin, ctrl.removeLineFromLot);
router.get("/lots/:lotId/export",                   requireLogin, ctrl.exportLot);

module.exports = router;
