# ESO Save

A browser extension for the ESO EHR web app (www.esosuite.net) that makes sure a run is never lost
to bad signal or a hung page.

- **Every change is kept on the device** the moment ESO's app tries to save it, and stays there until
  ESO's server confirms it.
- **No signal? Keep charting.** Saves that cannot reach ESO are held, the app is told "saved", and a
  card in the corner of the page turns amber and says so. Every tab's data is fetched quietly the
  moment a run opens, and each tab is clicked through once while the medic is idle so its code is
  loaded too, so switching to a tab you never opened still works. Even starting a new run
  works; ESO assigns the incident number when signal returns.
- **Signal back? Everything pushes itself**, in the original order, and the card turns green only when
  ESO has really accepted every change. Signatures are just data in those saves, so they go too.
- **Reloaded page, hung run, ruined run?** Open the run list on the card and push a whole recorded run
  back into the run that is open, or into a brand-new run, with one tap.
- **Always loud.** Logged out, a change ESO rejected, a run that has been held for a while: the card
  turns red or amber and stays that way until it is resolved. There is a per-run log of everything
  that was sent and when.
- **Signature images as a backup.** Every signature pad is snapshotted as a PNG when the pen lifts,
  in case one never makes it into ESO.
- **Call times in the top bar.** Dispatched, en route, on scene, at patient, depart scene, at
  destination and transfer of patient sit in the empty part of ESO's dark top bar as HH:MM, updated
  the moment a time is entered, so nobody has to leave the page to work out when something happened.
  Can be turned off in Settings.
- **Fax or email at lock.** The moment a run is locked, the extension asks ESO whether the run's
  destination has a fax number or an email address and whether a fax has already gone (ESO's own
  fax history). If there is somewhere to send it and it has not been sent, a prompt offers Send fax
  or Send email right there in the run, and sends through ESO's own call. With no signal the send is
  held with the run and goes when signal returns. Unlock and relock asks again until it has gone.
