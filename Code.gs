const FOLDER_NAME = "TakenCafe_POS_Drive_Sync";
const LIVE_FILE = "TakenCafe_Live_Sync.json";
const SHEET_NAME = "RAVI_POS_Live_Sheet";

function getOrCreateFolder() {
  const folders = DriveApp.getFoldersByName(FOLDER_NAME);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(FOLDER_NAME);
}

function getOrCreateSpreadsheet(folder) {
  const files = folder.getFilesByName(SHEET_NAME);
  if (files.hasNext()) return SpreadsheetApp.openById(files.next().getId());
  const ss = SpreadsheetApp.create(SHEET_NAME);
  DriveApp.getFileById(ss.getId()).moveTo(folder);
  return ss;
}

function writeSheetTab(ss, title, rows) {
  let sh = ss.getSheetByName(title);
  if (!sh) sh = ss.insertSheet(title);
  sh.clearContents();
  if (!rows || !rows.length) return;
  const maxCols = Math.max(...rows.map(r => r.length));
  const cleanRows = rows.map(r => { const c = r.map(v => typeof v === "string" && /^[=+@-]/.test(v) ? "'" + v : v); while (c.length < maxCols) c.push(""); return c; });
  sh.getRange(1, 1, cleanRows.length, maxCols).setValues(cleanRows);
  sh.setFrozenRows(1);
}

function updateLiveSheetFromBody(folder, body) {
  const ss = getOrCreateSpreadsheet(folder);
  const bills = Array.isArray(body.bills) ? body.bills : [];
  const expenses = Array.isArray(body.expenses) ? body.expenses : [];
  const attendance = Array.isArray(body.attendance) ? body.attendance : [];
  const dayMap = {};
  bills.forEach(b => {
    const k = b.date || "Unknown";
    if (!dayMap[k]) dayMap[k] = { date: k, count: 0, cash: 0, digital: 0, sales: 0, exp: 0 };
    const amt = Number(b.total || 0);
    dayMap[k].count += 1; dayMap[k].sales += amt;
    if (b.mode === "Cash") dayMap[k].cash += amt; else dayMap[k].digital += amt;
  });
  expenses.forEach(e => {
    const k = e.date || "Unknown";
    if (!dayMap[k]) dayMap[k] = { date: k, count: 0, cash: 0, digital: 0, sales: 0, exp: 0 };
    dayMap[k].exp += Number(e.amount || 0);
  });
  const dayRows = [["Date", "Total Bills", "Cash Sales", "UPI/Card Sales", "Total Sales", "Expenses", "Cash in Drawer", "Net Profit"]];
  Object.values(dayMap).forEach(d => dayRows.push([d.date, d.count, d.cash, d.digital, d.sales, d.exp, d.cash - d.exp, d.sales - d.exp]));
  const billRows = [["Bill No", "Date", "Time", "Staff", "Type", "Customer", "Mode", "Items", "Subtotal", "Packing", "Discount", "GST", "Grand Total"]];
  bills.forEach(b => billRows.push([b.billNo, b.date, b.time, b.staff || "", b.type || "", b.customer || "", b.mode || "", (b.items || []).map(i => i.name + " x" + i.qty).join("; "), Number(b.sub || 0), Number(b.packing || 0), Number(b.discount || 0), Number(b.gst || 0), Number(b.total || 0)]));
  const expRows = [["Date", "Category", "Note", "Amount"]];
  expenses.forEach(e => expRows.push([e.date, e.cat, e.note, Number(e.amount || 0)]));
  const attRows = [["Employee", "Date", "In Time", "Out Time", "Duration", "Device"]];
  attendance.forEach(a => attRows.push([a.name, a.date, a.inTime, a.outTime || "Active", a.duration || "-", a.device || ""]));
  writeSheetTab(ss, "Day_Wise_Summary", dayRows);
  writeSheetTab(ss, "Bills_Register", billRows);
  writeSheetTab(ss, "Expenses", expRows);
  writeSheetTab(ss, "Staff_Attendance", attRows);
  const defSh = ss.getSheetByName("Sheet1");
  if (defSh && ss.getSheets().length > 1) ss.deleteSheet(defSh);
}

