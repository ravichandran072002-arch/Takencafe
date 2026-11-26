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
  return raviReply({ protocol: RAVI_PROTOCOL });
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

function raviStaffSync(req, props, pepper) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return raviReply({ ok: false, reason: "busy" });
  try {
    const stored = props.getProperty("staff:" + req.id);
    if (!stored || !raviEqual(raviStaffDigest(pepper, req.id, req.password), stored)) {
      return raviReply({ ok: false, reason: "revoked" });
    }
    const bills = raviStaffRows(req.bills, req.id, "bills");
    const attendance = raviStaffRows(req.attendance, req.id, "attendance");
    const current = readBackup();
    if (bills.length || attendance.length) {
      writeBackup(raviMergeBackup(current, { bills, attendance }), false);
    }
    return raviReply({ ok: true, menu: current.menu });
  } finally {
    lock.releaseLock();
  }
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

    if (req.action === "staff.login" || req.action === "staff.sync") {
      if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(req.id || "") || !/^[A-Za-z0-9_-]{24}$/.test(req.password || "")) return raviReply(bad);
      if (req.action === "staff.sync") return raviStaffSync(req, props, staffPepper);
      const stored = props.getProperty("staff:" + req.id);
      const digest = raviStaffDigest(staffPepper, req.id, req.password);
      if (!stored || !raviEqual(digest, stored)) return raviReply(bad);
      return raviReply({ ok: true, staffId: req.id });
    }

    if (!raviEqual(req.ownerKey, ownerKey)) return raviReply(bad);
    if (req.action === "owner.check") return raviReply({ ok: true });
    if (req.action === "backup.read") return raviReply({ ok: true, data: readBackup() });
    if (req.action === "staff.list") {
      const ids = props.getKeys().filter(key => key.startsWith("staff:")).map(key => key.slice(6)).sort();
      return raviReply({ ok: true, ids });
    }

    const lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) return raviReply({ ok: false, reason: "busy" });
    try {
      if (req.action === "backup.write" && req.data && typeof req.data === "object" && !Array.isArray(req.data)) {
        const data = req.data;
        delete data.authUsers;
        delete data.deletedUserIds;
        if (!/^TakenCafe_AutoBackup_\d{4}-\d{2}-\d{2}\.json$/.test(data.backupFileName || "")) delete data.backupFileName;
        const merged = raviMergeBackup(readBackup(), data);
        writeBackup(merged, true);
        return raviReply({ ok: true, data: merged });
      }

      if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(req.id || "")) return raviReply(bad);
      const key = "staff:" + req.id;
      if (req.action === "staff.revoke") {
        props.deleteProperty(key);
        return raviReply({ ok: true });
      }
      if (req.action === "staff.create" && /^[A-Za-z0-9_-]{24}$/.test(req.password || "")) {
        const digest = raviStaffDigest(staffPepper, req.id, req.password);
        const existing = props.getProperty(key);
        if (existing && !raviEqual(existing, digest)) return raviReply({ ok: false, reason: "exists" });
        props.setProperty(key, digest);
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
    const response = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ protocol, action, ...fields })
    }, 15000);
    const result = await response.json();
    if (!response.ok || result?.ok !== true) {
      if (result?.reason === "exists") throw Error("That Staff ID already exists. Revoke it before replacing the password.");
      if (result?.reason === "revoked") {
        const error = Error("Staff access ended. Sign in again.");
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
    return request(endpoint, action, { ...fields, ownerKey: ownerConnection.key });
  }

  async function staff(endpoint, id, password) {
    if (!staffId.test(id) || !/^[A-Za-z0-9_-]{24}$/.test(password)) throw Error("Invalid Staff ID or password.");
    const result = await request(endpoint, "staff.login", { id, password });
    if (result.staffId !== id) throw Error("The shop returned an invalid sign-in response.");
    return result;
  }

  function refreshOwnerPanel() {
    const allowed = isOwner();
    byId("cloudStaffPanel").hidden = !allowed;
    if (!allowed) {
      ownerConnection = undefined;
      byId("cloudOwnerKey").value = "";
      byId("generatedOwnerKey").value = "";
      byId("generatedStaffPepper").value = "";
      byId("cloudStaffPassword").value = "";
      byId("cloudStaffPassword").hidden = true;
      byId("cloudStaffList").replaceChildren();
      byId("cloudStaffResult").textContent = "";
    }
  }

  function startStaffSession(endpoint, id, password) {
    staffConnection = { endpoint, id, password };
    safeStorageSet("tc_login_mode", "staff");
    localMenu = menu;
    clearCart();
    clearTimeout(staffExpiry);
    staffExpiry = setTimeout(() => logoutApp(), 8 * 60 * 60 * 1000);
    syncStaff();
  }

  function staffActive() {
    return Boolean(staffConnection);
  }

  function ownsRecord(record) {
    return !staffConnection || (record.cloud?.id === staffConnection.id && record.cloud.endpoint === staffConnection.endpoint);
  }

  function tagRecord(record) {
    if (staffConnection) {
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
      const batch = records => records.filter(record => record.cloud && ownsRecord(record)
        && record.cloud.uploadedAt !== (record.updatedAt || 0)).slice(0, 25);
      const billBatch = batch(bills);
      const attendanceBatch = batch(attendance);
      const snapshots = [...billBatch, ...attendanceBatch].map(row => [row, row.updatedAt || 0]);
      const outgoing = records => records.map(({ cloud, ...row }) => row);
      const remote = await request(connection.endpoint, "staff.sync", {
        id: connection.id, password: connection.password, bills: outgoing(billBatch), attendance: outgoing(attendanceBatch)
      });
      if (staffConnection !== connection) return;
      for (const [record, revision] of snapshots) record.cloud.uploadedAt = revision;
      safeStorageSet("tc_bills", bills);
      safeStorageSet("tc_attendance", attendance);
      if (Array.isArray(remote.menu)) {
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

  function init() {
    const keyField = byId("cloudOwnerKey");
    const passwordField = byId("cloudStaffPassword");
    const result = byId("cloudStaffResult");
    const shopField = byId("gdriveUrlInput");
    let pendingStaff;
    const mode = byId("loginMode");
    mode.value = safeStorageGet("tc_login_mode", DEFAULT_RAVI_ENDPOINT ? "staff" : "local") === "staff" ? "staff" : "local";

    function updateLoginMode() {
      byId("localLoginStaffName").hidden = mode.value === "staff";
    }

    mode.addEventListener("change", () => {
      updateLoginMode();
      safeStorageSet("tc_login_mode", mode.value);
      byId("loginPassInput").value = "";
      byId("loginPassInput").dispatchEvent(new Event("input"));
    });
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
      logout();
      refreshOwnerPanel();
    };

    const run = (button, action) => {
      button.addEventListener("click", async () => {
        if (!isOwner()) return;
        button.disabled = true;
        result.textContent = "";
        try {
          await action();
        } catch (error) {
          if (isOwner()) result.textContent = error.message;
        } finally {
          button.disabled = false;
        }
      });
    };

    function shopLink() {
      return endpointUrl(shopField.value.trim() || DEFAULT_RAVI_ENDPOINT);
    }

    async function refreshList(endpoint) {
      const { ids } = await owner(endpoint, "staff.list");
      if (!isOwner() || endpoint !== shopLink()) return;
      const list = byId("cloudStaffList");
      list.replaceChildren();
      for (const id of ids.filter(id => staffId.test(id))) {
        const row = document.createElement("li");
        const revoke = document.createElement("button");
        revoke.type = "button";
        revoke.className = "mini-btn del";
        revoke.textContent = "Revoke";
        run(revoke, async () => {
          if (shopLink() !== endpoint) throw Error("Refresh the staff list for this shop first.");
          await owner(endpoint, "staff.revoke", { id });
          if (!isOwner()) return;
          passwordField.value = "";
          passwordField.hidden = true;
          if (pendingStaff?.id === id) pendingStaff = undefined;
          row.remove();
          result.textContent = id + " revoked. Their next sign-in will be denied.";
        });
        row.append(id + " ", revoke);
        list.append(row);
      }
    }

    run(byId("generateCloudKeys"), () => {
      for (const id of ["generatedOwnerKey", "generatedStaffPepper"]) {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        byId(id).value = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
      }
      result.textContent = "Copy these into Apps Script → Project Settings → Script properties.";
    });
    run(byId("saveCloudOwnerKey"), async () => {
      const key = keyField.value.trim();
      const endpoint = shopLink();
      if (!ownerKeyFormat.test(key)) throw Error("Enter the 64-character owner key from Script Properties.");
      await request(endpoint, "owner.check", { ownerKey: key });
      if (!isOwner() || endpoint !== shopLink() || keyField.value.trim() !== key) return;
      ownerConnection = { endpoint, key };
      keyField.value = "";
      shopField.value = endpoint;
      settings.gdriveUrl = endpoint;
      safeStorageSet("tc_staff_shop", endpoint);
      safeStorageSet("tc_settings", settings);
      result.textContent = "Owner key saved for this session.";
      triggerBackgroundSync();
    });

    run(byId("createCloudStaff"), async () => {
      const id = byId("cloudStaffId").value.trim().toLowerCase();
      const endpoint = shopLink();
      if (!staffId.test(id)) throw Error("Use 3–32 lowercase letters, numbers, dots, dashes or underscores.");
      if (pendingStaff?.id !== id || pendingStaff.endpoint !== endpoint) {
        const bytes = crypto.getRandomValues(new Uint8Array(18));
        const password = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_");
        pendingStaff = { id, endpoint, password };
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
    refreshOwnerPanel();
  }

  return { init, owner, staff, staffShopLink, refreshOwnerPanel, startStaffSession, staffActive, ownsRecord, tagRecord, syncStaff };
})();
