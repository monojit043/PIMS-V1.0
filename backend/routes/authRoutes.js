const router = require("express").Router();
const ctrl = require("../controllers/authController");
const { requireLogin } = require("../middleware/auth");

router.post("/login", ctrl.login);
router.post("/logout", ctrl.logout);
router.get("/me", requireLogin, ctrl.me);
router.post("/change-password", requireLogin, ctrl.changePassword);

module.exports = router;
