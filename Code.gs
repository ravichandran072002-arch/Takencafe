const FOLDER_NAME = "TakenCafe_POS_Drive_Sync";
const LIVE_FILE = "TakenCafe_Live_Sync.json";
const SHEET_NAME = "RAVI_POS_Live_Sheet";
const RAVI_MEMBER_LIMIT = 5;

function getOrCreateFolder() {
  const id = PropertiesService.getScriptProperties().getProperty("RAVI_STORAGE_FOLDER_ID");
  if (id) return DriveApp.getFolderById(id);
  const folders = DriveApp.getFoldersByName(FOLDER_NAME);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(FOLDER_NAME);
}

function getOrCreateSpreadsheet(folder, name) {
  const files = folder.getFilesByName(name);
  if (files.hasNext()) return SpreadsheetApp.openById(files.next().getId());
  const ss = SpreadsheetApp.create(name);
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

function updateLiveSheetFromBody(folder, body, changes, targetSheet) {
  if (body.exportSettings) {
    folder = DriveApp.getFolderById(body.exportSettings.folderId);
  }
  const sheetName = body.exportSettings ? (String(body.settings?.name || "RAVI POS").slice(0, 60) + " · RAVI POS") : SHEET_NAME;
  const ss = targetSheet || getOrCreateSpreadsheet(folder, sheetName);
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
  const entries = Array.isArray(body.shopEntries) ? body.shopEntries : [];
  for (const entry of entries.filter(row => row.kind === "cash")) {
    const day = dayMap[entry.date] ||= { date: entry.date, count: 0, cash: 0, digital: 0, sales: 0, exp: 0 };
    day.drawerAdded = (day.drawerAdded || 0) + entry.amount;
  }
  const dayRows = [["Date", "Total Bills", "Cash Sales", "UPI/Card Sales", "Total Sales", "Expenses", "Cash in Drawer", "Net Profit"]];
  Object.values(dayMap).forEach(d => dayRows.push([d.date, d.count, d.cash, d.digital, d.sales, d.exp, d.cash + (d.drawerAdded || 0) - d.exp, d.sales - d.exp]));
  const billRows = [["Bill No", "Date", "Time", "Staff", "Type", "Customer", "Mode", "Items", "Subtotal", "Packing", "Discount", "GST", "Grand Total"]];
  bills.forEach(b => billRows.push([b.billNo, b.date, b.time || (b.timestamp > 0 ? Utilities.formatDate(new Date(b.timestamp), "Asia/Kolkata", "hh:mm a") : ""), b.staff || "", b.type || "", b.customer || "", b.mode || "", (b.items || []).map(i => i.name + " x" + i.qty).join("; "), Number(b.sub || 0), Number(b.packing || 0), Number(b.discount || 0), Number(b.gst || 0), Number(b.total || 0)]));
  const expRows = [["Date", "Category", "Note", "Amount"]];
  expenses.forEach(e => expRows.push([e.date, e.cat, e.note, Number(e.amount || 0)]));
  const attRows = [["Employee", "Date", "In Time", "Out Time", "Duration", "Device"]];
  attendance.forEach(a => attRows.push([a.name, a.date, a.inTime, a.outTime || "Active", a.duration || "-", a.device || ""]));
  const enabled = new Set(body.exportSettings?.tabs || ["bills", "expenses", "attendance", "stock", "advances"]);
  if (enabled.has("bills") && (!changes || changes.bills || changes.expenses)) writeSheetTab(ss, "Day_Wise_Summary", dayRows);
  if (enabled.has("bills") && (!changes || changes.bills)) writeSheetTab(ss, "Bills_Register", billRows);
  if (enabled.has("expenses") && (!changes || changes.expenses)) writeSheetTab(ss, "Expenses", expRows);
  if (enabled.has("attendance") && (!changes || changes.attendance)) writeSheetTab(ss, "Staff_Attendance", attRows);
  if (enabled.has("stock") && (!changes || changes.stock)) {
    const stock = entries.filter(row => row.kind === "stock").map(row => [row.note, row.amount, row.manufactured, row.expiry, row.by]);
    writeSheetTab(ss, "Stock", [["Item", "Quantity", "Manufactured", "Expiry", "Recorded by"], ...stock]);
  }
  if (enabled.has("advances") && !changes) {
    const advances = entries.filter(row => row.kind === "advance").map(row => [row.date, row.recipient, row.amount, row.by]);
    writeSheetTab(ss, "Staff_Advances", [["Date", "Staff", "Amount", "Recorded by"], ...advances]);
  }
  const defSh = !changes && ss.getSheetByName("Sheet1");
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

function writeBackup(body, archive, changes) {
  const folder = getOrCreateFolder();
  const properties = PropertiesService.getScriptProperties();
  if (!properties.getProperty("RAVI_STORAGE_FOLDER_ID")) {
    properties.setProperty("RAVI_STORAGE_FOLDER_ID", folder.getId());
  }
  const jsonStr = JSON.stringify(body);
  const liveFiles = folder.getFilesByName(LIVE_FILE);
  if (body.exportSettings?.backgroundReports) {
    const revision = Utilities.getUuid();
    properties.setProperty("RAVI_SHEET_DIRTY", "1");
    if (liveFiles.hasNext()) liveFiles.next().setContent(jsonStr); else folder.createFile(LIVE_FILE, jsonStr, MimeType.PLAIN_TEXT);
    properties.setProperty("RAVI_REPORT_REVISION", revision);
    properties.deleteProperty("RAVI_SHEET_DIRTY");
    return;
  }
  if (changes && properties.getProperty("RAVI_SHEET_DIRTY")) changes = undefined;
  properties.setProperty("RAVI_SHEET_DIRTY", "1");
  if (liveFiles.hasNext()) liveFiles.next().setContent(jsonStr); else folder.createFile(LIVE_FILE, jsonStr, MimeType.PLAIN_TEXT);
  if (archive && body.backupFileName) raviWriteArchive(folder, body.backupFileName, jsonStr);
  updateLiveSheetFromBody(folder, body, changes);
  properties.deleteProperty("RAVI_SHEET_DIRTY");
  if (body.exportSettings?.autoExcel) properties.setProperty("RAVI_XLSX_REVISION", Utilities.getUuid());
}

function raviWriteArchive(folder, name, contents) {
  const files = folder.getFilesByName(name);
  if (files.hasNext()) files.next().setContent(contents); else folder.createFile(name, contents, MimeType.PLAIN_TEXT);
}

function raviExportWorkbook(current, props) {
  const folder = current.exportSettings ? DriveApp.getFolderById(current.exportSettings.folderId) : getOrCreateFolder();
  const shopName = String(current.settings?.name || "RAVI POS").trim().slice(0, 60) || "RAVI POS";
  const filename = shopName + " · RAVI Reports.xlsx";
  const workbook = SpreadsheetApp.create(shopName + " · RAVI export");
  const temporaryFile = DriveApp.getFileById(workbook.getId());
  try {
    updateLiveSheetFromBody(folder, current, undefined, workbook);
    SpreadsheetApp.flush();
    const response = UrlFetchApp.fetch("https://docs.google.com/spreadsheets/d/" + workbook.getId() + "/export?format=xlsx", {
      headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() }
    });
    const blob = response.getBlob().setName(filename);
    if (blob.getBytes().slice(0, 2).join(",") !== "80,75") throw Error("Invalid workbook");
    const key = "RAVI_XLSX_" + folder.getId();
    const previousId = props.getProperty(key);
    const created = folder.createFile(blob);
    props.setProperty(key, created.getId());
    if (previousId) {
      try { DriveApp.getFileById(previousId).setTrashed(true); } catch (_) {}
    }
    return filename;
  } finally {
    temporaryFile.setTrashed(true);
  }
}

function raviRefreshExcel() {
  const lock = LockService.getUserLock();
  if (!lock.tryLock(1)) return;
  try {
    const props = PropertiesService.getScriptProperties();
    const revision = props.getProperty("RAVI_REPORT_REVISION");
    if (revision && revision !== props.getProperty("RAVI_REPORT_EXPORTED_REVISION")) {
      const current = readBackup();
      const folder = getOrCreateFolder();
      const archive = current.backupFileName;
      if (archive && /^TakenCafe_AutoBackup_\d{4}-\d{2}-\d{2}\.json$/.test(archive)) {
        raviWriteArchive(folder, archive, JSON.stringify(current));
      }
      updateLiveSheetFromBody(folder, current);
      if (current.exportSettings?.autoExcel) raviExportWorkbook(current, props);
      props.setProperty("RAVI_REPORT_EXPORTED_REVISION", revision);
      return;
    }
    const excelRevision = props.getProperty("RAVI_XLSX_REVISION");
    if (!excelRevision || excelRevision === props.getProperty("RAVI_XLSX_EXPORTED_REVISION")) return;
    const current = readBackup();
    if (!current.exportSettings?.autoExcel || current.exportSettings?.backgroundReports) return;
    raviExportWorkbook(current, props);
    props.setProperty("RAVI_XLSX_EXPORTED_REVISION", excelRevision);
  } finally {
    lock.releaseLock();
  }
}

const RAVI_PROTOCOL = "ravi-cloud-v2";

function raviReply(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return raviReply({ protocol: RAVI_PROTOCOL, devicePin: true, ownerStaffPin: true, accountPasswordReset: true, shopOperations: true, memberLimit: RAVI_MEMBER_LIMIT });
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
  for (const field of ["billingPreferences", "shopAppearance"]) {
    if (saved[field] && (saved[field].updatedAt || 0) >= (incoming[field]?.updatedAt || 0)) {
      merged[field] = saved[field];
    }
  }
  delete merged.authUsers;
  delete merged.deletedUserIds;
  delete merged.empty;
  for (const [field, tombstones, identify] of [
    ["menu", "deletedMenuIds", row => row.id],
    ["bills", "deletedBillIds", row => row.uid || row.billNo],
    ["expenses", "deletedExpenseIds", row => row.uid || (row.date + row.note + row.amount)],
    ["attendance", null, row => row.uid],
    ["shopEntries", null, row => row.uid]
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
    if (kind === "expenses") return {
      ...base, timestamp: date(row.timestamp), cat: text(row.cat), note: text(row.note), amount: number(row.amount), staff: id
    };
    if (kind === "stock") {
      if (row.kind !== "stock" || !raviValidStockDates(row) || !Number.isSafeInteger(row.amount) || row.amount < 1 || row.amount > 1000000 || !text(row.note).trim()) throw Error("Invalid stock batch");
      return { ...base, kind: "stock", by: id, note: text(row.note), amount: row.amount, manufactured: row.manufactured, expiry: row.expiry };
    }
    if (kind === "attendance") return {
      ...base, name: id, inTimestamp: date(row.inTimestamp), outTimestamp: date(row.outTimestamp),
      inTime: text(row.inTime, 20), outTime: text(row.outTime, 20), duration: text(row.duration, 32)
    };
    if (!Array.isArray(row.items) || !row.items.length || row.items.length > 200) throw Error("Invalid bill items");
    return {
      ...base, timestamp: date(row.timestamp), time: text(row.time, 24), billNo: text(row.billNo, 48), staff: id,
      type: text(row.type, 32), mode: text(row.mode, 32), customer: text(row.customer),
      ...(typeof row.customerPhone === "string" && /^\+[1-9]\d{7,14}$/.test(row.customerPhone) ? { customerPhone: row.customerPhone } : {}),
      items: row.items.map(item => ({ id: text(item.id, 48), name: text(item.name), cat: text(item.cat), price: number(item.price), qty: number(item.qty, 100000) })),
      sub: number(row.sub), packing: number(row.packing), discount: number(row.discount), gst: number(row.gst), total: number(row.total)
    };
  });
}

function raviValidStockDates(row) {
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  return datePattern.test(row.manufactured) && datePattern.test(row.expiry) && row.manufactured <= row.expiry;
}

function raviStaffSync(req) {
  const bills = raviStaffRows(req.bills, req.id, "bills");
  const attendance = raviStaffRows(req.attendance, req.id, "attendance");
  const expenses = raviStaffRows(req.expenses === undefined ? [] : req.expenses, req.id, "expenses");
  const stock = raviStaffRows(req.stock === undefined ? [] : req.stock, req.id, "stock");
  let current = readBackup();
  if (bills.length || attendance.length || expenses.length || stock.length) {
    const changes = { bills: bills.length > 0, attendance: attendance.length > 0, expenses: expenses.length > 0, stock: stock.length > 0 };
    const incoming = { bills, attendance, expenses, shopEntries: stock };
    const merged = raviMergeBackup(current, incoming);
    if (JSON.stringify(merged) !== JSON.stringify(current) || PropertiesService.getScriptProperties().getProperty("RAVI_SHEET_DIRTY")) {
      writeBackup(merged, false, current.empty ? undefined : changes);
    }
    current = merged;
  }
  const whatsAppPdf = current.billingPreferences?.whatsAppPdf === true;
  const shop = current.settings;
  const receiptShop = shop ? { name: shop.name, ...(whatsAppPdf ? { address: shop.address, phone: shop.phone, gstin: shop.gstin, upi: shop.upi } : {}) } : undefined;
  const shopEntries = (current.shopEntries || []).filter(row => row.kind === "stock"
    || (["advance", "message"].includes(row.kind) && row.recipient === req.id));
  return raviReply({ ok: true, menu: current.menu, whatsAppPdf, receiptShop, shopAppearance: current.shopAppearance, shopEntries, shopOperations: true });
}

function raviActiveMemberCount(props) {
  const values = props.getProperties();
  const primary = values.RAVI_PRIMARY_ID;
  let count = 1;
  for (const key of Object.keys(values)) {
    if (!key.startsWith("staff:")) continue;
    const id = key.slice(6);
    if (id !== primary && !values["revoked:" + id]) count++;
  }
  return count;
}

function raviRole(props, id) {
  if (props.getProperty("RAVI_PRIMARY_ID") === id) return "primary";
  return props.getProperty("co-owner:" + id) ? "co-owner" : "staff";
}

function raviVerifyAccount(props, pepper, req) {
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(req.id || "") || !/^[A-Za-z0-9_-]{24}$/.test(req.password || "")) return false;
  return !props.getProperty("revoked:" + req.id) && raviEqual(raviStaffDigest(pepper, req.id, req.password), props.getProperty("staff:" + req.id));
}

