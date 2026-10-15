import assert from "node:assert/strict";
import worker from "../src/index.js";

const env = { API_KEY: "route-test-api-key", DEEZER_ARL: "route-test-arl" };
const audio = Uint8Array.from({ length: 4096 }, (_, i) => i % 253);
const calls = [];

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  calls.push({ url: url.toString(), init });

  if (url.hostname === "auth.deezer.com" && url.pathname === "/login/arl") {
    const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 300, userId: "7" })).replace(/=/g, "");
    return new Response(JSON.stringify({ jwt: `header.${payload}.signature` }), { headers: { "Content-Type": "text/plain" } });
  }
  if (url.hostname === "pipe.deezer.com" && url.pathname === "/api") {
    const query = JSON.parse(init.body).query;
    assert.match(query, /mediaServiceLicenseToken/);
    assert.match(query, /token \{ payload expiresAt \}/);
    return Response.json({ data: {
      track: { id: "99", title: "Test Track", duration: 181, media: {
        id: "media-99", version: "1", token: { payload: "route-track-token", expiresAt: "2099-01-01T00:00:00Z" },
        estimatedSizes: { MP3_128: 4096, MP3_320: 4096, FLAC: 4096 },
        rights: { user: { full: { available: true } }, sub: { available: true } }
      } },
      tokens: { mediaServiceLicenseToken: { token: "route-license-token", expirationDate: "2099-01-01T00:00:00Z" } },
      me: { id: "7" }
    } });
  }

  if (url.hostname === "www.deezer.com" && url.pathname === "/ajax/gw-light.php") {
    const gatewayMethod = url.searchParams.get("method");
    if (gatewayMethod === "deezer.ping") return Response.json({ results: { SESSION: "route-session" } });
    if (gatewayMethod === "deezer.getUserData") return Response.json({ results: {
      SESSION_ID: "route-session", checkForm: "route-api-token",
      USER: { USER_ID: 12, OPTIONS: { license_token: "route-license-token", web_lossless: true, web_hq: true } },
    } });
    if (gatewayMethod === null) {
      const batch = JSON.parse(init.body);
      if (batch?.[0]?.method === "log.listen") return Response.json([{ results: { success: true } }]);
    }
    throw new Error(`Unexpected gateway method: ${gatewayMethod}`);
  }

  if (url.hostname === "api.deezer.com" && url.pathname === "/track/99") {
    return Response.json({ id: 99, title: "Test Track", duration: 181, preview: "https://cdns-preview.dzcdn.net/test-preview.mp3" });
  }
  if (url.hostname === "media.deezer.com" && url.pathname === "/v1/get_url") {
    const requestedFormat = JSON.parse(init.body).media[0].formats[0].format;
    return Response.json({ data: [{ media: [{ format: requestedFormat, sources: [
      { url: "http://bad.example/audio" }, { url: "https://cdn.dzcdn.net/route-audio" },
    ] }] }] });
  }

  if (url.hostname === "cdn.dzcdn.net") {
    const range = new Headers(init.headers || {}).get("Range");
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      assert.ok(match);
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : audio.length - 1;
      return new Response(audio.slice(start, end + 1), {
        status: 206,
        headers: { "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${audio.length}` },
      });
    }
    return new Response(audio.slice(), { headers: { "Content-Length": String(audio.length) } });
  }
  throw new Error(`Unexpected fetch URL: ${url}`);
};

const auth = { Authorization: `Bearer ${env.API_KEY}` };
const manifestRes = await worker.fetch(new Request("https://worker.test/trackManifests?id=99", { headers: auth }), env);
assert.equal(manifestRes.status, 200, await manifestRes.clone().text());
const manifest = await manifestRes.json();
const attr = manifest.data.data.attributes;
assert.equal(attr.trackPresentation, "FULL");
assert.equal(attr.format, "FLAC");
assert.match(attr.uri, /playback=1/);
assert.doesNotMatch(JSON.stringify(manifest), /route-test-arl|route-license-token|route-track-token/);
assert.ok(calls.some(x => new URL(x.url).hostname === "pipe.deezer.com"), "expected Pipe GraphQL playback lookup");
assert.ok(!calls.some(x => new URL(x.url).searchParams.get("method") === "song.getListData"), "legacy song.getListData must not be used");

const playbackRes = await worker.fetch(new Request(attr.uri), env);
assert.equal(playbackRes.status, 200, await playbackRes.clone().text());
assert.equal(playbackRes.headers.get("Content-Type"), "audio/flac");
assert.equal((await playbackRes.arrayBuffer()).byteLength, audio.length);

