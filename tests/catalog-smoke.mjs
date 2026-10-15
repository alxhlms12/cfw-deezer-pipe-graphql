import assert from "node:assert/strict";
import { getTrack, mapTrack, searchRest } from "../src/deezer.js";

const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async input => {
  const url = new URL(String(input));
  calls.push(url);
  let body;
  if (url.pathname.endsWith("/track/42")) {
    body = {
      id: 42, title: "Example Track", duration: 210,
      preview: "https://cdn.example.test/preview.mp3",
      link: "https://www.deezer.com/track/42",
      artist: { id: 9, name: "Example Artist", link: "https://www.deezer.com/artist/9" },
      album: { id: 7, title: "Example Album", cover_xl: "https://cdn.example.test/cover.jpg" },
      isrc: "USAAA2600001", explicit_lyrics: false,
    };
  } else {
    body = { data: [], total: 0 };
  }
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
};

try {
  const track = await getTrack("42");
  const mapped = mapTrack(track);
  assert.equal(mapped.id, 42);
  assert.equal(mapped.audioQuality, "PREVIEW");
  assert.equal(mapped.streamReady, true);
  assert.equal(mapped.preview, "https://cdn.example.test/preview.mp3");

  await searchRest("", "a query", 10, 20);
  const searchCall = calls.at(-1);
  assert.equal(searchCall.pathname, "/search");
  assert.equal(searchCall.searchParams.get("q"), "a query");
  assert.equal(searchCall.searchParams.get("limit"), "10");
  assert.equal(searchCall.searchParams.get("index"), "20");
  console.log("Catalog smoke test passed (REST mapping, preview labeling, and offset → index).");
} finally {
  globalThis.fetch = originalFetch;
}
