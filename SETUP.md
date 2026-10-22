# Travel Hub — setup (about 20 minutes)

The app (`index.html`, `sw.js`, `manifest.webmanifest`, icons) runs from this repo on GitHub Pages.
The Sheet script lives in `apps-script/Code.gs` — that one gets pasted into Google Apps Script.

---

## 1. Make the Sheet

1. Create a new Google Sheet and name it **Travel Hub**.
2. **Extensions → Apps Script**. Delete what's in `Code.gs` and paste in the whole `Code.gs` from this folder. Save.
3. In the function dropdown at the top, choose **setup** and click **Run**. Approve the permissions prompt (it's your own script).
4. Open **View → Logs** (or the Execution log). It prints your passphrase. Copy it.
   - To choose your own instead: **Project Settings (gear) → Script Properties → TOKEN**.

Your Sheet now has four tabs: **Trips, Items, Plan, Log**. Don't rename or reorder the columns. Adding new columns on the right is fine.

## 2. Turn on place lookups (names, addresses, hours)

Without this, Maps links still save, just with less detail.

1. Go to **console.cloud.google.com**. Create a project ("Travel Hub") and set up billing. The monthly free usage covers personal use, but Google requires a card.
2. **APIs & Services → Library**. Enable **Places API (New)**.
3. **APIs & Services → Credentials → Create credentials → API key**.
4. Edit the key. Under **API restrictions**, choose *Restrict key* and tick only **Places API (New)**. Leave *Application restrictions* as **None**, because the calls come from Google's own servers via your script, not from the browser.
5. Optional but smart: under **Billing → Budgets & alerts**, set a small budget, like $5, so you'd hear about any surprise.
6. Back in Apps Script: **Project Settings → Script Properties → Add**, name `PLACES_KEY`, and paste the key.
7. Run **testPlaces** from the function dropdown. The log should show Harpa with an address and hours.

### 2b. Real routes on the map (optional)

Without this, the map connects stops with dashed straight lines. With it, you get actual walking / transit / driving paths. Each leg is looked up once and saved to the **Routes** tab, so revisiting a day costs nothing.

1. **APIs & Services → Library**. Enable **Routes API**.
2. **APIs & Services → Credentials** → your key → **API restrictions**: tick **Routes API** in addition to Places API (New). Save.
3. Run **testRoutes** from the function dropdown. The log should say `Routes OK`.

## 3. Deploy the script as a web app

1. In Apps Script: **Deploy → New deployment**.
2. Gear icon → **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**. This is required so your phone can reach it. The passphrase is what keeps it private.
3. **Deploy**, then copy the **Web app URL** (ends in `/exec`).

### Updating the script later

1. Open https://raw.githubusercontent.com/tylerkline-mus/travel-hub/main/apps-script/Code.gs, select all, copy.
2. In Apps Script, select all of `Code.gs`, delete, paste, save.
3. Run **setup** once. It adds any new columns and tabs without touching your data.
4. **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. That keeps the same URL. (A *new deployment* would give you a new URL.)

## 4. Turn on GitHub Pages

The app files are already in this repo.

1. In the repo: **Settings → Pages**.
2. Source **Deploy from a branch**, branch **main**, folder **/ (root)**. Save.
3. After a minute or two the app is at **https://tylerkline-mus.github.io/travel-hub/**.

## 5. On your phone

1. Open that address in **Safari**.
2. Paste the **Web app URL** and **passphrase**, then tap **Connect**.
3. **Share → Add to Home Screen**. It now opens full-screen like an app, and works without signal using the last-synced copy. Anything you add offline is queued and sent when you're back online.
4. In the app's **Settings** (gear), paste your Sheet's link so it's one tap away.

---

## 6. The "Send to Trip" shortcut (save straight from Google Maps)

This puts a **Send to Trip** option in the Share menu of Google Maps, Safari, anywhere. Places go to the trip that's happening now, otherwise your next upcoming one. Move anything to another trip or Someday in the app.

> Send the details as a **JSON request body**, not inside the web address. Shortcuts mangles addresses built from inserted text (it cuts them off at the inserted part), but a JSON body arrives intact.

In the **Shortcuts** app, tap **+** and name it **Send to Trip**. Then:

1. Add **Get Text from Input**. Its input should be **Shortcut Input**.
2. Tap **ⓘ** (or the shortcut name → **Details**) and turn on **Show in Share Sheet**. Leave all input types on.
3. Add **Get Contents of URL**. URL: your Web app URL only (ending in `/exec`, nothing after it). Tap **›**:
   - **Method:** POST
   - **Request Body:** JSON, with five **Text** fields (key on the left, value on the right):

   | Key | Value |
   |---|---|
   | `action` | `add` |
   | `token` | your passphrase |
   | `trip` | `auto` |
   | `format` | `text` |
   | `text` | **Text** (from step 1) |

4. Add **Show Notification** with **Contents of URL**. It says e.g. *Saved Bjarmanes to Iceland, Autumn 2026.*

Try it: in Google Maps, open a place → **Share** → **Send to Trip**. It appears in the app after the next refresh, with name, address and hours. If nothing came through, the notification says so and nothing is added.

---

## 7. The "I'm here" shortcut (log a stop in one tap)

Two ways in, one shortcut:
- **Share a place from Google Maps → I'm here.** Logs that place to today's trip, stamped with the moment you shared it.
- **Tap it from your Home Screen, Action Button or Back Tap.** Logs where you're standing: the saved place you're at, otherwise the nearest place Google knows, otherwise the street or neighbourhood you're on (rename it in the app). "Somewhere" only if even that lookup fails.

In the **Shortcuts** app, tap **+** and name it **I'm here**. Then (details go in a JSON request body, as in §6 — never inside the address):

1. Tap **ⓘ** and turn on **Show in Share Sheet** (leave all types on). Under *If there's no input*, choose **Continue**.
2. Add **If**: *Shortcut Input* **has any value**.
3. Inside the **If** branch:
   - **Get Text from Input** (Shortcut Input).
   - **Get Contents of URL**: your Web app URL only (ending in `/exec`). Tap **›** → **Method** POST, **Request Body** JSON, Text fields: `action` = `here`, `token` = your passphrase, `format` = `text`, `text` = **Text**.
4. Inside the **Otherwise** branch:
   - **Get Current Location**.
   - **Get Details of Locations**: **Latitude**, then another for **Longitude**.
   - **Get Contents of URL**: same URL, POST, JSON, Text fields: `action` = `here`, `token` = your passphrase, `format` = `text`, `lat` = **Latitude**, `lng` = **Longitude**.
5. After **End If**, add **Show Notification** with **If Result**. It says what was logged, e.g. *Logged Kaffibarinn (Iceland, Autumn 2026).*

**Close calls (optional, recommended).** In a strip of shops your phone can't tell one storefront from the next, so the shortcut can ask instead of guessing:
- In the **Otherwise** branch's Get Contents of URL, add a Text field `ask` = `yes`.
- Replace the final **Show Notification** with: **If** *If Result* **begins with** `📍` → **Split Text** (If Result, New Lines) → **Choose from List** (Split Text, prompt "Where are you?") → **Get Contents of URL** (same URL, POST, JSON: `action` here, `token`, `format` text, `ask` yes, `lat` Latitude, `lng` Longitude, `pick` Chosen Item) → **Show Notification** (Contents of URL); **Otherwise** → **Show Notification** (If Result); **End If**.
When one place is clearly closest it still logs in one tap; when two or more are about equally close you get a short list, with **Just this spot** at the bottom.

To put it within reach: **ⓘ → Add to Home Screen**; or **Settings → Action Button → Shortcut**; or **Settings → Accessibility → Touch → Back Tap → Double Tap**. In Google Maps, it appears in the share sheet's list of apps and actions; long-press it there to move it near the front.

It logs to whichever trip is happening today (a day either side counts, for travel days). A shared place that's already saved to the trip is logged as that place (and ticked off). A second log at the same spot within half an hour doesn't log twice. It needs signal; with none, open the app and use **I'm here** there, which saves offline.

---

## How the pieces talk

- **The app** reads everything from the Sheet when it opens and writes each change back. It keeps a copy on the phone for offline use.
- **The Sheet** is the record. You can edit cells directly: fix a typo, paste rows, add notes. The app picks it up on the next open.
- **The `id` column** is how the app knows which row is which. Don't change existing IDs. If you add a row by hand, give it any unique short ID (e.g. `it_hand01`) so the app can edit it later.
- **Deleting a trip** sends its places back to Someday rather than deleting them.
- **Photos, sounds and souvenirs** you keep with a stop are rows in the **Artifacts** tab; the files themselves go to a **Travel Hub** folder in your Google Drive (one folder per trip), private to you. The app loads them back through the script and keeps a copy on the phone. The first time the script saves a file, Google asks for Drive permission — run **testDrive** once from the editor to get that out of the way. Deleting a stop sends its files to the Drive trash.

## Next steps (step 2)

Map view of a trip, drag-to-day planning, and hours-aware day suggestions.
