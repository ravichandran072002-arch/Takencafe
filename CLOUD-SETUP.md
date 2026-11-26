# RAVI POS online staff sign-in

## Update the Google Apps Script deployment

Use the Google account that owns the Apps Script project behind your shop's current `/exec` URL.

1. Sign in as Owner in the updated RAVI POS app. Open Settings and use **Copy Script** under **Google Apps Script Code**.
2. Open the original Apps Script project and save a copy of its source. Replace the old web app code with the copied script. The RAVI script uses the existing `TakenCafe_POS_Drive_Sync` folder and `RAVI_POS_Live_Sheet` names. If your current script uses different names or custom spreadsheet logic, preserve those before deploying.
3. In the app, open **Generate keys for Apps Script setup**. Generate two keys. Under Apps Script **Project Settings → Script properties**, set `RAVI_OWNER_KEY` and `RAVI_STAFF_PEPPER` to their respective values. Keep both private. Only the owner key is entered back into RAVI POS.
4. In Apps Script use **Deploy → Manage deployments → Edit → New version** on the existing web app. Set **Execute as** to the script owner. Set access to **Anyone** for phones that don't sign in to Google. Deploy and grant the requested Drive/Sheets permissions. Updating the existing deployment preserves its `/exec` URL.
5. Enter the URL and owner key in RAVI POS Settings. Choose **Save owner key** and confirm the app can sync. The owner key stays in memory until logout or app restart. Keep your own private copy.
6. If older web app deployments still expose the backup, archive them after confirming the new version works. Earlier backups may still contain legacy credential hashes. Keep those files private and review Drive sharing and retention.

## Create and use an online Staff ID

1. In the owner app, enter a unique online Staff ID and choose **Create Staff ID and password**. Give the staff member the ID and generated password privately.
2. On their phone, they install the updated app, choose **Staff / online**, and enter the ID and password. The shop link is preset. If the shop moves to a new deployment, open **Owner / this device** on that device, enter the replacement URL in **Settings**, and save the owner key to verify and remember the link.
3. Use **Refresh staff list → Revoke** to prevent future sign-ins with an old password. To replace a password, revoke the ID and create it again. An online staff session rechecks access during sync. It also locks on reload, logout or after eight hours.

## Android and Windows sync

Install matching builds on both devices and deploy the updated Apps Script version before using online sync. Update any older clients first.

- On each owner device, unlock the local Owner account and enter the same shop link and private owner key. The app merges menu, bills, attendance, expenses, deletions and shop details through the shared backup. Printer and theme preferences are device-specific.
- Staff use the same online Staff ID and password on Android or Windows. Once signed in, they can bill and punch in/out during an outage. New staff bills and attendance wait on the device and upload when it reconnects. If the app restarts before uploading, sign in again with the same ID and shop link. Menu updates flow from the owner to staff. Existing bills created with older app versions do not upload as staff records automatically.
- Drive/Sheets backup, expenses, reports and menu editing remain owner-only. Staff passwords are generated randomly and the server stores a keyed digest in Script Properties. Account credentials are excluded from Drive/Sheets backups.

## Set up automatic Owner sync once

1. Use **Owner / this device**, open **Settings**, and save the setup key once.
2. Choose an **Online Owner ID**. Generate the Owner password and save it privately before proceeding.
3. Tap **Activate Owner & Sync**. This creates the primary online Owner account, retires the setup key for online access, and starts sync. Use the new ID and password under **Staff / online** for later sign-ins.
4. While the app is open and online, changes trigger sync automatically. The app also tries again after reconnection.

## Co-owner and ownership transfer

Deploy this version of `Code.gs` to the existing web app and update the app on both devices. Keep the existing script properties and /exec URL.

- The current primary owner signs in and opens **Settings → Refresh staff list**. If this shop still uses the original local owner, save its owner key for that session first.
- **Make Co-owner** lets the selected staff account sign in with its current Online Staff ID and password and manage shop data and regular staff. Only the primary owner can assign or remove Co-owner access or transfer ownership.
- **Transfer ownership to [staff ID]** changes the primary owner immediately. That person signs in under **Staff / online** with their existing ID and password and gets the Owner screen. The previous primary owner's online Owner access ends. If they had an online account, it becomes Staff. The old setup key can no longer authorize online owner requests after transfer.
- Google Drive and Apps Script stay under the current Google account. The app transfer shares authorized shop access, and existing offline records already on a former owner's device remain on that device.
