const router = require("express").Router();
const multer = require("multer");
const path   = require("path");
const fs     = require("fs");
const ctrl   = require("../controllers/gadController");
const wf     = require("../controllers/gadWorkflowController");
const { requireLogin, requireModellerRole } = require("../middleware/auth");

const UPLOADS_ROOT = path.join(__dirname, "..", "uploads");
const TEMP_DIR     = path.join(__dirname, "..", "temp");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ── Multer: GAD upload — stores to uploads/{job}/{unit}/gad/{area}/ ────────
const gadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const info = JSON.parse(req.body.fileInfo || "{}");
      if (!info.valid) return cb(new Error(info.error || "Invalid GAD number"));
      const dir = path.join(UPLOADS_ROOT, info.jobNo, info.unitNo, "gad", info.areaNno);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    } catch (e) { cb(e); }
  },
  filename: (req, file, cb) => {
    // Temp name — final rename happens in controller
    cb(null, `${Date.now()}_${file.originalname.replace(/[^\w.\-]/g, "_")}`);
  },
});

const uploadGAD = multer({
  storage: gadStorage,
  fileFilter: (req, file, cb) => {
    if (!/\.pdf$/i.test(file.originalname)) return cb(new Error("Only PDF files allowed"));
    cb(null, true);
  },
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ── Multer: temp storage for annotated files ──────────────────────────────
const tempStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TEMP_DIR),
  filename: (req, file, cb) => {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    cb(null, `${ts}__${file.originalname.replace(/[^\w.\-]/g, "_")}`);
  },
});
const uploadTemp = multer({ storage: tempStorage, limits: { fileSize: 50 * 1024 * 1024 } });

// ── Document routes ───────────────────────────────────────────────────────
router.get ("/gad/tree",               ctrl.getTree);
router.get ("/gads",        requireLogin, ctrl.getGADs);
router.get ("/gads/final",  requireLogin, ctrl.getFinalGADs);
router.get ("/gad/get-base-file",      requireLogin, ctrl.getBaseFile);
router.post("/gad/upload",  requireModellerRole, uploadGAD.single("file"), ctrl.uploadGAD);
router.post("/gad/save-annotated",     requireLogin, uploadTemp.single("annotatedFile"), ctrl.saveAnnotated);
router.post("/gad/finalize-annotation",requireLogin, ctrl.finalizeAnnotation);
router.get ("/gad/check-roles",        requireLogin, ctrl.checkGADRoles);
router.get ("/gad/process-checkers",   requireLogin, ctrl.getProcessCheckers);
router.get ("/gad/checker-roles",      requireLogin, ctrl.getCheckerRoles);
router.get ("/gad/details",            requireLogin, ctrl.getGADDetails);
router.get ("/gad/task-history",       requireLogin, ctrl.getTaskHistory);
router.post("/gad/modeller-resubmit",  requireModellerRole, uploadTemp.single("file"), ctrl.modellerResubmit);

// ── Workflow / notification routes ────────────────────────────────────────
router.get ("/gad/notifications",           requireLogin, wf.getGADNotifications);
router.get ("/gad/notifications-by-role",   requireLogin, wf.getGADNotificationsByRole);
router.post("/gad/claim-notifications",     requireLogin, wf.claimGADNotifications);
router.get ("/gad/my-claimed-tasks",        requireLogin, wf.getClaimedGADTasks);
router.get ("/gad/my-modeller-tasks",       requireLogin, wf.getModellerGADTasks);
router.get ("/gad/my-gl-tasks",             requireLogin, wf.getGLGADTasks);
router.get ("/gad/claimers",                requireLogin, wf.getGADClaimers);
router.get ("/gad/area-claims",             requireLogin, wf.getAreaClaims);
router.post("/gad/unclaim",                 requireLogin, wf.unclaimGAD);
router.post("/gad/send-for-supporting",     requireLogin, wf.sendGADForSupporting);
router.post("/gad/submit-checker-comments", requireLogin, uploadTemp.single("file"), wf.submitGADCheckerComments);
router.post("/gad/submit-gl-comments",      requireLogin, uploadTemp.single("file"), wf.submitGADGLComments);
router.post("/gad/submit-sgl-comments",     requireLogin, uploadTemp.single("file"), wf.submitGADSGLComments);
router.post("/gad/forward-gl-to-modeller",  requireLogin, uploadTemp.single("file"), wf.forwardGADGLToModeller);
// New 4-stage workflow review endpoints
router.post("/gad/submit-by-review",        requireLogin, uploadTemp.single("file"), wf.submitByReview);
router.post("/gad/submit-bycheckReview",    requireLogin, uploadTemp.single("file"), wf.submitByCheckReview);
router.post("/gad/submit-check-review",     requireLogin, uploadTemp.single("file"), wf.submitCheckReview);
router.post("/gad/submit-gl-review",        requireLogin, uploadTemp.single("file"), wf.submitGLReview);
router.get ("/gad/holds",                   requireLogin, wf.getGADHolds);
router.patch("/gad/comments/:id/hold",      requireLogin, wf.removeGADHold);

// ── GAD Lot issuance ───────────────────────────────────────────────────────
const gl = require("../controllers/gadLotController");
router.get ("/gad/lots",                    requireLogin, gl.getGADLots);
router.get ("/gad/lots/planned",            requireLogin, gl.getPlannedGADLots);
router.post("/gad/lots/issue-selected",     requireLogin, gl.issueSelectedGADs);
router.get ("/gad/lots/:lotId/export",      requireLogin, gl.exportGADLot);
router.get ("/gad/lots/:lotId/lines",       requireLogin, gl.getGADLotLines);
router.post("/gad/lots/:lotId/issue",       requireLogin, gl.issueGADLot);
router.delete("/gad/lots/:lotId/gads/:gadId", requireLogin, gl.removeGADFromLot);

module.exports = router;