- **Validation outlines.** Every field on the open tab that ESO's own validation summary names is
  outlined, red for an error and amber for a warning, with the reason on it (hover or hold). ESO
  is asked again after each tab load and each save, so a field clears the moment it is filled and
  comes back if it is emptied; opening ESO's summary refreshes it too. An issue on one row of a
  list (one treatment's provider) is left to ESO's summary, which names the row. Each person's
  own setting, on to start, off if the outlines get in the way.
- **Not sent list.** Agency-wide, on any device: locked runs from the last 15 days that have a fax or
  email destination and no fax in ESO's history, with Fax and Email buttons. The card's words carry
  the count; the list itself is in the opened card, folded until tapped, not a button on the card's front.
  Emails leave no history in ESO, so a run emailed from a device without the extension still shows.
  Both are settings, on by default.
- **Quick buttons.** One-tap chips for the common history items and home medications (each list
  ends with None Reported) and NKDA for allergies sit beside Add History, Add Medications and Add
  Allergies on the Patient tab; each tap opens ESO's own list, ticks the row and presses OK, the way
  a finger would (taps that land while a list is being worked ride the next open). A second tap on
  a chip that is in opens the same list, unticks it and presses OK, so it comes back out. They hide while
  any ESO picker is open, and every button scrolls under
  ESO's top bar and tab strip with the page. A Race row (every race, shortened) sits under the Race label. Every button also
  hides while ESO draws anything over its field (a dialog, attachments, the camera, a print
  sheet, the patient popover). On the Incident tab, one "All: None/No Delay" button above the delay fields
  presses ESO's own None button on every delay still empty, leaving any already answered alone. On
  the Narrative tab, chips after each transport field (moved to stretcher, to and from the
  ambulance, position during transport) pick in ESO's list the same way. Facility chips under the
  Scene and Destination locations start as the agency's standard set (short labels, ids from ESO's
  saved facilities) and can be added to or trimmed per device in Settings, which searches the
  facilities ESO's configuration bundle carries; a tap selects Predefined, sets the type to match
  and picks the name. Each chip keeps the kind of place ESO says it is, on the Scene side (location
  type) and on the Destination side (destination type), so a nursing home sets Nursing Home and a
  rehab sets Rehabilitation Center, never Hospital by default; ESO's type tables are kept on the
  device from the last bundle seen, and Settings shows the type beside each chip. On the Assessments tab, "All normal" on each assessment opens ESO's own Quick Ax,
  presses No Abnormalities on every category still unset and presses OK; "A&Ox4" opens Mental Status
  and presses Alert and Oriented x4. On the Incident tab, Transported ALS / BLS, Refusal, Canceled
  (Prior) and Canceled (Scene) set the whole disposition set through ESO's pickers (Closest
  Facility, Diversion, Family Choice, Patient's Choice and Protocol chips sit under Transport Due
  To), then outline
  Transport Mode or Reason for Refusal in red until answered; choosing Emergent or Non-Emergent for
  the response or transport mode fills the lights/sirens, intersection, scheduled, speed and method
  fields still empty and sets EMD Performed to No. Rows for Run Type, Mutual Aid, EMD Complaint
  and Requested By sit under their labels; Mechanism of Injury chips on the Narrative tab. Every
  row sits under the label of the field it fills, and carries only what ESO's own quick-picks do
  not already offer (where ESO shows its own buttons and Other, the row has no Other… of its own).
  Mutual Aid stays hidden until the run type is mutual aid, as in ESO. Also on the Narrative tab: the ten
  most common impressions above Primary and Secondary Impression, ALS Paramedic / BLS above Local
  Protocol Provided Care Level, Psych / Neuro / GI / Immune / Reproductive / Pulmonary / Renal above
  Chief Complaint System (ESO shows the other three itself), Minutes / Hours / Days above the complaint duration's unit, and every anatomic location (abbreviated) above Anatomic
  Location. Every row ends with "Other…", which simply opens ESO's own list (a row that already
  holds every choice has no need of one). Every pick takes its row straight from the open list;
  only a list too long to show it all gets the name typed into its search box first, and the
  overlay only appears when a pick takes longer than a blink.   Inside ESO's Patient Refusal Form (Signatures tab) chips sit by its own lists: 18+ / Guardian
  under Legal, Clear / Drug-Alcohol / Threat under Decision-Making, Cleared under Medical, Check
  All under the patient notifications and all four Patient Refusals; they show while the form is
  open and hide while one of its pickers is up. Red, yellow and green buttons next to Initial and Final Patient Acuity pick the
  colour in ESO's list. Nothing is written behind the app's back: the buttons do what a finger would
  in ESO's pickers, so the screen and the save are ESO's. Each group is a setting, on by default.
- **Settings follow the ESO login.** The extension reads who is signed in to ESO from the app's own
  responses and shows the name on the card. The crew's settings (the quick-button switches and the
  facility chips) live in one agency table, one row per login, written when the login is first
  seen and whenever they change something; a tablet they have never used gets their row, a login
  the table has never seen starts from the agency defaults. The settings above the quick buttons
  (retention, tab warm-up, call times, fax prompt, Not sent list) are set in the code and shown
  locked. A run recorded on a tablet is its crew's: the Runs panel lists a run for any login on its
  personnel list (the login's agency person id against the crew's), so a partner added to the run
  sees it too and nobody else does; held changes still push whoever is signed in. Only those
  settings go to the table (`supabase/esosave_users.sql`), never a run nor which runs were
  worked; with no signal the tablet's copy stands and the row is written when signal returns.
- **Crew roles.** On the Incident tab every role (Lead Scene, Lead Trans, Drv Resp, Drv Trans,
  Other Scene, Other Trans, Other) sits above each crew member. A tap does what a finger would:
  opens the member, opens Roles, ticks the role, OK, OK. A second tap takes the role back out.
- **Before a lock.** ESO's Lock Record press is caught and a question shown first: "Have you
  attached the proper paperwork for this run, or acknowledge it's not required?" Yes lets the
  same press through to ESO; No leaves the run open. A locked setting.
