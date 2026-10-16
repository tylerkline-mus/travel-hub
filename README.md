# Travel Hub

A personal trip planner and travelogue. Plan before you go — flights, stays, bookings, saved places and loose ideas — then log what you actually do on the ground.

- **App:** https://tylerkline-mus.github.io/travel-hub/ (add to your phone's home screen)
- **Data:** your own Google Sheet, through a small Apps Script web app (`apps-script/Code.gs`)
- **Setup:** see [SETUP.md](SETUP.md)

No data, keys or passphrases live in this repo. The app asks for the web app URL and passphrase once and keeps them on the device.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole app |
| `sw.js` | Lets the app open with no signal |
| `manifest.webmanifest`, `icon-*.png` | Home-screen app icon and name |
| `apps-script/Code.gs` | The Google Sheet backend (paste into Extensions → Apps Script) |
| `SETUP.md` | Step-by-step setup, including the iPhone "Send to Trip" shortcut |

## Roadmap

1. ✅ Trips, capture (Maps links, ideas, fixed bookings), Someday bucket, offline queue
2. ✅ Start/end dates on bookings, tours with nested stops, day-by-day plan with ordering and opening-hours hints, map with routes
3. ✅ Travelogue: ordered "I'm here" logging, planned vs. found, travel mode per leg, end-of-day review
4. Photos, journal view, suggestion workflows
