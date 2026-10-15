import { distance } from "./wasm-match.js";
import {
  getAlbum, getAlbumTracks, getArtist, getArtistAlbums, getArtistTop, getRelatedArtists,
  getPlaylist, getPlaylistTracks, getTrack, getTrackRadio, mapAlbum, mapAlbumSummary,
  mapArtist, mapPlaylist, mapTrack, pagination, pipeGetAlbum, pipeGetArtist, rest, safeHttpsUrl, searchPipe, searchRest, version,
} from "./deezer.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-API-Key",
  "Access-Control-Max-Age": "86400",
};
const rateWindows = new Map();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: headers() });
    if (request.method !== "GET") return fail(405, "METHOD_NOT_ALLOWED", "This endpoint only accepts GET requests.", requestId, { Allow: "GET, OPTIONS" });

    const authError = authorize(request, env);
    if (authError) return fail(401, "UNAUTHORIZED", authError, requestId);
    const rateError = checkRateLimit(request);
    if (rateError) return fail(429, "RATE_LIMITED", "Too many requests from this client. Retry shortly.", requestId, { "Retry-After": "15" });

    const route = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (route === "/") return json({ version: version(), Repo: "Deezer catalog API rebuild (Tidal HiFi response-schema compatibility)" });
      if (route === "/info") return await trackInfo(url);
      if (route === "/track") return await trackManifestLegacy(url);
      if (route === "/trackManifests") return await trackManifests(url);
      if (route === "/recommendations") return await recommendations(url);
      if (route === "/search") return await search(url, env);
      if (route === "/album") return await album(url, env);
      if (route === "/mix") return await mix(url);
      if (route === "/playlist") return await playlist(url);
      if (route === "/cover") return await cover(url);
      if (route === "/artist") return await artist(url, env);
      if (route === "/artist/similar") return await similarArtists(url);
      if (route === "/lyrics") return fail(501, "LYRICS_NOT_EXPOSED", "Deezer's public catalog API does not provide a supported lyrics endpoint. This rebuild deliberately does not proxy full copyrighted lyrics.", requestId);
      return fail(404, "ROUTE_NOT_FOUND", "This route is not part of the Deezer rebuild. Tidal-only Widevine and video routes are intentionally excluded.", requestId);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 502;
      const message = publicMessage(error?.message, status);
      return fail(status, error?.status === 404 ? "NOT_FOUND" : status === 429 ? "UPSTREAM_RATE_LIMITED" : "UPSTREAM_ERROR", message, requestId);
    }
  },
};

async function trackInfo(url) {
  const id = requiredId(url);
  const t = await getTrack(id);
  return json({ version: version(), data: mapTrack(t) });
}

async function trackManifestLegacy(url) {
  const id = requiredId(url);
  const requestedQuality = (url.searchParams.get("quality") || "PREVIEW").toUpperCase();
  if (!["PREVIEW", "MP3_PREVIEW"].includes(requestedQuality)) {
    return fail(406, "QUALITY_UNAVAILABLE", "This public Deezer adapter supports only Deezer's official MP3 preview, not full-track or lossless manifests.");
  }
  const t = await getTrack(id);
  const preview = safeHttpsUrl(t.preview);
  if (!preview) return fail(404, "PREVIEW_UNAVAILABLE", "Deezer did not provide a preview URL for this track.");
  const manifestObject = { mimeType: "audio/mpeg", codecs: "mp3", encryptionType: "NONE", presentation: "PREVIEW", urls: [preview] };
  return json({ version: "3.0", data: {
    trackId: Number(t.id), assetPresentation: "PREVIEW", audioMode: "STEREO", audioQuality: "PREVIEW",
    manifestMimeType: "application/json", manifest: toBase64(JSON.stringify(manifestObject)),
    previewDuration: 30, previewUrl: preview,
  } });
}