- **CAD import gate.** The Import press in ESO's CAD Import dialog is caught first. The chosen
  incident number is looked up in the agency's call log, its crew usernames mapped to names
  through the agency's users, and only a run that lists the signed-in ESO login goes through;
  otherwise: "You are not associated with this run, please choose another or inform dispatch."
  A run the call log does not have yet asks before importing. A locked setting.
- **Unit level from the crew.** Unit Capability and Unit's Level of Care follow the crew on the run
  and their certifications in ESO (the agency's people in ESO's own configuration bundle): a
  paramedic on the crew makes the unit ALS, whatever they run it as; otherwise BLS. A unit named
  NT… is non-transport. Set once the unit is known (the CAD import brings it), once per crew and
  unit, again when either changes. Under the CAD gate's setting.
- **Agency settings.** The locked block (retention, tab warm-up, call times, fax prompt, Not sent
  list, the lock question, the CAD gate) is one agency row in the table, read by every tablet,
  and only the agency owner's ESO login can change it.
- **Loaded mileage.** Once the scene and the destination both have an address (a predefined
  place, or a typed street, city, state and zip), ESO's own Calculate Mileage button is pressed
  once for the crew, and again only if an address changes. A complaint ESO raises about it is
  closed; nothing else is touched. A setting, on by default. Every quick button also hides while
  one of ESO's dialogs (CAD import, a confirmation) is up.
- **Paperwork scanner.** Pressing Camera or Add Attachment in ESO's Attachments dialog first asks
  what the paperwork is: Facesheet, Physician Certification, Med List, Monitor Printout or Other.
  The answer becomes the attachment's description, `260918-021:Facesheet`, so the billing office
  can tell them apart. A run keeps one Facesheet and one Physician Certification: a second one asks
  whether to replace the first (the old one is deleted through ESO's own call) or keep both. On a
  desktop, ESO's own camera or file dialog then runs exactly as before, only the description is
  filled in. On an iPad carrying the ESO Save app, Camera hops to the app's document scanner
  (VisionKit: the page is found, straightened and cropped; several pages for a med list or a
  printout), the app then shows one button, Attach to ESO, which opens the run in Safari (a
  fresh tab; the extension closes the one the scan left from), and the pages upload themselves
  with the same request ESO's dialog sends, named `…Photo1.jpg`, `…Photo2.jpg` as ESO names them.
  A scan is claimed by one tab before it is used, so it can never attach twice. A facesheet
  (scanned, or a picture uploaded on the iPad) is read by the iPad's own text recognition and the
  crew shown what was found, name, sex and gender (the same unless the sheet names a gender of
  its own), DOB, race, ethnicity, address and phones, before anything is written; "Fill the
  Patient page" writes them with the same saves ESO's app makes (the address is looked up in
  ESO's places table first, so the county comes too). Nothing else: the insurance, the insured
  and the Billing page are the billing office's.
  A masked SSN and anything not on ESO's lists is left blank and named, and "Show the text that
  was read" shows what the text recognition produced. A setting, on by
  default; off, ESO's camera and Add Attachment work untouched. On a desktop the facesheet is
  attached and named but not read (no text recognition there).
- **Templates.** A Templates button on the card. Anyone can make their own fill-ins from ESO's own
  field list (the configuration bundle names every field on every tab, its type and its pick
  list): the editor is a mock chart, laid out as close to ESO's own as it can be. Tick a
  field, give it a value (a short list is a row of quick-pick buttons like ESO's own, a long one
  a search-and-scroll picker, a tick list for multi-picks, a date or time picker, yes/no, text;
  every list that has a None puts it first, one tap), a field that ESO only shows once another
  is answered (Mutual Aid agency, Transport Mode, the injury details, the refusal reasons) is
  shown and filled the same way, only once that answer is picked; and add items too: a vital
  laid out as ESO's vitals card (Blood Pressure, Pulse, Respirations, SpO2, GCS with its total
  worked out, and the rest), a treatment (its measure and route quick picks narrow to the
  treatment), an assessment laid out as ESO's own Assessments screen, from ESO's own layout
  code (the categories down the side; each category's sections, Head, Face, Eyes and Neck under
  HEENT say; each section's locations, each eye, each lung field, each side of each spinal
  level, each finger and toe, with only the findings ESO offers there, each a check or an X, a
  pupil size, a pulse or a capillary refill picked one at a time; No Abnormalities and Not
  Assessed per section written where ESO writes them; the category's comments; everything
  starts No Abnormalities on the areas ESO seeds, one button does all of it, one does Alert and
  Oriented x4; ESO's retired one-field-per-finding assessment form, still in its field list, is
  never offered; the same for what ESO sets itself, the unit's capability and level of care and
  the protocol age category, and its retired signs form), ESO's unable-to-obtain reasons named
  after what each stands in for (Last Known Well · UTO), a history entry,
  an allergy, a home
  medication, a sign or symptom, a protocol. What is the call's own (incident number, unit,
  vehicle, shift, crew, times, the addresses, the patient's name, DOB and SSN, signatures) is
  never offered. Templates are kept in the agency's table under the person's ESO id (so a name
  change loses nothing), private, or shared with everyone or with named people; the list shows
  My templates, Templates shared with you and Templates shared to everyone, each with who
  shared it. Any template, your own or one shared with you, can be copied: the copy is a new
  private one of your own, named "(copy)", "(copy 2)"..., to change and share as you like, so a
  call that differs only a little from a saved one starts from that one; only a template's maker
  can change or delete it. A name is used once per shared category across the agency (one "Refusal" shared to
  everyone and one shared with named people may both exist, two shared to everyone may not) and
  once among a person's own private ones; the editor says so and asks for a change, "Refusal2"
  say, and the table's own unique indexes hold the line. The agency owner can lock any field, any
  kind of item (vitals as a whole) or a part of one (blood pressure, the skin of an assessment) from any template's editor
  (Lock fields): the crew sees the lock, cannot set it, and a fill leaves it out, so a template
  can never make up what the crew must measure themselves. A narrative can be prewritten per
  call type with blanks (____) to fill on the run; {incident}, {unit}, {date} and {time} are
  filled in from the run. Filling needs an open, unlocked
  run: a question first, then a progress bar as each tab is written with the same saves ESO's
  app makes, replacing what is there; with no signal it is held like any save and pushed
  later. Should ESO refuse a tab's batch (HTTP 400), the batch is split until the refused
  fields stand alone: they are left out and named to the medic with ESO's own reason (and
  written to the run's log with ESO's full reply), and everything else still goes in. The list seen last is kept on the device, so it works with no signal.
