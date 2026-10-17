import assert from "node:assert/strict";
import worker from "../src/index.js";

const env = { API_KEY: "route-test-api-key", DEEZER_ARL: "route-test-arl" };
const audio = Uint8Array.from({ length: 4096 }, (_, i) => i % 253);
const calls = [];
const jwtPayload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 360 })).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  calls.push({ url: url.toString(), init });
  if (url.hostname === "auth.deezer.com" && url.pathname === "/login/arl") {
    return new Response(JSON.stringify({ jwt: `header.${jwtPayload}.signature` }), { headers: { "Content-Type": "text/plain" } });
  }
  if (url.hostname === "pipe.deezer.com" && url.pathname === "/api") {
    const query = JSON.parse(init.body).query;
    if (query.includes("DeezerPlaybackData")) return Response.json({ data: {
      track: { id: "99", title: "Test Track", duration: 181, media: {
        id: "media-99", version: "1", token: { payload: "route-track-token", expiresAt: "2099-01-01T00:00:00Z" },
        estimatedSizes: { MP3_128: 4096, MP3_320: 4096, FLAC: 4096 },
        rights: { user: { full: { available: true } }, sub: { available: true } },
      } },
      tokens: { mediaServiceLicenseToken: { token: "route-license-token", expirationDate: "2099-01-01T00:00:00Z" } }, me: { id: "7" },
    } });
    throw new Error(`Unexpected Pipe query: ${query}`);
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

function gqlUrl(query, variables = {}) {
  const url = new URL("https://worker.test/graphql");
  url.searchParams.set("query", query);
  if (Object.keys(variables).length) url.searchParams.set("variables", JSON.stringify(variables));
  return url.toString();
}
const auth = { Authorization: `Bearer ${env.API_KEY}` };

try {
  const manifestQuery = `query Manifest($id: ID!) { trackManifest(id: $id, quality: FLAC) { id type trackId trackPresentation assetPresentation audioMode uri streamUrl manifest manifestMimeType formats audioQuality format playbackToken previewUrl previewDuration streamReady } }`;
  const manifestRes = await worker.fetch(new Request(gqlUrl(manifestQuery, { id: "99" }), { headers: auth }), env);
  assert.equal(manifestRes.status, 200, await manifestRes.clone().text());
  const manifestBody = await manifestRes.json();
  assert.equal(manifestBody.errors, undefined, JSON.stringify(manifestBody.errors));
  const attr = manifestBody.data.trackManifest;
  assert.equal(attr.trackPresentation, "FULL");
  assert.equal(attr.trackId, "99");
  assert.equal(attr.assetPresentation, "FULL");
  assert.equal(attr.audioMode, "STEREO");
  assert.equal(attr.format, "FLAC");
  assert.match(attr.uri, /\/delivery\/audio\?/);
  assert.equal(attr.streamUrl, attr.uri, "streamUrl must preserve the working REST field as the playable URL");
  assert.equal(attr.streamReady, true);
  assert.equal(attr.manifestMimeType, "application/json");
  assert.deepEqual(JSON.parse(Buffer.from(attr.manifest, "base64").toString("utf8")).urls, [attr.streamUrl]);
  assert.equal(attr.previewUrl, null);
  assert.doesNotMatch(JSON.stringify(manifestBody), /route-test-arl|route-license-token|route-track-token/);
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

  const startMutation = `mutation Report($trackId: ID!, $playToken: String!, $event: PlaybackEvent!) { reportPlayback(trackId: $trackId, playToken: $playToken, event: $event) { accepted duplicate event playToken } }`;
  const telemetry = await worker.fetch(new Request("https://worker.test/graphql", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ query: startMutation, variables: { trackId: "99", playToken: attr.playbackToken, event: "START" } }),
  }), env);
  assert.equal(telemetry.status, 200, await telemetry.clone().text());
  const telemetryBody = await telemetry.json();
  assert.equal(telemetryBody.data.reportPlayback.accepted, true);
  assert.ok(telemetryBody.data.reportPlayback.playToken);
  const logCall = calls.findLast(x => {
    try { return JSON.parse(x.init.body)?.[0]?.method === "log.listen"; } catch { return false; }
  });
  assert.ok(logCall);
  assert.ok(new URL(logCall.url).searchParams.has("api_token"));
  assert.equal(JSON.parse(logCall.init.body)[0].params.params.lt, 0);

  const earlyResponse = await worker.fetch(new Request("https://worker.test/graphql", {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ query: startMutation, variables: { trackId: "99", playToken: telemetryBody.data.reportPlayback.playToken, event: "THIRTY_SECONDS" } }),
  }), env);
  const early = await earlyResponse.json();
  assert.equal(earlyResponse.status, 200);
  assert.equal(early.data.reportPlayback, null);
  assert.equal(early.errors[0].extensions.code, "LISTEN_THRESHOLD_TOO_EARLY");

  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 31_000;
    const threshold = await worker.fetch(new Request("https://worker.test/graphql", {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ query: startMutation, variables: { trackId: "99", playToken: telemetryBody.data.reportPlayback.playToken, event: "THIRTY_SECONDS" } }),
    }), env);
    const thresholdBody = await threshold.json();
    assert.equal(threshold.status, 200);
    assert.equal(thresholdBody.data.reportPlayback.accepted, true);
    assert.equal(thresholdBody.data.reportPlayback.event, "30");
  } finally { Date.now = realNow; }

  const hlsQuery = `query Hls($id: ID!) { trackManifest(id: $id, manifestType: HLS, usage: PLAYBACK) { id trackId trackPresentation assetPresentation audioMode uri streamUrl manifest manifestMimeType formats audioQuality format streamReady playbackToken previewUrl } }`;
  const hlsManifestRes = await worker.fetch(new Request(gqlUrl(hlsQuery, { id: "99" }), { headers: auth }), env);
  assert.equal(hlsManifestRes.status, 200, await hlsManifestRes.clone().text());
  const hlsManifestBody = await hlsManifestRes.json();
  assert.equal(hlsManifestBody.errors, undefined, JSON.stringify(hlsManifestBody.errors));
  const hlsAttributes = hlsManifestBody.data.trackManifest;
  assert.equal(hlsAttributes.manifestMimeType, "application/vnd.apple.mpegurl");
  assert.match(hlsAttributes.uri, /\/delivery\/manifest\?/);
  assert.equal(hlsAttributes.streamUrl, hlsAttributes.uri, "HLS streamUrl must be the playlist URL, not null or the audio segment URL");
  assert.equal(hlsAttributes.trackId, "99");
  assert.equal(hlsAttributes.assetPresentation, "FULL");
  assert.equal(hlsAttributes.audioMode, "STEREO");
  assert.equal(hlsAttributes.streamReady, true);
  assert.equal(hlsAttributes.previewUrl, null);
  assert.ok(["MP3_320", "MP3_128"].includes(hlsAttributes.format));
  const hlsPlaylistResponse = await worker.fetch(new Request(hlsAttributes.uri), env);
  assert.equal(hlsPlaylistResponse.status, 200, await hlsPlaylistResponse.clone().text());
  assert.match(hlsPlaylistResponse.headers.get("Content-Type"), /application\/vnd\.apple\.mpegurl/);
  const hlsPlaylist = await hlsPlaylistResponse.text();
  assert.match(hlsPlaylist, /^#EXTM3U/m);
  assert.match(hlsPlaylist, /#EXT-X-ENDLIST/);
  const hlsSegmentUrl = hlsPlaylist.split("\n").find(line => line.startsWith("https://worker.test/delivery/audio?") && line.includes("hlsSegment=1"));
  assert.ok(hlsSegmentUrl, "expected a signed HLS segment URL");
  const hlsSegment = await worker.fetch(new Request(hlsSegmentUrl), env);
  assert.equal(hlsSegment.status, 200, await hlsSegment.clone().text());
  assert.equal(hlsSegment.headers.get("Content-Type"), "audio/mpeg");
  const packedAudio = new Uint8Array(await hlsSegment.arrayBuffer());
  assert.equal(String.fromCharCode(...packedAudio.subarray(0, 3)), "ID3");
  assert.equal(packedAudio.byteLength, audio.length + (await import("../src/playback.js")).makeHlsTimestampTag().byteLength);

  const previewQuery = `query Preview($id: ID!) { trackManifest(id: $id, quality: PREVIEW) { id trackId trackPresentation assetPresentation audioMode uri streamUrl previewUrl manifest manifestMimeType format audioQuality streamReady previewDuration } }`;
  const previewRes = await worker.fetch(new Request(gqlUrl(previewQuery, { id: "99" }), { headers: auth }), env);
  assert.equal(previewRes.status, 200, await previewRes.clone().text());
  const previewBody = await previewRes.json();
  assert.equal(previewBody.errors, undefined, JSON.stringify(previewBody.errors));
  const preview = previewBody.data.trackManifest;
  assert.equal(preview.trackPresentation, "PREVIEW");
  assert.equal(preview.assetPresentation, "PREVIEW");
  assert.equal(preview.streamReady, true);
  assert.equal(preview.streamUrl, "https://cdns-preview.dzcdn.net/test-preview.mp3");
  assert.equal(preview.previewUrl, preview.streamUrl);
  assert.equal(preview.audioQuality, "PREVIEW");
  assert.deepEqual(JSON.parse(Buffer.from(preview.manifest, "base64").toString("utf8")).urls, [preview.streamUrl]);

  const dataUriQuery = `query DataUri($id: ID!) { trackManifest(id: $id, quality: FLAC, uriScheme: DATA) { uri streamUrl streamReady manifest } }`;
  const dataUriRes = await worker.fetch(new Request(gqlUrl(dataUriQuery, { id: "99" }), { headers: auth }), env);
  assert.equal(dataUriRes.status, 200, await dataUriRes.clone().text());
  const dataUriBody = await dataUriRes.json();
  assert.equal(dataUriBody.errors, undefined, JSON.stringify(dataUriBody.errors));
  const dataUriManifest = dataUriBody.data.trackManifest;
  assert.match(dataUriManifest.uri, /^data:application\/json;base64,/);
  assert.match(dataUriManifest.streamUrl, /\/delivery\/audio\?/);
  assert.equal(dataUriManifest.streamReady, true);
  assert.deepEqual(JSON.parse(Buffer.from(dataUriManifest.manifest, "base64").toString("utf8")).urls, [dataUriManifest.streamUrl]);

  const dashQuery = `query Dash($id: ID!) { trackManifest(id: $id, manifestType: MPEG_DASH) { id uri manifestMimeType } }`;
  const dash = await worker.fetch(new Request(gqlUrl(dashQuery, { id: "99" }), { headers: auth }), env);
  const dashBody = await dash.json();
  assert.equal(dash.status, 200);
  assert.equal(dashBody.errors[0].extensions.code, "MANIFEST_TYPE_UNSUPPORTED");

  const downloadQuery = `query Download($id: ID!) { trackManifest(id: $id, usage: DOWNLOAD) { id uri } }`;
  const download = await worker.fetch(new Request(gqlUrl(downloadQuery, { id: "99" }), { headers: auth }), env);
  const downloadBody = await download.json();
  assert.equal(download.status, 200);
  assert.equal(downloadBody.errors[0].extensions.code, "USAGE_UNSUPPORTED");

  const legacy = await worker.fetch(new Request("https://worker.test/search?s=Test", { headers: auth }), env);
  assert.equal(legacy.status, 404);
  assert.equal((await legacy.json()).error.code, "ROUTE_MOVED_TO_GRAPHQL");
  console.log("GraphQL playback route tests passed (manifest, signed audio/ranges, HLS, mutations, and standard errors).");
} finally {
  // Keep this isolated test from leaking mocked fetch into later tests.
}
