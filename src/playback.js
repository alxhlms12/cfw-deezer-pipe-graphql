import { createWasmDecryptor } from "./wasm-decrypt.js";

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
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { ...BROWSER_HEADERS, "Content-Type": "application/json", Cookie: `sid=${session?.sid || ""}; arl=${session?.arl || ""}` },
      body: JSON.stringify(params || {}),
      signal: AbortSignal.timeout(12000),
      cache: "no-store",
    });
  } catch (cause) {
    const code = cause?.name === "TimeoutError" || cause?.name === "AbortError" ? "GATEWAY_TIMEOUT" : "GATEWAY_NETWORK_ERROR";
    throw errorWithStatus(`Could not reach Deezer gateway method ${method} (${code}).`, 502, code);
  }
  const payload = await asJsonResponse(response);
  if (!response.ok) throw errorWithStatus(`Deezer gateway method ${method} returned HTTP ${response.status}.`, response.status, `GATEWAY_HTTP_${response.status}`);
  if (!payload || typeof payload !== "object") throw errorWithStatus(`Deezer gateway method ${method} returned an invalid JSON response.`, 502, "GATEWAY_INVALID_RESPONSE");
  if (payload?.error) throw errorWithStatus(`Deezer gateway method ${method} rejected the request.`, 502, `GATEWAY_${method.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_REJECTED`);
  return payload;
}

async function getSession(env) {
  const arl = String(env?.DEEZER_ARL || "").trim();
  if (!arl) throw errorWithStatus("Set DEEZER_ARL to enable authenticated full-track playback.", 503, "ARL_REQUIRED");
  const cached = sessionCache.get(arl);
  if (cached && Date.now() - cached.createdAt < 10 * 60 * 1000) return cached;

  const pingUrl = new URL(DEEZER_GW);
  pingUrl.searchParams.set("method", "deezer.ping"); pingUrl.searchParams.set("input", "3"); pingUrl.searchParams.set("api_version", "1.0"); pingUrl.searchParams.set("api_token", "");
  let pingResponse;
  try {
    pingResponse = await fetch(pingUrl, {
      method: "POST", headers: { ...BROWSER_HEADERS, "Content-Type": "application/json", Cookie: `arl=${arl}` },
      body: "{}", signal: AbortSignal.timeout(12000), cache: "no-store",
    });
  } catch (cause) {
    const code = cause?.name === "TimeoutError" || cause?.name === "AbortError" ? "ARL_PING_TIMEOUT" : "ARL_PING_NETWORK_ERROR";
    throw errorWithStatus(`Could not establish a Deezer session (${code}).`, 502, code);
  }
  const ping = await asJsonResponse(pingResponse);
  const sid = ping?.results?.SESSION;
  if (!pingResponse.ok || !sid) throw errorWithStatus("Deezer could not establish an authenticated session. Check DEEZER_ARL.", 502, "ARL_SESSION_FAILED");

  const userUrl = new URL(DEEZER_GW);
  userUrl.searchParams.set("method", "deezer.getUserData"); userUrl.searchParams.set("input", "3"); userUrl.searchParams.set("api_version", "1.0"); userUrl.searchParams.set("api_token", "null");
  let userResponse;
  try {
    userResponse = await fetch(userUrl, {
      method: "POST", headers: { ...BROWSER_HEADERS, "Content-Type": "application/json", Cookie: `sid=${sid}; arl=${arl}` },
      body: "{}", signal: AbortSignal.timeout(12000), cache: "no-store",
    });
  } catch (cause) {
    const code = cause?.name === "TimeoutError" || cause?.name === "AbortError" ? "USER_DATA_TIMEOUT" : "USER_DATA_NETWORK_ERROR";
    throw errorWithStatus(`Could not retrieve Deezer account session data (${code}).`, 502, code);
  }
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
  if (["320", "320k", "mp3320", "mp3_320", "hq"].includes(q)) return ["MP3_320", "MP3_128"];
  if (["128", "128k", "mp3128", "mp3_128", "standard"].includes(q)) return ["MP3_128"];
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
  const attempts = [];

  for (const targetFormat of ladder) {
    if (targetFormat === "FLAC" && session.canLossless === false) { attempts.push(`${targetFormat}: account option unavailable`); continue; }
    if (targetFormat === "MP3_320" && session.can320 === false) { attempts.push(`${targetFormat}: account option unavailable`); continue; }
    if (targetFormat === "FLAC" && String(trackData.FILESIZE_FLAC || "") === "0") { attempts.push(`${targetFormat}: track has no FLAC asset`); continue; }
    let response;
    try {
      response = await fetch(DEEZER_MEDIA_API, {
        method: "POST", headers: { ...BROWSER_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ license_token: session.licenseToken, media: [{ type: "FULL", formats: [{ cipher: "BF_CBC_STRIPE", format: targetFormat }] }], track_tokens: [trackData.TRACK_TOKEN] }),
        signal: AbortSignal.timeout(15000), cache: "no-store",
      });
    } catch (cause) {
      const isTimeout = cause?.name === "TimeoutError" || cause?.name === "AbortError";
      attempts.push(`${targetFormat}: ${isTimeout ? "timeout" : "network error"}`);
      continue;
    }

    const result = await asJsonResponse(response);
    const dataItem = Array.isArray(result?.data) ? result.data[0] : null;
    const media = Array.isArray(dataItem?.media) ? dataItem.media.find(x => x && Array.isArray(x.sources)) || dataItem.media[0] : null;
    const cdnUrl = (Array.isArray(media?.sources) ? media.sources : [])
      .map(source => safeCdnUrl(source?.url)).find(Boolean);
    if (response.ok && cdnUrl) {
      const actualFormat = String(media.format || targetFormat).toUpperCase();
      if (!["FLAC", "MP3_320", "MP3_128"].includes(actualFormat)) {
        attempts.push(`${targetFormat}: unsupported response format`);
        continue;
      }
      return { trackId: String(trackId), format: actualFormat, profile: profileFor(actualFormat), cdnUrl, duration: Number(trackData.DURATION || 0) };
    }
    const rawCode = dataItem?.errors?.[0]?.code ?? result?.errors?.[0]?.code ?? result?.error?.code ?? "";
    const sanitizedCode = String(rawCode).replace(/[^A-Z0-9_-]/gi, "").slice(0, 36);
    attempts.push(`${targetFormat}: HTTP ${response.status}${sanitizedCode ? ` (${sanitizedCode})` : ""}`);
  }

  const summary = attempts.length ? attempts.join("; ") : "no formats were eligible for this account";
  throw errorWithStatus(`Deezer did not provide a usable full-track URL. Attempts: ${summary}. Check the ARL session, track entitlement, and Deezer media service availability.`, 502, "MEDIA_RESOLUTION_FAILED");
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
  const cipher = await createWasmDecryptor(deriveTrackKey(trackId));
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


