"use strict";
/**
 * 数据层：使用 Node 内置的 node:sqlite（Node 22+），无需编译原生依赖。
 * 存储策略（<100 人规模，简单可靠）：
 *   - users     账号（登录、权限判定需要按手机号查，用独立列）
 *   - settings  键值表，存自定义字段(fields) 与工厂下拉(factories) 的 JSON
 *   - orders    每个订单一行，业务数据(values/logs/subs/inspections/followIssues) 存 JSON
 * 时间统一用毫秒时间戳(Date.now())。
 */
const { DatabaseSync } = require("node:sqlite");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// 数据目录可通过环境变量 DATA_DIR 指定（方便部署时挂载到独立磁盘/数据卷）
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
  CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    by_user TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    handled INTEGER NOT NULL DEFAULT 0,
    handled_at INTEGER
  );
`);

const uid = () => crypto.randomBytes(9).toString("base64url");

/* ---------- settings 帮助函数 ---------- */
function getSetting(key, fallback) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? JSON.parse(row.value) : fallback;
}
function setSetting(key, value) {
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(key, JSON.stringify(value));
}

/* ---------- 升级已有数据库：补齐新版本才有的配置 ----------
 * seedIfEmpty 只在全新库上跑，已经在用的库不会执行，
 * 所以新增的配置项要在这里补，否则老库升级后会缺配置。
 */
const DEFAULT_ROLES = [
  { k: "sales", label: "业务员", template: "sales", core: true },
  { k: "follower", label: "下厂员", template: "follower", core: true }
];
// 季节初始列表：当前年份前一年到后两年，SS/FW 各一档（管理员可在后台自行增删）
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
  // 老库补列：聊天附件
  if (!columnExists("messages", "attachment")) {
    db.exec("ALTER TABLE messages ADD COLUMN attachment TEXT");
    console.log("[db] 已为 messages 表补上 attachment 列");
  }
  // 老库补列：意见反馈的已处理标记
  if (!columnExists("feedback", "handled")) {
    db.exec("ALTER TABLE feedback ADD COLUMN handled INTEGER NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE feedback ADD COLUMN handled_at INTEGER");
    console.log("[db] 已为 feedback 表补上已处理标记列");
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
  // 老库补齐季节配置：按原先自动生成的年份区间为底，再把已有订单实际用到的季节也保留进去，避免"消失"
  const seasons = getSetting("seasons", null);
  if (!seasons || !seasons.length) {
    const merged = defaultSeasons();
    db.prepare("SELECT DISTINCT season FROM orders WHERE season IS NOT NULL AND season <> ''").all()
      .forEach(r => { if (!merged.includes(r.season)) merged.push(r.season); });
    setSetting("seasons", merged);
    console.log("[db] 已为现有数据库补齐季节配置");
  }
  // 老库把「面料」文本字段换成「面料工厂」下拉（插在绣印工厂前面），不影响其它自定义字段
  const fields = getSetting("fields", null);
  if (fields && fields.order) {
    const hasOldFabric = fields.order.some(f => f.k === "fabric");
    const hasFabricFactory = fields.order.some(f => f.k === "fabricFactory");
    if (hasOldFabric && !hasFabricFactory) {
      fields.order = fields.order.filter(f => f.k !== "fabric");
      const embIdx = fields.order.findIndex(f => f.k === "embFactory");
      const newField = { k: "fabricFactory", label: "面料工厂", type: "factory-fabric" };
      if (embIdx >= 0) fields.order.splice(embIdx, 0, newField); else fields.order.push(newField);
      setSetting("fields", fields);
      console.log("[db] 已将「面料」字段迁移为「面料工厂」下拉");
    }
  } else if (!fields) {
    console.warn("[db] 警告：缺少字段配置");
  }
  // 老库「生产厂」字段挂在"二、生产明细"下，改成挂到"一、订单明细"，排在面料工厂前面
  if (fields && fields.production && fields.order) {
    const idx = fields.production.findIndex(f => f.k === "factory");
    if (idx >= 0) {
      const [factoryField] = fields.production.splice(idx, 1);
      const fabIdx = fields.order.findIndex(f => f.k === "fabricFactory" || f.k === "fabricFactory1");
      const embIdx = fields.order.findIndex(f => f.k === "embFactory");
      const insertAt = fabIdx >= 0 ? fabIdx : (embIdx >= 0 ? embIdx : fields.order.length);
      fields.order.splice(insertAt, 0, factoryField);
      setSetting("fields", fields);
      console.log("[db] 已将「生产厂」字段从生产明细挪到订单明细(面料工厂前面)");
    }
  }
  // 老库标签重命名：主厂/生产厂 -> 本厂/服装工厂（只改显示文案，不动字段 key，数据不受影响）
  if (fields && fields.order) {
    const factoryF = fields.order.find(f => f.k === "factory" && f.label === "生产厂");
    if (factoryF) {
      factoryF.label = "服装工厂";
      setSetting("fields", fields);
      console.log("[db] 已将「生产厂」字段标签改名为「服装工厂」");
    }
  }
  // 老库拆分「面料工厂」为「面料工厂1」/「面料工厂2」，两个字段都保留动态多选(chip)UI；
  // 已有数据整体挪进 fabricFactory1，fabricFactory2 留空，员工可以自己再补填
  if (fields && fields.order) {
    const oldIdx = fields.order.findIndex(f => f.k === "fabricFactory");
    const hasSplit = fields.order.some(f => f.k === "fabricFactory1");
    if (oldIdx >= 0 && !hasSplit) {
      fields.order.splice(oldIdx, 1,
        { k: "fabricFactory1", label: "面料工厂1", type: "factory-fabric" },
        { k: "fabricFactory2", label: "面料工厂2", type: "factory-fabric" });
      setSetting("fields", fields);
      console.log("[db] 已将「面料工厂」拆分为「面料工厂1」「面料工厂2」");
    }
  }
  // 老库拆分「绣印工厂」为「绣花工厂」(沿用 embFactory 这个 key，数据不用搬)/「印花工厂」(新字段 printFactory)
  if (fields && fields.order) {
    const embF = fields.order.find(f => f.k === "embFactory");
    const hasPrintFactory = fields.order.some(f => f.k === "printFactory");
    if (embF && !hasPrintFactory) {
      embF.label = "绣花工厂";
      const embIdx = fields.order.findIndex(f => f.k === "embFactory");
      fields.order.splice(embIdx + 1, 0, { k: "printFactory", label: "印花工厂", type: "factory-emb" });
      setSetting("fields", fields);
      console.log("[db] 已将「绣印工厂」拆分为「绣花工厂」「印花工厂」");
    }
  }
  // 撤回「生产工序/车工人数/预计下车时间」挂在服装工厂旁边的做法——
  // 改回本厂打卡时才要填这三项(跟加工点不一样，加工点是创建时填，本厂没有单独的创建步骤，还是打卡时填)
  if (fields && fields.order) {
    const before = fields.order.length;
    fields.order = fields.order.filter(f => f.k !== "mainProcess" && f.k !== "mainWorkers" && f.k !== "mainEstDone");
    if (fields.order.length !== before) {
      setSetting("fields", fields);
      console.log("[db] 已撤回「生产工序」「车工人数」「预计下车时间」挂在服装工厂旁边的字段，改回本厂打卡时填");
    }
  }
  // 权限改回按"权限模板"分三档(业务员/下厂员/主管)后，技术主管/业务主管这两个职位要用
  // "主管"模板(能管所有订单)，不再是业务员模板——一次性迁移，以后新增主管职位直接在
  // 职位管理里选"主管权限"模板就行。同时清理掉之前版本试过的 fullAccess/permAdd/permEdit/
  // permDelete 这些废弃字段，避免残留数据造成混淆。
  const rolesForPerm = getSetting("roles", []);
  let permChanged = false;
  rolesForPerm.forEach(r => {
    // 内置的"下厂员"职位(k==="follower")权限模板必须固定是 follower，不能被下面这条
    // "曾带旧版 permAdd/fullAccess 标记就提升成主管权限"的规则误伤——它之前确实因为
    // 带过这个旧标记被误升级成了"主管权限"，导致下厂员账号能看到/操作所有订单，
    // 且订单页"下厂员"选人下拉框(按 template==="follower" 筛选)也因此是空的。
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

/**
 * 老库的订单迁移到新的「生产进度」「验货问题」数据结构：
 *  - subs 里叫"主厂"且没有 id 的那条 -> 挪进 mainLog，从 subs 里删掉
 *  - 其余 subs 补上 id（老结构没有），变成正式的动态加工点
 *  - 从没打过卡、还叫默认名字（加工厂2/3/4）的占位条目直接清掉，减少噪音
 *  - inspections：去掉 date，item 补 id/problemBy/fixBy/notes
 * 每一步都先判断"是不是已经是新结构"，可以放心重复跑（幂等）。
 */
function migrateOrdersSchema() {
  const rows = db.prepare("SELECT id, data FROM orders").all();
  let migrated = 0;
  rows.forEach(r => {
    const d = JSON.parse(r.data);
    let touched = false;
    // 「面料工厂」拆分为「面料工厂1」/「面料工厂2」：老数据整体搬进 fabricFactory1
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

/* ---------- 首次运行填充演示数据 ---------- */
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

  // 职位：label 可自由命名，template 决定权限（sales=业务员权限，follower=下厂员权限）
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
      { k: "factory", label: "服装工厂", type: "factory-prod" },
      { k: "fabricFactory1", label: "面料工厂1", type: "factory-fabric" },
      { k: "fabricFactory2", label: "面料工厂2", type: "factory-fabric" },
      { k: "embFactory", label: "绣花工厂", type: "factory-emb" },
      { k: "printFactory", label: "印花工厂", type: "factory-emb" }
    ],
    production: [
      { k: "follower", label: "下厂员", type: "user-follower", core: true },
      { k: "preSample", label: "产前样进度", type: "log" },
      { k: "cutting", label: "裁剪进度", type: "log" },
      { k: "ironing", label: "整烫进度", type: "log" },
      { k: "packing", label: "包装进度", type: "log" },
      { k: "shipDate", label: "发货日期", type: "date" }
    ]
  });

  const T = (d, h, m) => new Date(2026, 6, d, h, m).getTime();
  const L = (by, d, h, m, text) => ({ id: uid(), by, byName: nameOf[by], t: T(d, h, m), text });
  const emptyLogs = () => ({ fabricProg: [], embProg: [], preSample: [], cutting: [], ironing: [], packing: [] });
  // insp: 每次验货只由业务员创建"发现问题"，下厂员后续单独填"整改情况"
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