- **Copy a vital.** A small copy button floats just left of each saved vital's time in the Vitals
  tab; tapping it re-enters that vital as a new one with the current time, every other value the
  same. Only fields the app itself has been seen saving are copied, and the run log names any that
  were not. Settings lists the groups a vital is made of (blood pressure, pulse, respirations,
  SpO2/EtCO2/CO, glucose and temperature, pain, AVPU, side and posture, GCS, trauma score, ECG):
  untick one and the copy leaves it out, for things that change every time.
- **Not sent list.** Folded in the panel until tapped.

Nothing is invented. The extension only replays what ESO's own app tried to send.

Every quick button sits in a host of the extension's own inside ESO's scrolling container, so it
rides with the page natively (no script moves it during a scroll) and the container's own edge
takes it under the banner. Only buttons over ESO's fixed panels (the refusal form) live in the
fixed overlay.

## How it works

ESO's web app talks to its server with a small set of calls, recorded from a real run:

| Call | Meaning |
| --- | --- |
| `POST /ehr/api/PatientCareRecords` | start a run; returns the record id |
| `POST /ehr/api/PatientCareRecords/{id}/autosave?scope=incident` | save a batch of field edits for one tab (every ~10 s) |
| `GET  /ehr/api/PatientCareRecords/{id}/Views/Vitals` | load a tab; carries the run state (`draft` or locked) |
| `POST /ehr/api/PatientCareRecords/{id}/lock` | lock (`unlock` likewise); body `{lockDateTime}` |
| `GET  /ehr/api/PatientCareRecords/{id}/Fax/CanSend` | `{ok, destinationName, error}`; `Email/canSend` likewise |
| `POST /ehr/api/PatientCareRecords/{id}/Fax/Send` | body `{sendDateTime}`; `Email/Send` likewise |
| `POST /ehr/api/FaxHistory/Search` | `{incidentStartDate, incidentEndDate}` → every fax sent, agency-wide |
| `POST /ehr/api/PatientCareRecords/Search` | the records feed; status filter value 2 = locked |

