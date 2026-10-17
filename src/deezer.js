const REST = "https://api.deezer.com";
const PIPE = "https://pipe.deezer.com/api";
const AUTH = "https://auth.deezer.com/login/arl";
const APP_VERSION = "3.2.2";

let jwt = "";
let jwtExpiresAt = 0;
let jwtPromise = null;
let authCookies = new Map();

export function version() { return APP_VERSION; }

export async function rest(path, params = {}) {
  const url = new URL(path.replace(/^\//, ""), `${REST}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const bodyText = await response.text();
  let body;
  try { body = JSON.parse(bodyText); }
  catch { throw upstreamError("Deezer REST returned invalid JSON", response.status || 502); }
  if (!response.ok || body?.error) {
    const status = body?.error?.code === 4 ? 429 : response.status >= 400 ? response.status : 502;
    throw upstreamError(body?.error?.message || `Deezer REST HTTP ${response.status}`, status, body?.error?.code);
  }
  return body;
}

async function getJwt(env) {
  if (!env?.DEEZER_ARL) return null;
  if (jwt && Date.now() / 1000 < jwtExpiresAt - 30) return jwt;
  if (jwtPromise) return jwtPromise;
  jwtPromise = (async () => {
    const url = new URL(AUTH);
    url.searchParams.set("jo", "p");
    url.searchParams.set("rto", "c");
    url.searchParams.set("i", "c");
    const cookieHeader = [`arl=${env.DEEZER_ARL}`, ...Array.from(authCookies, ([k, v]) => `${k}=${v}`)].join("; ");
    const response = await fetch(url, {
      method: "POST",
      headers: { Cookie: cookieHeader, Accept: "application/json,text/plain,*/*" },
    });
    const setCookies = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : (response.headers.get("Set-Cookie") ? [response.headers.get("Set-Cookie")] : []);
    for (const cookie of setCookies) {
      const first = cookie.split(";")[0];
      const equals = first.indexOf("=");
      if (equals > 0) {
        const name = first.slice(0, equals).trim();
        if (name.toLowerCase() !== "arl") authCookies.set(name, first.slice(equals + 1).trim());
      }
    }
    const text = await response.text();
    if (!response.ok) throw upstreamError(`Deezer authentication failed (HTTP ${response.status})`, response.status === 401 ? 401 : 502);
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw upstreamError("Unexpected Deezer authentication response", 502); }
    if (typeof parsed.jwt !== "string") throw upstreamError("Deezer did not return a JWT", 502);
    const payloadPart = parsed.jwt.split(".")[1];
    if (!payloadPart) throw upstreamError("Malformed Deezer JWT", 502);
    const base64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
    jwt = parsed.jwt;
    jwtExpiresAt = Number(payload.exp) || (Date.now() / 1000 + 300);
    return jwt;
  })();
  try { return await jwtPromise; }
  finally { jwtPromise = null; }
}

export async function pipeQuery(query, variables, env) {
  const token = await getJwt(env);
  if (!token) return null;
  const response = await fetch(PIPE, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json", ...(authCookies.size ? { Cookie: Array.from(authCookies, ([k, v]) => `${k}=${v}`).join("; ") } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  const raw = await response.text();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw upstreamError("Pipe GraphQL returned invalid JSON", 502); }
  if (!response.ok) throw upstreamError(`Pipe GraphQL HTTP ${response.status}`, response.status >= 500 ? 502 : response.status);
  if (parsed.errors?.length && !parsed.data) throw upstreamError(parsed.errors[0]?.message || "Pipe GraphQL query failed", 502);
  if (parsed.errors?.length && parsed.data) {
    // Keep partial GraphQL success, matching current Pipe API behavior.
  }
  return parsed.data ?? null;
}

export async function pipeGetAlbum(id, limit, env) {
  const query = `query DeezerAlbum($albumId: String!, $tracksFirst: Int!) {
    album(albumId: $albumId) {
      id displayTitle type duration tracksCount discsCount releaseDate isTakenDown
      cover { id urls(pictureRequest: { width: 1000, height: 1000 }) }
      contributors(first: 5, roles: [MAIN]) { edges { node { ... on Artist { id name } } } }
      url { ... on Url { webUrl } }
      tracks(first: $tracksFirst) {
        edges { cursor node {
          id title ISRC duration isExplicit diskInfo { diskNumber trackNumber }
          album { id displayTitle cover { id urls(pictureRequest: { width: 500, height: 500 }) } }
          contributors(first: 10, roles: [MAIN, FEATURED]) { edges { roles node { ... on Artist { id name } } } }
        } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;
  const data = await pipeQuery(query, { albumId: String(id), tracksFirst: limit }, env);
  return data?.album ?? null;
}

export async function pipeGetArtist(id, env) {
  const query = `query DeezerArtist($artistId: String!) {
    artist(artistId: $artistId) {
      id name fansCount isFavorite bio { full }
      picture { id urls(pictureRequest: { width: 500, height: 500 }) }
      url { ... on Url { webUrl } }
    }
  }`;
  const data = await pipeQuery(query, { artistId: String(id) }, env);
  return data?.artist ?? null;
}

export async function searchPipe(q, limit, env) {
  const query = `query DeezerCatalogSearch($query: String!, $tracksFirst: Int!, $albumsFirst: Int!, $artistsFirst: Int!, $playlistsFirst: Int!) {
    search(query: $query) { results {
      tracks(first: $tracksFirst) { edges { node { id title duration isExplicit
        media { estimatedSizes { MP3_128 MP3_320 FLAC } rights { user { full { available } } sub { available } } }
        album { id displayTitle cover { urls(pictureRequest: { width: 500, height: 500 }) } }
        contributors(first: 3, roles: [MAIN, FEATURED]) { edges { node { ... on Artist { id name } } } }
      } } }
      albums(first: $albumsFirst) { edges { node { id displayTitle type releaseDate isExplicit cover { urls(pictureRequest: { width: 500, height: 500 }) } contributors(first: 3, roles: [MAIN]) { edges { node { ... on Artist { id name } } } } } } }
      artists(first: $artistsFirst) { edges { node { id name picture { urls(pictureRequest: { width: 500, height: 500 }) } } } }
      playlists(first: $playlistsFirst) { edges { node { id title estimatedTracksCount picture { urls(pictureRequest: { width: 500, height: 500 }) } owner { id name } } } }
    } } }`;
  return pipeQuery(query, {
    query: q,
    tracksFirst: limit,
    albumsFirst: Math.min(25, limit),
    artistsFirst: Math.min(25, limit),
    playlistsFirst: Math.min(25, limit),
  }, env);
}


export async function pipeGetTrackLyrics(id, env) {
  const trackId = String(id ?? "");
  if (!/^\d+$/.test(trackId)) throw Object.assign(new Error("id must be a numeric Deezer catalog identifier"), { status: 400 });
  const query = `query DeezerTrackLyrics($trackId: String!) {
    track(trackId: $trackId) {
      id title duration
      lyrics {
        id text licence copyright writers
        synchronizedLines { lrcTimestamp line lineTranslated milliseconds duration }
        synchronizedWordByWordLines { start end words { start end word } }
      }
    }
  }`;
  const data = await pipeQuery(query, { trackId }, env);
  return data?.track ?? null;
}

export async function pipeGetTrackQualities(trackIds, env) {
  const ids = [...new Set((trackIds || []).map(String).filter(id => /^\d+$/.test(id)))].slice(0, 100);
  if (!ids.length) return {};
  const declarations = ids.map((_, i) => `$id${i}: String!`).join(", ");
  const selections = ids.map((_, i) => `t${i}: track(trackId: $id${i}) { id media { estimatedSizes { MP3_128 MP3_320 FLAC } rights { user { full { available } } sub { available } } } }`).join("\n");
  const variables = Object.fromEntries(ids.map((id, i) => [`id${i}`, id]));
  const data = await pipeQuery(`query DeezerTrackQuality(${declarations}) { ${selections} }`, variables, env);
  const result = {};
  ids.forEach((id, i) => { const track = data?.[`t${i}`]; if (track?.id != null) result[String(track.id)] = track.media || null; });
  return result;
}

export async function getTrack(id) { return rest(`track/${encodeURIComponent(String(id))}`); }
export async function getAlbum(id) { return rest(`album/${encodeURIComponent(String(id))}`); }
export async function getAlbumTracks(id, limit, offset) { return rest(`album/${encodeURIComponent(String(id))}/tracks`, { limit, index: offset }); }
export async function getArtist(id) { return rest(`artist/${encodeURIComponent(String(id))}`); }
export async function getArtistTop(id, limit = 25) { return rest(`artist/${encodeURIComponent(String(id))}/top`, { limit }); }
export async function getArtistAlbums(id, limit = 25, offset = 0) { return rest(`artist/${encodeURIComponent(String(id))}/albums`, { limit, index: offset }); }
export async function getRelatedArtists(id, limit = 25, offset = 0) { return rest(`artist/${encodeURIComponent(String(id))}/related`, { limit, index: offset }); }
export async function getPlaylist(id) { return rest(`playlist/${encodeURIComponent(String(id))}`); }
export async function getPlaylistTracks(id, limit, offset) { return rest(`playlist/${encodeURIComponent(String(id))}/tracks`, { limit, index: offset }); }
export async function getTrackRadio(id, limit = 20, offset = 0) { return rest(`track/${encodeURIComponent(String(id))}/radio`, { limit, index: offset }); }
export async function searchRest(type, q, limit, offset) {
  const segment = type ? `search/${type}` : "search";
  return rest(segment, { q, limit, index: offset });
}

export function mapArtist(a) {
  if (!a) return null;
  const picture = a.picture_xl || a.picture_big || a.picture_medium || a.picture || null;
  return {
    id: numOrString(a.id), name: a.name || "", url: a.link || `https://www.deezer.com/artist/${a.id}`,
    picture, ...(Array.isArray(a.artistTypes) ? { artistTypes: a.artistTypes } : {}),
  };
}

export function mapAlbumSummary(a) {
  if (!a) return null;
  return {
    id: numOrString(a.id), title: a.title || a.displayTitle || "", cover: a.cover_xl || a.cover_big || a.cover || null,
    url: a.link || `https://www.deezer.com/album/${a.id}`,
    ...(a.release_date ? { releaseDate: a.release_date } : {}),
    ...(typeof a.explicit_lyrics === "boolean" ? { explicit: a.explicit_lyrics } : {}),
  };
}

export function mapTrack(t, parentAlbum = null) {
  if (!t) return null;
  const artist = mapArtist(t.artist || t.artists?.[0]);
  const artists = (Array.isArray(t.contributors) && t.contributors.length ? t.contributors : (t.artists || (t.artist ? [t.artist] : []))).map(mapArtist).filter(Boolean);
  const album = mapAlbumSummary(t.album || parentAlbum);
  const preview = safeHttpsUrl(t.preview);
  const hasPreviewField = Object.prototype.hasOwnProperty.call(t, "preview");
  return {
    id: numOrString(t.id), title: t.title || t.title_short || "", duration: numOrString(t.duration),
    ...(hasPreviewField ? { allowStreaming: Boolean(preview), streamReady: Boolean(preview) } : {}),
    ...(t.track_position != null ? { trackNumber: Number(t.track_position) } : {}),
    ...(t.disk_number != null ? { volumeNumber: Number(t.disk_number) } : {}),
    ...(t.title_version != null ? { version: t.title_version } : {}),
    ...(typeof t.explicit_lyrics === "boolean" ? { explicit: t.explicit_lyrics } : {}),
    ...(t.link ? { url: t.link } : { url: `https://www.deezer.com/track/${t.id}` }),
    ...(t.isrc ? { isrc: t.isrc } : {}),
    ...(hasPreviewField ? { audioQuality: preview ? "PREVIEW" : "UNAVAILABLE", mediaMetadata: { tags: [preview ? "PREVIEW_ONLY" : "UNAVAILABLE"] } } : {}),
    ...(artist ? { artist } : {}), ...(artists.length ? { artists } : {}), ...(album ? { album } : {}),
    ...(preview ? { preview } : {}),
  };
}

export function mapAlbum(a) {
  if (!a) return null;
  const primaryArtist = mapArtist(a.artist);
  return {
    id: numOrString(a.id), title: a.title || "", duration: numOrString(a.duration),
    ...(a.release_date ? { releaseDate: a.release_date } : {}),
    ...(a.record_type ? { type: String(a.record_type).toUpperCase() } : {}),
    ...(a.upc ? { upc: a.upc } : {}),
    ...(typeof a.explicit_lyrics === "boolean" ? { explicit: a.explicit_lyrics } : {}),
    ...(a.link ? { url: a.link } : { url: `https://www.deezer.com/album/${a.id}` }),
    ...(a.label ? { copyright: a.label } : {}),
    ...(a.cover_xl || a.cover_big || a.cover ? { cover: a.cover_xl || a.cover_big || a.cover } : {}),
    ...(primaryArtist ? { artist: primaryArtist, artists: [primaryArtist] } : {}),
  };
}

export function mapPlaylist(p) {
  if (!p) return null;
  return {
    id: numOrString(p.id), title: p.title || "", numberOfTracks: Number(p.nb_tracks ?? p.estimatedTracksCount ?? 0),
    duration: Number(p.duration || 0),
    ...(p.description != null ? { description: p.description } : {}),
    ...(p.creation_date ? { created: p.creation_date } : {}),
    ...(p.public != null ? { publicPlaylist: Boolean(p.public) } : {}),
    ...(p.link ? { url: p.link } : { url: `https://www.deezer.com/playlist/${p.id}` }),
    ...(p.picture_xl || p.picture_big || p.picture ? { image: p.picture_xl || p.picture_big || p.picture } : {}),
    ...(p.creator?.id != null ? { creator: { id: numOrString(p.creator.id), name: p.creator.name || "" } } : {}),
  };
}

export function getPicture(a) {
  return a?.picture_xl || a?.picture_big || a?.picture_medium || a?.picture || a?.cover_xl || a?.cover_big || a?.cover || null;
}

export function pagination(listResponse, requestedLimit, requestedOffset) {
  const items = Array.isArray(listResponse?.data) ? listResponse.data : [];
  return {
    limit: requestedLimit,
    offset: requestedOffset,
    totalNumberOfItems: Number(listResponse?.total ?? items.length),
    items,
  };
}

export function numOrString(value) {
  if (value === null || value === undefined || value === "") return value === 0 ? 0 : null;
  const n = Number(value);
  return Number.isFinite(n) ? n : String(value);
}

export function safeHttpsUrl(value) {
  if (typeof value !== "string") return null;
  try { const url = new URL(value); return url.protocol === "https:" ? url.toString() : null; }
  catch { return null; }
}

function upstreamError(message, status = 502, code = undefined) {
  const e = new Error(message);
  e.status = status;
  if (code !== undefined) e.upstreamCode = code;
  return e;
}
