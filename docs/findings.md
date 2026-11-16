# MinKøreprøve: findings

Investigated 2026-11-16 with one citizen login (MitID, private person, one
exam track: category A practical). Everything here was observed with
read-only GET requests. No booking, payment or cancellation call was made.

## Sites and hosts

| What | Host |
|---|---|
| Information site | `www.minkøreprøve.dk` (`xn--minkreprve-3cbe.dk`), a CMS page that only links onward |
| Booking app ("Borgerbooking") | `onlinebooking.prod.workforce-planner.dk` |
| Booking API | `onlinebooking-api.prod.workforce-planner.dk` |
| MitID gateway | `nemlogin.workforce-planner.dk`, then `nemlog-in.mitid.dk` |

The booking app is a WorkForce Planner product (an Angular single-page app)
configured per customer as a "microsite". Færdselsstyrelsen's microsite ID is
`6a53be98-4705-43e6-be57-72e7218d448b`, and the app lives under
`/microsites/{micrositeId}/…`. `GET /appsettings.json` on the app host returns
the API base URL and the MitID gateway URL.

## Authentication

- Login is MitID through NemLog-in. The gateway returns to
  `/nem-login-gateway/callback-login?parsingObject=…`, and the app then calls
  `POST token` on the API.
- The app stores the result in `localStorage` under
  `online-booking:auth:token`:
  `{ accessToken, refreshToken, expiresAt, tokenType: "bearer", micrositeId,
  isImpersonating, isMitIdCitizenLogin }`.
- API calls carry `Authorization: Bearer {accessToken}`. No other header was
  needed.
- The access token lives about 5 minutes. The app refreshes it on its own
  while the tab is open; the remaining lifetime dropped to 3 minutes and was
  back up later without any action. The refresh call itself was not captured.
- Consequence: a tool has to run inside the logged-in tab and read the token
  from `localStorage` on every request. A server-side tool would need the
  user's MitID session and is not viable.

## Endpoints

All paths are relative to the API host. All are GET.

| Path | Returns |
|---|---|
| `microsites/{micrositeId}` | Microsite configuration |
| `settings/{micrositeId}` | Settings |
| `localization/values?…` | UI texts |
| `auth/user-info` | `{ fullName, isBookOnBehalf, isMitIdProfessional }` |
| `person/associated-persons` | `{ loggedInPerson: { personId, fullName, civilRegistrationIdentifier, signature }, associatedPersons: [], isAnyChildWithoutNameOrCpr, isGuardianServiceUnavailable }` |
| `processes/applicant-processes` | `[{ processId, taskTypeId, taskTypeName }]`, one entry per exam track |
| `processes/{processId}/booking-eligibility` | `{ isReadyForBooking, message }` |
| `process/{processId}/booking-options` | The whole area, center and offer tree in one response (about 60 kB) |
| `appointments/unpaid` | `[]` when nothing is pending |
| `time-slots/task-groups-by-non-anonymous-person/{onlineOfferId}?…` | Free slots for one center |

Note the inconsistent prefix: `processes/…` for eligibility, `process/…` for
booking options.

### Booking options

```
{
  onlineCategories: [{ onlineCategoryId, name, description, subheader,
                       parentOnlineCategoryId, childrenOnlineCategoryIds,
                       onlineOfferIds, icon }],
  onlineOffers:     [{ onlineOfferId, name, address, description,
                       defaultDuration, secondaryDurations, daysInFuture,
                       taskTypeId, isCommon, … }]
}
```

- Categories form a two-level tree: 11 areas, each with its exam centers.
  A center is a category with a non-empty `onlineOfferIds`; its area is
  `parentOnlineCategoryId`.
- For this account there were 58 categories and 47 offers: one offer per
  center, all named "Stor motorcykel (A) - Praktisk prøve", all with
  `defaultDuration: 60` and `daysInFuture: 42`.
- Areas: Bornholm, Fyn, Kronjylland, København Syd, Midtsjælland,
  Nordjylland, Nordsjælland, Syd- og Sønderjylland, Sydsjælland og Lolland
  Falster, Vestjylland, Østjylland.
- Some center names have trailing spaces; trim them.

### Time slots

```
GET time-slots/task-groups-by-non-anonymous-person/{onlineOfferId}
    ?startDateTime=2026-11-16T11:08:43.144Z
    &endDateTime=2026-12-28T11:08:43.144Z
    &durationInMinutes=60
    &findFirstAvailable=false
```

```
{ timeSlots: [{ taskId: null,
                resources: [{ resourceId, name: "", isHardware, email }],
                startTime: "2026-11-18T08:10:00",
                endTime:   "2026-11-18T09:10:00",
                address: null }] }
```

- The app itself asks with `findFirstAvailable=true` and a window of about two
  weeks. With `findFirstAvailable=false` and the full 42-day window, one call
  returns every free slot at that center.
- `startTime` and `endTime` are local time without a zone suffix. The query
  parameters are UTC.
- The same start time can appear more than once, once per examiner. Count
  them to get the number of free seats.
- `resources[].email` is the examiner's work email address. Do not display or
  store it.
- An empty center returns `{ "timeSlots": [] }`.

## Rate limiting

- Four requests in parallel produced HTTP 500 on some of them.
- One request at a time gave 47 of 47 successes, repeatedly.
- A full sequential sweep of 47 centers took 8 to 30 seconds depending on the
  moment.
- No 429 and no rate-limit headers were seen; the limit shows up only as 500.

Keep requests sequential, scan only the areas the user selected, and cache
results for a couple of minutes.

## Navigating to the site's own slot page

The app's slot page for one center and one date is

```
/microsites/{micrositeId}/offers/{onlineOfferId}/time-slots/{YYYY-MM-DD}
```