function raviPinDeviceKey(pepper, id, token) {
  return "device:" + id + ":" + raviStaffDigest(pepper, "device", token);
}

function raviDeviceShape(req) {
  return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(req.id || "")
    && /^[a-f0-9]{64}$/.test(req.deviceToken || "") && /^\d{4}$/.test(req.pin || "");
}

function raviDeviceKeys(props, id) {
  return props.getKeys().filter(key => key.startsWith("device:" + id + ":"));
}

function raviResetDevices(props, id) {
  for (const key of raviDeviceKeys(props, id)) props.deleteProperty(key);
}

function raviCheckPin(props, pepper, req) {
  if (!raviDeviceShape(req)) return { reason: "pin-invalid" };
  const key = raviPinDeviceKey(pepper, req.id, req.deviceToken);
  const now = Date.now();
  const account = props.getProperty("staff:" + req.id);
  if (props.getProperty("revoked:" + req.id)) return { reason: "revoked" };
  if (!account) return { reason: req.action === "staff.login" ? "pin-invalid" : "revoked" };
  const managedKey = "staff-pin:" + req.id;
  const managed = JSON.parse(props.getProperty(managedKey) || "null");
  if (managed && raviRole(props, req.id) === "staff") {
    if (!managed.approved) return { reason: "pending-approval" };
    if (managed.retryAfter > now) return { reason: "pin-locked" };
    if (raviEqual(managed.digest, raviStaffDigest(pepper, managedKey, req.pin))) return null;
    const windowEnd = managed.windowEnd > now ? managed.windowEnd : now + 60 * 60 * 1000;
    const failures = managed.windowEnd === windowEnd ? managed.failures + 1 : 1;
    const retryAfter = failures >= 5 ? windowEnd : 0;
    props.setProperty(managedKey, JSON.stringify({ ...managed, failures, retryAfter, windowEnd }));
    return { reason: retryAfter ? "pin-locked" : "pin-invalid" };
  }
  const record = JSON.parse(props.getProperty(key) || "null");
  if (!record) return { reason: "pin-reset" };
  if (record.expires <= now || !raviEqual(record.account, account)) {
    props.deleteProperty(key);
    return { reason: "pin-reset" };
  }
  if (raviEqual(record.pinHash, raviStaffDigest(pepper, key, req.pin))) {
    if (record.failures) {
      record.failures = 0;
      props.setProperty(key, JSON.stringify(record));
    }
    return null;
  }
  record.failures++;
  if (record.failures >= 5) {
    props.deleteProperty(key);
    return { reason: "pin-reset" };
  }
  props.setProperty(key, JSON.stringify(record));
  return { reason: "pin-invalid" };
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

    if (req.action === "staff.login" && typeof req.password === "string"
        && typeof req.ownerKey === "undefined" && typeof req.deviceToken === "undefined") {
      // Read the password and role from the same snapshot without waiting for a data write.
      const values = props.getProperties();
      const snapshot = { getProperty: key => values[key] };
      return raviReply(raviVerifyAccount(snapshot, staffPepper, req)
        ? { ok: true, staffId: req.id, role: raviRole(snapshot, req.id) } : bad);
    }

    const lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) return raviReply({ ok: false, reason: "busy" });
    try {
      if (req.action === "device.enroll") {
        if (!raviDeviceShape(req) || !raviVerifyAccount(props, staffPepper, req)) return raviReply(bad);
        if (raviRole(props, req.id) === "staff") return raviReply({ ok: false, reason: "owner-sets-pin" });
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
      if (pinError) return raviReply({ ok: false, ...pinError });
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
      if (req.action === "exports.xlsx") {
        if (role !== "primary") return raviReply(bad);
        const exportLock = LockService.getUserLock();
        if (!exportLock.tryLock(1)) return raviReply({ ok: false, reason: "busy" });
        try {
          const filename = raviExportWorkbook(readBackup(), props);
          return raviReply({ ok: true, filename });
        } finally { exportLock.releaseLock(); }
      }
      if (req.action === "exports.configure") {
        if (role !== "primary") return raviReply(bad);
        const tabs = Array.isArray(req.tabs) ? [...new Set(req.tabs)] : [];
        if (!tabs.length || tabs.some(tab => !["bills", "expenses", "attendance", "stock", "advances"].includes(tab))) return raviReply(bad);
        const current = readBackup();
        const shopName = String(current.settings?.name || req.shopName || "RAVI POS").trim().slice(0,60) || "RAVI POS";
        let folder;
        if (req.folderId) {
          if (!/^[A-Za-z0-9_-]{10,120}$/.test(req.folderId)) return raviReply(bad);
          folder = DriveApp.getFolderById(req.folderId);
        } else {
          const savedId = current.exportSettings?.folderId || props.getProperty("RAVI_CREATED_EXPORT_FOLDER");
          folder = savedId ? DriveApp.getFolderById(savedId) : DriveApp.createFolder(shopName + " · RAVI POS");
          props.setProperty("RAVI_CREATED_EXPORT_FOLDER", folder.getId());
        }
        const autoExcel = req.autoExcel === true;
        if (!ScriptApp.getProjectTriggers().some(trigger => trigger.getHandlerFunction() === "raviRefreshExcel")) {
          ScriptApp.newTrigger("raviRefreshExcel").timeBased().everyMinutes(5).create();
        }
        current.exportSettings = { folderId: folder.getId(), tabs, autoExcel, backgroundReports: true };
        delete current.empty;
        writeBackup(current, false);
        return raviReply({ ok: true, folderName: folder.getName(), folderId: folder.getId() });
      }
      if (req.action === "backup.read") return raviReply({ ok: true, data: readBackup() });
      if (req.action === "staff.list") {
        const ids = props.getKeys().filter(key => key.startsWith("staff:")).map(key => key.slice(6)).sort();
        const roles = Object.fromEntries(ids.map(id => [id, raviRole(props, id)]));
        const revokedIds = ids.filter(id => props.getProperty("revoked:" + id));
        const pendingPins = role === "primary" ? ids.filter(id => {
          const pin = JSON.parse(props.getProperty("staff-pin:" + id) || "null");
          return roles[id] === "staff" && pin && !pin.approved;
        }) : [];
        return raviReply({ ok: true, ids, roles, canManageOwners: role === "primary", pendingPins, revokedIds, activeCount: raviActiveMemberCount(props), memberLimit: RAVI_MEMBER_LIMIT });
      }
      if (req.action === "backup.write" && req.data && typeof req.data === "object" && !Array.isArray(req.data)) {
        const data = req.data;
        delete data.authUsers;
        delete data.deletedUserIds;
        delete data.exportSettings;
        const preferences = data.billingPreferences;
        if (typeof preferences?.whatsAppPdf !== "boolean" || !Number.isSafeInteger(preferences.updatedAt) || preferences.updatedAt <= 0) {
          delete data.billingPreferences;
        } else {
          data.billingPreferences = { whatsAppPdf: preferences.whatsAppPdf, updatedAt: preferences.updatedAt };
        }
        const preset = data.shopAppearance;
        if (!["day", "dark", "auto"].includes(preset?.mode)
          || typeof preset.palette !== "string" || !/^[a-z-]{1,32}$/.test(preset.palette)
          || !Number.isSafeInteger(preset.updatedAt) || preset.updatedAt <= 0) {
          delete data.shopAppearance;
        } else {
          data.shopAppearance = { mode: preset.mode, palette: preset.palette, updatedAt: preset.updatedAt };
        }
        if (!/^TakenCafe_AutoBackup_\d{4}-\d{2}-\d{2}\.json$/.test(data.backupFileName || "")) delete data.backupFileName;
        const current = readBackup();
        if (Array.isArray(data.shopEntries)) {
          const known = new Set((current.shopEntries || []).map(row => row.uid));
          data.shopEntries = data.shopEntries.filter(row => row && typeof row.uid === "string" && !known.has(row.uid)
            && /^[a-f0-9-]{36}$/.test(row.uid) && typeof row.date === "string" && row.date.length <= 16
            && Number.isSafeInteger(row.updatedAt) && row.updatedAt > 0 && typeof row.by === "string" && row.by.length <= 120
            && typeof row.note === "string" && row.note.length <= 300
            && (row.kind === "message" ? Boolean(row.note.trim()) : Number.isFinite(row.amount) && row.amount > 0 && row.amount <= 100000000)
            && (row.kind === "stock" ? raviValidStockDates(row) && Number.isSafeInteger(row.amount) && row.amount <= 1000000 && Boolean(row.note.trim())
              : row.kind === "cash" ? Boolean(row.note.trim())
              : ["message", "advance"].includes(row.kind) && /^[a-z0-9][a-z0-9._-]{2,31}$/.test(row.recipient || "")
                && props.getProperty("staff:" + row.recipient) && raviRole(props, row.recipient) === "staff" && !props.getProperty("revoked:" + row.recipient)));
        } else delete data.shopEntries;
        const merged = raviMergeBackup(current, data);
        const fields = new Set([...Object.keys(current), ...Object.keys(merged)]);
        fields.delete("syncedAt");
        const changed = [...fields].some(field => JSON.stringify(current[field]) !== JSON.stringify(merged[field]));
        if (changed || props.getProperty("RAVI_SHEET_DIRTY")) writeBackup(merged, true);
        return raviReply({ ok: true, data: merged });
      }

      const target = accountLogin ? req.target : req.id;
      if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(target || "")) return raviReply(bad);
      const key = "staff:" + target;
      const targetRole = raviRole(props, target);
      const revokedKey = "revoked:" + target;
      if (req.action === "staff.restore" && targetRole === "staff" && props.getProperty(key)) {
        if (props.getProperty(revokedKey) && raviActiveMemberCount(props) >= RAVI_MEMBER_LIMIT) {
          return raviReply({ ok: false, reason: "member-limit" });
        }
        props.deleteProperty(revokedKey);
        return raviReply({ ok: true });
      }
      if (props.getProperty(revokedKey)) return raviReply(bad);
      if (req.action === "staff.pin.set") {
        if (role !== "primary" || targetRole !== "staff" || !/^\d{4}$/.test(req.assignedPin || "")) return raviReply(bad);
        const created = !props.getProperty(key);
        if (created) {
          if (raviActiveMemberCount(props) >= RAVI_MEMBER_LIMIT) return raviReply({ ok: false, reason: "member-limit" });
          if (!/^[A-Za-z0-9_-]{24}$/.test(req.recoveryPassword || "")) return raviReply(bad);
          props.setProperty(key, raviStaffDigest(staffPepper, target, req.recoveryPassword));
        }
        const pinKey = "staff-pin:" + target;
        const digest = raviStaffDigest(staffPepper, pinKey, req.assignedPin);
        const changed = !raviEqual(JSON.parse(props.getProperty(pinKey) || "null")?.digest, digest);
        if (changed) {
          raviResetDevices(props, target);
          props.setProperty(pinKey, JSON.stringify({ digest, approved: false, failures: 0, retryAfter: 0 }));
        }
        return raviReply({ ok: true, installed: changed, created });
      }
      if (req.action === "staff.pin.approve") {
        if (role !== "primary" || targetRole !== "staff" || !props.getProperty(key)) return raviReply(bad);
        const pinKey = "staff-pin:" + target;
        const pin = JSON.parse(props.getProperty(pinKey) || "null");
        if (!pin) return raviReply(bad);
        props.setProperty(pinKey, JSON.stringify({ ...pin, approved: true }));
        return raviReply({ ok: true });
      }
      if (req.action === "staff.revoke" && targetRole === "staff" && props.getProperty(key)) {
        props.setProperty(revokedKey, "1");
        raviResetDevices(props, target);
        return raviReply({ ok: true });
      }
      const password = accountLogin ? req.newPassword : req.password;
      if (req.action === "staff.create" && /^[A-Za-z0-9_-]{24}$/.test(password || "")) {
        const digest = raviStaffDigest(staffPepper, target, password);
        const existing = props.getProperty(key);
        if (existing && !raviEqual(existing, digest)) return raviReply({ ok: false, reason: "exists" });
        if (!existing && raviActiveMemberCount(props) >= RAVI_MEMBER_LIMIT) return raviReply({ ok: false, reason: "member-limit" });
        props.setProperty(key, digest);
        return raviReply({ ok: true });
      }
      if (role !== "primary" || !props.getProperty(key) || targetRole === "primary") return raviReply(bad);
      if (req.action === "staff.password.reset") {
        if (!/^[A-Za-z0-9_-]{24}$/.test(password || "")) return raviReply(bad);
        props.setProperty(key, raviStaffDigest(staffPepper, target, password));
        raviResetDevices(props, target);
        return raviReply({ ok: true });
      }
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