async function trackManifests(url) {
  const id = requiredId(url);
  const normalized = url.searchParams.getAll("formats").flatMap(v => v.split(",")).map(v => v.trim().toUpperCase()).filter(Boolean);
  if (normalized.length && !normalized.some(v => ["PREVIEW", "MP3_PREVIEW"].includes(v))) {
    return fail(406, "FORMAT_UNAVAILABLE", "Only Deezer's official preview MP3 is available from this adapter; requested lossless/full-track formats are not exposed.");
  }
  const t = await getTrack(id);
  const preview = safeHttpsUrl(t.preview);
  if (!preview) return fail(404, "PREVIEW_UNAVAILABLE", "Deezer did not provide a preview URL for this track.");
  const useData = (url.searchParams.get("uriScheme") || "HTTPS").toUpperCase() === "DATA";
  const manifest = { mimeType: "audio/mpeg", codecs: "mp3", encryptionType: "NONE", presentation: "PREVIEW", urls: [preview] };
  const uri = useData ? `data:application/json;base64,${toBase64(JSON.stringify(manifest))}` : preview;
  const self = `${url.pathname}${url.search}`;
  return json({ version: "2.7", data: { data: {
    id: String(t.id), type: "trackManifests", attributes: {
      trackPresentation: "PREVIEW", uri, formats: ["MP3_PREVIEW"], previewDuration: 30,
      ...(useData ? { manifestMimeType: "application/json" } : {}),
    },
  }, links: { self } } });
}

async function recommendations(url) {
  const id = requiredId(url);
  const limit = numberParam(url, "limit", 20, 1, 100);
  const offset = numberParam(url, "offset", 0, 0, 5000);
  const radio = await getTrackRadio(id, limit, offset);
  const tracks = (radio.data || []).map(t => ({ track: mapTrack(t), sources: ["SUGGESTED_TRACKS"] }));
  return json({ version: version(), data: { limit, offset, totalNumberOfItems: Number(radio.total ?? radio.data?.length ?? 0), items: tracks } });
}

async function search(url, env) {
  const keys = ["s", "a", "al", "p", "i", "v"].filter(k => url.searchParams.has(k) && url.searchParams.get(k) !== "");
  if (keys.length !== 1) return fail(400, "INVALID_SEARCH", "Specify exactly one search parameter: s (track), a (artist), al (album), p (playlist), or i (ISRC). The Tidal-only video search key v is not supported.");
  const key = keys[0];
  if (key === "v") return fail(404, "ROUTE_NOT_SUPPORTED", "Deezer's public catalog does not expose the Tidal video-search route.");
  const q = url.searchParams.get(key).trim();
  if (!q) return fail(400, "MISSING_QUERY", "Search query must not be empty.");
  const limit = numberParam(url, "limit", 25, 1, 100);
  const offset = numberParam(url, "offset", 0, 0, 5000);
  const type = ({ s: "track", a: "artist", al: "album", p: "playlist", i: "track" })[key];

  // Use Pipe GraphQL first for page-zero catalog search when configured. Offset paging stays on REST,
  // because Pipe is cursor-paginated and should not fake an offset from a cursor-less request.
  if (env?.DEEZER_ARL && offset === 0 && key !== "i") {
    try {
      const [pipe, countResponse] = await Promise.all([searchPipe(q, limit, env), searchRest(type === "track" ? "" : type, q, 1, 0).catch(() => null)]);
      const results = pipe?.search?.results;
      if (results) {
        const branch = ({ s: results.tracks, a: results.artists, al: results.albums, p: results.playlists })[key];
        const nodes = edges(branch).map(n => mapPipeSearchItem(key, n));
        const dataKey = ({ a: "artists", al: "albums", p: "playlists" })[key];
        const payload = { limit, offset, totalNumberOfItems: Number(countResponse?.total ?? nodes.length), items: nodes };
        return json({ version: version(), data: dataKey ? { [dataKey]: payload } : payload });
      }
    } catch (_) {
      // Public REST fallback is intentional: catalog access remains functional if Pipe changes.
    }
  }
  const found = await searchRest(type === "track" ? "" : type, q, Math.min(100, limit), offset);
  let list = Array.isArray(found.data) ? found.data : [];
  if (key === "i") {
    const target = q.toUpperCase();
    list = list.filter(x => String(x.isrc || "").toUpperCase() === target);
  }
  const mapped = list.map(item => key === "a" ? mapArtist(item) : key === "al" ? mapAlbumSummary(item) : key === "p" ? mapPlaylist(item) : mapTrack(item));
  const dataKey = ({ a: "artists", al: "albums", p: "playlists" })[key];
  const payload = { limit: Math.min(100, limit), offset, totalNumberOfItems: key === "i" ? mapped.length : Number(found.total ?? mapped.length), items: mapped };
  return json({ version: version(), data: dataKey ? { [dataKey]: payload } : payload });
}

