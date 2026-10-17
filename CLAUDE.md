# Travel Hub — project guide for Claude

Tyler's personal trip planner + travelogue. Phone-first web app on GitHub Pages, data in his Google Sheet.
Read this before changing anything. Keep it current when the structure changes.

## Architecture

- `index.html` — the entire app (vanilla JS, no build step). Leaflet 1.9.4 from cdnjs for maps, OpenStreetMap tiles (CARTO now needs a key — don't switch back).
- `sw.js` — service worker: app shell network-first, assets cache-first, OSM tiles cached as viewed (offline maps). Bump `CACHE` when shell files change.
- `apps-script/Code.gs` — Google Apps Script backend bound to the Sheet, deployed as a web app (Execute as me, Anyone). The app POSTs `{action, token, ...}` as text/plain JSON; the Shortcut uses GET params. Script Properties: `TOKEN` (passphrase), `PLACES_KEY` (Google key: Places API (New) + Routes API).
- Writes are optimistic: applied locally, queued in an outbox (localStorage), flushed to the script. Deletes go through `undoable()` (6 s undo).
- Google Places lookups happen server-side (`resolveText`): expands maps.app.goo.gl links, parses name/coords, Text Search → place id, address, hours (periods + weekday text), types, website. Airports: `airportLookup(code)` cached in Script Properties. Routes: `routes` action, cached in the Routes tab.

**Script changes need Tyler to redeploy**: copy raw `apps-script/Code.gs` → paste in Apps Script → run `setup` (adds missing columns/tabs non-destructively) → Deploy → Manage deployments → ✏️ → New version. Always tell him when a change needs this. App-only changes go live on push (GitHub Pages, ~1–2 min).

## Sheet schema (columns are read by header name; new columns are appended on the right by `setup`)

- **Trips**: id, name, destination, start, end, timezone (IANA), notes, created, updated
- **Items**: id, trip_id ('' = Someday), kind (fixed | place | idea), category, title, city, region, country, address, lat, lng, place_id, maps_url, hours (JSON), website, day, start_time, end_time, confirmation, status (open | done | skipped), source, notes, created, updated, end_day, parent_id (tour stop → its tour), seq (order within a day / tour), priority (must | want | maybe), from_code, to_code, from_name, to_name, from_lat, from_lng, to_lat, to_lng, types (comma list)
- **Log**: id, trip_id, item_id, place_id, title, lat, lng, logged_at, timezone, origin (planned | found), note, would_return (legacy), cost, currency, photo_url, created, parent_id, day, seq, time, mode (walk | transit | train | car | tour | bike), address, city, maps_url, updated, rating (loved | liked | meh)
- **Routes**: key, polyline, duration, distance, created
- **Plan**: unused (legacy)

**Reading the Sheet cheaply** (usage matters — Tyler is on Pro): the `hours` column is ~2 KB per row and dominates the Sheet. Never read whole tabs. Read only the columns needed, e.g. Items `A:H` + `P:V` + `Y:AB` (id…address, day…notes, end_day…priority) — check the header row first since columns can shift.

## App structure (index.html)

Routes: `#/` trips · `#/trip/:id/days|map|saved|log` · `#/someday`. Key functions: `tripDays` (includes travel days outside trip dates), `fixedEvents`, `plannedStops`, `stayForNight/Morning`, `drawMap` (+ `drawFlights` with date-line handling), `savedResults` (search with SYNONYMS, `openNow`, near me), `openItem`, `openCapture`, `openHere` (log a stop), `openReview`, `undoable`, `demoData` (sample mode — keep it exercising every feature).

## Testing

Sample mode runs fully offline. Test with Playwright at 390×844 @2x: route `cdnjs.cloudflare.com` to a local `npm i leaflet@1.9.4`, abort `tile.openstreetmap.org` and fonts. Use `timezone_id` / `geolocation` context options for open-now / near-me. `node --check` the extracted `<script>` and `Code.gs` before pushing. Screenshot and look before pushing.

## Conventions

- Plain, friendly UI copy; no jargon. Mobile first; everything works one-handed.
- Never put Tyler's Sheet ID, passphrase, or API key in this (public) repo.
- Tyler prefers complete code blocks when he has to paste code himself.
- Commit as Tyler; end commit messages with the Co-Authored-By / Claude-Session trailer the session provides.

## Ask Claude (built Oct 2026)

- Idea `status`: `open` · `ask` (Ask Claude toggle on) · `answered`. Toggle saves immediately; turning it off goes back to `answered` if the idea has suggestions, else `open`.
- Suggestions = non-fixed children of an idea (`isSuggestion`, `suggestionsOf`). Shown nested under the idea card and in its sheet with **Suggested** badge, **Keep** (clears `parent_id`) and **✕ Dismiss** (deleteItem, undoable). Excluded from day planning (they have a parent), the map, and Someday matches. Deleting an idea deletes its suggestions; moving an idea to another trip moves them.
- Claude's reply goes at the end of the idea's `notes` as a paragraph starting `Claude: `; the sheet shows it in the Ask Claude row.
- After each sync the app looks up new suggestions once (`lookUpSuggestions` → `refreshItem`, remembered in `th_sug_looked`), so Claude only needs to write a Maps search URL. No script change was needed.
- The "check my asks" procedure lives in Tyler's `travel-hub-asks` skill (holds the Sheet ID — never put it here).

## Recap poster (built Oct 2026)

- Route `#/trip/:id/recap` (button at the bottom of the Log tab). `recapData` → `drawPoster` on a canvas; Save image shares/downloads a PNG (1080×1350 post, 1080×1920 story).
- Draws from the Log once anything is logged, otherwise from the plan (planned stops, tours; musts in color).
- Design (deliberately not the app's cream/terracotta): ECM-sleeve restraint, routes as a pen line (real paths from the Routes cache, else a gentle bow), stays as squares, found-along-the-way as open rings, loved places in the accent with hand labels in italic. Looks: Fog / Night / Riso (accent overprinted with multiply, slightly off register). One typeface: Familjen Grotesk, loaded only on this screen. Paper grain is a seeded noise pass.
- Data: a "score" strip (one stroke per day, length = stops, colored top = loved), coordinates and scale bar, a locator inset in the emptiest corner when zoomed to the densest area (`recapCluster`), and first-person liner notes (`recapNotes`) — no stat tiles.
- Per-trip choices (size, look, zoom, own line) live in localStorage `th_poster`.

## Original design notes for Ask Claude

1. Ideas get an **Ask Claude** toggle → `status: 'ask'`. Personal notes stay `open`.
2. Tyler says "check my asks" in chat. Claude reads the Sheet lean (above), considers lodging (`Stay` items), free days, and the idea's notes; researches; then writes back:
   - suggestions as `kind: place` rows with `parent_id` = the idea's id, `priority: maybe`, `source: 'claude'`, a one-line why in `notes`, and `maps_url` = a Google Maps search URL (`https://www.google.com/maps/search/?api=1&query=…`) so the app's **Update older places** (refreshAll: rows with maps_url and empty types) fills in coords/hours/types;
   - a short reply in the idea's `notes` when useful;
   - idea `status: 'answered'`.
   Never edit fixed items or Tyler's own places.
3. App: ideas show nested suggestions (like tour stops) with a **Suggested** badge and **Keep** (clear parent_id, keep as a place) / **Dismiss** (delete) buttons; answered ideas show a subtle "answered" state; suggestions are excluded from Day planning until kept.
4. Package the read/write procedure as a skill (propose via the skill proposal card) holding the Sheet ID (given in chat, not this repo), column map, lean-read rule and the rules above.
5. First real run: Tyler's tattoo idea (walk-in, highly rated, Reykjavík). Candidates found so far near the Exeter: Ritual Tattoo (Skólavörðustígur 6b), Irezumi Ink (Laugavegur 69), Íslenska Húðflúrstofan (Ingólfsstræti 3), Reykjavik Ink (Laugavegur 59) — reviews not yet checked.

Later: photos per log entry (Drive via script), optional scheduled ask-checking.
