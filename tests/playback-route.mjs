import assert from "node:assert/strict";
import worker from "../src/index.js";

const env = { API_KEY: "route-test-api-key", DEEZER_ARL: "route-test-arl" };
const audio = Uint8Array.from({ length: 4096 }, (_, i) => i % 253);
const calls = [];

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  calls.push({ url: url.toString(), init });

  if (url.hostname === "www.deezer.com" && url.pathname === "/ajax/gw-light.php") {
    const gatewayMethod = url.searchParams.get("method");
    if (gatewayMethod === "deezer.ping") return Response.json({ results: { SESSION: "route-session" } });
    if (gatewayMethod === "deezer.getUserData") return Response.json({ results: {
      SESSION_ID: "route-session", checkForm: "route-api-token",
      USER: { USER_ID: 12, OPTIONS: { license_token: "route-license-token", web_lossless: true, web_hq: true } },
    } });
    if (gatewayMethod === "song.getListData") return Response.json({ results: { data: [{
      SNG_ID: 99, TRACK_TOKEN: "route-track-token", FILESIZE_FLAC: "4096",
    }] } });
    if (gatewayMethod === null) {
      const batch = JSON.parse(init.body);
      if (batch?.[0]?.method === "log.listen") return Response.json([{ results: { success: true } }]);
    }
    throw new Error(`Unexpected gateway method: ${gatewayMethod}`);
  }

  if (url.hostname === "media.deezer.com" && url.pathname === "/v1/get_url") {
    return Response.json({ data: [{ media: [{ format: "FLAC", sources: [
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
console.log("Worker route integration passed (full manifest, signed playback, decrypted byte ranges, and start/30-second log.listen event flow).");
