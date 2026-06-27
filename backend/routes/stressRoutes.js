const router = require("express").Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const ctrl = require("../controllers/stressController");
const { requireLogin } = require("../middleware/auth");

const TEMP_DIR = path.join(__dirname, "..", "temp");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const uploadTemp = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TEMP_DIR),
    filename: (req, file, cb) => {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      cb(null, `${ts}_${file.originalname.replace(/[^\w.\-]/g, "_")}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

router.post("/upload-stress-data", requireLogin, uploadTemp.single("stressFile"), ctrl.uploadStressData);
router.get("/final-isometrics", requireLogin, ctrl.getFinalIsometrics);
router.post("/final-isometrics/export-metadata", requireLogin, ctrl.exportMetadata);
router.post("/final-isometrics/export-zip", requireLogin, ctrl.exportZip);
router.post("/final-isometrics-revert", requireLogin, ctrl.revertFinalIsometrics);
router.get("/report-summary", requireLogin, ctrl.getReportSummary);

module.exports = router;
