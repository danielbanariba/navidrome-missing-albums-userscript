# Navidrome — Show Missing Albums (MusicBrainz)

A userscript for [Navidrome](https://www.navidrome.org/) that overlays greyed-out
placeholder tiles for studio albums missing from your library, sourced from
[MusicBrainz](https://musicbrainz.org/) and [Cover Art Archive](https://coverartarchive.org/),
and badges the albums you *do* have that are still sitting in a lossy format.

![Demo screenshot](https://github.com/user-attachments/assets/13dddc52-63cc-4ca0-a558-d99642812572)

## Why

Navidrome shows the albums you have. This userscript adds the albums you *don't* have
yet — so when an artist drops something new, or you discover an old release you
missed, it shows up greyed out on the artist page next to everything else.

It runs entirely client-side. No Navidrome modification, no server plugin, no
account needed beyond your existing Navidrome login.

## Status

This is a stop-gap until [Navidrome's plugin system](https://github.com/navidrome/navidrome/tree/master/plugins)
exposes the missing capability for a proper server-side implementation
(tracked in [navidrome/navidrome#5106](https://github.com/navidrome/navidrome/issues/5106)).

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or Greasemonkey, Violentmonkey).
2. Click the install link:
   - **[Install from raw GitHub](https://raw.githubusercontent.com/danielbanariba/navidrome-missing-albums-userscript/main/navidrome-missing-albums.user.js)**
   - Or via [Greasy Fork](https://greasyfork.org/) once published.
3. Open your Navidrome instance and go to any artist page. Greyed-out tiles for
   missing studio albums appear inline with your existing albums, sorted by year.

The script auto-detects whether the page is Navidrome (looks for a `token` in
localStorage and a Navidrome-shaped hash route), so the broad `@match *://*/*`
won't trip on unrelated sites.

## Behaviour

- **Studio albums only.** Filters out compilations, live albums, remixes,
  soundtracks, DJ-mixes, mixtapes, demos, interviews, audiobooks, audio dramas,
  and spokenword. Tweak `EXCLUDED_SECONDARY` in the script to taste.
- **Rate-limit respectful.** MusicBrainz API enforces 1 req/sec; the script
  waits 1.1s between calls and caches everything in `localStorage` for 7 days.
- **Cover art.** Fetched from the Cover Art Archive at the release-group level.
  CAA redirects to archive.org, whose download layer intermittently answers
  `5xx` or drops the connection, so a failed load is retried up to
  `COVER_RETRIES` times with exponential backoff and jitter before the
  music-note placeholder is shown.
- **Non-interactive tiles.** Greyed tiles can't be clicked or played — they're
  visual-only with a "Not in library" badge.
- **Year-sorted insert.** Missing tiles slot into the existing chronological
  grid order.
- **Quality badges.** A cover whose files are lossy gets a small `MP3 192`
  badge. Lossless copies get nothing: telling somebody their 24-bit file could
  be improved would be noise, and untrue.
- **One status line.** The count sits below the grid and is always present.
  Three notices used to take turns above it — searching, the count, "you have
  every studio album" — and each arrival and departure pushed every cover on the
  page down and back up.

## Configuration

The script ships with sensible defaults. To change behaviour, edit these
constants at the top:

```js
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const EXCLUDED_SECONDARY = new Set([...]);  // release-group secondary types to skip
const COVER_RETRIES = 3;                    // cover-art retries before placeholder
const COVER_RETRY_BASE_MS = 800;            // first backoff, doubles each retry
const COVER_RETRY_JITTER_MS = 400;          // random spread, avoids lockstep retries
```

## A better discography when the bridge is present

Searching MusicBrainz by artist name is the weak link in this script. Ten
artists are called "Delirium" and the search returns an Italian prog band first;
the discography drawn for a Honduran metal band was somebody else's entirely.

[navidrome-lidarr-bridge][bridge] can answer that better, because it can see the
library: unrelated bands sharing a name do not share a back catalogue, so the
candidate whose catalogue contains the albums already owned is the right one. It
also widens the result with Discogs, which lists releases MusicBrainz has never
heard of — three of them for that same band.

So when the bridge answers, its `/missing` is used instead of the MusicBrainz
path here. When it does not, nothing changes: the script resolves names on its
own exactly as before, which is what happens for anyone not running a bridge.

A release only Discogs knows is shown greyed like the rest but badged **Not on
MusicBrainz** and given no request button — Lidarr has no id to fetch it with.
Naming a record you did not know existed is still worth doing.

Cover art follows the same order. Cover Art Archive only holds what somebody
uploaded, so an obscure pressing often answers 404 no matter how many times it
is retried. The bridge sends a Discogs thumbnail alongside each entry, used when
the Archive has nothing and for releases that have no MusicBrainz id at all. On
the artist that prompted this, that is the difference between four covers and
seven.

[bridge]: https://github.com/danielbanariba/navidrome-lidarr-bridge

## Requesting a missing album (optional)

Paired with [navidrome-lidarr-bridge][bridge], each placeholder gets a
**Request** button over its cover that asks Lidarr to monitor the album and go
looking for it.

The bridge is probed once per page. When it does not answer — which is the case
for anyone not running it — no button is drawn and the tiles behave exactly as
before. Nothing else changes.

Both sides key on the MusicBrainz release-group id these tiles already carry:
Lidarr stores it as `foreignAlbumId`, so no title matching is involved in the
request itself.

The bridge is reached at `http://<host>:8687` when the page is Navidrome's own
port, and at a same-origin `/ndlb` prefix otherwise. That second case is not a
preference: once a reverse proxy terminates TLS, a page served over HTTPS cannot
call plain `http://host:8687` at all, because the browser blocks it as mixed
content. Set `window.__NDLB_BASE` to override.

A `404` on the button means Lidarr has not imported that artist yet, which the
button reports as *Monitor artist first* rather than a generic failure.

### Asking for a better copy of something you already have

The bridge also reports what the library *holds*, so a badged cover gets a
**Try for lossless** button of its own. Nothing is promised by pressing it: if a
better release turns up Lidarr replaces the file, and if it does not, the copy
already there is untouched.

Whether that button appears is a question of catalogue, not of quality. Lidarr
needs an id to act on, and a demo or a live set its metadata profile excludes
has none — so the badge still goes on, because knowing a record is MP3 is worth
saying even when nothing can be done about it, and the button does not.

Tiles are paired with the bridge's answer by Navidrome album id before falling
back to titles. An id is not a spelling: MusicBrainz files Ultra Vomit's 1999
demo as `Ultra Vomit` while the folder on disk is called `Demo`, and no amount
of normalising makes those two strings meet.

### What was requested is remembered by Lidarr, not by the browser

An album already asked for shows *Requested* instead of a button. That fact is
read from Lidarr's own `monitored` flag rather than kept in `localStorage`,
so it survives a cleared browser and reads the same on every device — which a
note kept in one browser's storage does not.

[bridge]: https://github.com/danielbanariba/navidrome-lidarr-bridge

## Limitations

- **MusicBrainz coverage.** Works best for artists with complete MusicBrainz
  release-group data. Lesser-known artists may have gaps.
- **Name matching.** Match is by normalized title — lowercased, accents folded,
  parens stripped, punctuation removed, and the common abbreviations collapsed
  (`M.`/`Mr`, `St.`/`Saint`, `&`/`and`), so `Mr Patate` and `M. Patate` are one
  record. Heavily-renamed releases can still produce false positives; where the
  bridge is present its Navidrome album id is used instead and the question does
  not arise.
- **MUI v4 dependent.** Targets Navidrome's current Material UI v4 grid
  classes. If/when Navidrome migrates to MUI v5+, the DOM selectors need updating.
- **No artist disambiguation UI.** If two artists share a name, the script
  picks the first match with score ≥90 from MusicBrainz. Override by ensuring
  the artist has a `mbzArtistId` set in Navidrome's metadata.

## Cache

Data lives in `localStorage` under the key `nd-missing-albums-cache`. To
force a refresh, clear that key (DevTools → Application → Local Storage),
or wait 7 days for natural expiry.

## Privacy

The script makes requests to:
- Your Navidrome instance (already authenticated via your normal session)
- `https://musicbrainz.org/ws/2/` (anonymous, public API)
- `https://coverartarchive.org/release-group/<mbid>/front-250` (anonymous,
  public)

No data leaves your browser apart from the MusicBrainz queries listed above.

## Contributing

Issues and pull requests welcome. Run the script against a real Navidrome
instance — there's no automated test suite.

## License

MIT — see [LICENSE](LICENSE).

## See also

- [Navidrome](https://www.navidrome.org/) — the music server this targets
- [navidrome/navidrome#5106](https://github.com/navidrome/navidrome/issues/5106) — the upstream feature request this works around
- [MusicBrainz](https://musicbrainz.org/) — the data source
- [Cover Art Archive](https://coverartarchive.org/) — the cover-art source
