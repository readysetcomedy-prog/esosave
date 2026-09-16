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

Nothing is invented. The extension only replays what ESO's own app tried to send.

## How it works

ESO's web app talks to its server with a small set of calls, recorded from a real run:

| Call | Meaning |
| --- | --- |
| `POST /ehr/api/PatientCareRecords` | start a run; returns the record id |
| `POST /ehr/api/PatientCareRecords/{id}/autosave?scope=incident` | save a batch of field edits for one tab (every ~10 s) |
| `GET  /ehr/api/PatientCareRecords/{id}/Views/Vitals` | load a tab; carries the run state (`draft` or locked) |

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

1. **Lock.** The lock call itself was not in the recording (locking would have sent a test run to
   the state). Lock detection relies on the run state ESO returns changing away from `draft`, which
   is what its API exposes on every tab load. If it never shows "locked" in the run list, tell me and
   I'll match the real call.
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

## Using it

- The card in the bottom-left corner of every ESO page shows the state: green (signal OK, everything saved),
  amber (no signal, or changes held), blue (pushing), red (logged out or ESO rejected a change).
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
that device only. It is never sent anywhere but ESO. Locked runs are purged automatically as soon as the lock is seen; a
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
- `ios-app/` — Expo wrapper that carries the extension onto iPads through EAS Build and TestFlight
