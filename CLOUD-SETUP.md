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

1. In the owner app, enter a unique online Staff ID and choose **Create Staff ID and password**. Give the staff member the ID, generated password and shop link privately.
2. On their phone, they install the updated app, choose **Staff / online**, and enter the shop link, ID and password.
3. Use **Refresh staff list → Revoke** to prevent future sign-ins with an old password. To replace a password, revoke the ID and create it again. An already-open staff session locks on reload, logout or after eight hours.

Online staff sign-in needs internet. Staff can use POS on their own device. The Drive/Sheets backup remains owner-only and staff-device transactions stay on the staff device. Staff passwords are generated randomly and the server stores a keyed digest in Script Properties. Owner and staff credentials are excluded from Drive/Sheets backups.