function mapPipeSearchItem(key, n) {
  const urlOf = x => {
    if (!x) return null;
    if (typeof x === "string") return x;
    if (Array.isArray(x)) return urlOf(x[0]);
    return x.url || x.webUrl || x.src || x.href || null;
  };
  const arts = edges(n.contributors).map(e => e.node || e).filter(a => a?.id != null).map(a => ({ id: numericId(a.id), name: a.name || "" }));
  if (key === "s") return {
    id: numericId(n.id), title: n.title || "", duration: Number(n.duration || 0), explicit: Boolean(n.isExplicit),
    url: `https://www.deezer.com/track/${encodeURIComponent(n.id)}`,
    ...(arts.length ? { artist: arts[0], artists: arts } : {}),
    ...(n.album ? { album: { id: numericId(n.album.id), title: n.album.displayTitle || "", cover: urlOf(n.album.cover?.urls), url: `https://www.deezer.com/album/${encodeURIComponent(n.album.id)}` } } : {}),
  };
  if (key === "a") return { id: numericId(n.id), name: n.name || "", url: `https://www.deezer.com/artist/${encodeURIComponent(n.id)}`, picture: urlOf(n.picture?.urls) };
  if (key === "al") return { id: numericId(n.id), title: n.displayTitle || "", type: n.type || null, url: `https://www.deezer.com/album/${encodeURIComponent(n.id)}`, cover: urlOf(n.cover?.urls), releaseDate: n.releaseDate || null, artists: edges(n.contributors).map(e => ({ id: numericId((e.node || e).id), name: (e.node || e).name || "" })) };
  return { id: numericId(n.id), title: n.title || "", numberOfTracks: Number(n.estimatedTracksCount || 0), url: `https://www.deezer.com/playlist/${encodeURIComponent(n.id)}`, image: urlOf(n.picture?.urls), ...(n.owner ? { creator: { id: numericId(n.owner.id), name: n.owner.name || "" } } : {}) };
}

async function album(url, env) {
  const id = requiredId(url);
  const limit = numberParam(url, "limit", 100, 1, 100);
  const offset = numberParam(url, "offset", 0, 0, 5000);
  if (env?.DEEZER_ARL && offset === 0) {
    try {
      const p = await pipeGetAlbum(id, limit, env);
      if (p) {
        const mapped = mapPipeAlbum(p);
        const trackNodes = edges(p.tracks);
        return json({ version: version(), data: {
          ...mapped, numberOfTracks: Number(p.tracksCount ?? trackNodes.length),
          items: trackNodes.map(t => ({ item: mapPipeSearchItem("s", t), type: "track" })),
          pagination: { limit, offset, totalNumberOfItems: Number(p.tracksCount ?? trackNodes.length), hasNextPage: Boolean(p.tracks?.pageInfo?.hasNextPage), nextCursor: p.tracks?.pageInfo?.endCursor || null },
        } });
      }
    } catch (_) { /* REST fallback below. */ }
  }
  const [a, tracks] = await Promise.all([getAlbum(id), getAlbumTracks(id, limit, offset)]);
  return json({ version: version(), data: { ...mapAlbum(a), numberOfTracks: Number(a.nb_tracks ?? tracks.total ?? 0), items: (tracks.data || []).map(t => ({ item: mapTrack(t, a), type: "track" })), pagination: { limit, offset, totalNumberOfItems: Number(tracks.total ?? 0) } } });
}

async function mix(url) {
  const id = requiredId(url);
  const limit = numberParam(url, "limit", 60, 1, 100);
  const offset = numberParam(url, "offset", 0, 0, 5000);
  const [source, radio] = await Promise.all([getTrack(id), getTrackRadio(id, limit, offset)]);
  const items = (radio.data || []).map(mapTrack);
  const cover = source.album?.cover_xl || source.album?.cover_big || source.album?.cover || null;
  return json({ version: version(), mix: {
    id: String(source.id), title: `${source.title || "Track"} Radio`, subTitle: source.artist?.name || "Deezer",
    description: "Tracks related to the selected Deezer track.", mixType: "TRACK_RADIO", contentBehavior: "UNRESTRICTED",
    ...(cover ? { images: { LARGE: { width: 1000, height: 1000, url: cover } } } : {}),
  }, items, pagination: { limit, offset, totalNumberOfItems: Number(radio.total ?? radio.data?.length ?? 0) } });
}

async function playlist(url) {
  const id = requiredId(url);
  const limit = numberParam(url, "limit", 100, 1, 100);
  const offset = numberParam(url, "offset", 0, 0, 5000);
  const [p, tracks] = await Promise.all([getPlaylist(id), getPlaylistTracks(id, limit, offset)]);
  return json({ version: version(), playlist: {
    ...mapPlaylist(p), items: (tracks.data || []).map(t => ({ item: mapTrack(t), type: "track" })),
    pagination: { limit, offset, totalNumberOfItems: Number(tracks.total ?? p.nb_tracks ?? 0) },
  } });
}

