import assert from "node:assert/strict";
import worker from "../src/index.js";

const originalFetch = globalThis.fetch;
const env = { API_KEY: "lyrics-test-key", DEEZER_ARL: "lyrics-test-arl" };
const calls = [];
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  calls.push({ url, init });
  if (url.hostname === "auth.deezer.com" && url.pathname === "/login/arl") {
    const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 300, userId: "7" })).replace(/=/g, "");
    return new Response(JSON.stringify({ jwt: `header.${payload}.signature` }), { status: 200 });
  }
  if (url.hostname === "pipe.deezer.com" && url.pathname === "/api") {
    const request = JSON.parse(init.body);
    assert.match(request.query, /synchronizedLines/);
    assert.match(request.query, /synchronizedWordByWordLines/);
    return Response.json({ data: { track: {
      id: "42", title: "Example Track", duration: 180,
      lyrics: {
        id: "lyr-42", text: "Example lyric line", writers: "Example Writer", copyright: "Example Publisher",
        licence: "Licensed lyrics",
        synchronizedLines: [{ lrcTimestamp: "00:01.00", line: "Example lyric line", lineTranslated: null, milliseconds: 1000, duration: 2000 }],
        synchronizedWordByWordLines: [{ start: 1000, end: 3000, words: [{ start: 1000, end: 1800, word: "Example" }, { start: 1900, end: 3000, word: "line" }] }],
      },
    } } });
  }
  throw new Error(`Unexpected fetch: ${url}`);
};

try {
  const auth = { Authorization: `Bearer ${env.API_KEY}` };
  const allQuery = `query Lyrics($id: ID!) { lyrics(id: $id, type: ALL) { trackId title duration type availableTypes plain synchronizedLines { lrcTimestamp line lineTranslated milliseconds duration } synchronizedWordByWordLines { start end words { start end word } } } }`;
  const allUrl = new URL("https://worker.test/graphql");
  allUrl.searchParams.set("query", allQuery);
  allUrl.searchParams.set("variables", JSON.stringify({ id: "42" }));
  const allResponse = await worker.fetch(new Request(allUrl.toString(), { headers: auth }), env);
  assert.equal(allResponse.status, 200, await allResponse.clone().text());
  const all = await allResponse.json();
  assert.equal(all.errors, undefined, JSON.stringify(all.errors));
  assert.equal(all.data.lyrics.type, "all");
  assert.equal(all.data.lyrics.plain, "Example lyric line");
  assert.equal(all.data.lyrics.synchronizedLines.length, 1);
  assert.equal(all.data.lyrics.synchronizedWordByWordLines[0].words[0].word, "Example");
  assert.deepEqual(all.data.lyrics.availableTypes, ["plain", "line", "word"]);

  const wordQuery = `{ lyrics(id: "42", type: WORD) { type synchronizedWordByWordLines { start end words { word } } } }`;
  const wordUrl = new URL("https://worker.test/graphql");
  wordUrl.searchParams.set("query", wordQuery);
  const wordResponse = await worker.fetch(new Request(wordUrl.toString(), { headers: auth }), env);
  assert.equal(wordResponse.status, 200);
  const word = await wordResponse.json();
  assert.equal(word.data.lyrics.synchronizedWordByWordLines.length, 1);
  assert.equal("plain" in word.data.lyrics, false);
  assert.ok(calls.some(call => call.url.hostname === "pipe.deezer.com"));
  console.log("Lyrics route test passed (plain, line-synced, word-synced, and all response shapes).");
} finally {
  globalThis.fetch = originalFetch;
}
