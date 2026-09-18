# esosave

Browser extension (Chrome, and Safari on iPad via the Expo wrapper in `ios-app/`) for the ESO EHR
web app. See README.md for what it does and how it is tested (`npm test`, `npm run test:inline`).

## Settings: locked or open

Settings come in two kinds. **Locked** ones (retention, tab warm-up, call times, fax prompt, Not
sent list) are set in the code and shown greyed out in the panel. **Open** ones (the quick-button
toggles and the facility chips, the `OPEN_SETTINGS` list in `extension/content.js`) may be changed
by the crew and follow the ESO login through the `esosave_users` table.

**Before adding any new setting, ask the repo owner whether it is locked or open.** Do not guess.

## Data that may leave the device

Only the open settings and the ids of the runs a login worked go to the table
(`supabase/esosave_users.sql`). Recorded runs, signature images, field definitions, the emailed
map and the Not sent list never do. The Supabase Management token lives in `.env.local`
(gitignored) and is never committed; the anon key in `content.js` is public by design.
