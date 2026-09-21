# esosave

Browser extension (Chrome, and Safari on iPad via the Expo wrapper in `ios-app/`) for the ESO EHR
web app. See README.md for what it does and how it is tested (`npm test`, `npm run test:inline`).

## Settings: locked or open

Settings come in two kinds. **Locked** ones (retention, tab warm-up, call times, fax prompt, Not
sent list, the paperwork question before a lock, the CAD import gate: the `LOCKED_SETTINGS` list)
are the agency's: one `__agency__` row in the table, changed only by the agency owner's ESO login
(`ADMIN` in `extension/content.js`) and shown greyed out to everyone else. **Open** ones (the quick-button
toggles and the facility chips, the `OPEN_SETTINGS` list in `extension/content.js`) may be changed
by the crew and follow the ESO login through the `esosave_users` table. The paperwork scanner
(`scanDocs`) and the vitals-copy groups (`vitalCopySkip`) are open; the template locks
(`tplLocks`, keys a fill leaves out) are locked.

**Before adding any new setting, ask the repo owner whether it is locked or open.** Do not guess.

## The person's row

`esosave_users` is keyed by the login name but carries `person_id` (ESO's agency person id);
the extension finds the row by id first and renames it when the login name changes. Templates
(`esosave_templates`, shares in `esosave_template_shares`) are owned by `owner_id`, that same
id. The Management API does run DDL now (the earlier refusals were the policy statements); the
SQL for these tables was applied from here.

## Templates

The field catalog comes from ESO's configuration bundle (`fieldConfigs`: address, fieldRef,
dataType, displayName, listRef) in `learnCatalog` (inject.js); `CATALOG_SKIP` names what is the
call's own and is never offered. A template body is `{ fields: { address: { r, t, v, l } }, items:
[{ root, kind, r, t, fields, findings }] }` and is written with the app's own ops (`templateOps`),
one autosave per tab. Item shapes (the ADD value each needs) were recorded from the app. The
assessment layout (`extension/assess-catalog.js`, `layout`: category → sections → locations with
their findings, `na` where a section's No Abnormalities / Not Assessed is written, `one` for
pick-one rows, `top` what ESO seeds Not Assessed) is taken from ESO's own Assessments code, not
PHI; findings are written per location exactly as ESO's screen writes them (recorded 2026-09-20).
ESO's retired `assessments.assessments` and `narrative.supportingSignsAndSymptoms` forms, the unit
capability / level of care (ESO sets them from the unit) and the protocol age category (from the
patient's age) are in `CATALOG_SKIP`: ESO refused each on its own (recorded 2026-09-20). A fill
that ESO refuses (400) is bisected (`saveOpsIsolating`), the refused ops named to the medic.

## Data that may leave the device

Only the open settings go to the table (`supabase/esosave_users.sql`); which runs a login may see
is decided on the tablet from each run's crew list. Recorded runs, signature images, field definitions, the emailed
map and the Not sent list never do. The Supabase Management token lives in `.env.local`
(gitignored) and is never committed; the anon key in `content.js` is public by design.

## Attachments and the scanner

ESO's attachment upload is one multipart POST (`description`, `file`) to
`PatientCareRecords/{id}/Attachments`, delete is `DELETE …/Attachments/{itemId}`; both were
recorded from the app. Desktop uploads stay ESO's own: the extension only sets the description.
iPad scans are uploaded by the extension with that same request. The Patient and Billing pages are
filled with the app's own autosave ops (recorded), never through the UI. Facesheet photos and
recordings are PHI: they live in the scratchpad only, never in the repo. The parser's fixtures in
`test/e2e.test.mjs` are made up.

## Validation outlines

`validateRun` (inject.js) GETs ESO's own `/PatientCareRecords/{id}/Validate?lrIsLinked=false`
after each tab load and each acked save (and takes the answer when ESO's summary fetches it).
`applyValidation` reads each `eso-field`'s ref through AngularJS's model controller
(`angular.element(el).controller('ngModel').$viewModel.fieldConfig()`, the way ESO's own
"take me there" matches a field), falling back to the `ng-model` path's tail, and sets
`esosave-val-err` / `esosave-val-warn` plus a `title`. Row issues (`ids` set) are skipped.
Open setting `valHighlight`, on by default. The mock fakes `window.angular` for its fields.

