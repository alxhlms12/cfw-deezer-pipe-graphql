// Authenticated Deezer media resolution and streaming support.
// Kept separate from catalog routes so ordinary search never resolves audio.
const DEEZER_GW = "https://www.deezer.com/ajax/gw-light.php";
const DEEZER_MEDIA_API = "https://media.deezer.com/v1/get_url";
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  "Origin": "https://www.deezer.com",
  "Referer": "https://www.deezer.com/",
};
const sessionCache = new Map();
const tokenCache = new Map();
const cipherCache = new Map();
const reportDedupe = new Map();

function asJsonResponse(response) { return response.json().catch(() => null); }
function errorWithStatus(message, status, code = "PLAYBACK_ERROR") {
  const error = new Error(message); error.status = status; error.code = code; return error;
}
function readBytes(value) { return new TextEncoder().encode(String(value)); }
function bytesToBase64Url(bytes) {
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function base64UrlToBytes(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded); return Uint8Array.from(binary, c => c.charCodeAt(0));
}
async function hmacKey(secret, usage) {
  return crypto.subtle.importKey("raw", readBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);
}
async function signTokenPayload(payload, secret) {
  const encoded = bytesToBase64Url(readBytes(JSON.stringify(payload)));
  const key = await hmacKey(secret, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, readBytes(encoded)));
  return `${encoded}.${bytesToBase64Url(sig)}`;
}
async function verifyToken(token, secret) {
  try {
    if (!secret || typeof token !== "string" || token.length > 4096) return null;
    const parts = token.split("."); if (parts.length !== 2) return null;
    const key = await hmacKey(secret, ["verify"]);
    const valid = await crypto.subtle.verify("HMAC", key, base64UrlToBytes(parts[1]), readBytes(parts[0]));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[0])));
    if (!payload || payload.v !== 1 || !/^\d+$/.test(String(payload.id)) || !Number.isFinite(payload.exp) || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

async function gatewayCall(method, params, session) {
  const url = new URL(DEEZER_GW);
  url.searchParams.set("method", method); url.searchParams.set("input", "3");
  url.searchParams.set("api_version", "1.0"); url.searchParams.set("api_token", session?.apiToken || "");
  const response = await fetch(url, {
    method: "POST",
    headers: { ...BROWSER_HEADERS, "Content-Type": "application/json", Cookie: `sid=${session?.sid || ""}; arl=${session?.arl || ""}` },
    body: JSON.stringify(params || {}),
    signal: AbortSignal.timeout(12000),
    cache: "no-store",
  });
  const payload = await asJsonResponse(response);
  if (!response.ok || payload?.error) {
    throw errorWithStatus(`Deezer gateway ${method} failed`, response.status >= 400 ? response.status : 502, `GATEWAY_${method.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`);
  }
  return payload;
}

async function getSession(env) {
  const arl = String(env?.DEEZER_ARL || "").trim();
  if (!arl) throw errorWithStatus("Set DEEZER_ARL to enable authenticated full-track playback.", 503, "ARL_REQUIRED");
  const cached = sessionCache.get(arl);
  if (cached && Date.now() - cached.createdAt < 10 * 60 * 1000) return cached;

  const pingUrl = new URL(DEEZER_GW);
  pingUrl.searchParams.set("method", "deezer.ping"); pingUrl.searchParams.set("input", "3"); pingUrl.searchParams.set("api_version", "1.0"); pingUrl.searchParams.set("api_token", "");
  const pingResponse = await fetch(pingUrl, {
    method: "POST", headers: { ...BROWSER_HEADERS, "Content-Type": "application/json", Cookie: `arl=${arl}` },
    body: "{}", signal: AbortSignal.timeout(12000), cache: "no-store",
  });
  const ping = await asJsonResponse(pingResponse);
  const sid = ping?.results?.SESSION;
  if (!pingResponse.ok || !sid) throw errorWithStatus("Deezer could not establish an authenticated session. Check DEEZER_ARL.", 502, "ARL_SESSION_FAILED");

  const userUrl = new URL(DEEZER_GW);
  userUrl.searchParams.set("method", "deezer.getUserData"); userUrl.searchParams.set("input", "3"); userUrl.searchParams.set("api_version", "1.0"); userUrl.searchParams.set("api_token", "null");
  const userResponse = await fetch(userUrl, {
    method: "POST", headers: { ...BROWSER_HEADERS, "Content-Type": "application/json", Cookie: `sid=${sid}; arl=${arl}` },
    body: "{}", signal: AbortSignal.timeout(12000), cache: "no-store",
  });
  const userData = await asJsonResponse(userResponse);
  const user = userData?.results?.USER;
  const apiToken = userData?.results?.checkForm;
  const licenseToken = user?.OPTIONS?.license_token;
  const userId = Number(user?.USER_ID ?? user?.id);
  if (!userResponse.ok || !apiToken || !licenseToken || !Number.isFinite(userId) || userId <= 0) {
    sessionCache.delete(arl);
    throw errorWithStatus("The Deezer ARL session is invalid or expired; replace DEEZER_ARL with a fresh session cookie.", 401, "ARL_INVALID");
  }
  const options = user?.OPTIONS || {};
  const losslessFlag = options.web_lossless ?? options.lossless ?? options.mobile_lossless;
  const hqFlag = options.web_hq ?? options.mobile_hq;
  const explicitFree = (options.web_lossless === false || options.lossless === false) && options.web_hq === false;
  const session = {
    arl, sid: String(userData?.results?.SESSION_ID || sid), userId, apiToken, licenseToken,
    canLossless: losslessFlag === true ? true : explicitFree ? false : undefined,
    can320: (losslessFlag === true || hqFlag === true) ? true : explicitFree ? false : undefined,
    createdAt: Date.now(),
  };
  sessionCache.set(arl, session);
  return session;
}

async function getTrackTokens(trackId, session) {
  const key = `${session.arl}|${trackId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() && cached.data?.TRACK_TOKEN) return cached.data;
  let data = null;
  const result = await gatewayCall("song.getListData", { sng_ids: [Number(trackId)] }, session);
  data = result?.results?.data?.[0] || null;
  if (!data?.TRACK_TOKEN) {
    const fallback = await gatewayCall("song.getData", { sng_id: Number(trackId), SNG_ID: Number(trackId) }, session);
    data = fallback?.results || null;
  }
  if (data?.FALLBACK) data = { ...data, ...data.FALLBACK };
  if (!data?.TRACK_TOKEN) throw errorWithStatus("Deezer did not return a playable full-track token for this track.", 404, "TRACK_TOKEN_MISSING");
  tokenCache.set(key, { data, expiresAt: Date.now() + 30000 });
  return data;
}

function formatLadder(quality) {
  const q = String(quality || "best").toLowerCase().replace(/[\s-]/g, "");
  if (["preview", "mp3_preview"].includes(q)) return [];
  if (["flac", "lossless", "hifi"].includes(q)) return ["FLAC", "MP3_320", "MP3_128"];
  if (["320", "320k", "mp3320", "hq"].includes(q)) return ["MP3_320", "MP3_128", "FLAC"];
  if (["128", "128k", "mp3128", "standard"].includes(q)) return ["MP3_128"];
  return ["FLAC", "MP3_320", "MP3_128"];
}
function profileFor(format) {
  const f = String(format || "MP3_128").toUpperCase();
  if (f === "FLAC") return { format: "FLAC", audioFormat: "FLAC", mime: "audio/flac", label: "Lossless FLAC", badge: "LOSSLESS", codecs: "flac", lossless: true };
  if (f === "MP3_320") return { format: "MP3_320", audioFormat: "MP3", mime: "audio/mpeg", label: "320 kbps MP3", badge: "HIGH", codecs: "mp3", lossless: false };
  return { format: "MP3_128", audioFormat: "MP3", mime: "audio/mpeg", label: "128 kbps MP3", badge: "STANDARD", codecs: "mp3", lossless: false };
}
function safeCdnUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return null;
    const host = u.hostname.toLowerCase();
    if (!(host === "dzcdn.net" || host.endsWith(".dzcdn.net") || host === "media.deezer.com")) return null;
    return u.toString();
  } catch { return null; }
}

export async function resolveFullTrack(trackId, quality, env) {
  const session = await getSession(env);
  const trackData = await getTrackTokens(trackId, session);
  const ladder = formatLadder(quality);
  if (!ladder.length) throw errorWithStatus("Preview quality does not use the full-track resolver.", 400, "PREVIEW_REQUESTED");
  let lastError = null;
  for (const targetFormat of ladder) {
    if (targetFormat === "FLAC" && session.canLossless === false) continue;
    if (targetFormat === "MP3_320" && session.can320 === false) continue;
    if (targetFormat === "FLAC" && String(trackData.FILESIZE_FLAC || "") === "0") continue;
    try {
      const response = await fetch(DEEZER_MEDIA_API, {
        method: "POST", headers: { ...BROWSER_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ license_token: session.licenseToken, media: [{ type: "FULL", formats: [{ cipher: "BF_CBC_STRIPE", format: targetFormat }] }], track_tokens: [trackData.TRACK_TOKEN] }),
        signal: AbortSignal.timeout(15000), cache: "no-store",
      });
      const result = await asJsonResponse(response);
      const media = result?.data?.[0]?.media?.[0];
      const cdnUrl = (Array.isArray(media?.sources) ? media.sources : [])
        .map(source => safeCdnUrl(source?.url)).find(Boolean);
      if (response.ok && cdnUrl) {
        const actualFormat = String(media.format || targetFormat).toUpperCase();
        if (!['FLAC', 'MP3_320', 'MP3_128'].includes(actualFormat)) {
          lastError = errorWithStatus(`Deezer returned an unsupported media format (${actualFormat}).`, 502, "UNSUPPORTED_MEDIA_FORMAT");
          continue;
        }
        return { trackId: String(trackId), format: actualFormat, profile: profileFor(actualFormat), cdnUrl };
      }
      const code = result?.data?.[0]?.errors?.[0]?.code || result?.errors?.[0]?.code || "";
      lastError = errorWithStatus(`Deezer did not grant ${targetFormat} media access.`, response.status >= 400 ? response.status : 403, `MEDIA_${String(code).replace(/[^a-z0-9]/gi, "_").toUpperCase()}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || errorWithStatus("No full-track format is available to this Deezer account.", 403, "FULL_TRACK_UNAVAILABLE");
}

export async function createPlaybackToken(trackId, format, env) {
  if (!env?.API_KEY) throw errorWithStatus("Set API_KEY as a Cloudflare secret before enabling full-track URLs.", 503, "PLAYBACK_API_KEY_REQUIRED");
  const now = Math.floor(Date.now() / 1000);
  const payload = { v: 1, id: String(trackId), format: String(format).toUpperCase(), iat: now, exp: now + 1800, n: crypto.randomUUID() };
  return { token: await signTokenPayload(payload, env.API_KEY), payload };
}
export async function validatePlaybackToken(token, env, trackId = null) {
  if (!env?.API_KEY) return null;
  const payload = await verifyToken(token, env.API_KEY);
  if (!payload || (trackId != null && String(payload.id) !== String(trackId))) return null;
  if (!["FLAC", "MP3_320", "MP3_128"].includes(String(payload.format).toUpperCase())) return null;
  payload.format = String(payload.format).toUpperCase();
  return payload;
}

async function decryptForPlayback(body, trackId, rangeStart, request) {
  const cipher = getTrackCipher(trackId);
  let pending = new Uint8Array(0);
  let blockIndex = Math.floor(rangeStart / 2048);
  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      if (request.signal.aborted) throw new DOMException("Playback request aborted", "AbortError");
      const incoming = new Uint8Array(chunk);
      const joined = new Uint8Array(pending.length + incoming.length);
      joined.set(pending); joined.set(incoming, pending.length);
      const aligned = Math.floor(joined.length / 2048) * 2048;
      if (aligned > 0) {
        const bytes = joined.slice(0, aligned);
        decryptAlignedBuffer(cipher, bytes, blockIndex, request.signal);
        blockIndex += aligned / 2048;
        controller.enqueue(bytes);
      }
      pending = joined.slice(aligned);
    },
    flush(controller) { if (pending.length) controller.enqueue(pending); },
  }));
}
function parseByteRange(value) {
  if (!value) return null;
  const m = /^bytes=(\d+)-(\d*)$/i.exec(value.trim());
  if (!m) throw errorWithStatus("Only single byte ranges are supported.", 416, "INVALID_RANGE");
  const start = Number(m[1]), end = m[2] ? Number(m[2]) : null;
  if (!Number.isSafeInteger(start) || (end !== null && (!Number.isSafeInteger(end) || end < start))) throw errorWithStatus("Invalid byte range.", 416, "INVALID_RANGE");
  return { start, end };
}
function contentRangeInfo(value) {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value || "");
  return m ? { start: Number(m[1]), end: Number(m[2]), total: m[3] === "*" ? null : Number(m[3]) } : null;
}
function sliceStream(stream, skipCount, maxCount) {
  const reader = stream.getReader();
  let skip = skipCount, sent = 0;
  return new ReadableStream({
    async pull(controller) {
      while (true) {
        if (sent >= maxCount) { controller.close(); await reader.cancel().catch(() => {}); return; }
        const { value, done } = await reader.read();
        if (done) { controller.close(); reader.releaseLock(); return; }
        let bytes = value;
        if (skip > 0) { const n = Math.min(skip, bytes.byteLength); skip -= n; bytes = bytes.subarray(n); }
        if (!bytes.byteLength) continue;
        const n = Math.min(bytes.byteLength, maxCount - sent);
        const chunk = bytes.subarray(0, n);
        sent += chunk.byteLength;
        controller.enqueue(chunk);
        if (sent >= maxCount) { controller.close(); await reader.cancel().catch(() => {}); }
        return;
      }
    },
    async cancel(reason) { await reader.cancel(reason).catch(() => {}); },
  });
}