function readBackup() {
  const folder = getOrCreateFolder();
  const files = folder.getFilesByName(LIVE_FILE);
  let data = { empty: true };
  if (files.hasNext()) { const c = files.next().getBlob().getDataAsString(); if (c) data = JSON.parse(c); }
  delete data.authUsers;
  delete data.deletedUserIds;
  return data;
}

function writeBackup(body, archive) {
  const folder = getOrCreateFolder();
  const jsonStr = JSON.stringify(body, null, 2);
  const liveFiles = folder.getFilesByName(LIVE_FILE);
  if (liveFiles.hasNext()) liveFiles.next().setContent(jsonStr); else folder.createFile(LIVE_FILE, jsonStr, MimeType.PLAIN_TEXT);
  if (archive && body.backupFileName) {
    const bFiles = folder.getFilesByName(body.backupFileName);
    if (bFiles.hasNext()) bFiles.next().setContent(jsonStr); else folder.createFile(body.backupFileName, jsonStr, MimeType.PLAIN_TEXT);
  }
  updateLiveSheetFromBody(folder, body);
}


const RAVI_PROTOCOL = "ravi-cloud-v2";

function raviReply(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return raviReply({ protocol: RAVI_PROTOCOL, devicePin: true });
}

function raviEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < right.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

function raviStaffDigest(secret, id, password) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(id + ":" + password, secret));
}

function raviMergeBackup(saved, incoming) {
  const merged = { ...saved, ...incoming };
  delete merged.authUsers;
  delete merged.deletedUserIds;
  delete merged.empty;
  for (const [field, tombstones, identify] of [
    ["menu", "deletedMenuIds", row => row.id],
    ["bills", "deletedBillIds", row => row.uid || row.billNo],
    ["expenses", "deletedExpenseIds", row => row.uid || (row.date + row.note + row.amount)],
    ["attendance", null, row => row.uid]
  ]) {
    const deleted = new Set(tombstones ? [...(saved[tombstones] || []), ...(incoming[tombstones] || [])].map(String) : []);
    if (tombstones) merged[tombstones] = [...deleted].map(id => field === "menu" && /^\d+$/.test(id) ? Number(id) : id);
    if (!(field in saved) && !(field in incoming)) continue;
    const rows = new Map();
    for (const row of [...(saved[field] || []), ...(incoming[field] || [])]) {
      const id = String(identify(row));
      if (deleted.has(id)) continue;
      const existing = rows.get(id);
      if (!existing || (row.updatedAt || 0) > (existing.updatedAt || 0)) rows.set(id, row);
    }
    merged[field] = [...rows.values()];
  }
  if ((saved.settings?.updatedAt || 0) > (incoming.settings?.updatedAt || 0)) merged.settings = saved.settings;
  return merged;
}

function raviStaffRows(rows, id, kind) {
  if (!Array.isArray(rows) || rows.length > 25) throw Error("Invalid batch");
  const text = (value, max = 120) => String(value ?? "").slice(0, max);
  const number = (value, max = 100000000) => {
    if (!Number.isFinite(value) || value < 0 || value > max) throw Error("Invalid amount");
    return value;
  };
  const date = value => number(value, 9007199254740991);
  return rows.map(row => {
    if (typeof row.uid !== "string" || !/^s:[a-z0-9._-]+:[a-f0-9-]{36}$/.test(row.uid) || !row.uid.startsWith("s:" + id + ":")) throw Error("Invalid record ID");
    const base = { uid: row.uid, date: text(row.date, 16), device: text(row.device, 32), updatedAt: date(row.updatedAt || 0) };
    if (kind === "attendance") return {
      ...base, name: id, inTimestamp: date(row.inTimestamp), outTimestamp: date(row.outTimestamp),
      inTime: text(row.inTime, 20), outTime: text(row.outTime, 20), duration: text(row.duration, 32)
    };
    if (!Array.isArray(row.items) || !row.items.length || row.items.length > 200) throw Error("Invalid bill items");
    return {
      ...base, timestamp: date(row.timestamp), billNo: text(row.billNo, 48), staff: id,
      type: text(row.type, 32), mode: text(row.mode, 32), customer: text(row.customer),
      items: row.items.map(item => ({ id: text(item.id, 48), name: text(item.name), cat: text(item.cat), price: number(item.price), qty: number(item.qty, 100000) })),
      sub: number(row.sub), packing: number(row.packing), discount: number(row.discount), gst: number(row.gst), total: number(row.total)
    };
  });
}

