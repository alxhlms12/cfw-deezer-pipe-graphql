import assert from "node:assert/strict";
import { createPlaybackToken, playbackResponse, reportListen, resolveFullTrack, validatePlaybackToken } from "../src/playback.js";

const env = { API_KEY: "integration-test-api-key", DEEZER_ARL: "integration-test-arl" };
const audio = Uint8Array.from({ length: 4096 }, (_, i) => i % 251);
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
      track: { id: "42", title: "Test Track", duration: 181, media: {
        id: "media-42", version: "1", token: { payload: "track-token-42", expiresAt: "2099-01-01T00:00:00Z" },
        estimatedSizes: { MP3_128: 4096, MP3_320: 4096, FLAC: 4096 },
        rights: { user: { full: { available: true } }, sub: { available: true } }
      } },
      tokens: { mediaServiceLicenseToken: { token: "license-token", expirationDate: "2099-01-01T00:00:00Z" } },
      me: { id: "7" }
    } });
  }

  if (url.hostname === "www.deezer.com" && url.pathname === "/ajax/gw-light.php") {
    const gatewayMethod = url.searchParams.get("method");
    if (gatewayMethod === "deezer.ping") return Response.json({ results: { SESSION: "session-id" } });
    if (gatewayMethod === "deezer.getUserData") return Response.json({ results: {
      SESSION_ID: "session-id",
      checkForm: "gateway-api-token",
      USER: { USER_ID: 7, OPTIONS: { license_token: "license-token", web_lossless: true, web_hq: true } },
    } });
    if (gatewayMethod === null) {
      const batch = JSON.parse(init.body);
      if (batch?.[0]?.method === "log.listen") return Response.json([{ results: { success: true } }]);
    }
    throw new Error(`Unexpected gateway method: ${gatewayMethod}`);
  }

  if (url.hostname === "media.deezer.com" && url.pathname === "/v1/get_url") {
    const body = JSON.parse(init.body);
    assert.equal(body.license_token, "license-token");
    assert.equal(body.track_tokens[0], "track-token-42");
    assert.equal(body.media[0].formats[0].format, "FLAC");
    return Response.json({ data: [{ media: [{
      format: "FLAC", sources: [{ url: "https://cdn.dzcdn.net/audio-test" }],
    }] }] });
  }

  if (url.hostname === "cdn.dzcdn.net") {
    const headers = new Headers(init.headers || {});
    const range = headers.get("Range");
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      assert.ok(match, `Unexpected upstream Range: ${range}`);
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : audio.length - 1;
      return new Response(audio.slice(start, end + 1), {
        status: 206,
        headers: { "Content-Type": "application/octet-stream", "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${audio.length}` },
      });
    }
    return new Response(audio.slice(), { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(audio.length) } });
  }

  throw new Error(`Unexpected fetch URL: ${url}`);
};

const resolved = await resolveFullTrack("42", "best", env);
assert.equal(resolved.trackId, "42");
assert.equal(resolved.format, "FLAC");
assert.equal(resolved.profile.mime, "audio/flac");
assert.doesNotMatch(JSON.stringify(resolved), /integration-test-arl|license-token|track-token-42/);

const audioResponse = await playbackResponse(new Request("https://worker.test/track?id=42"), resolved);
assert.equal(audioResponse.status, 200);
assert.equal(audioResponse.headers.get("Content-Type"), "audio/flac");
assert.equal(Number(audioResponse.headers.get("Content-Length")), audio.length);
assert.equal((await audioResponse.arrayBuffer()).byteLength, audio.length);

const rangeResponse = await playbackResponse(new Request("https://worker.test/track?id=42", { headers: { Range: "bytes=100-3000" } }), resolved);
assert.equal(rangeResponse.status, 206);
assert.equal(rangeResponse.headers.get("Content-Range"), `bytes 100-3000/${audio.length}`);
assert.equal((await rangeResponse.arrayBuffer()).byteLength, 2901);

const { token } = await createPlaybackToken("42", resolved.format, env);
const startResult = await reportListen({ trackId: "42", playToken: token, event: "start" }, env);
assert.equal(startResult.accepted, true);
assert.equal(startResult.event, "start");
assert.ok(startResult.playToken);
const listenCall = calls.findLast(x => {
  try { return JSON.parse(x.init.body)?.[0]?.method === "log.listen"; } catch { return false; }
});
assert.ok(listenCall, "expected a gateway log.listen request");
assert.ok(new URL(listenCall.url).searchParams.has("cid"));
const loggedBody = JSON.parse(listenCall.init.body);
assert.equal(loggedBody[0].params.params.lt, 0);
assert.equal(loggedBody[0].params.params.media.id, "42");
assert.equal(loggedBody[0].params.params.stat.pause, 0);

await assert.rejects(
  reportListen({ trackId: "42", playToken: startResult.playToken, event: "30" }, env),
  error => error?.code === "LISTEN_THRESHOLD_TOO_EARLY",
);
const realNow = Date.now;
try {
  Date.now = () => realNow() + 31_000;
  const thresholdResult = await reportListen({ trackId: "42", playToken: startResult.playToken, event: "30" }, env);
  assert.equal(thresholdResult.accepted, true);
  assert.equal(thresholdResult.event, "30");
  const thresholdCall = calls.findLast(x => {
    try { return JSON.parse(x.init.body)?.[0]?.method === "log.listen" && JSON.parse(x.init.body)[0].params.params.lt === 30; }
    catch { return false; }
  });
  assert.ok(thresholdCall, "expected a 30-second gateway log.listen request");
} finally { Date.now = realNow; }
assert.equal(await validatePlaybackToken(startResult.playToken, env, "43"), null);
assert.equal(calls.filter(x => new URL(x.url).hostname === "media.deezer.com").length, 1);
assert.ok(calls.some(x => new URL(x.url).hostname === "pipe.deezer.com"), "expected Pipe GraphQL playback lookup");
assert.ok(!calls.some(x => new URL(x.url).searchParams.get("method") === "song.getListData"), "legacy song.getListData must not be used");
console.log("Playback integration test passed (authenticated full-track resolution, decrypt pipeline, ranges, and start/30-second log.listen events).");
