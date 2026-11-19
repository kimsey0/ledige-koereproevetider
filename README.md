# Ledige køreprøvetider

A browser add-on that adds a panel to MinKøreprøve's booking app showing free
exam slots across all exam centers at once, with filters for exam type and
area. Clicking a slot opens the site's own page for that center and date,
where booking and payment happen as usual.

Unofficial and not affiliated with Færdselsstyrelsen. It only reads
availability, one request at a time, and never books anything.

- `extension/` is the add-on: a manifest and one content script.
- `build.py` builds the Firefox variant into `dist/`.
- `docs/findings.md` documents the booking API, rate limiting, the site's
  quirks, open questions and deployment options.
- `demo/` holds an offline smoke test and the scripts that recorded the demo
  video.

## Install in Firefox

1. In Firefox, open the file ending in `-signed.xpi` from the
   [latest release](../../releases/latest) and accept the install prompt.
2. Go to https://www.minkøreprøve.dk, click through to booking and log in
   with MitID.
3. Click "Ledige tider på tværs af prøvesteder" in the bottom right corner.

The signed file is signed by Mozilla as a self-distributed add-on, so it
stays installed and updates itself when a newer version is released here. It
is not listed on addons.mozilla.org.

## Install in Chrome, Edge or Brave

1. Download this repository and open `chrome://extensions`.
2. Switch on developer mode, choose "Load unpacked" and pick the `extension`
   folder.
3. Continue from step 2 above.

There are no automatic updates this way.

## If something does not work

The add-on keeps a technical log. To send it:

1. Open the panel and click "Fejlsøgning" at the bottom.
2. Click "Gem som fil" or "Kopiér log".

The log lists which calls were made to MinKøreprøve and how they went, the
site's own calls (paths only), page navigations and errors. It contains
internal IDs and exam center names, but no personal names, CPR numbers, email
addresses or login tokens. It lives in the browser tab only and is never sent
anywhere by the add-on.

If the button in the corner does not show up at all, there is no log to
open. Then check `about:debugging` for errors next to the add-on, and the
browser console (Ctrl+Shift+J, or Cmd+Shift+J on a Mac).

### A useful test run for a driving instructor

1. Log in and pick a student in "Elevoverblik", so the site shows "Vælg
   område" for that student.
2. Open the panel and let the search finish.
3. Click one of the times and check that the site shows that center and date.
4. Open the panel again and click a time at another center.
5. Open "Fejlsøgning" and save the log.

Do not reload the page along the way: the site then logs in again and drops
the selected student.

## Development

```
python build.py          # builds dist/firefox and the .xpi
cd demo && npm install
node smoke.mjs           # offline test against a stubbed site and API
```

To try an unsigned build in Firefox, open
`about:debugging#/runtime/this-firefox`, click "Load Temporary Add-on…" and
pick the `.xpi` from `dist/`. A temporary add-on disappears when Firefox is
closed.

## Releasing a Firefox version

Signed versions update themselves: the add-on's manifest points at
`updates.json` in this repository, and Firefox installs any newer version
listed there.

1. Set the new version in `extension/manifest.json` and in `VERSION` in
   `extension/content.js`.
2. Add an entry for it to `updates.json`, with the link the signed file will
   have: `…/releases/download/v<version>/ledige-tider-firefox-<version>-signed.xpi`.
3. Run `python build.py`, commit, push, and create the GitHub release
   `v<version>` with the unsigned `.xpi`.
4. Submit that `.xpi` at addons.mozilla.org's Developer Hub as an "On your
   own" (self-distributed) version.
5. Download the signed file and add it to the same GitHub release under the
   name from step 2:
   `gh release upload v<version> ledige-tider-firefox-<version>-signed.xpi`

Until step 5 is done, Firefox finds the entry but cannot download the file;
it simply tries again later. Give the signed file to new users; the unsigned
one only loads through `about:debugging`.

## Status

Prototype, version 0.2.2.

- Works with one citizen login in Chromium (installed extension) and in
  Firefox (0.2.0 as a temporary add-on).
- 0.2.1 did not work for a driving instructor: it found no exams for the
  selected student. 0.2.2 adds support for booking on behalf of a student,
  built from his debug log and checked offline only. It still needs a run in
  his session.
- Self-updating from 0.2.1 to 0.2.2 will be the first test of the update
  mechanism.