export async function playbackResponse(request, resolved) {
  const requestedRange = parseByteRange(request.headers.get("Range"));
  const upstreamHeaders = { "User-Agent": BROWSER_HEADERS["User-Agent"] };
  let alignedStart = 0, alignedEnd = null;
  if (requestedRange) {
    alignedStart = Math.floor(requestedRange.start / 2048) * 2048;
    if (requestedRange.end !== null) alignedEnd = Math.ceil((requestedRange.end + 1) / 2048) * 2048 - 1;
    upstreamHeaders.Range = `bytes=${alignedStart}-${alignedEnd === null ? "" : alignedEnd}`;
  }
  const upstream = await fetch(resolved.cdnUrl, { headers: upstreamHeaders, signal: request.signal, cache: "no-store" });
  if (![200, 206].includes(upstream.status) || !upstream.body) throw errorWithStatus("Deezer CDN did not return an audio stream.", 502, "UPSTREAM_AUDIO_ERROR");
  const cr = contentRangeInfo(upstream.headers.get("Content-Range"));
  const actualStart = upstream.status === 206 ? (cr?.start ?? alignedStart) : 0;
  if (actualStart % 2048 !== 0) throw errorWithStatus("CDN returned a non-aligned encrypted byte range; retry without Range.", 502, "UNALIGNED_CDN_RANGE");
  const total = cr?.total ?? (upstream.status === 200 ? Number(upstream.headers.get("Content-Length") || 0) || null : null);
  let outputStart = 0, outputLength = Infinity, outputEnd = null, rangeMode = Boolean(requestedRange);
  if (requestedRange) {
    if (!Number.isFinite(total) || total <= 0) throw errorWithStatus("CDN did not provide the object length needed for byte-range playback.", 502, "RANGE_LENGTH_UNKNOWN");
    outputStart = requestedRange.start;
    outputEnd = Math.min(requestedRange.end === null ? total - 1 : requestedRange.end, total - 1);
    if (outputStart >= total) throw errorWithStatus("Requested byte range is outside the audio object.", 416, "RANGE_NOT_SATISFIABLE");
    outputLength = outputEnd - outputStart + 1;
  }
  const decrypted = await decryptForPlayback(upstream.body, resolved.trackId, actualStart, request);
  const outputBody = requestedRange ? sliceStream(decrypted, outputStart - actualStart, outputLength) : decrypted;
  const headers = new Headers({
    "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-API-Key, Range",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, X-Audio-Format, X-Track-ID",
    "Content-Type": resolved.profile.mime, "Cache-Control": "private, no-store", "Accept-Ranges": "bytes",
    "X-Audio-Format": resolved.format, "X-Track-ID": String(resolved.trackId), "X-Content-Type-Options": "nosniff",
  });
  if (rangeMode) {
    headers.set("Content-Range", `bytes ${outputStart}-${outputEnd}/${total}`);
    headers.set("Content-Length", String(outputLength));
  } else if (total) headers.set("Content-Length", String(total));
  return new Response(outputBody, { status: rangeMode ? 206 : 200, headers });
}

