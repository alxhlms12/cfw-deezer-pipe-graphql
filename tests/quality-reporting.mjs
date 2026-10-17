import assert from "node:assert/strict";
import worker from "../src/index.js";

const originalFetch = globalThis.fetch;
const requests = [];
const jwtPayload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 360 }))
  .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const fakeJwt = `header.${jwtPayload}.signature`;

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  requests.push({ url, init });
  if (url.hostname === "auth.deezer.com") {
    return new Response(JSON.stringify({ jwt: fakeJwt }), { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  if (url.hostname === "pipe.deezer.com") {
    const requestBody = JSON.parse(init.body || "{}");
    if (requestBody.query.includes("DeezerCatalogSearch")) {
      return new Response(JSON.stringify({ data: { search: { results: {
        tracks: { edges: [{ node: {
          id: "472400862", title: "Test Track", duration: 211, isExplicit: false,
          media: { estimatedSizes: { FLAC: 40000000, MP3_320: 10000000, MP3_128: 4000000 }, rights: { user: { full: { available: true } }, sub: { available: true } } },
          contributors: { edges: [{ node: { id: "7", name: "Test Artist" } }] },
          album: { id: "8", displayTitle: "Test Album", cover: { urls: ["https://example.test/cover.jpg"] } },
        } }] }, albums: { edges: [] }, artists: { edges: [] }, playlists: { edges: [] },
      } } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected Pipe query: ${requestBody.query}`);
  }
  if (url.hostname === "api.deezer.com") {
    return new Response(JSON.stringify({ data: [{ id: 472400862, title: "Test Track", duration: 211, preview: "https://cdn.example.test/preview.mp3" }], total: 1 }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  throw new Error(`Unexpected fetch host ${url.hostname}`);
};

try {
  const query = `query Search($query: String!) { search(query: $query, type: TRACK) { totalNumberOfItems items { id title quality { status predictedQuality bestFormat formats { format audioQuality estimatedSizeBytes } mediaUrlGenerated } } } }`;
  const url = new URL("https://worker.test/graphql");
  url.searchParams.set("query", query);
  url.searchParams.set("variables", JSON.stringify({ query: "Test Track" }));
  const response = await worker.fetch(new Request(url.toString(), {
    headers: { "X-API-Key": "test-key" },
  }), { API_KEY: "test-key", DEEZER_ARL: "test-arl" });
  assert.equal(response.status, 200);
  const body = await response.json();
  const track = body.data.search.items[0];
  assert.equal(track.id, 472400862);
  assert.equal(track.quality.status, "AVAILABLE");
  assert.equal(track.quality.predictedQuality, "LOSSLESS");
  assert.equal(track.quality.bestFormat, "FLAC");
  assert.deepEqual(track.quality.formats.map(x => x.format), ["FLAC", "MP3_320", "MP3_128"]);
  assert.equal(track.quality.mediaUrlGenerated, false);
  assert.ok(requests.some(x => x.url.hostname === "pipe.deezer.com"));
  assert.ok(!requests.some(x => x.url.hostname === "media.deezer.com"));
  console.log("True quality reporting test passed (Pipe formats/rights, no media URL resolution).");
} finally {
  globalThis.fetch = originalFetch;
}
