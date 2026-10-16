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

## 3. Deploy the script as a web app

1. In Apps Script: **Deploy → New deployment**.
2. Gear icon → **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**. This is required so your phone can reach it. The passphrase is what keeps it private.
3. **Deploy**, then copy the **Web app URL** (ends in `/exec`).

> If you change `Code.gs` later: **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. That keeps the same URL. A *new deployment* would give you a new URL.

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

This puts a **Send to Trip** option in the Share menu of Google Maps, Safari, Instagram, anywhere.

In the **Shortcuts** app, tap **+** and name it **Send to Trip**. Then:

1. Tap the **ⓘ** (details) button and turn on **Show in Share Sheet**. Set it to accept **URLs** and **Text**.
2. Add **Text** action and paste your Web app URL followed by `?action=tripMenu&token=YOURPASSPHRASE`. For example:
   `https://script.google.com/macros/s/AKfy…/exec?action=tripMenu&token=abc123`
3. Add **Get Contents of URL**, with the Text from step 2 as input.
4. Add **Get Dictionary Value**: *Get Value for* `data` in **Contents of URL**. This is a list of your upcoming trips plus **Someday**.
5. Add **Choose from List**, with the input being that **Dictionary Value**. Shortcuts shows the trip names.
6. Add **Get Dictionary Value**: *Get Value for* **Chosen Item** in the **Dictionary Value** from step 4. This is the trip's ID.
7. Add **URL Encode** with input **Shortcut Input**.
8. Add **Text**:
   `https://script.google.com/macros/s/AKfy…/exec?action=add&token=YOURPASSPHRASE&trip=` then insert the **Dictionary Value** variable, then `&text=`, then insert the **URL Encoded Text** variable.
9. Add **Get Contents of URL** with that Text.
10. Add **Get Dictionary Value**: *Get Value for* `data` in **Contents of URL**, then another **Get Dictionary Value**: *Get Value for* `title` in that result.
11. Add **Show Notification**: `Saved: ` + the title.

Try it: in Google Maps, open a place → **Share** → **Send to Trip** → pick a trip. It appears in the app within a few seconds of the next refresh, with name, address and hours.

---

## How the pieces talk

- **The app** reads everything from the Sheet when it opens and writes each change back. It keeps a copy on the phone for offline use.
- **The Sheet** is the record. You can edit cells directly: fix a typo, paste rows, add notes. The app picks it up on the next open.
- **The `id` column** is how the app knows which row is which. Don't change existing IDs. If you add a row by hand, give it any unique short ID (e.g. `it_hand01`) so the app can edit it later.
- **Deleting a trip** sends its places back to Someday rather than deleting them.

## Next steps (step 2)

Map view of a trip, drag-to-day planning, and hours-aware day suggestions.