export async function reportListen({ trackId, playToken, event }, env) {
  const claims = await validatePlaybackToken(playToken, env, trackId);
  if (!claims) throw errorWithStatus("Invalid or expired playback token.", 401, "PLAYBACK_TOKEN_INVALID");
  const mark = String(event || "").toLowerCase();
  const listenedSeconds = mark === "start" ? 0 : (mark === "30" || mark === "threshold30" ? 30 : -1);
  if (listenedSeconds < 0) throw errorWithStatus("event must be start or 30.", 400, "INVALID_LISTEN_EVENT");
  const now = Date.now();
  let claimsForEvent = claims;
  let updatedPlayToken = playToken;
  if (listenedSeconds === 0) {
    if (!claims.startedAt) {
      claimsForEvent = { ...claims, startedAt: Math.floor(now / 1000) };
      updatedPlayToken = await signTokenPayload(claimsForEvent, env.API_KEY);
    }
  } else {
    if (!claims.startedAt) throw errorWithStatus("Send the start event when playback begins and use its returned playToken for the 30-second event.", 409, "LISTEN_START_REQUIRED");
    if (now < (claims.startedAt + 30) * 1000) throw errorWithStatus("The 30-second event cannot be submitted before 30 seconds of playback-session time has elapsed.", 425, "LISTEN_THRESHOLD_TOO_EARLY");
  }
  const dedupeKey = `${claims.n}:${listenedSeconds}`;
  for (const [key, expiry] of reportDedupe) if (expiry <= now) reportDedupe.delete(key);
  if (reportDedupe.has(dedupeKey)) return { accepted: true, duplicate: true, event: mark, playToken: updatedPlayToken };

  const session = await getSession(env);
  const timestamp = Math.floor(now / 1000);
  const startedAt = Number(claimsForEvent.startedAt || claimsForEvent.iat);
  // The observed gateway format is a batched method envelope. `log.listen`
  // belongs in the body; the gateway URL carries api_token/input/api_version.
  const body = [{ method: "log.listen", params: { params: {
    media: { id: String(trackId), type: "song" }, type: 0,
    stat: { seek: 0, pause: 0 }, lt: listenedSeconds,
    ctxt: { t: "search", id: 0 }, payload: { format: claims.format },
    dev: { v: "00350497", t: 0 }, ls: [], ts_listen: startedAt, timestamp,
  } } }];
  const url = new URL(DEEZER_GW);
  url.searchParams.set("input", "3");
  url.searchParams.set("api_version", "1.0"); url.searchParams.set("api_token", session.apiToken);
  url.searchParams.set("cid", String(Math.floor(Math.random() * 2_000_000_000)));
  const response = await fetch(url, {
    method: "POST", headers: { ...BROWSER_HEADERS, "Content-Type": "text/plain;charset=UTF-8", Cookie: `sid=${session.sid}; arl=${session.arl}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000), cache: "no-store",
  });
  const result = await asJsonResponse(response);
  const resultError = result?.error || result?.results?.error || (Array.isArray(result) ? result.find(item => item?.error)?.error : null);
  if (!response.ok || resultError) throw errorWithStatus("Deezer did not confirm the listen event.", response.status >= 400 ? response.status : 502, "LISTEN_REPORT_REJECTED");
  reportDedupe.set(dedupeKey, Date.now() + 30 * 60 * 1000);
  return { accepted: true, duplicate: false, event: mark, ...(listenedSeconds === 0 ? { playToken: updatedPlayToken } : {}), deezerResponse: result ?? null };
}

function md5(str) {
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000);

  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5,  9, 14, 20, 5,  9, 14, 20, 5,  9, 14, 20, 5,  9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ];

  const n = str.length;
  const bitLen = n * 8;
  const padLen = (((n + 8) >> 6) + 1) * 64;
  const msg = new Uint8Array(padLen);
  for (let i = 0; i < n; i++) msg[i] = str.charCodeAt(i);
  msg[n] = 0x80;

  const view = new DataView(msg.buffer);
  view.setUint32(padLen - 8, bitLen >>> 0, true);
  view.setUint32(padLen - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  for (let offset = 0; offset < padLen; offset += 64) {
    let a = a0, b = b0, c = c0, d = d0;
    const M = new Uint32Array(16);
    for (let j = 0; j < 16; j++) M[j] = view.getUint32(offset + j * 4, true);

    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | ((~b) & d); g = i; }
      else if (i < 32) { f = (d & b) | ((~d) & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | (~d)); g = (7 * i) % 16; }

      const temp = (a + f + K[i] + M[g]) >>> 0;
      a = d; d = c; c = b;
      const s = S[i];
      b = (b + (((temp << s) | (temp >>> (32 - s))) >>> 0)) >>> 0;
    }

    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }

  const out = new DataView(new ArrayBuffer(16));
  out.setUint32(0, a0, true);
  out.setUint32(4, b0, true);
  out.setUint32(8, c0, true);
  out.setUint32(12, d0, true);

  let hex = "";
  for (let i = 0; i < 16; i++) hex += out.getUint8(i).toString(16).padStart(2, "0");
  return hex;
}

function deriveTrackKey(trackId) {
  const md5Hex = md5(String(trackId));
  const secret = "g4el58wc0zvf9na1";
  const key = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    key[i] = md5Hex.charCodeAt(i) ^ md5Hex.charCodeAt(i + 16) ^ secret.charCodeAt(i);
  }
  return key;
}

const BF_P_INIT = [
  0x243f6a88, 0x85a308d3, 0x13198a2e, 0x03707344, 0xa4093822, 0x299f31d0,
  0x082efa98, 0xec4e6c89, 0x452821e6, 0x38d01377, 0xbe5466cf, 0x34e90c6c,
  0xc0ac29b7, 0xc97c50dd, 0x3f84d5b5, 0xb5470917, 0x9216d5d9, 0x8979fb1b
];

const BF_S_BOXES_B64 = `
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
`;

function decodeBase64(value) {
  const normalized = String(value)
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error("Invalid Base64 character");
  }

  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return atob(padded);
}

const GLOBAL_TABLES = (function () {
  const binary = decodeBase64(BF_S_BOXES_B64);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buffer[i] = binary.charCodeAt(i);
  const view = new DataView(buffer.buffer);
  const sBoxes = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let offset = 0;
  for (let b = 0; b < 4; b++) {
    for (let i = 0; i < 256; i++) {
      sBoxes[b][i] = view.getUint32(offset, false);
      offset += 4;
    }
  }
  return { pArray: new Uint32Array(BF_P_INIT), sBoxes };
})();

class FastBlowfish {
  constructor(keyBytes) {
    this.p = new Uint32Array(GLOBAL_TABLES.pArray);
    this.s0 = new Uint32Array(GLOBAL_TABLES.sBoxes[0]);
    this.s1 = new Uint32Array(GLOBAL_TABLES.sBoxes[1]);
    this.s2 = new Uint32Array(GLOBAL_TABLES.sBoxes[2]);
    this.s3 = new Uint32Array(GLOBAL_TABLES.sBoxes[3]);
    this.initKey(keyBytes);
  }

  encBlock(xl, xr) {
    const s0 = this.s0, s1 = this.s1, s2 = this.s2, s3 = this.s3, p = this.p;
    for (let i = 0; i < 16; i++) {
      xl ^= p[i];
      const a = (xl >>> 24) & 0xff, b = (xl >>> 16) & 0xff, c = (xl >>> 8) & 0xff, d = xl & 0xff;
      const f = (((s0[a] + s1[b]) ^ s2[c]) + s3[d]) >>> 0;
      xr = (f ^ xr) >>> 0;
      const tmp = xl; xl = xr; xr = tmp;
    }
    const tmp = xl; xl = xr; xr = tmp;
    return [(xl ^ p[17]) >>> 0, (xr ^ p[16]) >>> 0];
  }

  initKey(key) {
    let keyIdx = 0;
    for (let i = 0; i < 18; i++) {
      let data = 0;
      for (let k = 0; k < 4; k++) {
        data = ((data << 8) | key[keyIdx]) >>> 0;
        keyIdx = (keyIdx + 1) % key.length;
      }
      this.p[i] ^= data;
    }
    let block = [0, 0];
    for (let i = 0; i < 18; i += 2) {
      block = this.encBlock(block[0], block[1]);
      this.p[i] = block[0]; this.p[i + 1] = block[1];
    }
    for (let s = 0; s < 4; s++) {
      const currentS = s === 0 ? this.s0 : s === 1 ? this.s1 : s === 2 ? this.s2 : this.s3;
      for (let i = 0; i < 256; i += 2) {
        block = this.encBlock(block[0], block[1]);
        currentS[i] = block[0]; currentS[i + 1] = block[1];
      }
    }
  }

  decryptCBC(view, offset) {
    let ivL = 0x00010203, ivR = 0x04050607;
    const p = this.p;
    const s0 = this.s0, s1 = this.s1, s2 = this.s2, s3 = this.s3;

    for (let i = 0; i < 2048; i += 8) {
      const pos = offset + i;
      const cL = view.getUint32(pos, false);
      const cR = view.getUint32(pos + 4, false);

      let A = cL ^ p[17];
      let B = cR ^ p[16];

      B = ((((s0[(A >>> 24) & 0xff] + s1[(A >>> 16) & 0xff]) ^ s2[(A >>> 8) & 0xff]) + s3[A & 0xff]) ^ B) >>> 0; A ^= p[15];
      A = ((((s0[(B >>> 24) & 0xff] + s1[(B >>> 16) & 0xff]) ^ s2[(B >>> 8) & 0xff]) + s3[B & 0xff]) ^ A) >>> 0; B ^= p[14];
      B = ((((s0[(A >>> 24) & 0xff] + s1[(A >>> 16) & 0xff]) ^ s2[(A >>> 8) & 0xff]) + s3[A & 0xff]) ^ B) >>> 0; A ^= p[13];
      A = ((((s0[(B >>> 24) & 0xff] + s1[(B >>> 16) & 0xff]) ^ s2[(B >>> 8) & 0xff]) + s3[B & 0xff]) ^ A) >>> 0; B ^= p[12];
      B = ((((s0[(A >>> 24) & 0xff] + s1[(A >>> 16) & 0xff]) ^ s2[(A >>> 8) & 0xff]) + s3[A & 0xff]) ^ B) >>> 0; A ^= p[11];
      A = ((((s0[(B >>> 24) & 0xff] + s1[(B >>> 16) & 0xff]) ^ s2[(B >>> 8) & 0xff]) + s3[B & 0xff]) ^ A) >>> 0; B ^= p[10];
      B = ((((s0[(A >>> 24) & 0xff] + s1[(A >>> 16) & 0xff]) ^ s2[(A >>> 8) & 0xff]) + s3[A & 0xff]) ^ B) >>> 0; A ^= p[9];
      A = ((((s0[(B >>> 24) & 0xff] + s1[(B >>> 16) & 0xff]) ^ s2[(B >>> 8) & 0xff]) + s3[B & 0xff]) ^ A) >>> 0; B ^= p[8];
      B = ((((s0[(A >>> 24) & 0xff] + s1[(A >>> 16) & 0xff]) ^ s2[(A >>> 8) & 0xff]) + s3[A & 0xff]) ^ B) >>> 0; A ^= p[7];
      A = ((((s0[(B >>> 24) & 0xff] + s1[(B >>> 16) & 0xff]) ^ s2[(B >>> 8) & 0xff]) + s3[B & 0xff]) ^ A) >>> 0; B ^= p[6];
      B = ((((s0[(A >>> 24) & 0xff] + s1[(A >>> 16) & 0xff]) ^ s2[(A >>> 8) & 0xff]) + s3[A & 0xff]) ^ B) >>> 0; A ^= p[5];
      A = ((((s0[(B >>> 24) & 0xff] + s1[(B >>> 16) & 0xff]) ^ s2[(B >>> 8) & 0xff]) + s3[B & 0xff]) ^ A) >>> 0; B ^= p[4];
      B = ((((s0[(A >>> 24) & 0xff] + s1[(A >>> 16) & 0xff]) ^ s2[(A >>> 8) & 0xff]) + s3[A & 0xff]) ^ B) >>> 0; A ^= p[3];
      A = ((((s0[(B >>> 24) & 0xff] + s1[(B >>> 16) & 0xff]) ^ s2[(B >>> 8) & 0xff]) + s3[B & 0xff]) ^ A) >>> 0; B ^= p[2];
      B = ((((s0[(A >>> 24) & 0xff] + s1[(A >>> 16) & 0xff]) ^ s2[(A >>> 8) & 0xff]) + s3[A & 0xff]) ^ B) >>> 0; A ^= p[1];
      A = ((((s0[(B >>> 24) & 0xff] + s1[(B >>> 16) & 0xff]) ^ s2[(B >>> 8) & 0xff]) + s3[B & 0xff]) ^ A) >>> 0; B ^= p[0];

      view.setUint32(pos, ((B ^ ivL) >>> 0), false);
      view.setUint32(pos + 4, ((A ^ ivR) >>> 0), false);
      ivL = cL; ivR = cR;
    }
  }
}

function getTrackCipher(trackId) {
  const idStr = String(trackId);
  let cipher = cipherCache.get(idStr);
  if (cipher) return cipher;

  const key = deriveTrackKey(idStr);
  cipher = new FastBlowfish(key);
  cipherCache.set(idStr, cipher);
  return cipher;
}

function decryptAlignedBuffer(cipher, buffer, startBlock, abortSignal = null) {
  const numBlocks = Math.floor(buffer.length / 2048);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  for (let i = 0; i < numBlocks; i++) {
    if (abortSignal && (i & 15) === 0 && abortSignal.aborted) {
      throw new DOMException("Client aborted the stream request", "AbortError");
    }
    const currentBlock = startBlock + i;
    if (currentBlock % 3 === 0) {
      cipher.decryptCBC(view, i * 2048);
    }
  }
}

