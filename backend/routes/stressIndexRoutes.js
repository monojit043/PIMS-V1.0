"use strict";
const router = require("express").Router();
const { requireLogin, requireAnyRole } = require("../middleware/auth");
const ctrl = require("../controllers/stressIndexController");

const requireStressAccess = requireAnyRole("Stress Checker", "GL", "SGL");

// Upload operations — Stress Checker / GL / SGL only
router.post("/stress-index/preview", requireLogin, requireStressAccess, ctrl.previewStressUpload);
router.post("/stress-index/apply",   requireLogin, requireStressAccess, ctrl.applyStressUpload);

// Read operations — all authenticated users
router.get("/stress-index/data",    requireLogin, ctrl.getStressIndexData);
router.get("/stress-index/summary", requireLogin, ctrl.getStressIndexSummary);
router.get("/stress-index/export",  requireLogin, ctrl.exportStressIndex);

module.exports = router;