Each autosave is a list of `EDIT` / `ADD` / `DELETE` operations with a field address and value. New
list items (a vital, a treatment, a finding, a signed form) get a temporary key from the app and the
server answers with the real key. Signatures are sent as stroke coordinates inside the same batches.

The extension wraps the page's `XMLHttpRequest`. Each autosave is recorded, then sent. If the send
fails with a network error, a gateway error or a timeout, the batch is marked **held**, the app gets
a success response, and the medic keeps working. A probe every few seconds notices when ESO answers
again; held batches are pushed in order, temporary keys are rewritten to the keys ESO assigned, and
the app's later edits keep being rewritten so nothing goes stale.

Restoring into a different run reuses the same machinery: every recorded batch is queued against the
target run, with item keys and crew row ids remapped, then pushed.

Locked runs are detected from the state ESO returns and are cleared from the device after a
configurable number of hours (default 0: cleared as soon as the lock is seen).

## What is verified and what is not

Verified against a mock of ESO's API built from the recording (`npm test`):

- hold / fake-success / push-in-order / key remapping, including edits made offline against
  not-yet-created list items and edits made after signal returns
- a real recorded run (53 batches, 284 field operations, all signature spots) replayed with the
  connection cut produces exactly the same record as the same run online
- offline tab switching from cached views, offline run creation, reload after an outage, login
  expiry, gateway errors, rejected saves, duplicate re-sends, restore into a new run with crew
  remapping, lock detection and purge, signature snapshots
- both injection paths: Chrome's `world: "MAIN"` and the bundled-script fallback Safari uses

Not yet verified on the real ESO, and the first things to watch on a real call:

1. **Email/Send.** Recorded: lock, unlock, fax CanSend and Send, email canSend, fax history and the
   feed. Not recorded: the email Send call itself (no email-capable destination was to hand); it is
   assumed to mirror Fax/Send. If Send email ever fails, the error shown is ESO's own.
2. **How ESO's app reacts to the fake "saved"** for an `ADD` while offline: it keeps its temporary
   key and the extension rewrites it later. The mock is strict about this and it passes; the real
   server should behave the same since it is the same contract.
3. **Session token.** Replays reuse the token ESO's app sends with every request. After a fresh
   login the extension waits until it sees the app make one request before pushing.
4. **Signature pad snapshots** find the label by looking near the canvas. On ESO the label text may
   need tuning; the image is captured regardless.

Known limit: ESO's app batches edits for about ten seconds before saving. If the page is reloaded
inside that window, those ten seconds of typing were never handed to the extension. The signature
snapshot covers the signature; other fields in that window are lost, same as today.

## Install

### Chrome / Edge (station computers, Chromebooks)

1. `npm install && npm run build`
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick `dist/chrome`.
3. For managed devices, IT can push the same folder (zipped) through the `ExtensionInstallForcelist`
   policy without the Web Store.

### Safari on iPad (no Mac needed)

Safari only loads extensions that arrive inside an iOS app, so the repo carries a tiny Expo app in
`ios-app/` whose only job is to hold the extension. Expo's cloud build service (EAS) generates the
Xcode project and builds it on Apple hardware, the same way your other Expo app is built.

One-time setup:

1. Put your Apple Team ID in `ios-app/app.json` under `ios.appleTeamId` (it is on
   developer.apple.com under Membership). Change `ios.bundleIdentifier` if you want a different one;
   it must not collide with your other app.
2. In `ios-app/`: `npm install`, then `npx eas-cli login` and `npx eas-cli init` to link the project
   to your Expo account.

Every release:

```
npm run build                       # in the repo root: refreshes ios-app/targets/esosave/assets
cd ios-app
npx eas-cli build --platform ios --profile production
npx eas-cli submit --platform ios --latest
```

