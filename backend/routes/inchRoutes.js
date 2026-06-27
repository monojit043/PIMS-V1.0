const router = require('express').Router();
const ctrl   = require('../controllers/inchController');
const { requireLogin } = require('../middleware/auth');

router.post('/inch/upload',  requireLogin, ctrl.uploadInchData);
router.get('/inch/unit',     requireLogin, ctrl.getInchForUnit);
router.get('/inch/line',     requireLogin, ctrl.getInchByLine);
router.get('/inch/data',     requireLogin, ctrl.getInchData);
router.get('/inch/export',   requireLogin, ctrl.exportInchData);
router.get('/inch/summary',  requireLogin, ctrl.getInchSummary);

module.exports = router;
