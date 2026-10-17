import assert from "node:assert/strict";
import worker from "../src/index.js";

const originalFetch = globalThis.fetch;
const env = { API_KEY: "graphql-test-key", DEEZER_ARL: "graphql-test-arl" };
let restCalls = 0;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  if (url.hostname === "api.deezer.com" && url.pathname === "/search") {
    restCalls++;
    assert.equal(url.searchParams.get("q"), "Ella Mai");
    return Response.json({ total: 1, data: [{
      id: 44, title: "Example Song", duration: 199, preview: "https://cdn.example.test/preview.mp3",
      artist: { id: 9, name: "Ella Mai", link: "https://www.deezer.com/artist/9" },
      album: { id: 8, title: "Example Album", cover_xl: "https://cdn.example.test/cover.jpg" },
    }] });
  }
  throw new Error(`Unexpected upstream request: ${url}`);
};

try {
  const query = `query Search($term: String!, $limit: Int = 5) {
    results: search(query: $term, type: TRACK, limit: $limit) {
      query type totalNumberOfItems limit offset
      items { id title duration ... on Track { preview artist { id name } album { id title cover } } }
    }
  }`;
  const url = new URL("https://worker.test/graphql");
  url.searchParams.set("query", query);
  url.searchParams.set("variables", JSON.stringify({ term: "Ella Mai" }));
  const response = await worker.fetch(new Request(url.toString(), { headers: { Authorization: `Bearer ${env.API_KEY}` } }), { API_KEY: env.API_KEY });
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.get("Content-Type"), /application\/graphql-response\+json/);
  const body = await response.json();
  assert.equal(body.errors, undefined, JSON.stringify(body.errors));
  assert.equal(body.data.results.query, "Ella Mai");
  assert.equal(body.data.results.type, "TRACK");
  assert.equal(body.data.results.limit, 5, "GraphQL variable defaults should apply");
  assert.equal(body.data.results.items[0].id, 44);
  assert.equal(body.data.results.items[0].artist.name, "Ella Mai");
  assert.equal(body.data.results.items[0].album.title, "Example Album");
  assert.equal(restCalls, 1);

  // GET queries cannot perform mutations.
  const badGet = new URL("https://worker.test/graphql");
  badGet.searchParams.set("query", `mutation { reportPlayback(trackId: "44", playToken: "x", event: START) { accepted } }`);
  const rejected = await worker.fetch(new Request(badGet.toString(), { headers: { Authorization: `Bearer ${env.API_KEY}` } }), env);
  assert.equal(rejected.status, 405);
  assert.equal((await rejected.json()).errors[0].extensions.code, "GET_MUTATION_NOT_ALLOWED");

  const malformed = new URL("https://worker.test/graphql");
  malformed.searchParams.set("query", "{ search(query: ) { items { id } } }");
  const parseError = await worker.fetch(new Request(malformed.toString(), { headers: { Authorization: `Bearer ${env.API_KEY}` } }), env);
  assert.equal(parseError.status, 400);
  assert.ok((await parseError.json()).errors?.length);

  const invalidSelection = new URL("https://worker.test/graphql");
  invalidSelection.searchParams.set("query", '{ search(query: "x") { notARealField } }');
  const invalidSelectionResponse = await worker.fetch(new Request(invalidSelection.toString(), {
    headers: { Authorization: `Bearer ${env.API_KEY}`, Accept: "application/json" },
  }), env);
  assert.equal(invalidSelectionResponse.status, 422);
  assert.match(invalidSelectionResponse.headers.get("Content-Type"), /^application\/json/i);
  assert.ok((await invalidSelectionResponse.json()).errors?.length);

  const coercionResponse = await worker.fetch(new Request("https://worker.test/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.API_KEY}`, Accept: "application/graphql-response+json", "Content-Type": "application/json" },
    body: JSON.stringify({
      query: 'query BadVariables($limit: Int!) { search(query: "x", limit: $limit) { totalNumberOfItems } }',
      variables: { limit: "not-an-int" },
    }),
  }), env);
  assert.equal(coercionResponse.status, 422);
  assert.ok((await coercionResponse.json()).errors?.length);

  const unsupportedAccept = new URL("https://worker.test/graphql");
  unsupportedAccept.searchParams.set("query", "{ apiInfo { name } }");
  const unacceptable = await worker.fetch(new Request(unsupportedAccept.toString(), {
    headers: { Authorization: `Bearer ${env.API_KEY}`, Accept: "text/html" },
  }), env);
  assert.equal(unacceptable.status, 406);

  const oldRest = await worker.fetch(new Request("https://worker.test/search?s=Ella%20Mai", { headers: { Authorization: `Bearer ${env.API_KEY}` } }), env);
  assert.equal(oldRest.status, 404);
  assert.equal((await oldRest.json()).error.code, "ROUTE_MOVED_TO_GRAPHQL");

  const root = await worker.fetch(new Request("https://worker.test/", { headers: { Authorization: `Bearer ${env.API_KEY}` } }), env);
  assert.equal(root.status, 200);
  assert.equal((await root.json()).endpoint, "/graphql");
  console.log("GraphQL route tests passed (GET query, URL variables, typed selection, aliases, defaults, method errors, and retired REST route).");
} finally {
  globalThis.fetch = originalFetch;
}
