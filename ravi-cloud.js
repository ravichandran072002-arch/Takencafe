/* Google Apps Script transport and owner controls. */
const RaviCloud = (() => {
  "use strict";
  const protocol = "ravi-cloud-v2";
  const byId = id => document.getElementById(id);
  const staffId = /^[a-z0-9][a-z0-9._-]{2,31}$/;
  const ownerKeyFormat = /^[a-f0-9]{64}$/;
  let ownerConnection;
  let staffExpiry;
  let staffConnection;
  let syncingStaff = false;
  let localMenu;

  const server = String.raw`
const RAVI_PROTOCOL = "ravi-cloud-v2";

function raviReply(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return raviReply({ protocol: RAVI_PROTOCOL, devicePin: true, ownerStaffPin: true });
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
      ...base, timestamp: date(row.timestamp), time: text(row.time, 24), billNo: text(row.billNo, 48), staff: id,
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
      if (req.action === "backup.read") return raviReply({ ok: true, data: readBackup() });
      if (req.action === "staff.list") {
        const ids = props.getKeys().filter(key => key.startsWith("staff:")).map(key => key.slice(6)).sort();
        const roles = Object.fromEntries(ids.map(id => [id, raviRole(props, id)]));
        const pendingPins = role === "primary" ? ids.filter(id => {
          const pin = JSON.parse(props.getProperty("staff-pin:" + id) || "null");
          return roles[id] === "staff" && pin && !pin.approved;
        }) : [];
        return raviReply({ ok: true, ids, roles, canManageOwners: role === "primary", pendingPins });
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
      if (req.action === "staff.pin.set") {
        if (role !== "primary" || targetRole !== "staff" || !/^\d{4}$/.test(req.assignedPin || "")) return raviReply(bad);
        const created = !props.getProperty(key);
        if (created) {
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
      if (req.action === "staff.revoke" && targetRole === "staff") {
        props.deleteProperty(key);
        props.deleteProperty("staff-pin:" + target);
        raviResetDevices(props, target);
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
`;

  const validEndpoint = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;

  function endpointUrl(raw) {
    if (!validEndpoint.test(raw)) {
      throw Error("Enter your shop’s Google Apps Script /exec link.");
    }
    return raw;
  }

  async function request(raw, action, fields) {
    const endpoint = endpointUrl(raw);
    const probe = await fetchWithTimeout(endpoint + "?raviProtocol=1", { cache: "no-store" }, 8000);
    const info = await probe.json().catch(() => null);
    if (!probe.ok || info?.protocol !== protocol) {
      throw Error("The owner must deploy the updated RAVI Apps Script for this link.");
    }
    if (action.startsWith("staff.pin.") && info.ownerStaffPin !== true) {
      throw Error("Deploy the Owner-managed Staff PIN update first.");
    }
    if ((action === "device.enroll" || fields.deviceToken) && info.devicePin !== true) {
      throw Error("The shop owner must deploy the PIN update before you can use a PIN.");
    }
    const response = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ protocol, action, ...fields })
    }, 15000);
    const result = await response.json();
    if (!response.ok || result?.ok !== true) {
      if (result?.reason === "exists") throw Error("That Staff ID already exists. Revoke it before replacing the password.");
      if (result?.reason === "revoked") {
        const error = Error("Online access changed. Sign in again.");
        error.revoked = true;
        throw error;
      }
      if (result?.reason === "pending-approval") throw Error("Ask the Owner to approve your staff PIN, then tap Login again.");
      if (result?.reason === "pin-locked") throw Error("Too many incorrect PINs. Try again later or ask the Owner to reset your PIN.");
      if (result?.reason === "owner-sets-pin") throw Error("Ask the primary Owner to set your Staff PIN.");
      if (result?.reason === "pin-invalid") throw Error("Incorrect 4-digit PIN.");
      if (result?.reason === "pin-reset") {
        const error = Error("PIN locked or expired. Check with the Owner or use your existing account password.");
        error.revoked = true;
        throw error;
      }
      if (result?.reason === "busy") throw Error("The shop server is busy. Please try again.");
      throw Error(action === "staff.login" ? "Invalid Staff ID or password." : "Owner access was rejected. Check your owner key.");
    }
    return result;
  }

  function isOwner() {
    return sessionStorage.getItem("tc_session_logged") === "1" && getLoggedAccount().role === "Owner";
  }

  async function owner(endpoint, action, fields = {}) {
    if (!isOwner() || !ownerConnection || ownerConnection.endpoint !== endpoint) {
      throw Error("Save the owner key for this shop link first.");
    }
    const connection = ownerConnection;
    const { id: target, password: newPassword, ...payload } = fields;
    try {
      return await request(endpoint, action, connection.id
        ? { ...payload, target, newPassword, id: connection.id, ...connection.credentials }
        : { ...fields, ownerKey: connection.key });
    } catch (error) {
      if (connection === ownerConnection && error.revoked) {
        ownerConnection = undefined;
        if (connection.id) logoutApp();
      }
      throw error;
    }
  }

  function pinDevices() {
    const devices = safeStorageGet("tc_pin_devices", []);
    return Array.isArray(devices) ? devices : [];
  }

  function deviceTokenFor(endpoint, id) {
    return pinDevices().find(device => device.endpoint === endpoint && device.id === id)?.token;
  }

  async function staff(endpoint, id, secret, method) {
    if (!staffId.test(id)) throw Error("Invalid online Login ID.");
    let credentials;
    if (method === "pin") {
      if (!/^\d{4}$/.test(secret)) throw Error("Enter your 4-digit PIN.");
      const deviceToken = deviceTokenFor(endpoint, id) || newPinToken(endpoint, id);
      credentials = { deviceToken, pin: secret };
    } else {
      if (!/^[A-Za-z0-9_-]{24}$/.test(secret)) throw Error("Invalid online password.");
      credentials = { password: secret };
    }
    const result = await request(endpoint, "staff.login", { id, ...credentials });
    if (result.staffId !== id) throw Error("The shop returned an invalid sign-in response.");
    return { ...result, credentials };
  }

  function newPinToken(endpoint, id) {
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
    const records = pinDevices().filter(record => record.endpoint !== endpoint || record.id !== id);
    if (!safeStorageSet("tc_pin_devices", [...records, { endpoint, id, token }])) {
      throw Error("Could not save this device's PIN registration.");
    }
    return token;
  }

  async function enrollPin(endpoint, id, password, pin) {
    const token = deviceTokenFor(endpoint, id) || newPinToken(endpoint, id);
    await request(endpoint, "device.enroll", { id, password, deviceToken: token, pin });
  }

  function ownerConnected() {
    return isOwner() && ownerConnection?.endpoint === settings.gdriveUrl;
  }

  function refreshOwnerPanel() {
    const allowed = isOwner();
    byId("cloudStaffPanel").hidden = !allowed;
    const setup = byId("cloudOwnerSetup");
    setup.hidden = !allowed || isOnlineOwner();
    if (allowed && !ownerConnected()) {
      setup.open = true;
      showOwnerSyncStatus("setup", "Enter the owner key once to connect this device.");
    } else if (!allowed) {
      setup.open = false;
      showOwnerSyncStatus("setup", "Sign in as Owner to sync.");
      byId("cloudSetupResult").textContent = "";
    }
    byId("onlineOwnerActivation").hidden = !allowed || !ownerConnection?.canBootstrap;
    if (!allowed || isOnlineOwner()) {
      byId("onlineOwnerId").value = "";
      byId("onlineOwnerPassword").value = "";
      byId("onlineOwnerPasswordRow").hidden = true;
    }
    byId("gdriveUrlInput").readOnly = isOnlineOwner();
    if (!allowed) {
      ownerConnection = undefined;
      byId("cloudOwnerKey").value = "";
      byId("generatedOwnerKey").value = "";
      byId("generatedStaffPepper").value = "";
      byId("cloudStaffPassword").value = "";
      byId("cloudStaffPassword").hidden = true;
      byId("cloudStaffList").replaceChildren();
      byId("staffPinSetup").hidden = true;
      byId("assignedStaffPin").value = "";
      byId("cloudStaffResult").textContent = "";
    }
  }

  function isOnlineOwner() {
    return Boolean(ownerConnection?.id);
  }

  function startOnlineOwner(endpoint, id, credentials) {
    ownerConnection = { endpoint, id, credentials };
    settings.gdriveUrl = endpoint;
    byId("gdriveUrlInput").value = endpoint;
    safeStorageSet("tc_staff_shop", endpoint);
    safeStorageSet("tc_login_mode", "staff");
    safeStorageSet("tc_settings", settings);
    staffConnection = { endpoint, id, credentials };
    clearTimeout(staffExpiry);
    staffExpiry = setTimeout(() => logoutApp(), 8 * 60 * 60 * 1000);
  }

  function startStaffSession(endpoint, id, credentials) {
    staffConnection = { endpoint, id, credentials };
    safeStorageSet("tc_login_mode", "staff");
    localMenu = menu;
    clearCart();
    clearTimeout(staffExpiry);
    staffExpiry = setTimeout(() => logoutApp(), 8 * 60 * 60 * 1000);
    syncStaff();
  }

  function staffActive() {
    return Boolean(staffConnection) && !isOnlineOwner();
  }

  function ownsRecord(record) {
    return !staffActive() || (record.cloud?.id === staffConnection.id && record.cloud.endpoint === staffConnection.endpoint);
  }

  function tagRecord(record) {
    if (staffActive()) {
      record.uid = "s:" + staffConnection.id + ":" + crypto.randomUUID();
      record.cloud = { endpoint: staffConnection.endpoint, id: staffConnection.id, uploadedAt: -1 };
    }
  }

  async function syncStaff() {
    const connection = staffConnection;
    if (!connection || syncingStaff || !navigator.onLine) return;
    syncingStaff = true;
    const badge = byId("syncStatusBadge");
    try {
      const batch = records => records.filter(record => record.cloud?.id === connection.id && record.cloud.endpoint === connection.endpoint
        && record.cloud.uploadedAt !== (record.updatedAt || 0)).slice(0, 25);
      const billBatch = batch(bills);
      const attendanceBatch = batch(attendance);
      if (isOnlineOwner() && !billBatch.length && !attendanceBatch.length) return;
      const snapshots = [...billBatch, ...attendanceBatch].map(row => [row, row.updatedAt || 0]);
      const outgoing = records => records.map(({ cloud, ...row }) => row);
      const remote = await request(connection.endpoint, "staff.sync", {
        id: connection.id, ...connection.credentials, bills: outgoing(billBatch), attendance: outgoing(attendanceBatch)
      });
      if (staffConnection !== connection) return;
      for (const [record, revision] of snapshots) record.cloud.uploadedAt = revision;
      safeStorageSet("tc_bills", bills);
      safeStorageSet("tc_attendance", attendance);
      if (!isOnlineOwner() && Array.isArray(remote.menu)) {
        const clean = value => String(value ?? "").replace(/[<>&"'`\\]/g, "");
        menu = remote.menu.filter(row => Number.isFinite(Number(row.id))).map(row => ({
          id: Number(row.id), name: clean(row.name), cat: clean(row.cat), price: Number(row.price) || 0
        }));
        renderCategories();
        renderMenu();
      }
      if (staffConnection !== connection) return;
      const pending = batch(bills).length || batch(attendance).length;
      badge.textContent = pending ? "☁️ Pending" : "☁️ Synced";
      if (pending) setTimeout(syncStaff, 300);
    } catch (error) {
      if (staffConnection !== connection) return;
      badge.textContent = "☁️ Pending";
      if (error.revoked) {
        logoutApp();
        showToast(error.message);
      }
    } finally {
      syncingStaff = false;
    }
  }

  function staffShopLink() {
    return [safeStorageGet("tc_staff_shop", ""), settings.gdriveUrl, DEFAULT_RAVI_ENDPOINT]
      .find(url => typeof url === "string" && url !== OLD_RAVI_ENDPOINT && validEndpoint.test(url)) || "";
  }

  function createPassword() {
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_");
  }

  function init(openSession) {
    const keyField = byId("cloudOwnerKey");
    const passwordField = byId("cloudStaffPassword");
    const result = byId("cloudStaffResult");
    const setupResult = byId("cloudSetupResult");
    const shopField = byId("gdriveUrlInput");
    let pendingStaff;
    const mode = byId("loginMode");
    mode.value = safeStorageGet("tc_login_mode", DEFAULT_RAVI_ENDPOINT ? "staff" : "local") === "staff" ? "staff" : "local";

    const method = byId("onlineLoginMethod");
    const setupPin = byId("setupPinOnLogin");
    const secret = byId("loginPassInput");
    method.value = pinDevices().some(device => device.endpoint === staffShopLink()) ? "pin" : "password";

    function updateLoginMode() {
      const online = mode.value === "staff";
      const pin = online && method.value === "pin";
      byId("localLoginStaffName").hidden = online;
      byId("onlineLoginMethodRow").hidden = !online;
      byId("pinEnrollment").hidden = !online || pin;
      byId("newPinFields").hidden = !online || pin || !setupPin.checked;
      byId("loginPassLabel").textContent = pin ? "4-digit PIN" : "Password";
      secret.inputMode = pin ? "numeric" : "text";
      secret.placeholder = pin ? "Enter PIN" : "Enter password";
      secret.autocomplete = pin ? "off" : "current-password";
      if (pin) secret.maxLength = 4;
      else secret.removeAttribute("maxlength");
    }

    function clearLoginSecret() {
      secret.value = "";
      byId("newLoginPin").value = "";
      byId("confirmLoginPin").value = "";
      secret.dispatchEvent(new Event("input"));
    }

    mode.addEventListener("change", () => {
      updateLoginMode();
      safeStorageSet("tc_login_mode", mode.value);
      clearLoginSecret();
    });
    method.addEventListener("change", () => {
      updateLoginMode();
      clearLoginSecret();
    });
    setupPin.addEventListener("change", updateLoginMode);
    updateLoginMode();

    const logout = window.logoutApp;
    window.logoutApp = function () {
      clearTimeout(staffExpiry);
      staffConnection = undefined;
      if (localMenu) {
        menu = localMenu;
        localMenu = undefined;
        clearCart();
        renderCategories();
        renderMenu();
      }
      pendingStaff = undefined;
      ownerConnection = undefined;
      setupPin.checked = false;
      clearLoginSecret();
      method.value = pinDevices().some(device => device.endpoint === staffShopLink()) ? "pin" : "password";
      updateLoginMode();
      logout();
      refreshOwnerPanel();
    };

    const run = (button, action, feedback = result) => {
      button.addEventListener("click", async () => {
        if (!isOwner()) return;
        button.disabled = true;
        feedback.textContent = "";
        try {
          await action();
        } catch (error) {
          if (isOwner()) feedback.textContent = error.message;
        } finally {
          button.disabled = false;
        }
      });
    };

    function shopLink() {
      return endpointUrl(shopField.value.trim() || DEFAULT_RAVI_ENDPOINT);
    }

    async function refreshList(endpoint) {
      const { ids, roles, canManageOwners, pendingPins } = await owner(endpoint, "staff.list");
      if (!isOwner() || endpoint !== shopLink()) return;
      const list = byId("cloudStaffList");
      list.replaceChildren();
      byId("staffPinSetup").hidden = !canManageOwners;
      byId("cloudOwnershipNote").hidden = !canManageOwners || !ids.length;
      for (const id of ids.filter(id => staffId.test(id))) {
        const role = roles?.[id] || "staff";
        const roleLabel = { primary: "Primary owner", "co-owner": "Co-owner", staff: "Staff" }[role];
        const row = document.createElement("li");
        row.append(id + " · " + roleLabel + " ");
        const addAction = (label, action, message) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "mini-btn";
          button.textContent = label;
          run(button, async () => {
            if (shopLink() !== endpoint) throw Error("Refresh the staff list for this shop first.");
            await owner(endpoint, action, { id });
            if (!isOwner()) return;
            passwordField.value = "";
            passwordField.hidden = true;
            if (pendingStaff?.id === id) pendingStaff = undefined;
            if (action === "owner.transfer") {
              logoutApp();
              showToast(message);
              return;
            }
            await refreshList(endpoint);
            result.textContent = message;
          });
          row.append(button, " ");
        };
        if (role === "staff") addAction("Revoke", "staff.revoke", id + " revoked. Their next sign-in will be denied.");
        if (canManageOwners && role !== "primary") {
          if (role === "staff") addAction("Make Co-owner", "owner.promote", id + " is now a co-owner. They can sign in with their existing credentials.");
          else addAction("Remove Co-owner access", "owner.demote", id + " is now Staff.");
          addAction("Transfer ownership to " + id, "owner.transfer", "Ownership transferred to " + id + ". Your online owner session has ended.");
        }
        if (pendingPins?.includes(id)) {
          const approve = document.createElement("button");
          approve.type = "button";
          approve.className = "mini-btn";
          approve.textContent = "Approve staff PIN";
          run(approve, async () => {
            await owner(endpoint, "staff.pin.approve", { id });
            await refreshList(endpoint);
            result.textContent = "PIN approved. " + id + " can now sign in on any device.";
          });
          row.append(approve, " ");
        }
        list.append(row);
      }
    }

    run(byId("generateCloudKeys"), () => {
      for (const id of ["generatedOwnerKey", "generatedStaffPepper"]) {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        byId(id).value = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
      }
      setupResult.textContent = "Copy these into Apps Script → Project Settings → Script properties.";
    }, setupResult);
    run(byId("saveCloudOwnerKey"), async () => {
      const key = keyField.value.trim();
      const endpoint = shopLink();
      if (!ownerKeyFormat.test(key)) throw Error("Enter the 64-character owner key from Script Properties.");
      const ownerAccess = await request(endpoint, "owner.check", { ownerKey: key });
      if (!isOwner() || endpoint !== shopLink() || keyField.value.trim() !== key) return;
      ownerConnection = { endpoint, key, canBootstrap: ownerAccess.canBootstrap === true };
      byId("onlineOwnerId").value = getLoggedAccount().username.trim().toLowerCase();
      keyField.value = "";
      shopField.value = endpoint;
      settings.gdriveUrl = endpoint;
      safeStorageSet("tc_staff_shop", endpoint);
      safeStorageSet("tc_settings", settings);
      refreshOwnerPanel();
      byId("staffPinSetup").hidden = ownerAccess.role !== "primary";
      setupResult.textContent = "Owner key saved for this session.";
      triggerBackgroundSync();
    }, setupResult);

    run(byId("generateOnlineOwnerPassword"), () => {
      if (!ownerConnection?.canBootstrap) return;
      const field = byId("onlineOwnerPassword");
      field.value ||= createPassword();
      byId("onlineOwnerPasswordRow").hidden = false;
    }, setupResult);

    run(byId("activateOnlineOwner"), async () => {
      const connection = ownerConnection;
      if (!connection?.canBootstrap || connection.endpoint !== shopLink()) throw Error("Save the owner key for this shop link first.");
      const idField = byId("onlineOwnerId");
      const id = idField.value.trim().toLowerCase();
      if (!staffId.test(id)) throw Error("Use 3–32 lowercase letters, numbers, dots, dashes or underscores.");
      const password = byId("onlineOwnerPassword").value;
      if (!password) throw Error("Generate and save your online Owner password first.");
      const previousUid = sessionStorage.getItem("tc_logged_uid");
      idField.readOnly = true;
      try {
        await request(connection.endpoint, "owner.bootstrap", { ownerKey: connection.key, id, password });
        if (!isOwner() || sessionStorage.getItem("tc_logged_uid") !== previousUid) return;
        startOnlineOwner(connection.endpoint, id, { password });
        openSession({ uid: "cloud-owner:" + id, username: id, role: "Owner" });
        setupResult.textContent = "Online Owner activated. Sync starts automatically.";
      } finally {
        idField.readOnly = false;
      }
    }, setupResult);

    run(byId("createCloudStaff"), async () => {
      const id = byId("cloudStaffId").value.trim().toLowerCase();
      const endpoint = shopLink();
      if (!staffId.test(id)) throw Error("Use 3–32 lowercase letters, numbers, dots, dashes or underscores.");
      if (pendingStaff?.id !== id || pendingStaff.endpoint !== endpoint) {
        pendingStaff = { id, endpoint, password: createPassword() };
      }
      const { password } = pendingStaff;
      passwordField.value = "";
      passwordField.hidden = true;
      await owner(endpoint, "staff.create", { id, password });
      if (!isOwner() || endpoint !== shopLink()) return;
      passwordField.value = password;
      passwordField.hidden = false;
      result.textContent = "Created " + id + ". Share this password with that staff member.";
      pendingStaff = undefined;
      await refreshList(endpoint);
    });

    run(byId("saveStaffPin"), async () => {
      const id = byId("cloudStaffId").value.trim().toLowerCase();
      const pinField = byId("assignedStaffPin");
      const assignedPin = pinField.value;
      const endpoint = shopLink();
      if (!staffId.test(id) || !/^\d{4}$/.test(assignedPin)) throw Error("Enter an Online Staff ID and a 4-digit PIN.");
      const recoveryPassword = createPassword();
      const { created, installed } = await owner(endpoint, "staff.pin.set", { id, assignedPin, recoveryPassword });
      pinField.value = "";
      if (!isOwner() || endpoint !== shopLink()) return;
      passwordField.value = created ? recoveryPassword : "";
      passwordField.hidden = !created;
      await refreshList(endpoint);
      result.textContent = installed
        ? "PIN saved for " + id + ". Tap Approve staff PIN once." + (created ? " Keep the generated account password privately for future owner access." : "")
        : "The PIN for " + id + " is already set.";
    });

    run(byId("listCloudStaff"), () => refreshList(shopLink()));
    const script = APPS_SCRIPT_TEMPLATE + "\n\n" + server;
    byId("appsScriptDisplay").textContent = script;
    window.copyAppsScript = async function () {
      try {
        await navigator.clipboard.writeText(script);
        showToast("RAVI Apps Script copied.");
      } catch (_) {
        showToast("Select the script in the panel and copy it.");
      }
    };
    window.addEventListener("online", triggerBackgroundSync);
    window.addEventListener("offline", () => {
      if (!staffConnection && !ownerConnection) return;
      byId("syncStatusBadge").textContent = "☁️ Offline";
    });
    refreshOwnerPanel();
  }

  return { init, owner, staff, staffShopLink, enrollPin, refreshOwnerPanel, startStaffSession, startOnlineOwner, isOnlineOwner, staffActive, ownsRecord, tagRecord, syncStaff, ownerConnected };
})();
