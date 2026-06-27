const router = require('express').Router();
const ctrl   = require('../controllers/lmsController');
const { requireLogin } = require('../middleware/auth');

router.post('/lms/upload',  requireLogin, ctrl.uploadLmsData);
router.get('/lms/line',     requireLogin, ctrl.getLmsByLine);
router.get('/lms/data',     requireLogin, ctrl.getLmsData);
router.get('/lms/summary',  requireLogin, ctrl.getLmsSummary);
router.get('/lms/export',   requireLogin, ctrl.exportLmsData);

module.exports = router;
