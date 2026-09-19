"use strict";
// API 路由(/api)。订单业务数据以 JSON 存在 orders.data，所有写操作在服务端校验权限
// 这里只按顺序挂上各功能模块，具体接口见同目录下的文件
const express = require("express");
const A = require("../auth");
const session = require("./session");
const exportRoutes = require("./export");

const router = express.Router();

// 不需要登录：登录、导出文件下载（靠一次性票据）
router.use(session.pub);
router.use(exportRoutes.pub);

// 以下全部要登录
router.use(A.authRequired);
router.use(session.router);
router.use(require("./users"));
router.use(require("./settings"));
router.use(require("./orders"));
router.use(require("./chat"));
router.use(require("./notifications"));
router.use(require("./uploads"));
router.use(require("./import"));
router.use(exportRoutes.router);

module.exports = router;
