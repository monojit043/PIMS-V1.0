const router = require('express').Router();
const ctrl   = require('../controllers/dashboardController');
const { requireLogin } = require('../middleware/auth');

router.get('/dashboard/role-summary', requireLogin, ctrl.roleSummary);
router.get('/dashboard/modeller/jobs', requireLogin, ctrl.modellerJobs);
router.get('/dashboard/modeller/summary', requireLogin, ctrl.modellerSummary);
router.get('/dashboard/checker/jobs', requireLogin, ctrl.checkerJobs);
router.get('/dashboard/checker/summary', requireLogin, ctrl.checkerSummary);

module.exports = router;