function raviStaffSync(req) {
  const bills = raviStaffRows(req.bills, req.id, "bills");
  const attendance = raviStaffRows(req.attendance, req.id, "attendance");
  const current = readBackup();
  if (bills.length || attendance.length) writeBackup(raviMergeBackup(current, { bills, attendance }), false);
  return raviReply({ ok: true, menu: current.menu });
}

function raviRole(props, id) {
  if (props.getProperty("RAVI_PRIMARY_ID") === id) return "primary";
  return props.getProperty("co-owner:" + id) ? "co-owner" : "staff";
}

function raviVerifyAccount(props, pepper, req) {
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(req.id || "") || !/^[A-Za-z0-9_-]{24}$/.test(req.password || "")) return false;
  return raviEqual(raviStaffDigest(pepper, req.id, req.password), props.getProperty("staff:" + req.id));
}

function raviPinDeviceKey(pepper, id, token) {
  return "device:" + id + ":" + raviStaffDigest(pepper, "device", token);
}

function raviDeviceShape(req) {
  return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(req.id || "")
    && /^[a-f0-9]{64}$/.test(req.deviceToken || "") && /^\d{4}$/.test(req.pin || "");
}

function raviCheckPin(props, pepper, req) {
  if (!raviDeviceShape(req)) return "pin-invalid";
  const key = raviPinDeviceKey(pepper, req.id, req.deviceToken);
  const record = JSON.parse(props.getProperty(key) || "null");
  if (!record || record.expires <= Date.now() || !raviEqual(record.account, props.getProperty("staff:" + req.id))) {
    if (record) props.deleteProperty(key);
    return "pin-reset";
  }
  if (raviEqual(record.pinHash, raviStaffDigest(pepper, key, req.pin))) {
    if (record.failures) {
      record.failures = 0;
      props.setProperty(key, JSON.stringify(record));
    }
    return "";
  }
  record.failures++;
  if (record.failures >= 5) {
    props.deleteProperty(key);
    return "pin-reset";
  }
  props.setProperty(key, JSON.stringify(record));
  return "pin-invalid";
}

