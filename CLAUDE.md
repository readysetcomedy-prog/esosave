# esosave

Browser extension (Chrome, and Safari on iPad via the Expo wrapper in `ios-app/`) for the ESO EHR
web app. See README.md for what it does and how it is tested (`npm test`, `npm run test:inline`).

## Settings: locked or open

Settings come in two kinds. **Locked** ones (retention, tab warm-up, call times, fax prompt, Not
sent list, the paperwork question before a lock, the CAD import gate: the `LOCKED_SETTINGS` list)
are the agency's: one `__agency__` row in the table, changed only by the agency owner's ESO login
(`ADMIN` in `extension/content.js`) and shown greyed out to everyone else. **Open** ones (the quick-button
toggles and the facility chips, the `OPEN_SETTINGS` list in `extension/content.js`) may be changed
by the crew and follow the ESO login through the `esosave_users` table.

**Before adding any new setting, ask the repo owner whether it is locked or open.** Do not guess.

## Data that may leave the device

Only the open settings go to the table (`supabase/esosave_users.sql`); which runs a login may see
is decided on the tablet from each run's crew list. Recorded runs, signature images, field definitions, the emailed
map and the Not sent list never do. The Supabase Management token lives in `.env.local`
(gitignored) and is never committed; the anon key in `content.js` is public by design.
