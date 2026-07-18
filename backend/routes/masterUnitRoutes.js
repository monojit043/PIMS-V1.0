const router = require("express").Router();
const { requireLogin } = require("../middleware/auth");
const ctrl = require("../controllers/masterUnitController");

// resolve must be before the plain GET to avoid path collision
router.get("/master-units/resolve", requireLogin, ctrl.resolveMasterUnit);
router.get("/master-units",         requireLogin, ctrl.getMasterUnits);
router.post("/master-units",        requireLogin, ctrl.setMasterUnit);
router.delete("/master-units",      requireLogin, ctrl.deleteMasterUnit);

module.exports = router;