function prependBytesStream(prefix, stream) {
  const reader = stream.getReader();
  let prefixSent = false;
  return new ReadableStream({
    async pull(controller) {
      if (!prefixSent) { prefixSent = true; controller.enqueue(prefix); return; }
      const { value, done } = await reader.read();
      if (done) { controller.close(); reader.releaseLock(); return; }
      controller.enqueue(value);
    },
    async cancel(reason) { await reader.cancel(reason).catch(() => {}); },
  });
}

export function makeHlsTimestampTag(timestamp90k = 0n) {
  // HLS RFC 8216 packed-audio segments require this ID3 PRIV timestamp frame.
  const owner = new TextEncoder().encode("com.apple.streaming.transportStreamTimestamp\0");
  const ts = new Uint8Array(8);
  let n = BigInt(timestamp90k) & ((1n << 33n) - 1n);
  for (let i = 7; i >= 0; i--) { ts[i] = Number(n & 255n); n >>= 8n; }
  const payload = new Uint8Array(owner.length + ts.length);
  payload.set(owner); payload.set(ts, owner.length);
  const syncsafe = value => Uint8Array.of((value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f);
  const frame = new Uint8Array(10 + payload.length);
  frame.set(new TextEncoder().encode("PRIV"), 0); frame.set(syncsafe(payload.length), 4);
  frame[8] = 0; frame[9] = 0; frame.set(payload, 10);
  const header = new Uint8Array(10 + frame.length);
  header.set(new TextEncoder().encode("ID3"), 0); header[3] = 4; header[4] = 0; header[5] = 0;
  header.set(syncsafe(frame.length), 6); header.set(frame, 10);
  return header;
}

export async function playbackResponse(request, resolved, options = {}) {
  const prefixBytes = options.prefixBytes instanceof Uint8Array ? options.prefixBytes : null;
  const requestedRange = options.ignoreRange ? null : parseByteRange(request.headers.get("Range"));
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
  let outputBody = requestedRange ? sliceStream(decrypted, outputStart - actualStart, outputLength) : decrypted;
  if (prefixBytes && !requestedRange) outputBody = prependBytesStream(prefixBytes, outputBody);
  const headers = new Headers({
    "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-API-Key, Range",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, X-Audio-Format, X-Track-ID",
    "Content-Type": resolved.profile.mime, "Cache-Control": "private, no-store", "Accept-Ranges": options.ignoreRange ? "none" : "bytes",
    "X-Audio-Format": resolved.format, "X-Track-ID": String(resolved.trackId), "X-Content-Type-Options": "nosniff",
  });
  if (rangeMode) {
    headers.set("Content-Range", `bytes ${outputStart}-${outputEnd}/${total}`);
    headers.set("Content-Length", String(outputLength));
  } else if (total) headers.set("Content-Length", String(total + (prefixBytes ? prefixBytes.byteLength : 0)));
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

function decryptAlignedBuffer(cipher, buffer, startBlock, abortSignal = null) {
  // WASM decrypts selected stripes in batches rather than crossing the JS/WASM
  // boundary once per stripe. The wrapper preserves the absolute block index
  // required for ranges and arbitrary upstream chunk boundaries.
  if (abortSignal?.aborted) throw new DOMException("Client aborted the stream request", "AbortError");
  cipher.decryptAligned(buffer, startBlock, abortSignal);
}
