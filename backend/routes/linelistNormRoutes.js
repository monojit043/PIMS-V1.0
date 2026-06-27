const router = require('express').Router();
const ctrl   = require('../controllers/linelistNormController');
const { requireLogin } = require('../middleware/auth');

router.post('/linelist/save',              requireLogin, ctrl.saveLinelist);
router.get('/linelist/jobs',               requireLogin, ctrl.getJobsSummary);
router.get('/linelist/lines/:jobNo',       requireLogin, ctrl.getJobLines);
router.get('/linelist/history/:jobNo',     requireLogin, ctrl.getUploadHistory);
router.get('/linelist/check-rev/:jobNo',   requireLogin, ctrl.checkRev);
router.get('/linelist/export/:uploadId',   requireLogin, ctrl.getByUploadId);
router.get('/linelist/line-data',          requireLogin, ctrl.getLineData);

module.exports = router;