- Loading that URL directly (full page load) redirects to the start of the
  booking flow.
- Navigating inside the running app works: `history.pushState({}, '', url)`
  followed by `window.dispatchEvent(new PopStateEvent('popstate'))`. The page
  then shows the slots with the site's own "Book" buttons. Verified from the
  prototype panel for Odense on 18 November.
- Not verified: whether this works when the app has not yet loaded booking
  options in that tab, for example straight from "Mine prøver".

## Content security policy

```
default-src 'self'; script-src 'self' https://*.adyen.com …;
style-src 'self' 'unsafe-inline' …;
connect-src 'self' https://*.workforce-planner.dk …
```

- No inline or third-party scripts, so a bookmarklet cannot load code from
  elsewhere and may not run at all.
- Extension content scripts are not subject to the page's policy.
- Inline styles are allowed.
- The app makes its API calls with `XMLHttpRequest`, not `fetch`.

## Current availability snapshot (2026-11-16, category A practical)

10 free slots at 3 of 47 centers in the next 42 days:

- Odense, Havnegade 141: 18 Nov at 08:10, 11:00, 11:10
- Vejle, Grønlandsvej 364: 24 Nov at 08:00, 09:00, 10:00, 11:00, 12:30, 13:30
- Aalborg, Svendborgvej 18: 25 Nov at 09:00

## Not yet known

- **The instructor's flow.** He logs in with MitID Erhverv and books on behalf
  of students who granted him a power of attorney. The app has a "Vælg person"
  picker, `associatedPersons`, `isBookOnBehalf`, `isMitIdProfessional` and an
  `isImpersonating` flag on the token. The likely design is that picking a
  student swaps the token for an impersonating one, in which case the
  prototype works unchanged for whichever student is selected. This needs one
  look at the network calls in his session.
- **Theory exams.** This account has passed theory, so only practical offers
  were returned. Whether a center lists theory and practical as two offers in
  one track, or as separate tracks, is unknown. The prototype handles both.
- **Whether offer IDs are the same for every student** in the same category.
  If they are, one sweep could serve several students.
- **The slot endpoint is per person** ("non-anonymous-person"). Whether the
  slots differ between people is unknown.
- **Booking, payment, rebooking and cancellation calls.** Deliberately not
  exercised.

## Ground rules for a tool

- View only. Hand over to the site's own page for booking and payment.
- No automatic booking and no background polling. This is an undocumented API
  on a government system, and other students compete for the same slots.
- Sequential requests, as above.
- Never show or keep examiner email addresses or CPR numbers.

## Deployment options

| Option | Notes |
|---|---|
| Chrome, Edge or Brave extension | Works with the `extension` folder as is. Load unpacked for testing. An unlisted Chrome Web Store listing costs a one-time $5 fee plus a review, and gives automatic updates. Edge's store is free. |
| Safari extension | Has to be wrapped in a Mac app built with Xcode. Distribution needs the Apple Developer Program at $99 a year and App Store review. |
| Safari with a userscript manager | A single script file, no publishing. Not checked. |
| Bookmarklet | Blocked or crippled by the content security policy. |
| Hosted web app | Not viable; it would need his MitID session on a server. |

Extensions do not run in mobile Chrome, so this assumes a computer.

## Firefox

- The Firefox build uses Manifest V2 (`build.py`). Firefox only runs Manifest
  V3 content scripts after the user grants site access by hand.
- Unsigned add-ons can only be loaded temporarily through
  `about:debugging`; they are gone after a restart. A permanent install needs
  signing at addons.mozilla.org, where an unlisted (self-distributed) add-on
  is free.
- Precautions taken without having been able to test them in Firefox:
  API calls go through `content.fetch`, which makes the request as the page;
  the in-app navigation passes `null` as history state, because the page
  cannot read objects created by an extension.
- Playwright's Firefox build on this machine does not match the installed
  `playwright-core`, so the offline smoke test only runs in Chromium.

## Recording a demo

- The Claude desktop app's built-in browser has no video recording, and its
  screenshots are capped at 800 pixels wide. A video stitched from those was
  rejected as too low resolution and too static.
- Branded Google Chrome no longer accepts `--load-extension` on the command
  line; Playwright's bundled Chromium does.
- The working setup is in `demo/`: `launch.mjs` starts Playwright's Chromium
  with the extension and a debugging port, you log in with MitID by hand,
  and `record.mjs` attaches, drives the demo with real mouse events and
  records the window with ffmpeg (`gdigrab`). MitID login worked in that
  browser.
- Chrome's screencast and device emulation only give 1x pixels in a visible
  window. Real browser zoom does scale: `chrome.settingsPrivate.setDefaultZoom(1.5)`
  on `chrome://settings` turns a 1920x1080 page area into a sharp 1280x720
  layout.
- Reloading an unpacked extension over the debugging port leaves it disabled
  unless developer mode is on; `reload-extension.mjs` re-enables it.
- The site keeps hidden duplicates of some buttons for its mobile layout, so
  automation has to target the visible one.

## Stability of the site

- Going from one center's slot page straight to another's leaves the old page
  on screen. The extension leaves via "Mine prøver" first and waits for that
  navigation to finish.
- Overlapping in-app navigations confuse the app; do one at a time.
- Once, the start page claimed "Du er ikke frigivet til prøve" although the
  API still returned the exam track a moment later. Treat that message as
  possibly transient.
- On 2026-11-16 in the afternoon the booking app answered HTTP 503 ("The
  service is unavailable") for its start page, also from an outside network.
  This followed about an hour of testing from one login (several page loads
  and five or six sequential 47-center sweeps). The cause is unknown; it may
  be unrelated, but be sparing with sweeps.
