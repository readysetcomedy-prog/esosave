# ESO Save

A browser extension for the ESO EHR web app (www.esosuite.net) that makes sure a run is never lost
to bad signal or a hung page.

- **Every change is kept on the device** the moment ESO's app tries to save it, and stays there until
  ESO's server confirms it.
- **No signal? Keep charting.** Saves that cannot reach ESO are held, the app is told "saved", and a
  bar at the bottom of the page turns amber and says so. Switching tabs keeps working from the last
  copy of each tab. Even starting a new run works; ESO assigns the incident number when signal returns.
- **Signal back? Everything pushes itself**, in the original order, and the bar turns green only when
  ESO has really accepted every change. Signatures are just data in those saves, so they go too.
- **Reloaded page, hung run, ruined run?** Open the run list in the bar and push a whole recorded run
  back into the run that is open, or into a brand-new run, with one tap.
- **Always loud.** Logged out, a change ESO rejected, a run that has been held for a while: the bar
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

### Safari on iPad and Mac

Safari runs the same code, packaged as an app with Xcode:

1. On a Mac with Xcode installed, run
   `xcrun safari-web-extension-converter dist/chrome --app-name "ESO Save" --bundle-identifier com.YOURAGENCY.esosave --macos-only false`
2. Open the generated project in Xcode, set the team (Apple Developer account, $99/yr), build for
   iOS.
3. Put it on the iPads with **TestFlight** (fastest, up to 10,000 devices) or through Apple
   Business Manager if IT manages the iPads.
4. On each iPad: Settings › Safari › Extensions › ESO Save › on, and allow it for esosuite.net.

Safari ignores the `world: "MAIN"` manifest entry; the extension detects that and loads the same
script from its bundle instead (tested).

## Using it

- The card in the bottom-left corner of every ESO page shows the state: green (signal OK, everything saved),
  amber (no signal, or changes held), blue (pushing), red (logged out or ESO rejected a change).
- Tap the card or **Runs** to open the panel: every run recorded on the device, how many saves are
  held, the log, signature images, and the restore buttons:
  - **Push into the open run** — replay everything recorded for a run into the run open in ESO now.
  - **Push into a NEW run** — create a fresh run on ESO and replay everything into it. Open it from
    the records list when it finishes.
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
npm run build              # dist/chrome, dist/test, dist/test-inline
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