const ranged = await worker.fetch(new Request(attr.uri, { headers: { Range: "bytes=100-3000" } }), env);
assert.equal(ranged.status, 206, await ranged.clone().text());
assert.equal(ranged.headers.get("Content-Range"), `bytes 100-3000/${audio.length}`);
assert.equal((await ranged.arrayBuffer()).byteLength, 2901);

const telemetry = await worker.fetch(new Request("https://worker.test/track?log=listen", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ trackId: "99", playToken: attr.playbackToken, event: "start" }),
}), env);
assert.equal(telemetry.status, 202, await telemetry.clone().text());
const telemetryBody = await telemetry.json();
assert.equal(telemetryBody.accepted, true);
assert.ok(telemetryBody.playToken);
const logCall = calls.findLast(x => {
  try { return JSON.parse(x.init.body)?.[0]?.method === "log.listen"; } catch { return false; }
});
assert.ok(logCall);
assert.ok(new URL(logCall.url).searchParams.has("api_token"));
assert.equal(JSON.parse(logCall.init.body)[0].params.params.lt, 0);

const early = await worker.fetch(new Request("https://worker.test/track?log=listen", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ trackId: "99", playToken: telemetryBody.playToken, event: "30" }),
}), env);
assert.equal(early.status, 425);
assert.match(await early.text(), /30 seconds/);
const realNow = Date.now;
try {
  Date.now = () => realNow() + 31_000;
  const threshold = await worker.fetch(new Request("https://worker.test/track?log=listen", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trackId: "99", playToken: telemetryBody.playToken, event: "30" }),
  }), env);
  assert.equal(threshold.status, 202, await threshold.clone().text());
  const thresholdBody = await threshold.json();
  assert.equal(thresholdBody.accepted, true);
  assert.equal(thresholdBody.event, "30");
} finally { Date.now = realNow; }
const hlsManifestRes = await worker.fetch(new Request("https://worker.test/trackManifests/?id=99&manifestType=HLS&usgae=PLAYBACK", { headers: auth }), env);
assert.equal(hlsManifestRes.status, 200, await hlsManifestRes.clone().text());
const hlsManifest = await hlsManifestRes.json();
const hlsAttributes = hlsManifest.data.data.attributes;
assert.equal(hlsAttributes.manifestMimeType, "application/vnd.apple.mpegurl");
assert.match(hlsAttributes.uri, /playback=manifest/);
assert.ok(["MP3_320", "MP3_128"].includes(hlsAttributes.format));
const hlsPlaylistResponse = await worker.fetch(new Request(hlsAttributes.uri), env);
assert.equal(hlsPlaylistResponse.status, 200, await hlsPlaylistResponse.clone().text());
assert.match(hlsPlaylistResponse.headers.get("Content-Type"), /application\/vnd\.apple\.mpegurl/);
const hlsPlaylist = await hlsPlaylistResponse.text();
assert.match(hlsPlaylist, /^#EXTM3U/m);
assert.match(hlsPlaylist, /#EXT-X-ENDLIST/);
const hlsSegmentUrl = hlsPlaylist.split("\n").find(line => line.startsWith("https://worker.test/track?") && line.includes("hlsSegment=1"));
assert.ok(hlsSegmentUrl, "expected a signed HLS segment URL");
const hlsSegment = await worker.fetch(new Request(hlsSegmentUrl), env);
assert.equal(hlsSegment.status, 200, await hlsSegment.clone().text());
assert.equal(hlsSegment.headers.get("Content-Type"), "audio/mpeg");
const packedAudio = new Uint8Array(await hlsSegment.arrayBuffer());
assert.equal(String.fromCharCode(...packedAudio.subarray(0, 3)), "ID3");
assert.equal(packedAudio.byteLength, audio.length + (await import("../src/playback.js")).makeHlsTimestampTag().byteLength);

const dashUnsupported = await worker.fetch(new Request("https://worker.test/trackManifests?id=99&manifestType=MPEG_DASH", { headers: auth }), env);
assert.equal(dashUnsupported.status, 406);
assert.equal((await dashUnsupported.json()).error.code, "MANIFEST_TYPE_UNSUPPORTED");
const downloadUnsupported = await worker.fetch(new Request("https://worker.test/trackManifests?id=99&usage=DOWNLOAD", { headers: auth }), env);
assert.equal(downloadUnsupported.status, 501);
assert.equal((await downloadUnsupported.json()).error.code, "USAGE_UNSUPPORTED");
console.log("Worker route integration passed (full manifest, signed playback, WASM-decrypted byte ranges, HLS playlist/packed MP3 segment, and listen-event flow).");