function mapPipePicture(value) {
  if (!value) return null;
  const urls = value.urls;
  if (typeof urls === "string") return urls;
  if (Array.isArray(urls)) {
    const first = urls[0];
    return typeof first === "string" ? first : first?.url || first?.webUrl || null;
  }
  if (urls && typeof urls === "object") return urls.url || urls.webUrl || urls.src || null;
  return null;
}
function mapPipeArtist(a) {
  return {
    id: numericId(a.id), name: a.name || "", link: a.url?.webUrl || `https://www.deezer.com/artist/${encodeURIComponent(a.id)}`,
    picture: mapPipePicture(a.picture), fansCount: a.fansCount ?? null, biography: a.bio?.full || null,
  };
}
function mapPipeAlbum(a) {
  const artists = edges(a.contributors).map(n => n.node || n).filter(x => x?.id != null).map(x => ({ id: numericId(x.id), name: x.name || "" }));
  return {
    id: numericId(a.id), title: a.displayTitle || "", duration: Number(a.duration || 0),
    numberOfTracks: Number(a.tracksCount || 0), numberOfVolumes: Number(a.discsCount || 1),
    ...(a.releaseDate ? { releaseDate: a.releaseDate } : {}), ...(a.type ? { type: String(a.type) } : {}),
    ...(a.isTakenDown ? { allowStreaming: false } : {}),
    url: a.url?.webUrl || `https://www.deezer.com/album/${encodeURIComponent(a.id)}`,
    ...(mapPipePicture(a.cover) ? { cover: mapPipePicture(a.cover) } : {}),
    ...(artists.length ? { artists, artist: artists[0] } : {}),
  };
}

async function cover(url) {
  const id = url.searchParams.get("id");
  const q = url.searchParams.get("q");
  if (!id && !q) return fail(400, "MISSING_IDENTIFIER", "Provide a track id or search query q.");
  let t;
  if (id) {
    if (!/^\d+$/.test(id)) return fail(400, "INVALID_ID", "Track id must be numeric.");
    t = await getTrack(id);
  } else {
    const found = await searchRest("", q, 25, 0);
    const list = found.data || [];
    if (!list.length) return json({ version: version(), covers: [] });
    const needle = cleanForMatch(q);
    let best = list[0];
    let bestScore = Infinity;
    for (const candidate of list) {
      const titleScore = await distance(needle, cleanForMatch(candidate.title || ""));
      const artistScore = await distance(needle, cleanForMatch(candidate.artist?.name || ""));
      const score = Math.min(titleScore, artistScore + Math.max(0, needle.length - 4));
      if (score < bestScore) { bestScore = score; best = candidate; }
    }
    t = best;
  }
  const a = t.album || {};
  const small = a.cover_small || a.cover || t.album?.cover;
  const medium = a.cover_medium || a.cover_big || small;
  const large = a.cover_big || a.cover_xl || medium;
  const xl = a.cover_xl || large;
  return json({ version: version(), covers: [{
    id: numericId(a.id ?? t.id), name: a.title || t.title || "",
    small: small || null, medium: medium || null, large: large || null, xl: xl || null,
  }] });
}