Then add the build to TestFlight testers in App Store Connect like any other build. On each iPad,
one time: Settings › Apps › Safari › Extensions › ESO Save › on, and allow it for esosuite.net. The
app's only screen repeats those steps and has an Open Settings button.

Notes:

- `ios-app/targets/esosave/assets` is the Safari build of the extension (a non-persistent background
  page instead of a service worker, otherwise identical). It is generated by `npm run build`, and EAS
  regenerates it itself after installing dependencies, so it is not committed.
- `npx expo prebuild -p ios --no-install` inside `ios-app/` regenerates the Xcode project locally
  and is a quick check that the target still resolves; it runs on Windows and Linux too.
- Safari ignores the `world: "MAIN"` manifest entry; the extension detects that and loads the same
  script from its bundle instead (tested).
- Use the Safari app itself, not a home-screen shortcut: extensions do not run in home-screen web apps.

The app also carries the paperwork scanner. It needs the camera (asked once) and the
`group.com.ruralmedems.esosave` App Group, which the EAS build sets up from `app.json` and
`targets/esosave/expo-target.config.js`: the app writes each scan into that shared container and
the extension's native handler (`SafariWebExtensionHandler.swift`) hands it, with the text read
off a facesheet by Vision, to the extension through native messaging.

## Using it

- The card in the bottom-left corner of every ESO page shows the state: green (signal OK, everything saved),
  amber (no signal, or changes held), blue (pushing), red (logged out or ESO rejected a change). The
  "–" collapses it to just the logo with a coloured ring (and a count of held changes); tap the logo
  to expand. It stays collapsed through amber (no signal, changes held) and only expands by itself
  when it turns red.
- Tap the card or **Runs** to open the panel: every run recorded on the device, how many saves are
  held, the log, signature images, and the restore buttons:
  - **Push into the open run** / **Push into a NEW run** — first pick which pages to copy (Incident
    and Narrative are on by default; Toggle all for a full recovery). Turning on Patient or
    Signatures shows a warning: those overwrite the target run's patient details and signatures,
    so only for the same patient. A new run is opened from the records list when it finishes.
  - **Export backup** — a JSON file with every recorded save and signature image.
  - **Clear** — remove the run from the device.
- The toolbar icon shows the number of held changes and offers export/clear when ESO is not open.

## Privacy

Everything recorded is protected health information and stays in the extension's local storage on
that device only. Templates carry no patient: they are the crew member's own fill-ins and go to
the agency's table (`esosave_templates`, `esosave_template_shares`) under their ESO id. It is never sent anywhere but ESO. Locked runs are purged automatically as soon as the lock is seen; a
retention window can be set in Settings. Exports are plain JSON files: treat them like a printed chart.

## Development

```
npm install
npm run build              # dist/chrome, dist/safari (copied into ios-app), dist/test, dist/test-inline
npm test                   # end-to-end suite against the mock ESO (headless Chromium + extension)
npm run test:inline        # same suite through the Safari-style injection path
ESOSAVE_RECORDING=path/to/recording.json npm run test:recording   # replay a real recording (kept out of the repo)
npm run mock               # run the mock ESO by hand at http://127.0.0.1:PORT/ehr/
```

Layout:

- `extension/inject.js` — page-world interceptor: recording, holding, pushing, remapping, restore
- `extension/content.js` — storage, the bar and the panel
- `extension/background.js` — toolbar badge, scheduled purge
- `test/mock-eso/` — mock of ESO's API and a fake app that saves exactly like the real one
- `test/e2e.test.mjs` — scenarios; `test/recording.test.mjs` — real-recording replay
- `ios-app/` — Expo wrapper that carries the extension onto iPads through EAS Build and TestFlight.
  (A Bluetooth "monitor test" screen was tried and removed: the LIFEPAK 15 uses classic Bluetooth,
  which iPad apps cannot open without the maker's MFi approval, and its data format is Stryker's own.
  Monitor data reaches ESO through LIFENET and the Monitor Import button, not through a device link.)
- `scripts/make-icons.mjs` — regenerates every icon size and the iOS icon from one square logo image