function doPost(e) {
  const bad = { ok: false };
  const props = PropertiesService.getScriptProperties();
  const ownerKey = props.getProperty("RAVI_OWNER_KEY");
  const staffPepper = props.getProperty("RAVI_STAFF_PEPPER");
  try {
    const req = JSON.parse(e.postData.contents);
    if (!req || req.protocol !== RAVI_PROTOCOL || !/^[a-f0-9]{64}$/.test(ownerKey || "")
        || !/^[a-f0-9]{64}$/.test(staffPepper || "") || ownerKey === staffPepper) return raviReply(bad);

    const lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) return raviReply({ ok: false, reason: "busy" });
    try {
      if (req.action === "device.enroll") {
        if (!raviDeviceShape(req) || !raviVerifyAccount(props, staffPepper, req)) return raviReply(bad);
        const key = raviPinDeviceKey(staffPepper, req.id, req.deviceToken);
        props.setProperty(key, JSON.stringify({
          account: props.getProperty("staff:" + req.id),
          pinHash: raviStaffDigest(staffPepper, key, req.pin),
          expires: Date.now() + 90 * 24 * 60 * 60 * 1000,
          failures: 0
        }));
        return raviReply({ ok: true });
      }
      const pinLogin = typeof req.deviceToken === "string";
      const accountLogin = typeof req.ownerKey !== "string" && (pinLogin || typeof req.password === "string");
      const pinError = pinLogin ? raviCheckPin(props, staffPepper, req) : "";
      if (pinError) return raviReply({ ok: false, reason: pinError });
      const verified = pinLogin || (accountLogin && raviVerifyAccount(props, staffPepper, req));
      if (req.action === "staff.login") return raviReply(verified
        ? { ok: true, staffId: req.id, role: raviRole(props, req.id) } : bad);
      if (req.action === "staff.sync") return verified ? raviStaffSync(req) : raviReply({ ok: false, reason: "revoked" });

      const primaryId = props.getProperty("RAVI_PRIMARY_ID");
      if (req.action === "owner.bootstrap" && raviEqual(req.ownerKey, ownerKey)) {
        if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(req.id || "") || !/^[A-Za-z0-9_-]{24}$/.test(req.password || "")) return raviReply(bad);
        const key = "staff:" + req.id;
        const digest = raviStaffDigest(staffPepper, req.id, req.password);
        if (primaryId) return raviReply(primaryId === req.id && raviEqual(digest, props.getProperty(key))
          ? { ok: true } : { ok: false, reason: "revoked" });
        if (props.getProperty(key)) return raviReply({ ok: false, reason: "exists" });
        props.setProperties({ [key]: digest, RAVI_PRIMARY_ID: req.id });
        return raviReply({ ok: true });
      }
      const role = accountLogin
        ? (verified ? raviRole(props, req.id) : "staff")
        : (!primaryId && raviEqual(req.ownerKey, ownerKey) ? "primary" : "staff");
      if (role === "staff") return raviReply(accountLogin || (primaryId && raviEqual(req.ownerKey, ownerKey))
        ? { ok: false, reason: "revoked" } : bad);
      if (req.action === "owner.check") return raviReply({ ok: true, role, canBootstrap: !accountLogin });
      if (req.action === "backup.read") return raviReply({ ok: true, data: readBackup() });
      if (req.action === "staff.list") {
        const ids = props.getKeys().filter(key => key.startsWith("staff:")).map(key => key.slice(6)).sort();
        const roles = Object.fromEntries(ids.map(id => [id, raviRole(props, id)]));
        return raviReply({ ok: true, ids, roles, canManageOwners: role === "primary" });
      }
      if (req.action === "backup.write" && req.data && typeof req.data === "object" && !Array.isArray(req.data)) {
        const data = req.data;
        delete data.authUsers;
        delete data.deletedUserIds;
        if (!/^TakenCafe_AutoBackup_\d{4}-\d{2}-\d{2}\.json$/.test(data.backupFileName || "")) delete data.backupFileName;
        const merged = raviMergeBackup(readBackup(), data);
        writeBackup(merged, true);
        return raviReply({ ok: true, data: merged });
      }

      const target = accountLogin ? req.target : req.id;
      if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(target || "")) return raviReply(bad);
      const key = "staff:" + target;
      const targetRole = raviRole(props, target);
      if (req.action === "staff.revoke" && targetRole === "staff") {
        props.deleteProperty(key);
        const prefix = "device:" + target + ":";
        for (const name of props.getKeys()) if (name.startsWith(prefix)) props.deleteProperty(name);
        return raviReply({ ok: true });
      }
      const password = accountLogin ? req.newPassword : req.password;
      if (req.action === "staff.create" && /^[A-Za-z0-9_-]{24}$/.test(password || "")) {
        const digest = raviStaffDigest(staffPepper, target, password);
        const existing = props.getProperty(key);
        if (existing && !raviEqual(existing, digest)) return raviReply({ ok: false, reason: "exists" });
        props.setProperty(key, digest);
        return raviReply({ ok: true });
      }
      if (role !== "primary" || !props.getProperty(key) || targetRole === "primary") return raviReply(bad);
      if (req.action === "owner.promote") {
        props.setProperty("co-owner:" + target, "1");
        return raviReply({ ok: true });
      }
      if (req.action === "owner.demote") {
        props.deleteProperty("co-owner:" + target);
        return raviReply({ ok: true });
      }
      if (req.action === "owner.transfer") {
        props.deleteProperty("co-owner:" + target);
        props.setProperty("RAVI_PRIMARY_ID", target);
        return raviReply({ ok: true });
      }
      return raviReply(bad);
    } finally {
      lock.releaseLock();
    }
  } catch (_) {
    return raviReply(bad);
  }
}
