// Run recoverRaviPrimaryOwner from the Apps Script editor of the existing shop.
function recoverRaviPrimaryOwner() {
  const actor = Session.getActiveUser().getEmail();
  const effective = Session.getEffectiveUser().getEmail();
  if (!actor || actor !== effective) throw new Error("Open the script editor with the shop's Google account.");

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error("Shop sync is busy. Run recovery again in a moment.");
  try {
    const props = PropertiesService.getScriptProperties();
    const ownerId = props.getProperty("RAVI_PRIMARY_ID");
    const pepper = props.getProperty("RAVI_STAFF_PEPPER");
    const recoveryProperty = "RAVI_RECOVERED_OWNER_PASSWORD";
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(ownerId || "")
        || !/^[a-f0-9]{64}$/.test(pepper || "")
        || !props.getProperty("staff:" + ownerId) || props.getProperty("revoked:" + ownerId)) {
      throw new Error("No active primary Owner account was found. Recovery made no changes.");
    }
    if (props.getProperty(recoveryProperty)) {
      throw new Error("A recovery password already exists. Read it privately in Script properties.");
    }

    const password = Utilities.getUuid().replace(/-/g, "").slice(0, 24);
    const newHash = raviStaffDigest(pepper, ownerId, password);
    if (!newHash) throw new Error("Could not create the new password.");
    props.setProperties({ ["staff:" + ownerId]: newHash, [recoveryProperty]: password });
    console.log("Online Owner ID: " + ownerId + ". Read and remove RAVI_RECOVERED_OWNER_PASSWORD in Script properties.");
  } finally {
    lock.releaseLock();
  }
}
