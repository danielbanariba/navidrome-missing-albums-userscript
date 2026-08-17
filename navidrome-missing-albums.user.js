// ==UserScript==
// @name         Navidrome — Show Missing Albums (MusicBrainz)
// @namespace    https://github.com/danielbanariba/navidrome-missing-albums-userscript
// @version      1.1.0
// @description  On an artist page, fetch the full studio discography from MusicBrainz and overlay greyed-out placeholder tiles for albums missing from your Navidrome library.
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
      .replace(/\s*\(.*?\)\s*/g, "")
      .replace(/\s*\[.*?\]\s*/g, "")
      .replace(/[^\w\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function findMissing(localAlbums, mbAlbums) {
    const local = new Set(localAlbums.map((a) => normalize(a.name)));
    return mbAlbums.filter((a) => !local.has(normalize(a.title)));
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
    if (img) setCoverWithRetry(img, album);

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

    // "Not in library" badge
    const imgWrapper = img?.closest("div");
    if (imgWrapper) {
      imgWrapper.style.position = "relative";
      const badge = document.createElement("div");
      badge.style.cssText =
        "position:absolute;bottom:6px;left:6px;background:rgba(0,0,0,0.75);" +
        "color:#999;font-size:10px;padding:2px 8px;border-radius:3px;" +
        "pointer-events:none;letter-spacing:0.5px;";
      badge.textContent = "Not in library";
      imgWrapper.appendChild(badge);
    }

    return tile;
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
      const missing = findMissing(localAlbums, mbAlbums);

      console.log(LOG_PREFIX, "MusicBrainz:", mbAlbums.length, "| Missing:", missing.length);

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
