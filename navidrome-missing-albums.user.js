// ==UserScript==
// @name         Navidrome — Show Missing Albums (MusicBrainz)
// @namespace    https://github.com/danielbanariba/navidrome-missing-albums-userscript
// @version      1.7.5
// @description  On an artist page, fetch the full studio discography from MusicBrainz and overlay greyed-out placeholder tiles for albums missing from your Navidrome library. Optionally request them from Lidarr.
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

  async function probeBridge() {
    if (bridgeReady !== null) return bridgeReady;
    try {
      const res = await fetch(`${BRIDGE_BASE}/status`, { method: "GET" });
      // A failing bridge still answers 503 with a body, and a request would
      // still be accepted, so anything that replies counts as present.
      bridgeReady = res.status < 500 || res.status === 503;
    } catch (_) {
      bridgeReady = false;
    }
    return bridgeReady;
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
  let cache = { albums: {}, missing: {}, requested: {}, ts: {} };

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

  function saveCache() {
    try {
      localStorage.setItem("nd-missing-albums-cache", JSON.stringify(cache));
    } catch (_) {}
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
    }).then((r) => r.json());
  }

  function getArtistInfo(id) {
    return ndFetch(`/api/artist/${id}`);
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
  let lastMB = 0;

  async function mbFetch(url) {
    const wait = Math.max(0, 1100 - (Date.now() - lastMB));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastMB = Date.now();
    const r = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (!r.ok) throw new Error(`MB ${r.status}`);
    return r.json();
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
  async function getReleaseGroups(mbid) {
    if (cache.albums[mbid] && isFresh("rg2:" + mbid)) return cache.albums[mbid];

    const groups = [];
    let offset = 0;

    while (true) {
      const data = await mbFetch(
        `${MB_BASE}/release-group?artist=${mbid}&type=album&limit=100&offset=${offset}&fmt=json`
      );
      const page = data["release-groups"] || [];
      if (!page.length) break;

      for (const rg of page) {
        if (rg["primary-type"] !== "Album") continue;
        groups.push({
          title: rg.title,
          year: (rg["first-release-date"] || "????").slice(0, 4),
          mbid: rg.id,
          secondary: rg["secondary-types"] || [],
        });
      }

      offset += 100;
      if (offset >= (data["release-group-count"] || 0)) break;
    }

    groups.sort((a, b) => a.year.localeCompare(b.year));
    cache.albums[mbid] = groups;
    // A new freshness key, because an entry written by an older version was
    // already filtered and carries no secondary types to filter by.
    cache.ts["rg2:" + mbid] = Date.now();
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
  function normalize(name) {
    return name
      .toLowerCase()
      .replace(/\s*\(.*?\)\s*/g, " ")
      .replace(/\s*\[.*?\]\s*/g, " ")
      // Replaced with a space rather than deleted: dropping the hyphen turned
      // "Revenge-10th" into "revenge10th", which then no longer starts with
      // "revenge" — exactly what the prefix match below looks for.
      .replace(/[^\w\s]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
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
  function ownedMatcher(localAlbums) {
    const local = localAlbums.map((a) => normalize(a.name));
    return (title) => {
      const key = normalize(title);
      return local.some((have) => have === key || have.startsWith(key + " "));
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
  function setCoverWithRetry(img, album) {
    const url = `${CAA_BASE}/release-group/${album.mbid}/front-250`;
    let attempt = 0;

    img.alt = album.title;
    img.onerror = function () {
      if (attempt >= COVER_RETRIES) {
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

    if (container) {
      container.style.filter = "grayscale(100%)";
      container.style.opacity = "0.4";
      container.style.transition = "opacity 0.3s, filter 0.3s";

      container.addEventListener("mouseenter", () => {
        container.style.opacity = "0.65";
      });
      container.addEventListener("mouseleave", () => {
        container.style.opacity = "0.4";
      });
    }

    // Replace cover art
    const img = tile.querySelector("img");
    if (img) {
      // A record only Discogs lists has no release-group id, so there is no
      // Cover Art Archive entry to go and fetch — but Discogs itself has art.
      if (album.mbid) setCoverWithRetry(img, album);
      else {
        img.alt = album.title;
        img.onerror = function () {
          this.onerror = null;
          this.src = PLACEHOLDER_SVG;
        };
        img.src = album.cover || PLACEHOLDER_SVG;
      }
    }

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

    // "Not in library" badge. Top-left, so it does not sit under the request
    // button when the bridge is present.
    const imgWrapper = img?.closest("div");
    if (imgWrapper) {
      imgWrapper.style.position = "relative";
      const badge = document.createElement("div");
      badge.style.cssText =
        "position:absolute;top:6px;left:6px;background:rgba(0,0,0,0.72);" +
        "color:#b9bec7;font-size:9px;padding:2px 7px;border-radius:10px;" +
        "pointer-events:none;letter-spacing:0.6px;text-transform:uppercase;";
      // An album Lidarr has no id for cannot be fetched, and a badge that said
      // only "Not in library" next to no button would look broken rather than
      // explained.
      badge.textContent =
        album.requestable === false ? "Not on MusicBrainz" : "Not in library";
      imgWrapper.appendChild(badge);
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
      try {
        const res = await fetch(`${BRIDGE_BASE}/request`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Lidarr's own id when the bridge supplied one, which needs no
          // catalogue lookup on the way in.
          body: JSON.stringify(
            album.albumId ? { albumId: album.albumId } : { mbid: album.mbid }
          ),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          settle("Requested ✓", true);
          remember(album);
        } else {
          // 404 means Lidarr has not imported this artist yet, which is a
          // different problem from the album not existing.
          settle(res.status === 404 ? "Monitor artist first" : "Failed", false);
          btn.title = data.error || `HTTP ${res.status}`;
        }
      } catch (err) {
        settle("Failed", false);
        btn.title = String(err && err.message ? err.message : err);
        console.warn(LOG_PREFIX, "request failed", err);
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
    if (!held || !held.length) return;
    const byTitle = new Map(held.map((h) => [normalize(h.title), h]));

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
        byTitle.get(key) ||
        held.find((h) => {
          const cat = normalize(h.title);
          return cat && (key === cat || key.startsWith(cat + " "));
        });
      // Either id will do: Lidarr's own when it holds the artist, the
      // release-group id when it does not.
      if (!entry || !(entry.id || entry.mbid)) continue;

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

  // ── Status messages ──────────────────────────────────────
  function showLoading(grid) {
    removeMessages();
    const el = document.createElement("div");
    el.id = "missing-albums-loading";
    el.style.cssText =
      "padding:8px 16px;color:#888;font-size:13px;font-style:italic;";
    el.textContent = "Searching for missing albums on MusicBrainz…";
    grid.parentNode.insertBefore(el, grid);
  }

  function removeMessages() {
    document.getElementById("missing-albums-loading")?.remove();
    document.getElementById("missing-albums-counter")?.remove();
    document.getElementById("missing-albums-complete")?.remove();
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
        const msg = document.createElement("div");
        msg.style.cssText = "padding:8px 16px;color:#555;font-size:12px;";
        msg.textContent = "You have every studio album for this artist.";
        msg.id = "missing-albums-complete";
        grid.parentNode.insertBefore(msg, grid);
        setTimeout(() => msg.remove(), 4000);
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

      const counter = document.createElement("div");
      counter.id = "missing-albums-counter";
      counter.style.cssText = "padding:4px 16px 12px;color:#666;font-size:12px;";
      counter.textContent = `${missing.length} studio album(s) not in your library`;
      grid.parentNode.insertBefore(counter, grid);
    } catch (e) {
      console.error(LOG_PREFIX, "Error:", e);
      removeMessages();
    }

    working = false;
  }

  // ── Init ─────────────────────────────────────────────────
  function init() {
    if (!isNavidrome()) return;

    loadCache();
    console.log(LOG_PREFIX, `v${VERSION} ready`);
    // Reachable from the console without opening the script manager: when a
    // feature seems missing, the first question is always which version is
    // actually running, and the answer should not take five minutes to get.
    try {
      window.ndMissingAlbums = { version: VERSION, cacheShape: CACHE_SHAPE };
    } catch (_) {}

    const style = document.createElement("style");
    style.textContent = `
      [${MARKER}] { transition: transform 0.2s; }
      [${MARKER}]:hover { transform: scale(1.02); }
    `;
    document.head.appendChild(style);

    window.addEventListener("hashchange", () => {
      currentArtistId = null;
      removeMessages();
      scheduleCheck();
    });

    const observer = new MutationObserver(() => {
      if (window.location.hash.match(/^#\/artist\/[^/]+\/show/)) {
        scheduleCheck();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

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
