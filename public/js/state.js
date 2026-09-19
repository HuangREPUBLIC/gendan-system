"use strict";
// 前端单页应用：数据都来自服务端；权限以服务端为准，这里只隐藏没权限的入口
// 全局状态和常量；A 是所有 onclick 处理函数的总表，各功能文件用 Object.assign 往里挂方法

const A = {};

let state = {
  token: localStorage.getItem("daka_token") || null,
  me: null, users: [], fields: { order: [], production: [] },
  factories: { emb: [], prod: [], proc: [] }, orders: [], roles: [], seasons: [],
  chat: { contacts: [], activeId: null, contact: null, messages: [], draft: "", att: null },
  unread: { total: 0, byUser: {} },
  // list 为 null 表示还没加载；open 是桌面端铃铛下拉
  notifs: { list: null, unread: 0, open: false },
  myLogs: null
};
let route = { v: "orders", id: null };
let editingBasic = false, editingFollower = false, importPreview = null, importRaw = "";
let showWelcome = false;  // 登录后短暂展示的欢迎界面
const expandedLogGroups = new Set();  // 打卡记录里展开全部的订单
// ship/recent 来自桌面端概览卡片
let filt = { season: "", sales: "", follower: "", kw: "", factoryKw: "", ship: "", recent: false };
let adminUserFilt = { kw: "", page: 1 };
let adminTab = "people";
const ADMIN_USERS_PAGE_SIZE = 10;
let modalState = null;

const COMPANY_NAME = "天津锦利国际贸易有限公司";
const APP_NAME = "跟单系统";
const APP_LOGO = `
  <svg viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect width="512" height="512" rx="116" fill="#2F5FA8"/>
    <rect x="128" y="87" width="256" height="338" rx="42" fill="#FFFFFF"/>
    <path d="M200 174 V338" stroke="#2F5FA8" stroke-width="16"/>
    <circle cx="200" cy="174" r="26" fill="#2F5FA8"/>
    <circle cx="200" cy="256" r="26" fill="#2F5FA8"/>
    <circle cx="200" cy="338" r="22" fill="#FFFFFF" stroke="#2F5FA8" stroke-width="15"/>
    <path d="M262 174 H334 M262 256 H334 M262 338 H296" stroke="#2F5FA8" stroke-width="26" stroke-linecap="round"/>
  </svg>`;
