// 插件路由（酷狗/QQVIP 等，本服务仅网易云，统一返回未登录）
const express = require('express');
const router = express.Router();

const notLogin = (req, res) => res.json({ code: 500, msg: '该插件未启用（本服务仅支持网易云）' });

router.get('/kg/refreshToken', notLogin);
router.get('/kg/signIn', notLogin);
router.get('/kg/getQrImage', notLogin);
router.get('/kg/checkQrCodeStatus', notLogin);
router.get('/kg/getWxQrImage', notLogin);
router.get('/kg/checkWxQrCodeStatus', notLogin);
router.get('/qqvip/getWechatQrImage', notLogin);
router.get('/qqvip/getQrImage', notLogin);
router.get('/qqvip/checkQrCodeStatus', notLogin);
router.get('/qqvip/refreshQQvipCookie', notLogin);

module.exports = router;
