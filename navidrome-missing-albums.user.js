// ==UserScript==
// @name         Navidrome — Show Missing Albums (MusicBrainz)
// @namespace    https://github.com/danielbanariba/navidrome-missing-albums-userscript
// @version      1.3.0
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

  const MB_BASE = "https://musicbrainz.org/ws/2";
  const CAA_BASE = "https://coverartarchive.org";
  const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
  const MARKER = "data-missing-album";
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

  async function bridgeMissing(artistId) {
    // The bridge answers a better question than this script can ask alone. It
    // identifies the artist by matching the library's own albums against each
    // candidate's catalogue, which searching MusicBrainz by name cannot do:
    // ten artists are called "Delirium" and the search returns the wrong one
    // first. It also widens the result with Discogs, which lists records
    // MusicBrainz has never heard of.
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
      return (data.missing || []).map((a) => ({
        title: a.title,
        year: a.year || "????",
        // Absent for a record only Discogs knows: no cover art to fetch, and
        // nothing Lidarr can be asked for.
        mbid: a.mbid || null,
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
  let cache = { artists: {}, albums: {}, ts: {} };

  function loadCache() {
    try {
      const raw = localStorage.getItem("nd-missing-albums-cache");
      if (raw) cache = JSON.parse(raw);
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

  function getArtistAlbums(id) {
    const filter = encodeURIComponent(JSON.stringify({ artist_id: id }));
    return ndFetch(
      `/api/album?filter=${filter}&sort=["max_year","ASC"]&range=[0,499]`
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

  async function findArtistMBID(name, mbzId) {
    if (mbzId) return mbzId;

    const key = name.toLowerCase();
    if (cache.artists[key] !== undefined && isFresh("a:" + key))
      return cache.artists[key];

    const data = await mbFetch(
      `${MB_BASE}/artist/?query=artist:"${encodeURIComponent(name)}"&limit=5&fmt=json`
    );

    let mbid = null;
    for (const a of data.artists || []) {
      if (a.name.toLowerCase() === key) {
        mbid = a.id;
        break;
      }
    }
    if (!mbid && data.artists?.[0]?.score >= 90) {
      mbid = data.artists[0].id;
    }

    cache.artists[key] = mbid;
    cache.ts["a:" + key] = Date.now();
    saveCache();
    return mbid;
  }

  async function getStudioAlbums(mbid) {
    if (cache.albums[mbid] && isFresh("rg:" + mbid)) return cache.albums[mbid];

    const albums = [];
    let offset = 0;

    while (true) {
      const data = await mbFetch(
        `${MB_BASE}/release-group?artist=${mbid}&type=album&limit=100&offset=${offset}&fmt=json`
      );
      const groups = data["release-groups"] || [];
      if (!groups.length) break;

      for (const rg of groups) {
        if (rg["primary-type"] !== "Album") continue;
        const secondary = rg["secondary-types"] || [];
        if (secondary.some((s) => EXCLUDED_SECONDARY.has(s))) continue;

        albums.push({
          title: rg.title,
          year: (rg["first-release-date"] || "????").slice(0, 4),
          mbid: rg.id,
        });
      }

      offset += 100;
      if (offset >= (data["release-group-count"] || 0)) break;
    }

    albums.sort((a, b) => a.year.localeCompare(b.year));
    cache.albums[mbid] = albums;
    cache.ts["rg:" + mbid] = Date.now();
    saveCache();
    return albums;
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

  function findMissing(localAlbums, mbAlbums) {
    const local = localAlbums.map((a) => normalize(a.name));

    // A local copy often carries an edition suffix the catalogue title does not
    // — "…Revenge-10th Anniversary Edition" against plain "…Revenge" — and those
    // suffixes are not always parenthesised, so a prefix match is needed. Only
    // in that direction: a plain local title must not satisfy a longer, distinct
    // catalogue entry.
    const owned = (title) => {
      const key = normalize(title);
      return local.some((have) => have === key || have.startsWith(key + " "));
    };

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
        this.src = PLACEHOLDER_SVG;
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
      // Cover Art Archive entry to go and fetch.
      if (album.mbid) setCoverWithRetry(img, album);
      else {
        img.src = PLACEHOLDER_SVG;
        img.alt = album.title;
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
  function createRequestOverlay(album) {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:absolute;top:0;left:0;width:100%;aspect-ratio:1;z-index:2;" +
      "display:flex;align-items:center;justify-content:center;" +
      "background:linear-gradient(180deg,rgba(0,0,0,0) 35%,rgba(0,0,0,0.55) 100%);" +
      "opacity:0;transition:opacity .18s ease;pointer-events:none;";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Request";
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
    const settle = (text, ok) => {
      btn.textContent = text;
      btn.disabled = true;
      btn.style.cursor = "default";
      btn.style.borderColor = "transparent";
      btn.style.background = ok ? "rgba(46,125,79,.95)" : "rgba(142,59,52,.95)";
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

    overlay.appendChild(btn);
    return overlay;
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

    grid
      .querySelectorAll(`[${MARKER}]`)
      .forEach((el) => el.remove());
    removeMessages();

    try {
      showLoading(grid);

      const [artistInfo, localAlbums] = await Promise.all([
        getArtistInfo(artistId),
        getArtistAlbums(artistId),
      ]);

      console.log(LOG_PREFIX, "Artist:", artistInfo?.name, "| Local albums:", localAlbums?.length);

      if (!artistInfo?.name) {
        removeMessages();
        working = false;
        return;
      }

      let missing = (await probeBridge()) ? await bridgeMissing(artistId) : null;

      if (missing) {
        console.log(LOG_PREFIX, "Bridge | Missing:", missing.length);
      } else {
        const mbid = await findArtistMBID(
          artistInfo.name,
          artistInfo.mbzArtistId
        );
        console.log(LOG_PREFIX, "MBID:", mbid);

        if (!mbid) {
          removeMessages();
          working = false;
          return;
        }

        const mbAlbums = await getStudioAlbums(mbid);
        missing = findMissing(localAlbums, mbAlbums);

        console.log(LOG_PREFIX, "MusicBrainz:", mbAlbums.length, "| Missing:", missing.length);
      }

      removeMessages();

      if (!missing.length) {
        const msg = document.createElement("div");
        msg.style.cssText = "padding:8px 16px;color:#555;font-size:12px;";
        msg.textContent = "You have every studio album for this artist.";
        msg.id = "missing-albums-complete";
        grid.parentNode.insertBefore(msg, grid);
        setTimeout(() => msg.remove(), 4000);
        working = false;
        return;
      }

      const template = existingTiles[0];

      for (const album of missing) {
        const tile = createMissingTile(album, template);
        insertByYear(grid, tile, album);
      }

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
    console.log(LOG_PREFIX, "v1.1.0 ready");

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
