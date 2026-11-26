/* Google Apps Script transport and owner controls. */
const RaviCloud = (() => {
  "use strict";
  const protocol = "ravi-cloud-v1";
  const byId = id => document.getElementById(id);
  const staffId = /^[a-z0-9][a-z0-9._-]{2,31}$/;
  const ownerKeyFormat = /^[a-f0-9]{64}$/;
  let ownerConnection;
  let staffExpiry;

  const server = String.raw`
const RAVI_PROTOCOL = "ravi-cloud-v1";

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

function doPost(e) {
  const bad = { ok: false };
  const props = PropertiesService.getScriptProperties();
  const ownerKey = props.getProperty("RAVI_OWNER_KEY");
  const staffPepper = props.getProperty("RAVI_STAFF_PEPPER");
  try {
    const req = JSON.parse(e.postData.contents);
    if (!req || req.protocol !== RAVI_PROTOCOL || !/^[a-f0-9]{64}$/.test(ownerKey || "")
        || !/^[a-f0-9]{64}$/.test(staffPepper || "") || ownerKey === staffPepper) return raviReply(bad);

    if (req.action === "staff.login") {
      if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(req.id || "") || !/^[A-Za-z0-9_-]{24}$/.test(req.password || "")) return raviReply(bad);
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
        writeBackup(data);
        return raviReply({ ok: true });
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

  function endpointUrl(raw) {
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(raw)) {
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

  function startStaffSession() {
    clearTimeout(staffExpiry);
    staffExpiry = setTimeout(() => logoutApp(), 8 * 60 * 60 * 1000);
  }

  function init() {
    const keyField = byId("cloudOwnerKey");
    const passwordField = byId("cloudStaffPassword");
    const result = byId("cloudStaffResult");
    const shopField = byId("gdriveUrlInput");
    let pendingStaff;
    const mode = byId("loginMode");
    byId("staffEndpoint").value = DEFAULT_RAVI_ENDPOINT;
    mode.addEventListener("change", () => {
      byId("staffEndpointRow").hidden = mode.value !== "staff";
      byId("loginPassInput").value = "";
      byId("loginPassInput").dispatchEvent(new Event("input"));
    });

    const logout = window.logoutApp;
    window.logoutApp = function () {
      clearTimeout(staffExpiry);
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
    refreshOwnerPanel();
  }

  return { init, owner, staff, refreshOwnerPanel, startStaffSession };
})();
