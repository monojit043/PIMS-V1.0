const router = require("express").Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const ctrl = require("../controllers/drawingController");
const { requireLogin, requireModellerRole } = require("../middleware/auth");

const UPLOADS_ROOT = path.join(__dirname, "..", "uploads");
const TEMP_DIR = path.join(__dirname, "..", "temp");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Multer for isometric uploads (dynamic destination by project/unit/zone)
const isoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const info = JSON.parse(req.body.fileInfo || "{}");
      const job = req.body.project;
      const dir = path.join(UPLOADS_ROOT, job, info.unit, info.zone);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    } catch (e) { cb(e); }
  },
  filename: (req, file, cb) => {
    try {
      const info = JSON.parse(req.body.fileInfo || "{}");
      // Temp name; final rename happens in controller
      cb(null, `${Date.now()}_${file.originalname.replace(/[^\w.\-]/g, "_")}`);
    } catch (e) { cb(e); }
  },
});

const uploadIso = multer({
  storage: isoStorage,
  fileFilter: (req, file, cb) => {
    if (!/\.pdf$/i.test(file.originalname)) return cb(new Error("Only PDF files allowed"));
    cb(null, true);
  },
  limits: { fileSize: 50 * 1024 * 1024 },
});

// Multer for annotated files (temp dir)
const tempStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TEMP_DIR),
  filename: (req, file, cb) => {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    cb(null, `${ts}__${file.originalname.replace(/[^\w.\-]/g, "_")}`);
  },
});
const uploadTemp = multer({ storage: tempStorage, limits: { fileSize: 50 * 1024 * 1024 } });

router.get("/tree", ctrl.getTree);
router.get("/isos", requireLogin, ctrl.getISOs);
router.get("/get-base-file", requireLogin, ctrl.getBaseFile);
router.post("/upload-isometric", requireModellerRole, uploadIso.single("file"), ctrl.uploadIsometric);
router.post("/save-annotated", requireLogin, uploadTemp.single("annotatedFile"), ctrl.saveAnnotated);
router.post("/finalize-annotation", requireLogin, ctrl.finalizeAnnotation);
router.get("/check-iso-roles", requireLogin, ctrl.checkIsoRoles);
router.get("/process-checkers", requireLogin, ctrl.getProcessCheckers);
router.get("/checker-roles", requireLogin, ctrl.getCheckerRoles);
router.get("/line-details", requireLogin, ctrl.getLineDetails);
router.get("/task-history", requireLogin, ctrl.getTaskHistory);
router.get("/drawing-revision-history", requireLogin, ctrl.getRevisionHistory);
router.post("/modeller-resubmit", requireModellerRole, uploadTemp.single("file"), ctrl.modellerResubmit);
router.post("/drawings/tag",     requireLogin,          ctrl.tagDrawing);

module.exports = router;
