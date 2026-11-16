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

## Install in Firefox (temporary, for testing)

1. Download `ledige-tider-firefox-<version>.xpi` from the
   [latest release](../../releases/latest).
2. Open `about:debugging#/runtime/this-firefox` in Firefox.
3. Click "Load Temporary Add-on…" ("Indlæs midlertidig tilføjelse…") and pick
   the downloaded file.
4. Go to https://www.minkøreprøve.dk, click through to booking and log in
   with MitID.
5. Click "Ledige tider på tværs af prøvesteder" in the bottom right corner.

A temporary add-on disappears when Firefox is closed; repeat steps 2 and 3
after a restart. A permanent install needs the file signed by Mozilla, which
is a later step.

## Install in Chrome, Edge or Brave

1. Open `chrome://extensions` and switch on developer mode.
2. Choose "Load unpacked" and pick the `extension` folder.
3. Continue from step 4 above.

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

The on-behalf-of flow has not been seen yet, so a log from this run answers
most open questions:

1. Log in, and pick a student in the site's "Vælg person" menu.
2. Open the panel and let the search finish.
3. Click one of the times and check that the site shows that center and date.
4. Pick another student, open the panel again and let the search finish.
5. Open "Fejlsøgning" and save the log.

## Development

```
python build.py          # builds dist/firefox and the .xpi
cd demo && npm install
node smoke.mjs           # offline test against a stubbed site and API
```

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

Prototype, version 0.2.1. Tested as an installed extension in Chromium and
as a temporary add-on in Firefox (0.2.0) with one citizen login. Not yet
tested in a driving instructor's session, and self-updating has not been
exercised yet.