async function artist(url, env) {
  const id = url.searchParams.get("id");
  const f = url.searchParams.get("f");
  if (!id && !f) return fail(400, "MISSING_IDENTIFIER", "Provide id for artist metadata or f for discography/track aggregation.");
  const artistId = id || f;
  if (!/^\d+$/.test(artistId)) return fail(400, "INVALID_ID", "Artist id must be numeric.");
  let pipeArtist = null;
  if (env?.DEEZER_ARL) {
    try { pipeArtist = await pipeGetArtist(artistId, env); } catch (_) { /* REST fallback below. */ }
  }
  const a = pipeArtist ? mapPipeArtist(pipeArtist) : await getArtist(artistId);
  const image = a.picture_xl || a.picture_big || a.picture_medium || a.picture || null;
  if (!f) return json({ version: version(), artist: {
    ...mapArtist(a), ...(a.nb_album != null ? { numberOfAlbums: Number(a.nb_album) } : {}),
    ...(a.nb_fan != null ? { fans: Number(a.nb_fan) } : {}), ...(a.fansCount != null ? { fans: Number(a.fansCount) } : {}),
    ...(a.biography ? { biography: a.biography } : {}),
  }, ...(image ? { cover: { id: numericId(a.id), name: a.name, large: image } } : {}) });

  const skipTracks = ["1", "true", "yes"].includes(String(url.searchParams.get("skip_tracks") || "false").toLowerCase());
  const limit = numberParam(url, "limit", 25, 1, 100);
  const offset = numberParam(url, "offset", 0, 0, 5000);
  const albumsResponse = await getArtistAlbums(artistId, limit, offset);
  const albums = albumsResponse.data || [];
  let tracks = [];
  if (skipTracks) {
    const top = await getArtistTop(artistId, Math.min(100, limit));
    tracks = (top.data || []).map(mapTrack);
  } else {
    // Aggregation is only performed on explicit f-mode requests, bounded to four album requests at once.
    const selected = albums.slice(0, Math.min(albums.length, 40));
    const chunks = [];
    for (let i = 0; i < selected.length; i += 4) {
      const group = selected.slice(i, i + 4);
      const pages = await Promise.all(group.map(al => rest(`album/${encodeURIComponent(String(al.id))}/tracks`, { limit: 100, index: 0 }).catch(() => ({ data: [] }))));
      chunks.push(...pages);
    }
    tracks = chunks.flatMap(p => p.data || []).map(mapTrack);
  }
  return json({ version: version(), albums: pagination({ ...albumsResponse, data: albums.map(a => mapAlbum(a)) }, limit, offset), tracks });
}

async function similarArtists(url) {
  const id = requiredId(url);
  const limit = numberParam(url, "limit", 25, 1, 100);
  const offset = numberParam(url, "offset", 0, 0, 5000);
  const [source, response] = await Promise.all([getArtist(id), getRelatedArtists(id, limit, offset)]);
  const items = (response.data || []).map(mapArtist);
  return json({ version: version(), data: {
    limit, offset, totalNumberOfItems: Number(response.total ?? response.data?.length ?? 0),
    artist: mapArtist(source), items,
  } });
}

function requiredId(url) {
  const id = url.searchParams.get("id");
  if (!id) throw Object.assign(new Error("Required query parameter: id"), { status: 400 });
  if (!/^\d+$/.test(id)) throw Object.assign(new Error("id must be a numeric Deezer catalog identifier"), { status: 400 });
  return id;
}
function numberParam(url, name, fallback, min, max) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw Object.assign(new Error(`${name} must be a non-negative integer`), { status: 400 });
  return Math.max(min, Math.min(max, Number(raw)));
}
function edges(x) { return Array.isArray(x) ? x.map(e => e?.node ?? e).filter(Boolean) : (Array.isArray(x?.edges) ? x.edges.map(e => e?.node ?? e).filter(Boolean) : []); }
function numericId(value) { const n = Number(value); return Number.isFinite(n) ? n : String(value ?? ""); }
function cleanForMatch(value) { return String(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\b(track|artist|album):/g, " ").replace(/[\"'()[\]{}]/g, " ").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim(); }
function toBase64(text) { return btoa(Array.from(new TextEncoder().encode(text), b => String.fromCharCode(b)).join("")); }
function authorize(request, env) {
  if (!env?.API_KEY) return null;
  const bearer = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  const provided = bearer || request.headers.get("X-API-Key");
  return provided === env.API_KEY ? null : "Provide the configured API key in Authorization: Bearer or X-API-Key.";
}
function checkRateLimit(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const now = Date.now();
  const current = rateWindows.get(ip);
  if (!current || now >= current.reset) {
    rateWindows.set(ip, { count: 1, reset: now + 60_000 });
    if (rateWindows.size > 2000) for (const [k, v] of rateWindows) if (now >= v.reset) rateWindows.delete(k);
    return false;
  }
  current.count += 1;
  return current.count > 120;
}
function headers(extra = {}) { return { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store, max-age=0", "X-Content-Type-Options": "nosniff", ...extra }; }
function json(value, status = 200, extra = {}) { return new Response(JSON.stringify(value), { status, headers: headers(extra) }); }
function fail(status, code, message, requestId = crypto.randomUUID(), extra = {}) { return json({ version: version(), error: { code, message, requestId } }, status, extra); }
function publicMessage(message, status) {
  if (status >= 500) return "The upstream service failed or returned an unsupported response. Retry later; no catalog response has been cached.";
  return String(message || "Request failed").slice(0, 240);
}
