/* RAVI POS fixes — load AFTER the main <script>:  <script src="ravi-fixes.js"></script> */
(function () {
  "use strict";
  const $r = id => document.getElementById(id);

  /* ---------- 4. HTML-injection protection ---------- */
  const MAP = { "<": "‹", ">": "›", "&": "＆", '"': "”", "'": "’", "`": "’", "\\": "/" };
  const cl = s => (typeof s === "string" ? s.replace(/[<>&"'`\\]/g, c => MAP[c]) : s);
  function sanitizeAll() {
    menu.forEach(m => { m.name = cl(m.name); m.cat = cl(m.cat); });
    bills.forEach(b => {
      b.uid = cl(b.uid); b.billNo = cl(b.billNo); b.customer = cl(b.customer); b.staff = cl(b.staff);
      b.type = cl(b.type); b.mode = cl(b.mode); b.device = cl(b.device);
      (b.items || []).forEach(i => { i.name = cl(i.name); i.cat = cl(i.cat); });
    });
    expenses.forEach(e => { e.uid = cl(e.uid); e.cat = cl(e.cat); e.note = cl(e.note); });
    attendance.forEach(a => { a.uid = cl(a.uid); a.name = cl(a.name); a.device = cl(a.device); });
    authUsers.forEach(u => { u.uid = cl(u.uid); u.username = cl(u.username); });
  }
  function saveAll() {
    safeStorageSet("tc_menu", menu); safeStorageSet("tc_bills", bills); safeStorageSet("tc_expenses", expenses);
    safeStorageSet("tc_attendance", attendance); safeStorageSet("tc_auth_users", authUsers);
  }
  function cleanInputs() {
    document.querySelectorAll("input[type=text],input[type=tel],textarea").forEach(el => {
      if (["gdriveUrlInput", "loginPassInput", "newLoginPass"].includes(el.id)) return;
      const v = cl(el.value); if (v !== el.value) el.value = v;
    });
  }
  ["checkoutBill", "addExpense", "addMenuItem", "saveEditedItem", "punchInStaff", "saveSettings"].forEach(n => {
    const o = window[n];
    window[n] = function () { cleanInputs(); return o.apply(this, arguments); };
  });

  /* ---------- 3. Password hashing ---------- */
  /* Salted PBKDF2, fail closed if WebCrypto is unavailable. */
  const enc = new TextEncoder();
  const b64 = input => btoa(String.fromCharCode(...new Uint8Array(input)));
  const unb64 = input => Uint8Array.from(atob(input), c => c.charCodeAt(0));
  async function hashPw(password) {
    if (!crypto || !crypto.subtle || !crypto.getRandomValues) throw Error("Secure hashing unavailable");
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
    const hash = await crypto.subtle.deriveBits({name:"PBKDF2",salt,hash:"SHA-256",iterations:160000},key,256);
    return "pbkdf2$160000$"+b64(salt)+"$"+b64(hash);
  }
  async function verifyPw(password, stored, uid) {
    if (typeof stored !== "string") return false;
    if (stored.startsWith("pbkdf2$")) {
      const pieces = stored.split("$"); if (pieces.length !== 4) return false;
      const iterations=Number(pieces[1]); if (!Number.isInteger(iterations)||iterations<100000||iterations>1000000) return false;
      if (!/^[A-Za-z0-9+/]{22}==$/.test(pieces[2]) || !/^[A-Za-z0-9+/]{43}=$/.test(pieces[3])) return false;
      const salt=unb64(pieces[2]), expected=unb64(pieces[3]);
      const key=await crypto.subtle.importKey("raw",enc.encode(password),"PBKDF2",false,["deriveBits"]);
      const real=new Uint8Array(await crypto.subtle.deriveBits({name:"PBKDF2",salt,hash:"SHA-256",iterations},key,256));
      if(real.length!==expected.length)return false;
      let difference=0; for(let i=0;i<real.length;i++)difference|=real[i]^expected[i]; return difference===0;
    }
    if (/^[a-f0-9]{64}$/.test(stored)) {
      const bytes=await crypto.subtle.digest("SHA-256",enc.encode("ravi|"+uid+"|"+password));
      return Array.from(new Uint8Array(bytes)).map(x=>x.toString(16).padStart(2,"0")).join("")===stored;
    }
    if (/^f[a-f0-9]{1,14}$/.test(stored)) {
      // Read the fallback format from older RAVI builds. Successful login upgrades it.
      const input = "ravi|" + uid + "|" + password;
      let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
      for (let i = 0; i < input.length; i++) {
        const code = input.charCodeAt(i);
        h1 = Math.imul(h1 ^ code, 2654435761);
        h2 = Math.imul(h2 ^ code, 1597334677);
      }
      h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
      h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
      return stored === "f" + (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
    }
    return false;
  }

  let migrationQueue = Promise.resolve();
  function migrateUsers() {
    const task = migrationQueue.then(migrateUsersImpl);
    migrationQueue = task.catch(() => {});
    return task;
  }
  async function migrateUsersImpl() {
    while (authUsers.some(user => user.password !== undefined)) {
      const accounts = authUsers;
      const upgraded = [];
      for (const user of accounts) {
        if (user.password === undefined) {
          upgraded.push(user);
          continue;
        }
        const { password, ...account } = user;
        account.passHash = await hashPw(String(password));
        if (String(password) === "2002") account.mustChange = true;
        upgraded.push(account);
      }
      if (accounts !== authUsers) continue;
      if (!safeStorageSet("tc_auth_users", upgraded)) throw Error("Account storage unavailable");
      authUsers = upgraded;
    }
  }

  const loginForm = $r("appLoginForm");
  const loginButton = $r("appLoginButton");
  const passwordChange = $r("ownerPasswordChange");
  const loginHint = $r("loginSyncHint");
  const loginMessage = loginHint.textContent.trim();

  function clearPasswordChange() {
    passwordChange.hidden = true;
    $r("ownerNewPassword").value = "";
    $r("ownerConfirmPassword").value = "";
    loginButton.textContent = "Login to RAVI";
  }
  ["loginUserIdInput", "loginPassInput"].forEach(id => {
    $r(id).addEventListener("input", clearPasswordChange);
  });

  async function handleAppLogin() {
    const id = $r("loginUserIdInput").value.trim().toLowerCase();
    const pw = $r("loginPassInput").value.trim();
    const staff = cl($r("loginStaffNameInput").value.trim());
    if (!id || !pw) return showToast("Enter your login ID and password.");
    if (passwordChange.hidden && settings.gdriveUrl && navigator.onLine) {
      loginHint.textContent = "Checking cloud accounts…";
      try {
        const sep = settings.gdriveUrl.includes("?") ? "&" : "?";
        const res = await fetchWithTimeout(`${settings.gdriveUrl}${sep}t=${Date.now()}`, { cache: "no-store" }, 7000);
        if (res.ok) { const remote = await res.json(); if (remote && !remote.empty) await mergeTwoWayData(remote); }
      } catch (error) {
        console.warn("Cloud accounts unavailable", error);
      }
    }
    loginHint.textContent = loginMessage;
    await migrateUsers();
    let u;
    let verifiedHash;
    for (const account of authUsers) {
      if (String(account.username).trim().toLowerCase() !== id) continue;
      const hash = account.passHash;
      if (await verifyPw(pw, hash, account.uid)) {
        u = account;
        verifiedHash = hash;
        break;
      }
    }
    if (!u) {
      clearPasswordChange();
      loginHint.textContent = "Invalid login ID or password.";
      return;
    }
    const mustChange = u.mustChange || (u.role === "Owner" && pw === "2002");
    let nextHash;
    if (mustChange) {
      if (passwordChange.hidden) {
        passwordChange.hidden = false;
        loginButton.textContent = "Save password and sign in";
        loginHint.textContent = "Change the default password before signing in.";
        $r("ownerNewPassword").focus();
        return;
      }
      const nextPassword = $r("ownerNewPassword").value.trim();
      if (nextPassword.length < 8 || nextPassword !== $r("ownerConfirmPassword").value.trim()) {
        loginHint.textContent = "Use at least 8 characters and enter the same password twice.";
        return;
      }
      nextHash = await hashPw(nextPassword);
    } else if (!verifiedHash.startsWith("pbkdf2$")) {
      nextHash = await hashPw(pw);
    }
    if (!authUsers.includes(u) || u.passHash !== verifiedHash
        || $r("loginUserIdInput").value.trim().toLowerCase() !== id || $r("loginPassInput").value.trim() !== pw) {
      clearPasswordChange();
      loginHint.textContent = "The account changed. Please sign in again.";
      return;
    }
    if (nextHash) {
      const updated = { ...u, passHash: nextHash, mustChange: false };
      if (mustChange) updated.updatedAt = Math.max(Date.now(), (u.updatedAt || 0) + 1);
      const accounts = authUsers.map(account => account === u ? updated : account);
      if (!safeStorageSet("tc_auth_users", accounts)) {
        loginHint.textContent = "Could not save the password. Free device storage and try again.";
        return;
      }
      authUsers = accounts;
      u = updated;
    }
    clearPasswordChange();
    const priv = u.role === "Owner" || u.role === "Admin" || u.role === "Manager";
    sessionStorage.setItem("tc_session_logged", "1");
    sessionStorage.setItem("tc_logged_uid", u.uid);
    sessionStorage.setItem("tc_logged_username", u.username);
    sessionStorage.setItem("tc_logged_role", u.role);
    sessionStorage.setItem("tc_logged_att_access", (priv || u.canViewAttendance) ? "1" : "0");
    $r("appLoginScreen").classList.add("hidden");
    $r("loginPassInput").value = "";
    applyRolePermissionsUI();
    if (staff) { $r("staffNameInput").value = staff; punchInStaff(); }
    else showToast(`✅ Welcome ${u.username} (${u.role})`);
    if (settings.gdriveUrl) triggerBackgroundSync();
  }
  loginForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (loginButton.disabled) return;
    loginButton.disabled = true;
    try {
      await handleAppLogin();
    } catch (error) {
      console.error("Login failed", error);
      loginHint.textContent = "Sign-in is unavailable. Check device storage and update Android System WebView.";
    } finally {
      loginButton.disabled = false;
    }
  });
  loginButton.disabled = false;

  window.addNewLoginUser = async function () {
    if (sessionStorage.getItem("tc_session_logged") !== "1" || !getLoggedAccount().isOwnerOrMgr) return showToast("Owner / Manager mattum dhaan Login ID create panna mudiyum!");
    cleanInputs();
    const username = $r("newLoginId").value.trim(), password = $r("newLoginPass").value.trim();
    const role = $r("newLoginRole").value, priv = role === "Owner" || role === "Manager";
    if (sessionStorage.getItem("tc_session_logged") !== "1") return showToast("Login required");
    if (role === "Owner" && getLoggedAccount().role !== "Owner") return showToast("Owner ID create panna Owner-ku mattum dhaan permission!");
    if (!username || password.length < 8) return showToast("Enter Login ID & minimum 8-char Password!");
    if (authUsers.some(u => u.username.toLowerCase() === username.toLowerCase())) return showToast("Indha Login ID already irukku!");
    const now = Date.now(), uid = "usr-" + now + "-" + Math.floor(Math.random() * 1000);
    authUsers.push({ uid, username, passHash: await hashPw(password), role, canViewAttendance: priv ? true : $r("newLoginAttAccess").value === "1", updatedAt: now });
    safeStorageSet("tc_auth_users", authUsers);
    $r("newLoginId").value = ""; $r("newLoginPass").value = "";
    renderLoginUsersTable(); triggerBackgroundSync();
    showToast(`✅ ${role} ID "${username}" created locally; sync pending`);
  };

  window.resetUserPass = async function (uid) {
    if (sessionStorage.getItem("tc_session_logged") !== "1" || !getLoggedAccount().isOwnerOrMgr) return showToast("Owner / Manager mattum dhaan!");
    const u = authUsers.find(x => x.uid === uid); if (!u) return;
    if (u.role === "Owner" && getLoggedAccount().role !== "Owner") return showToast("Owner password Owner mattum dhaan maatha mudiyum");
    const np = prompt(`New password for ${u.username} (min 8 chars):`);
    if (!np || np.trim().length < 8) return showToast("Password change cancelled");
    u.passHash = await hashPw(np.trim()); u.mustChange = false; u.updatedAt = Date.now();
    safeStorageSet("tc_auth_users", authUsers); triggerBackgroundSync(); showToast(`🔑 Password reset for ${u.username}`);
  };

  window.renderLoginUsersTable = function () {
    const tbody = $r("loginUsersTable"); if (!tbody) return;
    tbody.innerHTML = authUsers.map(u => {
      const priv = u.role === "Owner" || u.role === "Manager" || u.role === "Admin";
      const access = priv ? `<span class="status-pill status-in">✅ Full Access</span>`
        : `<button class="mini-btn ${u.canViewAttendance ? "grant" : "del"}" onclick="toggleStaffAttendanceAccess('${u.uid}')">${u.canViewAttendance ? "✅ Allowed (Tap to Off)" : "🔒 Off (Tap to Grant)"}</button>`;
      return `<tr><td><b>${u.username}</b></td><td><span class="mode-badge ${priv ? "owner" : "cash"}">${["Owner","Manager","Admin","Staff"].includes(u.role) ? u.role : "Staff"}</span></td><td>${access}</td><td>••••••• <button class="mini-btn" style="margin-left:4px;padding:3px 6px;" onclick="resetUserPass('${u.uid}')">Reset</button></td><td><button class="mini-btn del" onclick="promptDeleteLoginUser('${u.uid}')">🗑️ Del</button></td></tr>`;
    }).join("");
  };

  /* ---------- 2. Delete PIN (hashed, owner-set, no hardcoded value) ---------- */
  const PIN_KEY = "tc_pin_hash";
  const pinHash = p => hashPw(p);

  window.confirmDeleteWithPin = async function () {
    const entered = $r("billDeletePinInput").value.trim();
    const acc = getLoggedAccount();
    if (!pendingDeleteTarget) return;
    const stored = localStorage.getItem(PIN_KEY);
    if (!stored) {
      if (acc.role !== "Owner") return showToast("Owner must set the Delete PIN first (Settings)");
      if (!/^\d{6}$/.test(entered)) return showToast("Enter a new 6-digit PIN to set it");
      localStorage.setItem(PIN_KEY, await pinHash(entered));
      $r("billDeletePinInput").value = "";
      return showToast("✅ Delete PIN saved — enter it again to delete");
    }
    if (!(await verifyPw(entered, stored, "pin"))) {
      showToast("❌ Thappana PIN! Delete aagala.");
      $r("billDeletePinInput").value = ""; $r("billDeletePinInput").focus(); return;
    }
    const { type, uid } = pendingDeleteTarget;
    if (sessionStorage.getItem("tc_session_logged") !== "1" || !acc.isOwnerOrMgr) return showToast("Owner / Manager mattum dhaan!");
    if (type === "bill") {
      const t = bills.find(b => (b.uid || b.billNo) === uid);
      bills = bills.filter(b => (b.uid || b.billNo) !== uid);
      if (!deletedBillIds.includes(uid)) deletedBillIds.push(uid);
      safeStorageSet("tc_bills", bills); safeStorageSet("tc_deleted_bill_ids", deletedBillIds);
      closePinModal(); renderSummary(); showToast(`🗑️ Bill ${t ? t.billNo : ""} deleted & synced!`);
    } else if (type === "expense") {
      expenses = expenses.filter(e => e.uid !== uid);
      if (!deletedExpenseIds.includes(uid)) deletedExpenseIds.push(uid);
      safeStorageSet("tc_expenses", expenses); safeStorageSet("tc_deleted_expense_ids", deletedExpenseIds);
      closePinModal(); renderExpenses(); if (activeTabName === "summary") renderSummary(); showToast("🗑️ Expense deleted & synced!");
    } else if (type === "user") {
      const t = authUsers.find(u => u.uid === uid);
      if (t?.role === "Owner" && acc.role !== "Owner") return showToast("Only the Owner can delete an Owner account");
      if (t?.role === "Owner" && authUsers.filter(u => u.role === "Owner").length <= 1) return showToast("Cannot delete the last Owner account");
      authUsers = authUsers.filter(u => u.uid !== uid);
      if (!deletedUserIds.includes(uid)) deletedUserIds.push(uid);
      safeStorageSet("tc_auth_users", authUsers); safeStorageSet("tc_deleted_user_ids", deletedUserIds);
      closePinModal(); renderLoginUsersTable(); showToast(`🗑️ Login ID "${t ? t.username : ""}" deleted & synced!`);
    }
    triggerBackgroundSync();
  };

  async function changePin() {
    if (getLoggedAccount().role !== "Owner") return showToast("Owner mattum dhaan PIN maatha mudiyum");
    const stored = localStorage.getItem(PIN_KEY);
    if (stored) { const cur = prompt("Current Delete PIN:"); if (!cur || !(await verifyPw(cur.trim(), stored, "pin"))) return showToast("❌ Wrong current PIN"); }
    const np = prompt("New 6-digit Delete PIN:");
    if (!np || !/^\d{6}$/.test(np.trim())) return showToast("PIN must be exactly 6 digits");
    localStorage.setItem(PIN_KEY, await pinHash(np.trim())); showToast("✅ Delete PIN updated");
  }

  /* ---------- 5. Unique bill numbers across devices ---------- */
  function devCode() {
    let c = localStorage.getItem("tc_dev_code");
    if (!c) { c = Array.from(crypto.getRandomValues(new Uint8Array(4))).map(x => x.toString(16).padStart(2, "0")).join("").toUpperCase(); localStorage.setItem("tc_dev_code", c); }
    return c;
  }
  window.getNextBillNo = function () {
    let max = Number(localStorage.getItem("tc_last_bill_seq")) || 100;
    bills.forEach(b => { const m = String(b.billNo || "").match(/^TC-(\d+)/); if (m) max = Math.max(max, parseInt(m[1], 10)); });
    const n = max + 1; localStorage.setItem("tc_last_bill_seq", String(n));
    return "TC-" + n + "-" + devCode();
  };

  /* ---------- 8 & 9. Sync merge fixes ---------- */
  const origMerge = window.mergeTwoWayData;
  window.mergeTwoWayData = function (remote) {
    if (!remote || typeof remote !== "object") return;
    (remote.menu || []).forEach(m => { m.name = cl(m.name); m.cat = cl(m.cat); });
    (remote.bills || []).forEach(b => { b.customer = cl(b.customer); b.staff = cl(b.staff); (b.items || []).forEach(i => i.name = cl(i.name)); });
    (remote.expenses || []).forEach(e => { e.note = cl(e.note); e.cat = cl(e.cat); });
    (remote.attendance || []).forEach(a => { a.name = cl(a.name); });
    (remote.authUsers || []).forEach(u => { u.username = cl(u.username); });
    const prev = { ...settings };
    const rb = new Map((remote.bills || []).map(b => [b.uid || b.billNo, b]));
    const re = new Map((remote.expenses || []).map(e => [e.uid, e]));
    origMerge(remote);
    const pick = (loc, map, key, dead) => {
      const r = map.get(key(loc));
      return r && !dead.includes(key(loc)) && (r.updatedAt || 0) > (loc.updatedAt || 0) ? r : loc;
    };
    bills = bills.map(b => pick(b, rb, x => x.uid || x.billNo, deletedBillIds));
    expenses = expenses.map(e => pick(e, re, x => x.uid, deletedExpenseIds));
    ["name", "phone", "address", "upi", "gstin"].forEach(k => { if (!settings[k] && prev[k]) settings[k] = prev[k]; });
    safeStorageSet("tc_settings", settings);
    sanitizeAll(); saveAll();
    return migrateUsers().then(() => { if (activeTabName === "settings") renderLoginUsersTable(); });
  };

  /* ---------- 7. Sync secret for the Apps Script endpoint ---------- */
  const getTok = () => localStorage.getItem("tc_sync_token") || "";
  const realFetch = window.fetch.bind(window);
  window.fetch = function (url, opt) {
    opt = opt || {};
    try {
      const base = settings.gdriveUrl, tok = getTok();
      if (tok && base && typeof url === "string" && (url === base || url.startsWith(base + (base.includes("?") ? "&" : "?")))) {
        if (!opt.method || opt.method === "GET") url += (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(tok);
        else if (typeof opt.body === "string") { const o = JSON.parse(opt.body); o.token = tok; opt = { ...opt, body: JSON.stringify(o) }; }
      }
    } catch (e) {}
    return realFetch(url, opt);
  };
  function setSyncSecret() {
    if (sessionStorage.getItem("tc_session_logged") !== "1" || !getLoggedAccount().isOwnerOrMgr) return showToast("Owner / Manager mattum dhaan!");
    const t = prompt("Sync secret (same value as SECRET in your Apps Script). Leave empty to clear:");
    if (t === null) return;
    if (t.trim()) localStorage.setItem("tc_sync_token", t.trim()); else localStorage.removeItem("tc_sync_token");
    showToast("🔐 Sync secret saved"); triggerBackgroundSync();
  }
  const SECURE_SCRIPT = APPS_SCRIPT_TEMPLATE
    .replace("function doGet(e) {",
      'const SECRET = "CHANGE_ME_TO_A_LONG_RANDOM_STRING";\n\nfunction doGet(e) {\n  if (!e.parameter || e.parameter.token !== SECRET) return ContentService.createTextOutput(JSON.stringify({ empty: true })).setMimeType(ContentService.MimeType.JSON);')
    .replace("const body = JSON.parse(e.postData.contents);",
      'const body = JSON.parse(e.postData.contents);\n  if (body.token !== SECRET) return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "unauthorized" })).setMimeType(ContentService.MimeType.JSON);\n  delete body.token;');
  window.copyAppsScript = function () {
    if (navigator.clipboard) navigator.clipboard.writeText(SECURE_SCRIPT);
    showToast("Secured Google Drive Script copied! Set your SECRET in it.");
  };

  /* ---------- 6. Extra role guards (UI-level; real enforcement needs a server) ---------- */
  ["toggleStaffAttendanceAccess", "promptDeleteLoginUser"].forEach(n => {
    const o = window[n];
    window[n] = function () { if (sessionStorage.getItem("tc_session_logged") !== "1" || !getLoggedAccount().isOwnerOrMgr) return showToast("Owner / Manager mattum dhaan!"); return o.apply(this, arguments); };
  });

  /* ---------- Startup ---------- */
  function injectButtons() {
    const host = $r("currentUserBadgeText") && $r("currentUserBadgeText").parentElement;
    if (!host || $r("raviSecRow")) return;
    const d = document.createElement("div");
    d.id = "raviSecRow"; d.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;";
    d.innerHTML = '<button class="mini-btn" id="raviPinBtn">🔑 Delete PIN</button><button class="mini-btn" id="raviTokBtn">🔐 Sync Secret</button>';
    host.appendChild(d);
    $r("raviPinBtn").onclick = changePin; $r("raviTokBtn").onclick = setSyncSecret;
  }
  sanitizeAll(); saveAll();
  migrateUsers().then(() => { renderLoginUsersTable(); renderCategories(); renderMenu(); }).catch(e => console.error('Login initialization failed', e));
  injectButtons();
  const origApply = window.applySettingsToInputs;
  window.applySettingsToInputs = function () { origApply(); injectButtons(); };
  const sync = window.syncNowBothWays;
  window.syncNowBothWays = async function (notify) {
    try {
      await migrateUsers();
      return await sync(notify);
    } catch (error) {
      console.error("Could not prepare accounts for cloud backup", error);
      if (notify) showToast("Cloud backup paused. Account storage is unavailable.");
    }
  };
  if (sessionStorage.getItem("tc_session_logged") === "1" && settings.gdriveUrl) syncNowBothWays(false);
  $r("appsScriptDisplay").textContent = SECURE_SCRIPT;
})();