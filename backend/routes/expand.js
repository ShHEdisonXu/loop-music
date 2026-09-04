// 阿里云盘扩展路由（本服务不实现，统一返回未配置）
const express = require('express');
const router = express.Router();

const notConfigured = (req, res) => res.json({ code: 500, msg: '阿里云盘同步未配置' });

router.post('/getAuthorizationCode', notConfigured);
router.post('/getConfirmCode', notConfigured);
router.get('/checkAccessToken', notConfigured);
router.get('/getAndSetUserInfo', notConfigured);
router.post('/checkFolder', notConfigured);
router.get('/getDefaultSavePath', notConfigured);
router.post('/autoCreateFolder', notConfigured);
router.get('/syncOnce', notConfigured);
router.get('/incrementalSync', notConfigured);
router.get('/queryAllUploadFile', notConfigured);
router.get('/queryAllUploadFileTree', notConfigured);

module.exports = router;
