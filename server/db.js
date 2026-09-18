"use strict";
/* 数据层：Node 内置 node:sqlite。
 * users 账号 / settings 配置(JSON) / orders 订单(业务数据存 JSON)；时间统一用毫秒时间戳 */
const { DatabaseSync } = require("node:sqlite");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// 数据目录可用环境变量 DATA_DIR 指定
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "daka.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_active ON users(phone) WHERE deleted = 0;
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    from_user TEXT NOT NULL,
    to_user TEXT NOT NULL,
    text TEXT NOT NULL,
    attachment TEXT,
    created_at INTEGER NOT NULL,
    read_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages(from_user, to_user, created_at);
  CREATE INDEX IF NOT EXISTS idx_msg_unread ON messages(to_user, read_at);
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    season TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    order_id TEXT,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_notif_unread ON notifications(user_id, read_at);
  -- 推送订阅：一台设备一行，endpoint 唯一
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    ua TEXT,
    created_at INTEGER NOT NULL,
    last_ok_at INTEGER,
    fail_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
`);

const uid = () => crypto.randomBytes(9).toString("base64url");

function getSetting(key, fallback) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? JSON.parse(row.value) : fallback;
}
function setSetting(key, value) {
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(key, JSON.stringify(value));
}

// 老库升级：补齐新版本才有的列和配置（seedIfEmpty 只在空库上跑）
const DEFAULT_ROLES = [
  { k: "sales", label: "业务员", template: "sales", core: true },
  { k: "follower", label: "下厂员", template: "follower", core: true }
];
// 默认季节：去年到后年，SS/FW 各一个
function defaultSeasons() {
  let y;
  try { y = +new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", year: "numeric" }).format(new Date()); }
  catch (e) { y = new Date().getFullYear(); }
  const list = [];
  for (let yy = y - 1; yy <= y + 2; yy++) list.push("SS" + yy, "FW" + yy);
  return list;
}
function columnExists(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
}

function ensureDefaults() {
  if (!columnExists("messages", "attachment")) {
    db.exec("ALTER TABLE messages ADD COLUMN attachment TEXT");
    console.log("[db] 已为 messages 表补上 attachment 列");
  }
  // 通知的结构化字段；老通知这几列为 NULL，前端退回纯文本
  if (!columnExists("notifications", "actor_name")) {
    db.exec("ALTER TABLE notifications ADD COLUMN actor_name TEXT");
    db.exec("ALTER TABLE notifications ADD COLUMN order_label TEXT");
    db.exec("ALTER TABLE notifications ADD COLUMN what TEXT");
    console.log("[db] 已为 notifications 表补上 actor_name/order_label/what 列");
  }
  const roles = getSetting("roles", null);
  if (!roles || !roles.length) {
    setSetting("roles", DEFAULT_ROLES);
    console.log("[db] 已为现有数据库补齐职位配置");
  }
  const factories = getSetting("factories", null);
  if (factories && !factories.fabric) {
    factories.fabric = [];
    setSetting("factories", factories);
    console.log("[db] 已为现有数据库补齐面料工厂配置");
  }
  // 补季节配置时保留订单里已用到的季节
  const seasons = getSetting("seasons", null);
  if (!seasons || !seasons.length) {
    const merged = defaultSeasons();
    db.prepare("SELECT DISTINCT season FROM orders WHERE season IS NOT NULL AND season <> ''").all()
      .forEach(r => { if (!merged.includes(r.season)) merged.push(r.season); });
    setSetting("seasons", merged);
    console.log("[db] 已为现有数据库补齐季节配置");
  }
  // 字段配置的历次调整：每步幂等，改过才写回
  const fields = getSetting("fields", null);
  if (!fields || !fields.order) console.warn("[db] 警告：缺少字段配置");
  else {
    fields.production = fields.production || [];
    const idx = k => fields.order.findIndex(f => f.k === k);
    const has = k => idx(k) >= 0;
    const steps = [
      // 产前样进度挪到「一、订单明细」，业务员才能打卡；只挪位置，记录不动
      ["产前样进度移到「一、订单明细」", () => {
        const i = fields.production.findIndex(f => f.k === "preSample");
        if (i < 0) return false;
        const [moved] = fields.production.splice(i, 1);
        if (!has("preSample")) { const at = idx("embProg"); fields.order.splice(at >= 0 ? at + 1 : fields.order.length, 0, moved); }
        return true;
      }],
      ["「面料」改为「面料工厂」下拉", () => {
        if (!has("fabric") || has("fabricFactory")) return false;
        fields.order = fields.order.filter(f => f.k !== "fabric");
        const at = idx("embFactory");
        fields.order.splice(at >= 0 ? at : fields.order.length, 0, { k: "fabricFactory", label: "面料工厂", type: "factory-fabric" });
        return true;
      }],
      ["「生产厂」挪到「一、订单明细」", () => {
        const i = fields.production.findIndex(f => f.k === "factory");
        if (i < 0) return false;
        const [f] = fields.production.splice(i, 1);
        const fab = fields.order.findIndex(x => x.k === "fabricFactory" || x.k === "fabricFactory1"), emb = idx("embFactory");
        fields.order.splice(fab >= 0 ? fab : emb >= 0 ? emb : fields.order.length, 0, f);
        return true;
      }],
      ["「生产厂」改名「服装工厂」", () => {
        const f = fields.order.find(x => x.k === "factory" && x.label === "生产厂");
        if (!f) return false;
        f.label = "服装工厂";
        return true;
      }],
      ["「面料工厂」拆成「面料工厂1/2」", () => {
        const i = idx("fabricFactory");
        if (i < 0 || has("fabricFactory1")) return false;
        fields.order.splice(i, 1, { k: "fabricFactory1", label: "面料工厂1", type: "factory-fabric" },
          { k: "fabricFactory2", label: "面料工厂2", type: "factory-fabric" });
        return true;
      }],
      ["「绣印工厂」拆成「绣花工厂」「印花工厂」", () => {
        const i = idx("embFactory");
        if (i < 0 || has("printFactory")) return false;
        fields.order[i].label = "绣花工厂";
        fields.order.splice(i + 1, 0, { k: "printFactory", label: "印花工厂", type: "factory-emb" });
        return true;
      }],
      // 工序/人数/预计下车时间改回本厂打卡时填，不再挂在服装工厂旁
      ["撤掉本厂的工序/人数/预计下车时间字段", () => {
        const n = fields.order.length;
        fields.order = fields.order.filter(f => !["mainProcess", "mainWorkers", "mainEstDone"].includes(f.k));
        return fields.order.length !== n;
      }]
    ];
    let changed = false;
    steps.forEach(([msg, run]) => { if (run()) { changed = true; console.log("[db] 字段迁移：" + msg); } });
    if (changed) setSetting("fields", fields);
  }
  // 技术主管/业务主管改用主管模板，清掉旧版废弃的权限字段
  const rolesForPerm = getSetting("roles", []);
  let permChanged = false;
  rolesForPerm.forEach(r => {
    // 内置下厂员职位必须保持 follower 模板（曾被旧规则误升为主管）
    const shouldSupervise = r.k !== "follower" &&
      (r.label === "技术主管" || r.label === "业务主管" || r.fullAccess || r.permAdd) && r.template !== "supervisor";
    if (shouldSupervise) { r.template = "supervisor"; permChanged = true; }
    if (r.k === "follower" && r.template !== "follower") { r.template = "follower"; permChanged = true; }
    if (r.fullAccess !== undefined) { delete r.fullAccess; permChanged = true; }
    if (r.permAdd !== undefined || r.permEdit !== undefined || r.permDelete !== undefined) {
      delete r.permAdd; delete r.permEdit; delete r.permDelete; permChanged = true;
    }
  });
  if (permChanged) {
    setSetting("roles", rolesForPerm);
    console.log("[db] 已把「技术主管」「业务主管」职位改成「主管权限」模板，并修复「下厂员」职位被误设为「主管权限」的问题");
  }
  migrateOrdersSchema();
}

// 订单数据迁移到新版生产进度/验货结构，可重复执行
function migrateOrdersSchema() {
  const rows = db.prepare("SELECT id, data FROM orders").all();
  let migrated = 0;
  rows.forEach(r => {
    const d = JSON.parse(r.data);
    let touched = false;
    if (d.values && d.values.fabricFactory !== undefined && d.values.fabricFactory1 === undefined) {
      d.values.fabricFactory1 = d.values.fabricFactory;
      delete d.values.fabricFactory;
      touched = true;
    }
    if (!Array.isArray(d.mainLog)) { d.mainLog = []; touched = true; }
    if (!Array.isArray(d.subs)) { d.subs = []; touched = true; }
    else {
      const mainIdx = d.subs.findIndex(s => s.name === "主厂" && !s.id);
      if (mainIdx >= 0) {
        const main = d.subs[mainIdx];
        if (Array.isArray(main.log) && main.log.length) d.mainLog = d.mainLog.concat(main.log);
        d.subs.splice(mainIdx, 1);
        touched = true;
      }
      d.subs.forEach(s => {
        if (!s.id) { s.id = uid(); touched = true; }
        if ("factory" in s) { delete s.factory; touched = true; }
      });
      const before = d.subs.length;
      d.subs = d.subs.filter(s => !(/^加工厂[234]$/.test(s.name) && (!s.log || !s.log.length)));
      if (d.subs.length !== before) touched = true;
    }
    if (Array.isArray(d.inspections)) {
      d.inspections.forEach(g => {
        if (g.date !== undefined) { delete g.date; touched = true; }
        (g.items || []).forEach(it => {
          if (!it.id) { it.id = uid(); touched = true; }
          if (it.problemBy === undefined) { it.problemBy = g.by; it.problemByName = g.byName; it.problemAt = g.t; touched = true; }
          if (it.fixBy === undefined) { it.fixBy = null; it.fixByName = it.fixByName || ""; it.fixAt = it.fixAt || null; touched = true; }
          if (!Array.isArray(it.notes)) { it.notes = []; touched = true; }
        });
      });
    }
    if (touched) { db.prepare("UPDATE orders SET data=? WHERE id=?").run(JSON.stringify(d), r.id); migrated++; }
  });
  if (migrated) console.log(`[db] 已迁移 ${migrated} 个订单到新版生产进度/验货数据结构`);
}

// 首次运行填充演示数据
function seedIfEmpty() {
  const n = db.prepare("SELECT COUNT(*) c FROM users").get().c;
  if (n > 0) return;

  const now = Date.now();
  const mkUser = (name, phone, role) => {
    const id = uid();
    db.prepare("INSERT INTO users(id,name,phone,password_hash,role,deleted,created_at) VALUES(?,?,?,?,?,0,?)")
      .run(id, name, phone, bcrypt.hashSync("123456", 10), role, now);
    return id;
  };
  const boss = mkUser("老板", "13800000000", "admin");
  const s1 = mkUser("陈晓芳", "13811112222", "sales");
  const s2 = mkUser("林志远", "13833334444", "sales");
  const f1 = mkUser("王建国", "13855556666", "follower");
  const f2 = mkUser("刘敏", "13877778888", "follower");
  const nameOf = { [boss]: "老板", [s1]: "陈晓芳", [s2]: "林志远", [f1]: "王建国", [f2]: "刘敏" };

  setSetting("roles", DEFAULT_ROLES);
  setSetting("factories", {
    fabric: ["恒信面料行", "锦源纺织"],
    emb: ["锦绣绣花厂", "华艺印花厂", "美达绣印"],
    prod: ["宏发制衣厂", "联诚服装厂", "永盛制衣"]
  });
  setSetting("seasons", defaultSeasons());
  setSetting("fields", {
    order: [
      { k: "sales", label: "业务员", type: "user-sales", core: true },
      { k: "styleNo", label: "货号", type: "text" },
      { k: "img", label: "款式图", type: "image" },
      { k: "styleName", label: "款式名", type: "text" },
      { k: "style", label: "款式", type: "text" },
      { k: "qty", label: "数量", type: "number" },
      { k: "desc", label: "款式描述", type: "textarea" },
      { k: "deadline", label: "订单交期", type: "date" },
      { k: "fabricProg", label: "面料进度", type: "log" },
      { k: "embProg", label: "绣印进度", type: "log" },
      { k: "preSample", label: "产前样进度", type: "log" },
      { k: "factory", label: "服装工厂", type: "factory-prod" },
      { k: "fabricFactory1", label: "面料工厂1", type: "factory-fabric" },
      { k: "fabricFactory2", label: "面料工厂2", type: "factory-fabric" },
      { k: "embFactory", label: "绣花工厂", type: "factory-emb" },
      { k: "printFactory", label: "印花工厂", type: "factory-emb" }
    ],
    production: [
      { k: "follower", label: "下厂员", type: "user-follower", core: true },
      { k: "cutting", label: "裁剪进度", type: "log" },
      { k: "ironing", label: "整烫进度", type: "log" },
      { k: "packing", label: "包装进度", type: "log" },
      { k: "shipDate", label: "发货日期", type: "date" }
    ]
  });

  const T = (d, h, m) => new Date(2026, 6, d, h, m).getTime();
  const L = (by, d, h, m, text) => ({ id: uid(), by, byName: nameOf[by], t: T(d, h, m), text });
  const emptyLogs = () => ({ fabricProg: [], embProg: [], preSample: [], cutting: [], ironing: [], packing: [] });
  // 验货：业务员填发现问题，下厂员后续填整改情况
  const insp = (problemer, d, h, m, pairs) => ({
    id: uid(), t: T(d, h, m), by: problemer, byName: nameOf[problemer], photos: [],
    items: pairs.map(([fixer, problem, fix]) => ({
      id: uid(), problem, problemBy: problemer, problemByName: nameOf[problemer], problemAt: T(d, h, m),
      fix: fix || "", fixBy: fix ? fixer : null, fixByName: fix ? nameOf[fixer] : "",
      fixAt: fix ? T(d, h, m + 30) : null, notes: []
    }))
  });
  const insertOrder = (season, createdBy, values, logs, mainLog, subs, inspections, followIssues) => {
    db.prepare("INSERT INTO orders(id,season,created_by,created_at,updated_at,data) VALUES(?,?,?,?,?,?)")
      .run(uid(), season, createdBy, T(1, 9, 0), now,
        JSON.stringify({ values, logs: Object.assign(emptyLogs(), logs), mainLog, subs, inspections, followIssues }));
  };

  insertOrder("SS2027", s1,
    { sales: s1, styleNo: "SS27-T012", styleName: "女装印花短袖T恤", style: "圆领短袖", qty: "3200",
      desc: "32支精梳棉，前胸水浆印花，领口撞色包边", deadline: "2026-08-15", fabricFactory: "恒信面料行",
      embFactory: "华艺印花厂", follower: f1, factory: "宏发制衣厂", shipDate: "" },
    { fabricProg: [L(s1, 8, 10, 20, "面料已下机染色，预计12日到仓"), L(f1, 13, 9, 5, "面料到仓 2860kg，已验布，色差合格")],
      embProg: [L(f1, 15, 14, 30, "印花版已确认，16日上机")],
      preSample: [L(f1, 5, 16, 0, "产前样已寄客户，等确认意见")],
      cutting: [L(f1, 17, 8, 40, "已开裁，2张裁床，预计19日裁完"), L(f1, 19, 17, 10, "裁剪完成，共3250件裁片，含备损")] },
    [L(f1, 19, 17, 30, "车缝上线2条，日产约400件")],
    [ { id: uid(), name: "加工点1（新星印花厂）", log: [L(f1, 18, 9, 0, "外发印花 800件，预计20日回厂")] } ],
    [ insp(s1, 18, 15, 0, [[f1, "首件肩缝有轻微起皱", "已调整缝纫机张力，返修3件后正常"]]) ],
    [ { id: uid(), by: s1, byName: "陈晓芳", t: T(16, 11, 20), text: "客户要求包装改用平铺装，每箱40件，已通知工厂", photos: [] } ]
  );

  insertOrder("SS2027", s2,
    { sales: s2, styleNo: "SS27-D031", styleName: "碎花吊带连衣裙", style: "连衣裙", qty: "1800",
      desc: "全棉印花梭织布，腰部松紧，裙摆压褶", deadline: "2026-08-28", fabricFactory: "锦源纺织",
      embFactory: "美达绣印", follower: f2, factory: "联诚服装厂", shipDate: "" },
    { fabricProg: [L(s2, 14, 9, 30, "坯布已进印花厂，预计20日出成品布")],
      preSample: [L(f2, 17, 10, 15, "产前样制作中，预计21日完成")] },
    [], [], [], []
  );

  insertOrder("FW2026", s1,
    { sales: s1, styleNo: "FW26-J105", styleName: "男装连帽夹克", style: "夹克外套", qty: "2600",
      desc: "尼龙面料防泼水，前胸绣花logo，双层帽", deadline: "2026-07-30", fabricFactory: "恒信面料行",
      embFactory: "锦绣绣花厂", follower: f1, factory: "永盛制衣", shipDate: "2026-07-28" },
    { fabricProg: [L(s1, 1, 10, 0, "面料6月28日已全部到仓")],
      embProg: [L(f1, 3, 15, 0, "绣花片已回厂，数量核对无误")],
      preSample: [L(f1, 2, 9, 0, "产前样客户已确认")],
      cutting: [L(f1, 6, 8, 30, "裁剪完成")],
      ironing: [L(f1, 16, 14, 0, "大烫进行中，已完成约60%"), L(f1, 19, 16, 40, "整烫全部完成")],
      packing: [L(f1, 19, 18, 0, "开始包装，预计22日完成，每箱30件")] },
    [L(f1, 10, 9, 0, "车缝完成，尾查中")],
    [ { id: uid(), name: "加工点1（汇丰加工厂）", log: [L(f1, 8, 9, 0, "800件已完成回厂")] } ],
    [ insp(s1, 12, 14, 0, [
        [f1, "拉链头个别拉合不顺", "供应商已换新拉链头，全检更换"],
        [f1, "帽绳长短不一约20件", "已返工统一长度"]
      ]) ],
    [ { id: uid(), by: boss, byName: "老板", t: T(13, 8, 50), text: "此单交期紧，包装完成后立即安排出货，物流已订", photos: [] } ]
  );

  console.log("[db] 已填充演示数据（管理员 13800000000 / 密码 123456）");
}

module.exports = { db, uid, getSetting, setSetting, seedIfEmpty, ensureDefaults, DATA_DIR, UPLOAD_DIR };
