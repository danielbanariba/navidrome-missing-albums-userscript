// ==UserScript==
// @name         Navidrome — Show Missing Albums (MusicBrainz)
// @namespace    https://github.com/danielbanariba/navidrome-missing-albums-userscript
// @version      1.10.0
// @description  On an artist page, fetch the full studio discography from MusicBrainz and overlay greyed-out placeholder tiles for albums missing from your Navidrome library. Search MusicBrainz from Navidrome's own search box for bands the library holds nothing by. Optionally request them from Lidarr.
// @author       Daniel Banariba (@danielbanariba)
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// @noframes
// @license      MIT
// @homepageURL  https://github.com/danielbanariba/navidrome-missing-albums-userscript
// @supportURL   https://github.com/danielbanariba/navidrome-missing-albums-userscript/issues
// @icon         https://www.navidrome.org/images/logo.png
// @updateURL    https://raw.githubusercontent.com/danielbanariba/navidrome-missing-albums-userscript/main/navidrome-missing-albums.user.js
// @downloadURL  https://raw.githubusercontent.com/danielbanariba/navidrome-missing-albums-userscript/main/navidrome-missing-albums.user.js
// ==/UserScript==

(function () {
  "use strict";

  // Read from the header rather than repeated by hand, which is how the banner
  // came to announce 1.1.0 from a 1.5.0 script.
  // typeof, not a plain read: an undeclared identifier throws rather than
  // reading as undefined, and this script also runs injected by hand.
  const VERSION =
    (typeof GM_info !== "undefined" && GM_info?.script?.version) || "dev";
  const MB_BASE = "https://musicbrainz.org/ws/2";
  // Each candidate costs one discography request, so a name hundreds of bands
  // share is not worth exhausting; the right one is near the top of the results.
  const MAX_CANDIDATES = 6;

  // There is no upper bound on a MusicBrainz artist. "Various Artists" reports
  // 257,821 release groups with &type=album, and the paging loop below had no
  // cap: at the 1.1s the rate limiter puts between calls that is a 47-minute
  // walk holding every other MusicBrainz lookup in the tab behind it, ending in
  // a quarter of a million tiles and a JSON.stringify into a 5 MB quota. Five
  // pages is past any real discography and bounds the worst case at seconds.
  const MAX_RG_PAGES = 5;
  // What the panel will draw. The cap above bounds this for anything fetched
  // now; this bounds a list that came back from a cache written before it.
  const MAX_SEARCH_TILES = 500;
  const CAA_BASE = "https://coverartarchive.org";
  const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
  const MARKER = "data-missing-album";
  const HELD_MARKER = "data-held-upgrade";
  const LOG_PREFIX = "[Navidrome Missing Albums]";

  // Cover Art Archive 307-redirects to archive.org, whose download layer
  // intermittently answers 5xx or drops the connection. One failure is not
  // proof the cover is absent, so retry before falling back.
  const COVER_RETRIES = 3;
  const COVER_RETRY_BASE_MS = 800;
  const COVER_RETRY_JITTER_MS = 400;

  // A band the library holds nothing by has no Discogs thumbnail behind the
  // Cover Art Archive, so the full ladder spends four requests and about six
  // seconds per tile to arrive at the same placeholder — a grid of grey squares
  // that reads as broken. One retry still absorbs the archive.org 5xx above.
  const SEARCH_COVER_RETRIES = 1;

  const EXCLUDED_SECONDARY = new Set([
    "Compilation", "Live", "Remix", "Soundtrack", "DJ-mix",
    "Mixtape/Street", "Demo", "Interview", "Audiobook",
    "Audio drama", "Spokenword",
  ]);

  // ── Optional: request a missing album from Lidarr ─────────
  //
  // https://github.com/danielbanariba/navidrome-lidarr-bridge exposes Lidarr at
  // POST /request, keyed by the same MusicBrainz release-group id these tiles
  // already carry — Lidarr stores it as foreignAlbumId — so no translation is
  // needed. The bridge is probed once; when it is absent the tiles behave
  // exactly as before and nothing is drawn.
  //
  // Navidrome on its own port has no proxy to mount a path on, so the bridge is
  // reached there by port. Behind a reverse proxy the same-origin prefix is the
  // only option that works: a page served over HTTPS cannot call plain
  // http://host:8687, because the browser blocks it as mixed content.
  const BRIDGE_BASE =
    window.__NDLB_BASE ||
    (location.port === "4533"
      ? `${location.protocol}//${location.hostname}:8687`
      : "/ndlb");

  let bridgeReady = null; // null = not probed yet, then true/false
  let bridgeProbedAt = 0;

  // How long a "no bridge here" answer is believed. A bridge that started after
  // the browser did was asked once, said nothing, and was never asked again —
  // so every request button stayed gone for the rest of the session with no
  // explanation but a reload. Only the negative answer goes stale: nothing that
  // happens on this page turns a present bridge into an absent one.
  const BRIDGE_REPROBE_MS = 60 * 1000;

  // The answer was only remembered once it had arrived, so callers that started
  // together each sent their own request — one per missing tile on an artist
  // page, and one per row in a list of search results. Holding the request
  // itself means the second caller waits on the first instead of repeating it.
  let bridgeProbe = null;

  function probeBridge() {
    if (bridgeReady === true) return Promise.resolve(true);
    if (bridgeReady === false && Date.now() - bridgeProbedAt < BRIDGE_REPROBE_MS) {
      return Promise.resolve(false);
    }
    if (!bridgeProbe) {
      bridgeProbe = fetch(`${BRIDGE_BASE}/status`, { method: "GET" })
        // A failing bridge still answers 503 with a body, and a request would
        // still be accepted, so anything that replies counts as present.
        .then((res) => res.status < 500 || res.status === 503)
        .catch(() => false)
        .then((ready) => {
          bridgeReady = ready;
          bridgeProbedAt = Date.now();
          bridgeProbe = null;
          return ready;
        });
    }
    return bridgeProbe;
  }

  let bridgeInfoPromise = null;

  // A stricter probe, for the one thing that draws itself over Navidrome's own
  // chrome before anybody asks for it.
  //
  // This script is matched against every site, and away from Navidrome's own
  // port BRIDGE_BASE is the same-origin path "/ndlb" — so on any site at all,
  // probeBridge reads that site's own 404 page as "bridge present", because a
  // 404 is under 500. That is harmless for a button drawn inside a Navidrome
  // album grid, which only exists on Navidrome. It is not harmless for anything
  // that appears on its own. /status is the bridge's health endpoint and always
  // carries a boolean `healthy`; a stranger's 404 page does not.
  function bridgeInfo(refresh) {
    if (refresh) bridgeInfoPromise = null;
    if (!bridgeInfoPromise) {
      bridgeInfoPromise = fetch(`${BRIDGE_BASE}/status`)
        .then((res) => res.json())
        .then((data) => (data && typeof data.healthy === "boolean" ? data : null))
        .catch(() => null);
    }
    return bridgeInfoPromise;
  }

  // Lidarr's metadata server and MusicBrainz do not carry the same catalogue,
  // and this script's search exists for precisely the obscure bands where they
  // disagree. Asking before the button lights up turns an eighty-second wait
  // ending in a red button into a greyed row with a reason on it.
  //
  // A bridge older than this route answers 404, and so does anything else that
  // is not the bridge — both have to read as "yes", or upgrading the script
  // would grey out every artist there is.
  async function bridgeImportable(artistMbid) {
    try {
      const res = await fetch(
        `${BRIDGE_BASE}/importable?artist=${encodeURIComponent(artistMbid)}`
      );
      if (!res.ok) return true;
      const data = await res.json();
      return data.importable !== false;
    } catch (_) {
      return true;
    }
  }

  // The answer above, remembered for this page and no longer.
  //
  // It used to be written onto the artist object — which is the very object
  // held inside cache.search — so the next saveCache() from anywhere persisted
  // it, and the "we already know this one" short circuit read it back for the
  // full seven-day TTL. But `importable:false` is a statement about Lidarr's
  // metadata mirror at one instant: add the artist to Lidarr, or let a lagging
  // mirror catch up, and it stops being true. Cached for a week with nothing in
  // the UI able to refresh it, it greyed out exactly the new and obscure bands
  // this feature exists to reach. A Map dies with the page, so the worst a
  // stale "no" can now cost is a reload.
  //
  // Also deduplicated while in flight: ten rows asking about ten artists is
  // ten questions, but a row and the discography opened from it is one.
  const importableSeen = new Map();
  const importableAsking = new Map();

  // Never rejects. bridgeImportable answers true for a bridge that is absent,
  // older than this route, or unreachable, because refusing to draw a button is
  // the more expensive mistake.
  function artistImportable(mbid) {
    if (importableSeen.has(mbid)) return Promise.resolve(importableSeen.get(mbid));
    let asking = importableAsking.get(mbid);
    if (!asking) {
      asking = probeBridge()
        .then((ready) => (ready ? bridgeImportable(mbid) : true))
        .then((ok) => {
          importableSeen.set(mbid, ok);
          importableAsking.delete(mbid);
          return ok;
        });
      importableAsking.set(mbid, asking);
    }
    return asking;
  }

  // The bridge answers a failure with a sentence written for a person, but it
  // arrives in a tooltip, which is nothing at all on a phone. These put the
  // gist on the button itself.
  //
  // Every unmatched case falls through to the "Failed" this script has always
  // shown, with the server's own words still on btn.title — so a message
  // reworded upstream degrades to what shipped before rather than to nothing.
  // The strings come from bridge.py's import_artist_for and request_album,
  // which carry a comment naming them as read from here.
  function requestFailureText(status, error) {
    const msg = String(error || "");
    if (/no album in Lidarr's catalogue/i.test(msg)) return "Not in Lidarr";
    if (/catalogue has no artist/i.test(msg)) return "Not in Lidarr";
    if (/has not listed the album yet/i.test(msg)) return "Still importing…";
    if (/does not list this release/i.test(msg)) return "Lidarr won't carry it";
    if (/could not keep (artist|album) .*monitored/i.test(msg)) return "Lidarr is busy";
    if (/LIDARR_API_KEY is not set/i.test(msg)) return "Bridge not configured";
    // 504 comes from the reverse proxy, not from the bridge: the import outran
    // its read timeout. There is no data.error behind it — the body is an HTML
    // error page — so this is the only place that can say what happened.
    if (status === 504) return "Still importing…";
    if (status === 502) return "Lidarr unreachable";
    return "Failed";
  }

  // What the bridge said the library already holds, from the last call. Kept
  // beside the missing list rather than threaded through it: the two answers
  // come from one request and are only ever used together.
  let lastHeld = [];

  async function bridgeMissing(artistId) {
    // The bridge answers a better question than this script can ask alone. It
    // widens the discography with Discogs, which lists records MusicBrainz has
    // never heard of, and it knows which albums Lidarr can actually be sent
    // after. It identifies the artist the same way this script now does, by
    // matching the library's own albums against each candidate's catalogue.
    //
    // Returning null means "no better answer available", and the MusicBrainz
    // path below runs unchanged — which is what happens for anyone not running
    // a bridge at all.
    try {
      const res = await fetch(
        `${BRIDGE_BASE}/missing?id=${encodeURIComponent(artistId)}`
      );
      if (!res.ok) return null;
      const data = await res.json();
      if (!data.monitored) return null; // Lidarr does not hold this artist yet
      lastHeld = data.held || [];
      return (data.missing || []).map((a) => ({
        title: a.title,
        year: a.year || "????",
        // Absent for a record only Discogs knows: no cover art to fetch, and
        // nothing Lidarr can be asked for.
        mbid: a.mbid || null,
        // Lidarr already monitoring it means somebody pressed this button.
        requested: a.requested === true,
        // Discogs thumbnail, used when Cover Art Archive has nothing.
        cover: a.cover || null,
        albumId: a.id ?? null,
        requestable: a.requestable !== false,
      }));
    } catch (err) {
      console.warn(LOG_PREFIX, "bridge /missing unavailable", err);
      return null;
    }
  }

  // ── Self-detect: only run on pages that look like Navidrome ──
  function isNavidrome() {
    return !!localStorage.getItem("token") &&
           /^#\/(album|artist|song|playlist|library)/.test(window.location.hash || "");
  }

  // ── Cache ────────────────────────────────────────────────
  //
  // albums    — studio-only release groups, keyed rg2:<artist mbid>
  // allGroups — every release group including EPs and singles, keyed rga:<mbid>
  // search    — MusicBrainz artist search answers, keyed q:<normalised query>
  //
  // albums and allGroups are deliberately two buckets holding the same kind of
  // thing. The artist panel's missing list is computed from the album-only
  // answer, and writing the wider one over it would not look like a cache bug —
  // it would look like the panel inventing singles nobody is missing, for the
  // whole seven days the entry stays fresh.
  let cache = {
    albums: {}, allGroups: {}, missing: {}, requested: {}, search: {}, ts: {},
  };

  // What the library holds, as one short string. The missing list is only valid
  // for the library it was computed against, so an album arriving has to
  // invalidate it — and nothing else should.
  function librarySignature(localAlbums) {
    const names = localAlbums.map((a) => normalize(a.name)).sort().join("|");
    let hash = 0;
    for (let i = 0; i < names.length; i++) {
      hash = (hash * 31 + names.charCodeAt(i)) | 0;
    }
    return localAlbums.length + ":" + hash;
  }

  // A request that succeeded stays remembered, so reloading the page does not
  // offer to make it again as though nothing had happened.
  function remember(album) {
    const key = album.mbid || album.title;
    if (!key) return;
    cache.requested[key] = Date.now();
    saveCache();
  }

  function wasRequested(album) {
    // The server's answer first. An album Lidarr is monitoring with nothing on
    // disk was asked for and is still being looked for — that record survives a
    // cleared browser and reads the same on every device, which a note kept in
    // one browser's storage does not.
    if (album.requested) return true;
    const at = cache.requested[album.mbid || album.title];
    return !!at && Date.now() - at < CACHE_TTL;
  }

  function loadCache() {
    try {
      const raw = localStorage.getItem("nd-missing-albums-cache");
      // Merged rather than assigned: a cache written by an older version is
      // missing keys this one reads, and reading through a hole throws.
      if (raw) cache = { ...cache, ...JSON.parse(raw) };
    } catch (_) {}
  }

  let saveWarned = false;

  function saveCache() {
    try {
      localStorage.setItem("nd-missing-albums-cache", JSON.stringify(cache));
    } catch (err) {
      // Swallowed silently for a long time, which made a full localStorage look
      // like the cache simply having stopped working: every page load redoing
      // every MusicBrainz lookup, and nothing anywhere saying why. Said once,
      // because a quota error repeats on every single write.
      if (!saveWarned) {
        saveWarned = true;
        console.warn(LOG_PREFIX, "cache could not be saved", err);
      }
    }
  }

  // Which bucket a timestamp key belongs to. Nothing ever removed an expired
  // entry, only overwrote it when the same artist came round again — so a
  // browser that had visited a few hundred artists carried every one of them
  // forever, and cache.requested had no expiry at all. localStorage caps around
  // 5 MB, and the failure above is what hitting it looks like.
  const CACHE_BUCKETS = {
    rg2: "albums", rga: "allGroups", m: "missing", q: "search",
  };

  function pruneCache() {
    const now = Date.now();
    let dropped = 0;
    for (const [key, at] of Object.entries(cache.ts)) {
      if (now - at < CACHE_TTL) continue;
      const cut = key.indexOf(":");
      const bucket = CACHE_BUCKETS[key.slice(0, cut)];
      if (bucket && cache[bucket]) delete cache[bucket][key.slice(cut + 1)];
      delete cache.ts[key];
      dropped++;
    }
    // Kept by timestamp rather than beside a ts entry, so it is walked on its own.
    for (const [key, at] of Object.entries(cache.requested)) {
      if (now - at < CACHE_TTL) continue;
      delete cache.requested[key];
      dropped++;
    }
    if (dropped) {
      console.log(LOG_PREFIX, `pruned ${dropped} expired cache entr(ies)`);
      saveCache();
    }
  }

  function isFresh(key) {
    return cache.ts[key] && Date.now() - cache.ts[key] < CACHE_TTL;
  }

  // Bumped whenever a cached entry gains a field. An entry written before that
  // field existed is still fresh by its timestamp, so without this it would be
  // read back missing the very thing a new version needs — and the feature
  // would stay invisible until the cache aged out a week later.
  const CACHE_SHAPE = 2;

  function usable(entry) {
    return !!entry && entry.shape === CACHE_SHAPE;
  }

  // ── Navidrome API ────────────────────────────────────────
  function ndFetch(path) {
    const token = localStorage.getItem("token");
    return fetch(path, {
      headers: {
        Accept: "application/json",
        "X-ND-Authorization": `Bearer ${token}`,
        "X-ND-Client-Unique-Id": "missing-albums-userscript",
      },
    }).then((r) => {
      // An expired session answers 401 with a JSON body, which resolved as a
      // perfectly good value and read downstream as an artist with no name —
      // indistinguishable from an artist Navidrome genuinely knows nothing
      // about, and silent either way.
      if (!r.ok) throw new Error(`Navidrome ${r.status}`);
      return r.json();
    });
  }

  function getArtistInfo(id) {
    return ndFetch(`/api/artist/${id}`);
  }

  // How many artists Navidrome itself has under this name — the same filter its
  // own search box applies. The offer to go and look on MusicBrainz means two
  // different things depending on the answer: with an empty list on screen it
  // is the only way forward, with matches on screen it is a footnote. An
  // unreachable API counts as "there are matches", so a broken call makes the
  // offer quieter rather than louder.
  function ndCount(name) {
    return ndFetch(`/api/artist?name=${encodeURIComponent(name)}&_start=0&_end=1`)
      .then((rows) => (Array.isArray(rows) ? rows.length : 1))
      .catch(() => 1);
  }

  // Navidrome takes its filters as plain query parameters and ignores a JSON
  // `filter` object without complaining — so this asked for one artist's albums
  // and silently got the entire library: 1971 records for a band with four,
  // starting with a release by somebody else entirely.
  //
  // That was wrong before and merely hid missing albums whose titles another
  // band happened to share. It matters much more now that identity is decided
  // by what the library holds, because a candidate could be confirmed by a
  // record belonging to a different artist.
  // One call for the whole artist rather than one per album: the quality of
  // what is held has to be known before any of it can be judged, and twenty
  // requests to learn twenty codecs is a poor way to spend a page load.
  function getArtistSongs(id) {
    return ndFetch(
      `/api/song?artist_id=${encodeURIComponent(id)}&_start=0&_end=1000`
    );
  }

  const LOSSLESS_SUFFIX = new Set(["flac", "alac", "ape", "wv", "aiff", "wav"]);

  // What the library holds this album as, in the terms the rest of this
  // project uses: real hi-res, plain lossless, or lossy.
  function qualityOf(songs) {
    if (!songs.length) return null;
    const suffix = (songs[0].suffix || "").toLowerCase();
    const lossless = LOSSLESS_SUFFIX.has(suffix);
    const depth = Math.max(...songs.map((s) => s.bitDepth || 0));
    const rate = Math.max(...songs.map((s) => s.sampleRate || 0));
    const rates = songs.map((s) => s.bitRate || 0).filter(Boolean);
    const bitrate = rates.length
      ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length)
      : 0;
    const hires = lossless && (depth > 16 || rate > 48000);
    return {
      tier: hires ? 2 : lossless ? 1 : 0,
      label: lossless
        ? `${suffix.toUpperCase()}${depth > 16 ? " " + depth + "bit" : ""}`
        : `${suffix.toUpperCase()}${bitrate ? " " + bitrate : ""}`,
    };
  }

  function getArtistAlbums(id) {
    return ndFetch(
      `/api/album?artist_id=${encodeURIComponent(id)}` +
        `&_sort=max_year&_order=ASC&_start=0&_end=500`
    );
  }

  // ── MusicBrainz API ─────────────────────────────────────
  //
  // Only half of MusicBrainz's policy is implemented here, and the other half
  // cannot be: it asks for an identifying User-Agent, which fetch treats as a
  // forbidden header, and @grant none leaves no GM_xmlhttpRequest to go around
  // it. MusicBrainz sees the browser's own User-Agent, which is what any web
  // client sends. If it ever starts refusing on that, the fix is routing these
  // calls through the bridge — which does send a contact address — and not a
  // header that will be dropped on the way out.
  let lastMB = 0;

  async function mbFetchNow(url) {
    const wait = Math.max(0, 1100 - (Date.now() - lastMB));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastMB = Date.now();
    const r = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (!r.ok) throw new Error(`MB ${r.status}`);
    return r.json();
  }

  // The gate above is a last-timestamp check, not a queue: two calls that start
  // together compute the same wait, sleep the same amount and fire in the same
  // millisecond, which MusicBrainz answers with 503. Every caller this script
  // had awaited inside a loop and never met the case; opening a discography
  // while another lookup is still paging does. Chaining each call onto the tail
  // of the one before makes the wait real without touching a single call site.
  //
  // The tail swallows rejections. Without that, one 503 would leave a rejected
  // promise as the head of the chain and every later call would inherit it —
  // one failed lookup poisoning the rest of the session.
  //
  // Still module-scoped, so two Navidrome tabs remain two throttles.
  let mbChain = Promise.resolve();

  function mbFetch(url) {
    const result = mbChain.then(() => mbFetchNow(url));
    mbChain = result.catch(() => {});
    return result;
  }

  // Unrelated bands share a name; they do not share a back catalogue. Ten
  // artists are called "Delirium" and taking the first exact name match put a
  // punk discography on a metal band's page. So every candidate is judged by
  // what the library already holds, and a name nothing confirms draws nothing.
  //
  // The check costs no extra requests in the ordinary case: the discography a
  // candidate is judged on is the same one the panel needs anyway.
  async function identifyArtist(name, mbzId, localAlbums) {
    // A MusicBrainz id in the file tags is not a guess and needs no second opinion.
    if (mbzId) {
      return { mbid: mbzId, albums: studioAlbums(await getReleaseGroups(mbzId)) };
    }

    const key = name.toLowerCase();
    const data = await mbFetch(
      `${MB_BASE}/artist/?query=artist:"${encodeURIComponent(name)}"&limit=10&fmt=json`
    );
    const all = data.artists || [];

    let candidates = all.filter((a) => a.name.toLowerCase() === key);
    // A near miss on the name is a much weaker signal, so it is only worth
    // considering when nothing matches exactly — and it still has to prove itself.
    if (!candidates.length && all[0]?.score >= 90) candidates = [all[0]];
    if (!candidates.length) return null;

    if (candidates.length > MAX_CANDIDATES) {
      console.log(
        LOG_PREFIX,
        `${candidates.length} artists are called "${name}"; judging the first ${MAX_CANDIDATES}.`
      );
      candidates = candidates.slice(0, MAX_CANDIDATES);
    }

    const owned = ownedMatcher(localAlbums);
    const scored = [];
    for (const cand of candidates) {
      const groups = await getReleaseGroups(cand.id);
      scored.push({
        mbid: cand.id,
        albums: studioAlbums(groups),
        // Judged on everything, offered as studio albums only.
        overlap: groups.filter((g) => owned(g.title)).length,
        catalogue: groups.length,
      });
    }
    scored.sort((x, y) => y.overlap - x.overlap);
    const best = scored[0];

    if (best.overlap > 0) {
      // A tie is not an answer: two catalogues matching equally well means the
      // library cannot tell them apart either.
      if (scored.length > 1 && scored[1].overlap === best.overlap) {
        console.log(LOG_PREFIX, `"${name}" is ambiguous — two catalogues match equally well.`);
        return null;
      }
      return best;
    }

    // Nothing matched. A catalogue that lists no albums at all contradicts
    // nothing, so a lone candidate like that is still the only answer available.
    if (scored.length === 1 && !best.catalogue) return best;

    console.log(
      LOG_PREFIX,
      `No artist called "${name}" in MusicBrainz shares an album with your library — not guessing.`
    );
    return null;
  }

  // Every release group MusicBrainz files as an album, secondary types intact.
  // Two questions are asked of this list and they want different subsets: a
  // compilation is not a record to go and fetch, but owning one is still proof
  // of which band this is. Filtering here served the first question and quietly
  // broke the second — an artist whose one shared record was a compilation read
  // as a stranger.
  //
  // `all` widens it to every release group MusicBrainz has, EPs and singles
  // included, and answers into its own bucket. A band advertised as having
  // seven release groups can render three tiles here, because &type=album and
  // the primary-type filter drop everything else — which looks like the panel
  // being wrong rather than the panel being narrow. The search panel says the
  // count in those words and offers this as the way to see the rest.
  //
  // `cancelled` is an opt-in predicate, asked before each page is queued. The
  // loop used to be unstoppable: neither closing the panel nor opening another
  // discography could end it, and every page it had left to fetch went on
  // holding the rate limiter. It is opt-in because the artist-page flow has its
  // own guards and must not be cut short by a panel opening or closing.
  async function getReleaseGroups(mbid, all = false, cancelled) {
    const store = all ? cache.allGroups : cache.albums;
    const stamp = (all ? "rga:" : "rg2:") + mbid;
    if (store[mbid] && isFresh(stamp)) return store[mbid];

    const groups = [];
    let offset = 0;
    let truncated = false;

    for (let page = 0; page < MAX_RG_PAGES; page++) {
      // Before the call, not after it: by the time a page has answered, its
      // 1.1 seconds are already spent and the point was not to spend them.
      if (cancelled && cancelled()) throw new Error("cancelled");

      const data = await mbFetch(
        `${MB_BASE}/release-group?artist=${mbid}` +
          (all ? "" : "&type=album") +
          `&limit=100&offset=${offset}&fmt=json`
      );
      const rows = data["release-groups"] || [];
      if (!rows.length) break;

      for (const rg of rows) {
        const primary = rg["primary-type"] || "Other";
        if (!all && primary !== "Album") continue;
        groups.push({
          title: rg.title,
          year: (rg["first-release-date"] || "????").slice(0, 4),
          mbid: rg.id,
          // Only ever read for the wider list, where it is the one thing
          // separating an album from a single. An rg2: entry written before
          // this field existed is still fresh by its timestamp and has none, so
          // everything reading it treats absent as "an album" rather than
          // showing the word "undefined" under a cover for a week.
          primary,
          secondary: rg["secondary-types"] || [],
        });
      }

      offset += 100;
      if (offset >= (data["release-group-count"] || 0)) break;
      // About to leave on the cap rather than on the catalogue running out, so
      // what is in hand is a slice of an artist rather than an artist.
      if (page === MAX_RG_PAGES - 1) truncated = true;
    }

    groups.sort((a, b) => a.year.localeCompare(b.year));

    if (truncated) {
      // Not cached: a slice written under a fresh timestamp would be read back
      // as the whole discography for a week. The flag rides on the array
      // because identifyArtist and the artist page take this list positionally
      // and neither one cares — and it never has to survive localStorage,
      // precisely because a truncated list is never written there.
      groups.truncated = true;
      return groups;
    }

    store[mbid] = groups;
    // A new freshness key, because an entry written by an older version was
    // already filtered and carries no secondary types to filter by.
    cache.ts[stamp] = Date.now();
    saveCache();
    return groups;
  }

  // What the panel offers to go and find: a compilation or a live record is
  // not a gap in a collection.
  function studioAlbums(groups) {
    return groups.filter(
      (g) => !(g.secondary || []).some((s) => EXCLUDED_SECONDARY.has(s))
    );
  }

  // ── Local vs MusicBrainz comparison ──────────────────────

  // One word, spelled two ways on either side of the comparison. The library
  // holds "Mr Patate" where MusicBrainz lists "M. Patate", and once the period
  // is gone "mr" no longer looks anything like "m" — so an album already in the
  // library shows up as missing and is offered for download a second time.
  const ABBREV = {
    m: "mr", mister: "mr", monsieur: "mr",
    mme: "mrs", madame: "mrs", missus: "mrs",
    st: "saint", ste: "saint", sainte: "saint",
    dr: "doctor",
    vol: "volume", pt: "part", no: "number", num: "number",
    versus: "vs", v: "vs",
  };

  function normalize(name) {
    return name
      .toLowerCase()
      // Accents are folded rather than dropped, so "Xibalbá" still matches
      // "Xibalba" instead of becoming "xibalb a".
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      // Only a bracketed group standing on its own is an edition note. One
      // written inside a word is part of the title: "Pussy(De)Luxe" reduced to
      // "pussy luxe" while the same record spelled "Pussy De Luxe" reduced to
      // "pussy de luxe", so one album was listed twice as two missing records.
      .replace(/(^|\s)[([].*?[)\]]/g, " ")
      // The word, not the symbol: deleting it leaves "rock roll" against
      // "rock and roll", which are the same record.
      .replace(/&/g, " and ")
      // A slash between two names means what "vs" means, and it has to survive
      // as a word: stripped to whitespace it left "spasm mizar" against
      // "mizar vs spasm", which no longer look like the same split.
      .replace(/\s*[/\\]\s*/g, " vs ")
      // Replaced with a space rather than deleted: dropping the hyphen turned
      // "Revenge-10th" into "revenge10th", which then no longer starts with
      // "revenge" — exactly what the prefix match below looks for.
      .replace(/[^\w\s]+/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => ABBREV[w] || w)
      .join(" ");
  }

  // A local copy often carries an edition suffix the catalogue title does not
  // — "Raping Uranus: The Lost Tracks Of…" against plain "Raping Uranus" — and
  // those suffixes are not always parenthesised, so a prefix match is needed.
  // Only in that direction: a plain local title must not satisfy a longer,
  // distinct catalogue entry, such as a live album named after the studio one.
  //
  // Both the missing list and artist identification ask this question, and they
  // have to answer it the same way: when they disagreed, an artist whose one
  // shared record carried such a suffix read as a different band entirely.
  // A split is credited to two acts and no two catalogues write it the same
  // way — the library calls one "Mizar vs Spasm" where the catalogue has
  // "Spasm / Mizar". Same record, reversed, and as strings they never meet.
  // Only titles naming more than one act are compared this way: matching by
  // unordered parts is looser than matching by string, and it is safe only
  // where the order genuinely carries no meaning.
  function splitParts(key) {
    const parts = key.split(/\s+vs\s+/).filter(Boolean).sort();
    return parts.length > 1 ? parts.join("\u0000") : null;
  }

  function ownedMatcher(localAlbums) {
    const local = localAlbums.map((a) => normalize(a.name));
    const localSplits = new Set(local.map(splitParts).filter(Boolean));
    return (title) => {
      const key = normalize(title);
      if (local.some((have) => have === key || have.startsWith(key + " "))) return true;
      const parts = splitParts(key);
      return parts !== null && localSplits.has(parts);
    };
  }

  function findMissing(localAlbums, mbAlbums) {
    const owned = ownedMatcher(localAlbums);
    return mbAlbums.filter((a) => !owned(a.title));
  }

  // ── DOM ──────────────────────────────────────────────────
  // MUI v4 in production emits hashed class names like MuiGridList-root-123,
  // so we match with [class*="..."] to be suffix-agnostic.

  const PLACEHOLDER_SVG =
    'data:image/svg+xml,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">' +
        '<rect width="300" height="300" fill="#282828"/>' +
        '<text x="150" y="140" text-anchor="middle" font-family="sans-serif" font-size="60" fill="#555">&#9834;</text>' +
        '<text x="150" y="190" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#444">No cover</text>' +
        "</svg>"
    );

  // Point an <img> at the Cover Art Archive, retrying transient upstream
  // failures with exponential backoff plus jitter before showing the
  // placeholder. The retry query parameter is ignored by CAA but changes the
  // URL, so the browser reissues the request instead of replaying the cached
  // failure. Jitter keeps concurrent tiles from retrying in lockstep.
  //
  // The budget is an argument because it is not the same everywhere: a tile on
  // an artist page has a Discogs thumbnail waiting behind the retries and is
  // worth the wait, while a search result has nothing behind them and only
  // spends the time. Defaulted, so the artist page is unchanged by its being
  // there at all.
  function setCoverWithRetry(img, album, retries = COVER_RETRIES) {
    const url = `${CAA_BASE}/release-group/${album.mbid}/front-250`;
    let attempt = 0;

    img.alt = album.title;
    img.onerror = function () {
      if (attempt >= retries) {
        this.onerror = null;
        // Cover Art Archive only holds what somebody uploaded, and for an
        // obscure pressing that is often nothing — a 404 no amount of retrying
        // will fix. The bridge already carries a Discogs thumbnail for exactly
        // this case, so fall through to it before giving up on a picture.
        this.src = album.cover || PLACEHOLDER_SVG;
        return;
      }
      attempt++;
      const delay =
        COVER_RETRY_BASE_MS * Math.pow(2, attempt - 1) +
        Math.random() * COVER_RETRY_JITTER_MS;
      setTimeout(() => {
        if (!img.isConnected) return;
        img.src = `${url}?retry=${attempt}`;
      }, delay);
    };
    img.src = url;
  }

  // The three treatments that say "this record is not here", pulled out of
  // createMissingTile so the search panel's own tiles can wear the same ones.
  // As copies they were three places to fix a badge, and only ever one of them
  // would get fixed.

  function fadeAsMissing(el) {
    el.style.filter = "grayscale(100%)";
    el.style.opacity = "0.4";
    el.style.transition = "opacity 0.3s, filter 0.3s";

    el.addEventListener("mouseenter", () => {
      el.style.opacity = "0.65";
    });
    el.addEventListener("mouseleave", () => {
      el.style.opacity = "0.4";
    });
  }

  function applyCover(img, album, retries) {
    // A record only Discogs lists has no release-group id, so there is no
    // Cover Art Archive entry to go and fetch — but Discogs itself has art.
    if (album.mbid) {
      setCoverWithRetry(img, album, retries);
      return;
    }
    img.alt = album.title;
    img.onerror = function () {
      this.onerror = null;
      this.src = PLACEHOLDER_SVG;
    };
    img.src = album.cover || PLACEHOLDER_SVG;
  }

  // Top-left, so it does not sit under the request button when the bridge is
  // present.
  function missingBadge(album, label) {
    const badge = document.createElement("div");
    badge.style.cssText =
      "position:absolute;top:6px;left:6px;background:rgba(0,0,0,0.72);" +
      "color:#b9bec7;font-size:9px;padding:2px 7px;border-radius:10px;" +
      "pointer-events:none;letter-spacing:0.6px;text-transform:uppercase;" +
      "z-index:1;";
    // An album Lidarr has no id for cannot be fetched, and a badge that said
    // only "Not in library" next to no button would look broken rather than
    // explained. The caller can name the reason when it knows a better one.
    badge.textContent =
      label || (album.requestable === false ? "Not on MusicBrainz" : "Not in library");
    return badge;
  }

  function findGrid() {
    return document.querySelector('[class*="MuiGridList-root"]');
  }

  function findTiles(grid) {
    return grid.querySelectorAll(`:scope > [class*="MuiGridListTile-root"]:not([${MARKER}])`);
  }

  function getTileYear(tile) {
    const tileDiv = tile.querySelector('[class*="MuiGridListTile-tile"]');
    if (!tileDiv) return "0000";
    const container = tileDiv.querySelector(":scope > div");
    if (!container) return "0000";
    const spans = container.querySelectorAll(":scope > span");
    const lastSpan = spans[spans.length - 1];
    return lastSpan?.textContent?.match(/\d{4}/)?.[0] || "0000";
  }

  function createMissingTile(album, templateTile) {
    const tile = templateTile.cloneNode(true);
    tile.setAttribute(MARKER, "true");
    tile.dataset.mbid = album.mbid;

    const tileDiv = tile.querySelector('[class*="MuiGridListTile-tile"]');
    const container = tileDiv?.querySelector(":scope > div");

    if (container) fadeAsMissing(container);

    // Replace cover art
    const img = tile.querySelector("img");
    if (img) applyCover(img, album);

    // Replace album name (the second <a> with /album/ href is the title link)
    const links = tile.querySelectorAll('a[href*="/album/"]');
    const nameLink = links[1];
    if (nameLink) {
      const nameP = nameLink.querySelector("p");
      if (nameP) nameP.textContent = album.title;
      const allP = nameLink.querySelectorAll("p");
      if (allP.length > 1) allP[1].remove();
    }

    // Replace subtitle (year)
    if (container) {
      const spans = container.querySelectorAll(":scope > span");
      const lastSpan = spans[spans.length - 1];
      if (lastSpan) lastSpan.textContent = album.year !== "????" ? album.year : "";
    }

    // Disable links — placeholder tile is non-interactive
    tile.querySelectorAll("a").forEach((a) => {
      a.removeAttribute("href");
      a.style.cursor = "default";
      a.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    });

    // Remove play overlay
    const tileBar = tile.querySelector('[class*="MuiGridListTileBar-root"]');
    if (tileBar) tileBar.remove();

    const imgWrapper = img?.closest("div");
    if (imgWrapper) {
      imgWrapper.style.position = "relative";
      imgWrapper.appendChild(missingBadge(album));
    }

    // Request button, only when the bridge answered the probe.
    if (tileDiv) {
      probeBridge().then((ready) => {
        if (!ready || album.requestable === false) return;
        tileDiv.style.position = "relative";
        const overlay = createRequestOverlay(album);
        tileDiv.appendChild(overlay);
        tile.addEventListener("mouseenter", () => (overlay.style.opacity = "1"));
        tile.addEventListener("mouseleave", () => {
          if (!overlay.dataset.pinned) overlay.style.opacity = "0";
        });
      });
    }

    return tile;
  }

  // Hangs off the tile wrapper rather than the cover container: that container
  // carries grayscale and reduced opacity, and children inherit both. The cover
  // is meant to look faded; the button is not. Sized with aspect-ratio so it
  // covers the square art without reaching into the title row, and without
  // measuring pixels that a resize would invalidate.
  //
  // Adding a band Lidarr has never seen is slow by nature. It imports the
  // artist, waits for the discography to arrive, then reads the monitored flag
  // back until it sticks — up to about ninety seconds before the first byte of
  // an answer comes out. A button that has said "Requesting…" for a minute and
  // a half is indistinguishable from a button that has hung, so it says which
  // part is taking the time instead.
  const REQUEST_PHASES = [
    [6000, "Adding artist…"],
    [25000, "Importing discography…"],
  ];

  // Longer than anything the bridge can legitimately take, and shorter than the
  // 300s the reverse proxy is configured to wait. That ordering is the whole
  // point: an abort has to mean "this is taking longer than we know how to
  // explain", never "the proxy hung up on a request that was going to succeed".
  const REQUEST_TIMEOUT_MS = 150000;

  function createRequestOverlay(album, label) {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:absolute;top:0;left:0;width:100%;aspect-ratio:1;z-index:2;" +
      "display:flex;align-items:center;justify-content:center;" +
      "background:linear-gradient(180deg,rgba(0,0,0,0) 35%,rgba(0,0,0,0.55) 100%);" +
      "opacity:0;transition:opacity .18s ease;pointer-events:none;";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label || "Request";
    const already = wasRequested(album);
    btn.style.cssText =
      "pointer-events:auto;cursor:pointer;font:600 11px/1 system-ui,sans-serif;" +
      "letter-spacing:.4px;padding:7px 16px;border-radius:999px;" +
      "border:1px solid rgba(255,255,255,.25);color:#fff;" +
      "background:rgba(28,32,38,.92);backdrop-filter:blur(2px);" +
      "box-shadow:0 2px 10px rgba(0,0,0,.45);transition:background .15s;";
    btn.addEventListener("mouseenter", () => {
      if (!btn.disabled) btn.style.background = "rgba(48,54,64,.95)";
    });
    btn.addEventListener("mouseleave", () => {
      if (!btn.disabled) btn.style.background = "rgba(28,32,38,.92)";
    });

    // An outcome has to stay readable after the pointer leaves the tile.
    //
    // Success is final; failure is not. Locking the button on failure too meant
    // the only way to try again was to reload the page, which threw away the
    // whole discography lookup and started it over — for a request that may
    // simply have hit a busy Lidarr.
    const settle = (text, ok) => {
      btn.textContent = text;
      btn.disabled = ok;
      btn.style.cursor = ok ? "default" : "pointer";
      btn.style.borderColor = ok ? "transparent" : "rgba(255,255,255,.25)";
      btn.style.background = ok ? "rgba(46,125,79,.95)" : "rgba(142,59,52,.95)";
      overlay.dataset.pinned = "1";
      overlay.style.opacity = "1";
      if (!ok) {
        btn.title = (btn.title ? btn.title + " — " : "") + "click to try again";
      }
    };

    // Neither outcome. The bridge imports the artist and monitors the album
    // server-side whether this tab is still listening or not, so painting the
    // terminal red state on a timeout would tell exactly the lie the proxy's
    // own timeout used to tell: "Failed" over a request that worked. Left
    // clickable, deliberately not the failure colour, and nothing is
    // remembered, because nothing was confirmed.
    const waiting = (text) => {
      btn.textContent = text;
      btn.disabled = false;
      btn.style.cursor = "pointer";
      btn.style.borderColor = "rgba(255,255,255,.25)";
      btn.style.background = "rgba(28,32,38,.92)";
      btn.title =
        "Lidarr is still working on this. Give it a minute and check Lidarr — " +
        "clicking again is safe, it asks for the same album.";
      overlay.dataset.pinned = "1";
      overlay.style.opacity = "1";
    };

    btn.addEventListener("click", async (e) => {
      // Every link in the tile has its clicks cancelled; this button is the
      // one thing on it that is meant to be clickable.
      e.preventDefault();
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = "Requesting…";
      btn.title = "";
      btn.style.background = "rgba(28,32,38,.92)";
      overlay.dataset.pinned = "1";

      const phases = REQUEST_PHASES.map(([at, text]) =>
        setTimeout(() => {
          // Only while it is still the pending button. An answer that arrived
          // early must not be overwritten by a timer nobody cancelled in time.
          if (btn.disabled) btn.textContent = text;
        }, at)
      );
      // An AbortController rather than a bare timer: the request has to
      // actually be let go, or a tab left open all afternoon holds a connection
      // for every one it gave up on.
      const abort = new AbortController();
      const bail = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
      const stopTimers = () => {
        phases.forEach(clearTimeout);
        clearTimeout(bail);
      };

      try {
        const res = await fetch(`${BRIDGE_BASE}/request`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Lidarr's own id when the bridge supplied one, which needs no
          // catalogue lookup on the way in.
          body: JSON.stringify(
            album.albumId ? { albumId: album.albumId } : { mbid: album.mbid }
          ),
          signal: abort.signal,
        });
        stopTimers();
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          settle("Requested ✓", true);
          remember(album);
        } else {
          settle(requestFailureText(res.status, data.error), false);
          // A 504 is the proxy's, and its body is an HTML error page — there is
          // no data.error behind it to explain anything, so the explanation has
          // to come from here.
          btn.title =
            data.error ||
            (res.status === 504
              ? "The import outran the proxy's timeout. Lidarr is very likely " +
                "still working on it."
              : `HTTP ${res.status}`);
        }
      } catch (err) {
        stopTimers();
        if (err && err.name === "AbortError") {
          waiting("Still working…");
        } else {
          settle("Failed", false);
          btn.title = String(err && err.message ? err.message : err);
          console.warn(LOG_PREFIX, "request failed", err);
        }
      }
    });

    if (already) {
      settle("Requested ✓", true);
    }

    overlay.appendChild(btn);
    return overlay;
  }

  // A record already on the shelf is not necessarily finished. One held as MP3
  // can still be improved, and the panel is the only place that knows both what
  // the library has and what can be asked for — but it has to say so gently:
  // the offer is worth taking or leaving, and nothing is lost by declining it.
  function decorateHeld(grid, quality, held) {
    const byTitle = new Map((held || []).map((h) => [normalize(h.title), h]));
    // The bridge names the Navidrome album each catalogue entry belongs to, and
    // an id is not a spelling: MusicBrainz files the 1999 demo as "Ultra Vomit"
    // while the folder is called "Demo", and no normalising makes those meet.
    const byId = new Map(
      (held || []).filter((h) => h.ndId).map((h) => [h.ndId, h])
    );

    for (const tile of grid.children) {
      if (tile.hasAttribute(MARKER)) continue;
      const link = tile.querySelector('a[href*="#/album/"]');
      const id = link && (link.getAttribute("href").match(/#\/album\/([^/]+)/) || [])[1];
      const found = id && quality.get(id);
      // Only the lossy ones. Telling someone their 24-bit copy could be
      // improved would be noise, and untrue.
      if (!found || found.tier !== 0) continue;

      // The tile bar carries no text in this Navidrome build; the cover's alt
      // does. Falling back to the bar keeps it working where it does.
      const title = (
        tile.querySelector("img")?.alt ||
        tile.querySelector('[class*="MuiGridListTileBar-title"]')?.textContent ||
        ""
      ).trim();
      if (!title) continue;

      // A held copy often carries an edition suffix the catalogue title does
      // not — "Captain Morgan's Revenge-10th Anniversary Edition" against plain
      // "Captain Morgan's Revenge" — which is why an exact match found nothing.
      const key = normalize(title);
      const entry =
        byId.get(id) ||
        byTitle.get(key) ||
        (held || []).find((h) => {
          const cat = normalize(h.title);
          return cat && (key === cat || key.startsWith(cat + " "));
        });
      // Either id will do: Lidarr's own when it holds the artist, the
      // release-group id when it does not. Without one there is nothing to
      // ask with — but the badge still goes on, because knowing a record is
      // MP3 is worth saying even when nothing can be done about it. One
      // artist here holds nineteen albums, fifteen of them lossy, and the
      // catalogue lists three; the other twelve were told nothing at all.
      const askable = !!(entry && (entry.id || entry.mbid));

      const wrap = tile.querySelector('[class*="MuiGridListTile-tile"]') || tile;
      wrap.style.position = wrap.style.position || "relative";

      const pill = document.createElement("div");
      pill.textContent = found.label;
      pill.setAttribute(HELD_MARKER, "true");
      pill.style.cssText =
        "position:absolute;top:8px;left:8px;z-index:3;pointer-events:none;" +
        "font:600 10px/1 system-ui,sans-serif;letter-spacing:.4px;" +
        "padding:4px 8px;border-radius:999px;color:#e8d9b0;" +
        "background:rgba(28,24,16,.82);border:1px solid rgba(224,176,112,.35);";
      wrap.appendChild(pill);

      if (!askable) continue;

      const overlay = createRequestOverlay(
        { albumId: entry.id || null, mbid: entry.mbid, title: entry.title },
        "Try for lossless"
      );
      overlay.setAttribute(HELD_MARKER, "true");
      overlay.querySelector("button").title =
        `You have this as ${found.label}. Ask for a lossless copy — ` +
        `nothing is lost if none turns up.`;
      // Above Navidrome's own hover controls, which sit on the same corner of
      // the cover and would otherwise take the pointer first.
      overlay.style.zIndex = "5";
      wrap.appendChild(overlay);

      // The overlay starts invisible and is revealed on hover. A tile drawn by
      // this script gets those listeners when it is built; one of Navidrome's
      // own never did, so the button was there the whole time at zero opacity
      // and nothing could reach it.
      tile.addEventListener("mouseenter", () => (overlay.style.opacity = "1"));
      tile.addEventListener("mouseleave", () => {
        if (!overlay.dataset.pinned) overlay.style.opacity = "0";
      });
    }
  }

  function insertByYear(grid, tile, album) {
    const existing = findTiles(grid);
    for (const el of existing) {
      const year = getTileYear(el);
      if (album.year < year) {
        grid.insertBefore(tile, el);
        return;
      }
    }
    grid.appendChild(tile);
  }

  // ── Status line ──────────────────────────────────────────
  //
  // One element, created once, that never leaves and never changes height.
  // Three separate notices used to be inserted above the grid and taken away
  // again — searching, the count, "you have every studio album" — and each
  // arrival and departure shifted every cover on the page down and back up.
  // A row that is always there, sometimes holding no text, says the same
  // things without moving anything.
  const STATUS_ID = "missing-albums-status";

  function statusLine(grid) {
    let el = document.getElementById(STATUS_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = STATUS_ID;
      el.style.cssText =
        "padding:8px 16px 4px;color:#666;font-size:12px;min-height:16px;";
      // Below the grid, not above it. Navidrome has already laid the covers out
      // by the time this runs, so anything inserted ahead of them pushes every
      // one of them down — once is better than the three times it used to be,
      // but nothing is better still. Adding the row after the grid extends the
      // page instead of moving it.
      grid.parentNode.insertBefore(el, grid.nextSibling);
    }
    return el;
  }

  function setStatus(grid, text) {
    statusLine(grid).textContent = text || "";
  }

  function showLoading(grid) {
    setStatus(grid, "Searching for missing albums on MusicBrainz…");
  }

  function removeMessages() {
    const el = document.getElementById(STATUS_ID);
    if (el) el.textContent = "";
  }

  // ── Main flow ────────────────────────────────────────────
  let currentArtistId = null;
  let working = false;

  async function processArtistPage() {
    const match = window.location.hash.match(/^#\/artist\/([^/]+)\/show/);
    if (!match) return;

    const artistId = match[1];
    if (working) return;

    const grid = findGrid();
    if (!grid) {
      console.log(LOG_PREFIX, "Grid not ready yet");
      return;
    }

    const existingTiles = findTiles(grid);
    if (!existingTiles.length) {
      console.log(LOG_PREFIX, "No tiles in grid yet");
      return;
    }

    if (
      currentArtistId === artistId &&
      grid.querySelector(`[${MARKER}]`)
    )
      return;

    working = true;
    currentArtistId = artistId;

    grid.querySelectorAll(`[${MARKER}]`).forEach((el) => el.remove());
    grid.querySelectorAll(`[${HELD_MARKER}]`).forEach((el) => el.remove());
    removeMessages();

    try {
      const [artistInfo, localAlbums, songs] = await Promise.all([
        getArtistInfo(artistId),
        getArtistAlbums(artistId),
        getArtistSongs(artistId).catch(() => []),
      ]);

      // Quality per album, from the one song call above.
      const byAlbum = new Map();
      for (const song of songs) {
        if (!song.albumId) continue;
        if (!byAlbum.has(song.albumId)) byAlbum.set(song.albumId, []);
        byAlbum.get(song.albumId).push(song);
      }
      const quality = new Map();
      for (const [id, group] of byAlbum) {
        const q = qualityOf(group);
        if (q) quality.set(id, q);
      }

      console.log(LOG_PREFIX, "Artist:", artistInfo?.name, "| Local albums:", localAlbums?.length);

      if (!artistInfo?.name) {
        removeMessages();
        working = false;
        return;
      }

      // Answered from memory when the library has not changed since. Without
      // it, every visit to an artist page asked MusicBrainz who the band was
      // all over again — and a failed request could only be retried by
      // reloading, which threw that whole lookup away to redo it.
      //
      // The signature is what makes it safe to keep: an album arriving changes
      // it and the answer is recomputed; nothing else does.
      const signature = librarySignature(localAlbums);
      const stored = cache.missing[artistId];
      const fresh =
        usable(stored) && stored.sig === signature && isFresh("m:" + artistId);
      const remembered = fresh ? stored.albums : null;
      if (fresh) lastHeld = stored.held || [];

      let missing = remembered;
      if (missing) {
        console.log(LOG_PREFIX, "from cache |", missing.length, "missing");
      } else {
        // Only once something is actually going to be fetched: a cached answer
        // that flashed "Searching on MusicBrainz…" would be lying about it.
        showLoading(grid);
        if (await probeBridge()) {
          missing = await bridgeMissing(artistId);
          if (missing) console.log(LOG_PREFIX, "bridge |", missing.length, "missing");
        }
      }

      if (!missing) {
        const identified = await identifyArtist(
          artistInfo.name,
          artistInfo.mbzArtistId,
          localAlbums
        );
        console.log(LOG_PREFIX, "MBID:", identified?.mbid ?? "not identified");

        if (!identified) {
          removeMessages();
          working = false;
          return;
        }

        missing = findMissing(localAlbums, identified.albums);
        console.log(LOG_PREFIX, "MusicBrainz:", identified.albums.length,
                    "|", missing.length, "missing");

        // The badge needs something to ask with, and without Lidarr holding
        // this artist there is no album id — but /request takes a release-group
        // id too and imports the artist on the way in. So the catalogue already
        // in hand supplies it, and an artist nobody starred is served as well
        // as one that was.
        const owned = ownedMatcher(localAlbums);
        lastHeld = identified.albums
          .filter((a) => owned(a.title) && a.mbid)
          .map((a) => ({ id: null, mbid: a.mbid, title: a.title }));
      }

      if (!remembered) {
        cache.missing[artistId] = {
          shape: CACHE_SHAPE, sig: signature, albums: missing, held: lastHeld,
        };
        cache.ts["m:" + artistId] = Date.now();
        saveCache();
      }

      removeMessages();

      if (!missing.length) {
        // Having the whole discography is not the same as being finished with
        // it: the badge is about the quality of what is held, and leaving here
        // meant the artists with nothing missing — the well-kept ones — were
        // the only ones never told which of their records are still MP3.
        decorateHeld(grid, quality, lastHeld);
        working = false;
        return;
      }

      const template = existingTiles[0];

      for (const album of missing) {
        const tile = createMissingTile(album, template);
        insertByYear(grid, tile, album);
      }

      decorateHeld(grid, quality, lastHeld);

      setStatus(grid, `${missing.length} studio album(s) not in your library`);
    } catch (e) {
      console.error(LOG_PREFIX, "Error:", e);
      removeMessages();
    }

    working = false;
  }

  // ── Find any band ────────────────────────────────────────
  //
  // Everything above can only exist on an artist page, and an artist page only
  // exists once the library holds a file by that artist. A band you own nothing
  // by is unreachable: there is no page to draw on, no local albums to identify
  // it from, and identifyArtist would refuse to name it anyway — it picks a
  // candidate by counting how many of its records the library already holds,
  // which for such a band is zero by construction. This is the way in.
  //
  // It hitchhikes on Navidrome's own search box rather than adding one.
  // <SearchInput id="search"> reaches the DOM as a plain <input id="search">,
  // which is the only stable handle in the whole app that owes nothing to MUI's
  // hashed class names — in a production build only names beginning "Mui"
  // survive, and Navidrome's own code has a selector broken by exactly that.
  // React replaces the input whenever the filter form remounts, so the listener
  // goes on document in the capture phase, where it cannot be orphaned: no
  // observer, no re-injection, nothing to keep alive.
  //
  // The panel hangs off document.body. React renders into #root and never looks
  // outside it, so a node there survives every re-render by construction rather
  // than by being put back afterwards.
  const PANEL_ID = "ndlb-find-panel";
  const PILL_ID = "ndlb-find-pill";
  const PILL_DELAY_MS = 400;
  const MIN_QUERY = 3;
  // How many candidates one MusicBrainz search asks for, and therefore how far
  // "More results" advances the offset.
  const SEARCH_PAGE = 10;

  // #search is also the id of the filter box on the Players, Radios and Users
  // admin lists, and isNavidrome() is read once at document-idle and never
  // again — so a tab that started on #/album and walked to #/player would have
  // offered to search MusicBrainz for a player name. The route is re-read on
  // every keystroke instead of trusted from load time. (Songs filter on
  // source="title" and playlists on "q", so those inputs are id="title" and
  // id="q" and never reach this at all.)
  const PILL_ROUTES = /^#\/(artist|album)/;

  // Bumped by anything that replaces the question. An answer that comes back
  // holding an old number is answering a panel the user has already left, and
  // dropping it is cheaper than trying to cancel a paging loop mid-flight.
  let findSeq = 0;
  let lastFindTerm = "";
  // Every page fetched for the current term, and how many there are in total.
  // MusicBrainz has no way back to a page already left behind, so the rows
  // accumulate here and "‹ Results" re-renders them rather than re-searching —
  // which would silently drop the reader back to the first ten.
  let findResults = [];
  let findCount = 0;
  // Its own timer. scheduleCheck is hard-wired to processArtistPage, and
  // sharing it would mean a keystroke silently cancelling the artist panel.
  let pillTimer = null;
  let pillDismissed = false;
  let searchWired = false;

  // identifyArtist's query with the scoring taken off rather than reused: that
  // function exists to refuse an answer the library cannot confirm, which is
  // the opposite of what is wanted here. The person reading the list is the
  // disambiguator, so MusicBrainz's disambiguation, country, type and start
  // year are kept instead of discarded — they are the only things that tell
  // three bands called Delirium apart.
  //
  // MusicBrainz reports how many artists match and then hands over ten of them.
  // The panel used to print the ten as though they were all there were —
  // "Delirium" matches 93 artists, and being shown ten of them under the words
  // "10 artists matched" tells somebody whose band is at rank fourteen that it
  // does not exist. The count comes back with the rows now, and `offset` is how
  // the rest are reached.
  async function searchArtists(query, offset = 0) {
    const key = normalize(query) + (offset ? "@" + offset : "");
    const stamp = "q:" + key;
    const hit = cache.search[key];
    if (hit && isFresh(stamp)) {
      // An entry written by an older version is a bare array with no count at
      // all. Reading it as "that many, and no more" is what it used to mean.
      return Array.isArray(hit) ? { artists: hit, count: hit.length } : hit;
    }

    const data = await mbFetch(
      `${MB_BASE}/artist/?query=artist:"${encodeURIComponent(query)}"` +
        `&limit=${SEARCH_PAGE}&offset=${offset}&fmt=json`
    );
    const artists = (data.artists || []).map((a) => ({
      mbid: a.id,
      name: a.name,
      note: [
        a.disambiguation,
        a.country,
        a.type,
        String((a["life-span"] || {}).begin || "").slice(0, 4),
      ]
        .filter(Boolean)
        .join(" · "),
    }));
    // How many exist, not how many were fetched.
    const answer = { artists, count: Number(data.count) || artists.length };

    cache.search[key] = answer;
    cache.ts[stamp] = Date.now();
    saveCache();
    return answer;
  }

  // Created once and looked up by id afterwards, the same way the status line
  // is: two panels stacked on each other is what a double init used to buy.
  function panelEl() {
    let root = document.getElementById(PANEL_ID);
    if (!root) {
      root = document.createElement("div");
      root.id = PANEL_ID;
      // Above MUI's drawer (1200) and below its modal (1300). This is meant to
      // cover Navidrome's own chrome and never a dialog Navidrome opens.
      root.style.cssText =
        "position:fixed;inset:0;z-index:1250;display:flex;align-items:center;" +
        "justify-content:center;background:rgba(0,0,0,.62);" +
        "font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;";

      const card = document.createElement("div");
      card.style.cssText =
        "width:min(880px,92vw);max-height:86vh;display:flex;flex-direction:column;" +
        "background:#1d2027;color:#e8eaed;border:1px solid #333945;" +
        "border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.55);overflow:hidden;";

      const head = document.createElement("div");
      head.style.cssText =
        "display:flex;align-items:center;gap:10px;padding:14px 16px;" +
        "border-bottom:1px solid #2a2f3a;";

      const title = document.createElement("div");
      title.dataset.ndlb = "title";
      title.style.cssText =
        "font-weight:600;font-size:14px;flex:1;min-width:0;overflow:hidden;" +
        "text-overflow:ellipsis;white-space:nowrap;";

      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "✕";
      close.title = "Close (Esc)";
      close.style.cssText =
        "cursor:pointer;border:0;background:transparent;color:#9aa3b2;" +
        "font-size:16px;line-height:1;padding:4px 6px;";
      close.addEventListener("click", closePanel);

      head.append(title, close);

      // The same always-there row the artist page uses, for the same reason:
      // nearly every step of this has something to say, and a notice that
      // appears and disappears between the covers moves every one of them.
      const status = document.createElement("div");
      status.dataset.ndlb = "status";
      status.style.cssText =
        "padding:10px 16px 0;color:#8b93a1;font-size:12px;min-height:17px;";

      const body = document.createElement("div");
      body.dataset.ndlb = "body";
      body.style.cssText = "padding:12px 16px 18px;overflow:auto;";

      card.append(head, status, body);
      root.appendChild(card);

      // mousedown rather than click, and only when the backdrop itself is the
      // target: a drag that starts on a title and ends outside would otherwise
      // take the whole panel with it.
      root.addEventListener("mousedown", (e) => {
        if (e.target === root) closePanel();
      });

      document.body.appendChild(root);
    }
    return {
      root,
      title: root.querySelector('[data-ndlb="title"]'),
      status: root.querySelector('[data-ndlb="status"]'),
      body: root.querySelector('[data-ndlb="body"]'),
    };
  }

  function closePanel() {
    const root = document.getElementById(PANEL_ID);
    if (root) root.remove();
    // Anything still in flight is now answering a panel that is gone.
    findSeq++;
  }

  function setPanelStatus(text) {
    const el = document.querySelector(`#${PANEL_ID} [data-ndlb="status"]`);
    if (el) el.textContent = text || "";
  }

  // MusicBrainz answers 503 when it is busy, and this script has no way to
  // identify itself out of that queue. Waiting is the whole remedy, so say so
  // rather than showing a status code.
  function mbErrorText(err) {
    return /MB 5\d\d/.test(String((err && err.message) || ""))
      ? "MusicBrainz is busy — try again in a moment."
      : "MusicBrainz did not answer — try again in a moment.";
  }

  function panelButton(text) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = text;
    btn.style.cssText =
      "cursor:pointer;font:12px/1 system-ui,-apple-system,sans-serif;" +
      "padding:7px 12px;border-radius:8px;border:1px solid #3a4150;" +
      "background:#252a33;color:#c8cfdb;";
    return btn;
  }

  function panelBar() {
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;gap:8px;margin:0 0 14px;flex-wrap:wrap;";
    return bar;
  }

  // One sentence over an empty body is a dead end. Both panels clear the body
  // before they await, and openFinder has hidden the pill on the way in, so a
  // MusicBrainz 503 — the exact case mbErrorText exists to phrase — used to
  // destroy the candidate list, say "try again in a moment" and offer nothing
  // to try again with: recovery was Esc, retype the search, wait out the
  // debounce, click the pill, click the row. Every failure path now puts back
  // something to press.
  function panelFailure(err, actions) {
    setPanelStatus(mbErrorText(err));
    const { body } = panelEl();
    body.textContent = "";
    const bar = panelBar();
    for (const [label, run] of actions) {
      const btn = panelButton(label);
      btn.addEventListener("click", run);
      bar.appendChild(btn);
    }
    body.appendChild(bar);
  }

  async function openFinder(query, offset = 0) {
    const term = String(query || "").trim();
    if (!term) return;
    hidePill();
    lastFindTerm = term;

    const seq = ++findSeq;
    const { title, body } = panelEl();
    title.textContent = `Find “${term}” on MusicBrainz`;
    // A new search starts from nothing; "More results" adds to what is there.
    if (!offset) {
      findResults = [];
      findCount = 0;
      body.textContent = "";
    }
    setPanelStatus(offset ? "Fetching more…" : "Searching MusicBrainz…");

    let page;
    try {
      page = await searchArtists(term, offset);
    } catch (err) {
      if (seq !== findSeq) return;
      // A later page failing must not cost the reader the pages that worked;
      // reopenResults re-renders exactly what is already in hand.
      panelFailure(err, [
        ...(offset ? [["‹ Results", reopenResults]] : []),
        ["Retry", () => openFinder(term, offset)],
      ]);
      return;
    }
    if (seq !== findSeq) return;

    findResults = offset ? findResults.concat(page.artists) : page.artists.slice();
    findCount = page.count;
    renderCandidates(findResults, term, seq, findCount);
  }

  // What "‹ Results" goes back to. Re-rendering what is already held rather
  // than searching again: the extra pages "More results" fetched are part of
  // the list the reader was looking at.
  function reopenResults() {
    if (!findResults.length) return openFinder(lastFindTerm);
    const seq = ++findSeq;
    panelEl().title.textContent = `Find “${lastFindTerm}” on MusicBrainz`;
    renderCandidates(findResults, lastFindTerm, seq, findCount);
  }

  function renderCandidates(artists, term, seq, count) {
    const { body } = panelEl();
    body.textContent = "";

    if (!artists.length) {
      setPanelStatus(
        `No artist called “${term}” on MusicBrainz. Try the spelling it is ` +
          `filed under there.`
      );
      return;
    }
    // Said against the number that exist rather than the number fetched, and
    // with the one thing that actually helps: MusicBrainz ranks a search, and
    // a country or a disambiguation in the query moves the right band up it.
    setPanelStatus(
      count > artists.length
        ? `${artists.length} of ${count} artists matched — add a country or ` +
            `disambiguation to narrow it, or ask for more below.`
        : artists.length === 1
          ? "One artist matched."
          : `${artists.length} artists matched — pick the right one.`
    );

    for (const artist of artists) {
      const row = document.createElement("button");
      row.type = "button";
      row.style.cssText =
        "display:block;width:100%;text-align:left;cursor:pointer;" +
        "padding:10px 12px;margin-bottom:6px;border-radius:8px;" +
        "border:1px solid #2a2f3a;background:#22262e;color:inherit;font:inherit;";
      row.addEventListener("mouseenter", () => (row.style.background = "#282e38"));
      row.addEventListener("mouseleave", () => (row.style.background = "#22262e"));

      const name = document.createElement("div");
      name.textContent = artist.name;
      name.style.cssText = "font-weight:600;font-size:13px;";

      const note = document.createElement("div");
      note.textContent = artist.note;
      note.style.cssText = "font-size:11px;color:#8b93a1;margin-top:2px;";

      const markUnimportable = () => {
        row.style.opacity = "0.5";
        note.textContent =
          "Not in Lidarr's catalogue" + (artist.note ? " · " + artist.note : "");
      };

      row.append(name, note);
      row.addEventListener("click", () => openDiscography(artist));
      body.appendChild(row);

      // Answered from this page's Map, so coming back to these results from a
      // discography does not ask Lidarr the same ten questions over again, and
      // a row that was greyed is greyed on arrival rather than after a flash.
      if (importableSeen.get(artist.mbid) === false) {
        markUnimportable();
        continue;
      }
      if (importableSeen.get(artist.mbid) === true) continue;

      // Asked after the rows are on screen, never before them. Lidarr's answer
      // is worth having — MusicBrainz lists bands its metadata server has never
      // carried, and this feature is written for exactly those — but it is not
      // worth making the list wait for, and an older bridge has no answer at
      // all. A row that cannot be imported still opens: seeing the discography
      // is useful even when nothing on it can be fetched.
      //
      // The answer is recorded by artistImportable whatever is on screen by the
      // time it lands. Guarding the recording itself with findSeq meant that
      // clicking a row — whose first act is to bump findSeq — threw away the
      // answer about the artist that had just been clicked, leaving every tile
      // in the discography with a Request button that could only end in a
      // ninety-second import and a refusal. Only the greying is guarded, and
      // only because the row it would grey may already be gone.
      artistImportable(artist.mbid).then((ok) => {
        if (ok || seq !== findSeq || !row.isConnected) return;
        markUnimportable();
      });
    }

    // MusicBrainz has more of them than it handed over. Without this the panel
    // has told the reader their band does not exist.
    if (count > artists.length) {
      const bar = panelBar();
      bar.style.margin = "12px 0 0";
      const more = panelButton(`More results (${artists.length} of ${count})`);
      more.addEventListener("click", () => {
        more.disabled = true;
        more.textContent = "Fetching…";
        openFinder(term, artists.length);
      });
      bar.appendChild(more);
      body.appendChild(bar);
    }
  }

  async function openDiscography(artist, all = false) {
    const seq = ++findSeq;
    const { title, body } = panelEl();
    title.textContent = artist.name;
    body.textContent = "";
    setPanelStatus(all ? "Loading every release…" : "Loading discography…");

    let groups;
    let importable;
    try {
      // Both at once. Lidarr's answer is one call to a service on this machine
      // and MusicBrainz's is a rate-limited walk over the network, so waiting
      // for the pair costs nothing over waiting for the discography alone — and
      // it buys a definite yes or no to draw the tiles from, rather than an
      // "unknown" that used to read as "yes" and put a Request button on every
      // record of a band Lidarr has never heard of.
      [groups, importable] = await Promise.all([
        // Abandoned the moment anything replaces this panel: closing it and
        // opening another discography both bump findSeq.
        getReleaseGroups(artist.mbid, all, () => seq !== findSeq),
        artistImportable(artist.mbid),
      ]);
    } catch (err) {
      // A cancelled paging loop lands here too, and is exactly the case this
      // guard already covered: the panel it was answering is gone.
      if (seq !== findSeq) return;
      panelFailure(err, [
        ["‹ Results", reopenResults],
        ["Retry", () => openDiscography(artist, all)],
      ]);
      return;
    }
    if (seq !== findSeq) return;

    // The narrow view answers the same question the artist panel answers, and
    // has to answer it the same way: a compilation or a live record is not a
    // gap in a collection.
    renderDiscography(
      artist,
      all ? groups : studioAlbums(groups),
      all,
      importable,
      groups.truncated === true
    );
  }

  function renderDiscography(artist, albums, all, importable, truncated) {
    const { body } = panelEl();
    body.textContent = "";

    const bar = panelBar();

    const back = panelButton("‹ Results");
    back.addEventListener("click", reopenResults);

    // Offered from the first render rather than kept behind an empty state.
    // "Seven release groups" and "three tiles" is the ordinary case for a band
    // whose catalogue is mostly EPs, and without this the panel just looks
    // wrong.
    const toggle = panelButton(
      all ? "Studio albums only" : "Show EPs, singles and everything else"
    );
    toggle.addEventListener("click", () => openDiscography(artist, !all));

    bar.append(back, toggle);
    body.appendChild(bar);

    if (!albums.length) {
      setPanelStatus(
        truncated
          ? `Nothing to show in the first ${MAX_RG_PAGES * 100} release groups ` +
            `MusicBrainz was asked for — this artist has more than a panel ` +
            `like this can show.`
          : all
            ? "MusicBrainz lists no releases at all for this artist."
            : "MusicBrainz lists no studio albums for this artist — there may " +
              "still be EPs or singles."
      );
      return;
    }

    // Said in the words the filter actually uses. The old panel counted what it
    // drew and left the reader to wonder where the rest went.
    const shown = albums.slice(0, MAX_SEARCH_TILES);
    const counted = all
      ? `${shown.length} release(s) on MusicBrainz`
      : `${shown.length} studio album(s) on MusicBrainz — compilations, live ` +
        `records, EPs and singles are not counted`;
    // A truncated fetch and a truncated draw are two different admissions and
    // both have to be made: the first says MusicBrainz has more, the second
    // says this panel is not going to draw them.
    const cut = [
      truncated
        ? `Only the first ${MAX_RG_PAGES * 100} release groups were fetched — ` +
          `this artist has more than a panel like this can show.`
        : "",
      shown.length < albums.length
        ? `Showing the first ${MAX_SEARCH_TILES}.`
        : "",
      importable === false
        ? `Lidarr's catalogue does not carry this artist, so there is nothing ` +
          `here it can be asked for.`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    setPanelStatus(cut ? `${counted}. ${cut}` : counted);

    const grid = document.createElement("div");
    grid.style.cssText =
      "display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:14px;";
    body.appendChild(grid);

    for (const group of shown) {
      // The shape bridgeMissing normalises to, so every tile helper and the
      // whole request/settle/remember state machine work on it untouched. No
      // Discogs thumbnail and no Lidarr id, because nothing local has ever
      // heard of this band; requestable is what /importable said about it, and
      // openDiscography has already waited for that answer, so it is a yes or
      // a no here and never an "not asked yet" read as a yes.
      grid.appendChild(
        searchTile({
          title: group.title,
          year: group.year,
          mbid: group.mbid,
          primary: group.primary,
          secondary: group.secondary,
          cover: null,
          albumId: null,
          requested: false,
          requestable: importable !== false,
        })
      );
    }
  }

  function searchTile(album) {
    const tile = document.createElement("div");
    tile.setAttribute(MARKER, "true");
    tile.style.cssText = "position:relative;";

    // Faded as one block, with the request button hung off the tile outside it.
    // That container carries grayscale and reduced opacity and children inherit
    // both: the cover is meant to look faded, a button meant to be pressed is
    // not.
    const card = document.createElement("div");
    fadeAsMissing(card);

    const art = document.createElement("div");
    art.style.cssText =
      "position:relative;aspect-ratio:1;border-radius:6px;overflow:hidden;" +
      "background:#282828;";

    const img = document.createElement("img");
    img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;";
    applyCover(img, album, SEARCH_COVER_RETRIES);

    art.append(
      img,
      missingBadge(
        album,
        album.requestable === false ? "Not in Lidarr" : "Not in library"
      )
    );

    const name = document.createElement("div");
    name.textContent = album.title;
    name.title = album.title;
    name.style.cssText =
      "margin-top:7px;font-size:12px;font-weight:600;line-height:1.3;" +
      "display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;" +
      "overflow:hidden;";

    const sub = document.createElement("div");
    // The type only when it is not an album: in the narrow view everything is
    // one, and repeating the word under every cover says nothing.
    sub.textContent = [
      album.year !== "????" ? album.year : "",
      album.primary && album.primary !== "Album" ? album.primary : "",
      (album.secondary || [])[0] || "",
    ]
      .filter(Boolean)
      .join(" · ");
    sub.style.cssText = "margin-top:2px;font-size:11px;color:#8b93a1;";

    card.append(art, name, sub);
    tile.appendChild(card);

    // Request button, only when the bridge answered the probe — the same way a
    // missing tile on an artist page gets one, and after the cover rather than
    // before it, so a slow probe never holds up the grid. An album with no
    // release-group id has nothing to ask with, and an artist Lidarr's
    // catalogue does not carry has nowhere to send it.
    if (album.mbid && album.requestable !== false) {
      probeBridge().then((ready) => {
        if (!ready || !tile.isConnected) return;
        const overlay = createRequestOverlay(album);
        overlay.style.borderRadius = "6px";
        // Pinned open at creation, using the same flag settle() sets. On an
        // artist page the overlay is revealed by hover listeners the tile gets
        // when it is built; here there is nothing to hover away to, and a
        // button sitting at zero opacity with nothing to reveal it is a bug
        // this script has already had once. The overlay is pointer-events:none
        // with the button pointer-events:auto, so pinning it costs nothing
        // underneath.
        overlay.dataset.pinned = "1";
        overlay.style.opacity = "1";
        tile.appendChild(overlay);
      });
    }

    return tile;
  }

  // ── The way in ───────────────────────────────────────────

  function hidePill() {
    const el = document.getElementById(PILL_ID);
    if (el) el.remove();
  }

  // The pill is placed from the input's own box, which is stale the moment the
  // list under it re-renders or the page scrolls — so it is re-measured on both
  // rather than left where it was drawn. An input that has gone (React swapped
  // the filter form, or the route changed) takes the pill with it.
  function positionPill() {
    const pill = document.getElementById(PILL_ID);
    if (!pill) return;
    const input = document.getElementById("search");
    if (!input || !input.isConnected) {
      hidePill();
      return;
    }
    const rect = input.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      hidePill();
      return;
    }
    const left = Math.min(rect.left, window.innerWidth - pill.offsetWidth - 12);
    pill.style.top = `${Math.round(rect.bottom + 8)}px`;
    pill.style.left = `${Math.round(Math.max(12, left))}px`;
  }

  function showPill(term, quiet) {
    let pill = document.getElementById(PILL_ID);
    if (!pill) {
      pill = document.createElement("div");
      pill.id = PILL_ID;
      pill.style.cssText =
        "position:fixed;z-index:1250;display:flex;align-items:center;gap:6px;" +
        "padding:6px 8px 6px 12px;border-radius:999px;background:#23272f;" +
        "color:#e8eaed;border:1px solid #3a4150;max-width:min(440px,86vw);" +
        "box-shadow:0 6px 22px rgba(0,0,0,.45);" +
        "font:12px/1.3 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;";

      const open = document.createElement("button");
      open.type = "button";
      open.dataset.ndlb = "pill-open";
      open.style.cssText =
        "cursor:pointer;border:0;background:transparent;color:inherit;" +
        "font:inherit;text-align:left;padding:2px 0;flex:1;min-width:0;" +
        "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      open.addEventListener("click", () => openFinder(pill.dataset.term || ""));

      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.textContent = "✕";
      dismiss.title =
        "Hide this for now. It comes back on the next page load, and " +
        "ndMissingAlbums.find(\"band name\") opens it from the console.";
      dismiss.style.cssText =
        "cursor:pointer;border:0;background:transparent;color:#8b93a1;" +
        "font-size:12px;line-height:1;padding:3px 5px;";
      dismiss.addEventListener("click", () => {
        pillDismissed = true;
        hidePill();
      });

      pill.append(open, dismiss);
      document.body.appendChild(pill);
    }

    pill.dataset.term = term;
    pill.querySelector('[data-ndlb="pill-open"]').textContent = quiet
      ? `Not the band you meant? Look on MusicBrainz`
      : `⌕ Search MusicBrainz for “${term}”`;
    positionPill();
  }

  function onSearchTyped(input) {
    clearTimeout(pillTimer);
    const term = (input.value || "").trim();

    if (
      pillDismissed ||
      !isNavidrome() ||
      !PILL_ROUTES.test(window.location.hash || "") ||
      term.length < MIN_QUERY
    ) {
      hidePill();
      return;
    }

    pillTimer = setTimeout(() => {
      // Still the same question by the time the debounce lands.
      if (!input.isConnected || (input.value || "").trim() !== term) return;
      ndCount(term).then((count) => {
        if (!input.isConnected || (input.value || "").trim() !== term) return;
        // Offered, never opened for them. The panel covers the page, and one
        // that appears by itself while somebody is still typing takes the
        // keyboard away mid-word.
        showPill(term, count !== 0);
      });
    }, PILL_DELAY_MS);
  }

  function wireSearchTrigger() {
    if (searchWired) return;
    searchWired = true;

    document.addEventListener(
      "input",
      (e) => {
        if (e.target && e.target.id === "search") onSearchTyped(e.target);
      },
      true
    );

    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Escape") return;
        // Not prevented: Navidrome's own search box clears itself on Escape and
        // should go on doing so.
        if (document.getElementById(PANEL_ID)) closePanel();
        else hidePill();
      },
      true
    );

    // Both do nothing at all while there is no pill, and a pill left behind by
    // a scrolled page is worse than no pill.
    window.addEventListener("scroll", positionPill, true);
    window.addEventListener("resize", positionPill);
  }

  // ── Init ─────────────────────────────────────────────────
  let started = false;

  function init() {
    // Registered before the gate rather than inside it. init() runs once at
    // document-idle and reads isNavidrome() exactly once, so a tab that landed
    // on #/ or #/personal — a bookmark, a reload on the player page — stayed
    // dead for the whole session however far the user navigated afterwards.
    // The listener costs nothing on a page that is not Navidrome, because the
    // handler asks the same question again every time it fires.
    window.addEventListener("hashchange", onHashChange);
    if (isNavidrome()) start();
  }

  // The route, not the whole hash. react-admin keeps a list's filter, sort and
  // page in the query string and pushes them
  // (`history.push({search: "?" + stringify({…, filter: JSON.stringify(…)})})`),
  // and Navidrome runs on hash history — so every keystroke in its own search
  // box, and every page the artist list pulls in as it is scrolled, fires
  // hashchange with the same route and a different "?". Tearing everything down
  // on those deleted the pill, which is this feature's only discoverable way
  // in, closed a panel the reader had just opened, and re-ran the artist check
  // once per keystroke. Only a genuine route change means the reader has moved
  // on from what is on screen.
  function routeOf(hash) {
    return String(hash || "").split("?")[0];
  }

  let lastRoute = routeOf(window.location.hash);

  function onHashChange() {
    if (!isNavidrome()) {
      lastRoute = routeOf(window.location.hash);
      closePanel();
      hidePill();
      return;
    }
    start();

    const route = routeOf(window.location.hash);
    if (route === lastRoute) return;
    lastRoute = route;

    currentArtistId = null;
    removeMessages();
    // A panel left open across a route change is answering a question the user
    // has moved on from. Closing it also bumps findSeq, which drops whatever
    // MusicBrainz lookup it had running — so the artist page about to load does
    // not end up sharing the rate limiter with it.
    closePanel();
    hidePill();
    scheduleCheck();
  }

  function start() {
    if (started) return;
    started = true;

    loadCache();
    pruneCache();
    console.log(LOG_PREFIX, `v${VERSION} ready`);
    // Reachable from the console without opening the script manager: when a
    // feature seems missing, the first question is always which version is
    // actually running, and the answer should not take five minutes to get.
    try {
      window.ndMissingAlbums = {
        version: VERSION,
        cacheShape: CACHE_SHAPE,
        // A way in that does not depend on the pill: the search box is not on
        // every route, the pill can be dismissed, and a bridge that came up
        // late may have missed its window to install one at all.
        find: (term) => openFinder(term),
      };
    } catch (_) {}

    const style = document.createElement("style");
    style.textContent = `
      [${MARKER}] { transition: transform 0.2s; }
      [${MARKER}]:hover { transform: scale(1.02); }
    `;
    document.head.appendChild(style);

    const observer = new MutationObserver(() => {
      if (window.location.hash.match(/^#\/artist\/[^/]+\/show/)) {
        scheduleCheck();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Only where a bridge answered its own health endpoint, and asked twice
    // more before giving up: a bridge that starts after the browser does would
    // otherwise be missed for the rest of the session, and there would be
    // nothing on screen to say a feature was ever meant to be there. With no
    // bridge at all nothing is installed and nothing is drawn — the script
    // behaves exactly as it did before any of this existed.
    let installTries = 0;
    const installFinder = () => {
      bridgeInfo(installTries > 0).then((info) => {
        if (info) wireSearchTrigger();
        else if (++installTries <= 2) setTimeout(installFinder, BRIDGE_REPROBE_MS);
      });
    };
    installFinder();

    scheduleCheck();
  }

  let checkTimer = null;
  function scheduleCheck() {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(processArtistPage, 800);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
