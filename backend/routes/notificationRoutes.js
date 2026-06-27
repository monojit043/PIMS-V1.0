const router = require("express").Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const ctrl = require("../controllers/notificationController");
const { requireLogin, requireCheckerRole, requireGLRole, requireSGLAccess } = require("../middleware/auth");

const TEMP_DIR = path.join(__dirname, "..", "temp");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const uploadTemp = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TEMP_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname.replace(/[^\w.\-]/g, "_")}`),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// Live notification SSE + CRUD
router.get("/notif/stream",     requireLogin, ctrl.sseStream);
router.get("/notif",            requireLogin, ctrl.getNotifList);
router.put("/notif/read-all",   requireLogin, ctrl.markAllRead);
router.put("/notif/:id/read",   requireLogin, ctrl.markOneRead);

router.get("/notifications", requireLogin, ctrl.getNotifications);
router.get("/notifications-by-role", requireLogin, ctrl.getNotificationsByRole);
router.post("/claim-notifications", requireLogin, ctrl.claimNotifications);
router.get("/my-claimed-tasks", requireLogin, ctrl.getClaimedTasks);
router.get("/my-modeller-tasks", requireLogin, ctrl.getModellerTasks);
router.get("/my-gl-tasks", requireLogin, ctrl.getGLTasks);
router.get("/my-all-tasks", requireLogin, ctrl.getAllTasks);
router.get("/drawing-claimers", requireLogin, ctrl.getDrawingClaimers);
router.post("/forward-iso-lines", requireLogin, ctrl.forwardIsoLines);
router.get("/sc-users", requireLogin, ctrl.getScUsers);
router.get("/modellers", requireLogin, ctrl.getModellerUsers);
router.post("/send-for-supporting", requireLogin, ctrl.sendForSupporting);
router.post("/submit-checker-comments", requireCheckerRole, uploadTemp.single("commentFile"), ctrl.submitCheckerComments);
router.post("/submit-gl-comments", requireGLRole, uploadTemp.single("commentFile"), ctrl.submitGLComments);
router.post("/submit-sgl-comments", requireSGLAccess, uploadTemp.single("commentFile"), ctrl.submitSGLComments);
router.post("/forward-gl-to-modeller", requireLogin, uploadTemp.single("commentFile"), ctrl.forwardGLToModeller);
// Independent blocking-hold escalation — description only, no file attachment.
router.post("/declare-checker-blocking-hold", requireCheckerRole, ctrl.declareCheckerBlockingHold);
router.post("/declare-gl-blocking-hold",       requireGLRole,      ctrl.declareGLBlockingHold);
router.post("/declare-sgl-blocking-hold",      requireSGLAccess,   ctrl.declareSGLBlockingHold);
router.post("/unclaim", requireLogin, ctrl.unclaimLine);
router.get("/zone-claims", requireLogin, ctrl.getZoneClaims);
router.get("/my-final-isometrics", requireLogin, ctrl.getGLFinalIsometrics);
router.get("/track-line",          requireLogin, ctrl.trackLine);
router.get("/line-holds",          requireLogin, ctrl.getLineHolds);
router.patch("/drawing-comments/:id/hold", requireLogin, ctrl.removeHold);

module.exports = router;
