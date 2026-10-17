import assert from "node:assert/strict";
import worker from "../src/index.js";
import { buildGraphQLSchema } from "../src/graphql.js";

const schema = buildGraphQLSchema();
const queryFields = Object.keys(schema.getQueryType().getFields());
const mutationFields = Object.keys(schema.getMutationType().getFields());
for (const field of [
  "similarTracks", "trackMix", "artistMix", "tracksByIds", "albumEditions",
  "countryCharts", "podcastSearch", "podcast", "genres", "genreArtists",
  "radioStations", "radioStation",
]) assert.ok(queryFields.includes(field), `missing public discovery field ${field}`);
for (const forbidden of ["me", "flow", "flowConfigs", "favoriteTracks", "recentlyPlayed", "userPlaylists", "userFavorites", "songCatcher"]) {
  assert.ok(!queryFields.includes(forbidden), `account-scoped query ${forbidden} must not be public`);
}
for (const forbidden of ["createPlaylist", "updatePlaylist", "deletePlaylist", "addTrackToFavorite", "removeTrackFromFavorite"]) {
  assert.ok(!mutationFields.includes(forbidden), `account-scoped mutation ${forbidden} must not be public`);
}

const originalFetch = globalThis.fetch;
const env = { API_KEY: "public-discovery-test-key" }; // Intentionally no DEEZER_ARL.
const calls = [];
const track = (id, title = `Track ${id}`) => ({
  id, title, duration: 180, bpm: 121.4, gain: -8.2, rank: 77, release_date: "2025-01-02",
  preview: `https://cdn.example.test/${id}.mp3`, link: `https://www.deezer.com/track/${id}`,
  artist: { id: 7, name: "Test Artist", link: "https://www.deezer.com/artist/7" },
  contributors: [{ id: 7, name: "Test Artist" }, { id: 70, name: "Featured Artist" }],
  album: { id: 8, title: "Test Album", cover_xl: "https://cdn.example.test/album.jpg", upc: "123456789012", label: "Test Label" },
});

globalThis.fetch = async (input) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  if (url.hostname !== "api.deezer.com") throw new Error(`Unexpected upstream host: ${url.hostname}`);
  calls.push(url);
  let body = {};
  if (/^\/track\/\d+$/.test(url.pathname)) {
    const id = url.pathname.split("/").at(-1);
    body = track(Number(id), id === "50" ? "Album Alpha" : undefined);
  } else if (/^\/track\/\d+\/radio$/.test(url.pathname)) {
    const seed = Number(url.pathname.split("/")[2]);
    body = { total: 2, data: seed === 1 ? [track(110), track(111)] : [track(120), track(121)] };
  } else if (/^\/artist\/\d+$/.test(url.pathname)) {
    const id = Number(url.pathname.split("/").at(-1));
    body = { id, name: `Artist ${id}`, picture_xl: "https://cdn.example.test/artist.jpg", link: `https://www.deezer.com/artist/${id}` };
  } else if (/^\/artist\/\d+\/top$/.test(url.pathname)) {
    const id = Number(url.pathname.split("/")[2]);
    body = { total: 2, data: id === 3 ? [track(210), track(211)] : [track(220), track(221)] };
  } else if (url.pathname === "/album/50") {
    body = { id: 50, title: "Album Alpha", artist: { id: 7, name: "Test Artist" } };
  } else if (url.pathname === "/search/album") {
    body = { total: 3, data: [
      { id: 50, title: "Album Alpha", artist: { id: 7, name: "Test Artist" } },
      { id: 51, title: "Album Alpha", artist: { id: 7, name: "Test Artist" }, cover_xl: "https://cdn.example.test/edition.jpg" },
      { id: 52, title: "Different Album", artist: { id: 7, name: "Test Artist" } },
    ] };
  } else if (url.pathname === "/search/podcast") {
    body = { total: 1, data: [{ id: 60, title: "Science Weekly", description: "Public show", picture_xl: "https://cdn.example.test/podcast.jpg", link: "https://www.deezer.com/podcast/60" }] };
  } else if (url.pathname === "/podcast/60") {
    body = { id: 60, title: "Science Weekly", description: "Public show", picture_xl: "https://cdn.example.test/podcast.jpg", link: "https://www.deezer.com/podcast/60" };
  } else if (url.pathname === "/podcast/60/episodes") {
    body = { total: 1, data: [{ id: 600, title: "Episode One", duration: 600, release_date: "2025-03-04", link: "https://www.deezer.com/episode/600" }] };
  } else if (url.pathname === "/genre") {
    body = { data: [{ id: 1, name: "Pop", picture_xl: "https://cdn.example.test/pop.jpg" }] };
  } else if (url.pathname === "/genre/1") {
    body = { id: 1, name: "Pop", picture_xl: "https://cdn.example.test/pop.jpg" };
  } else if (url.pathname === "/genre/1/artists") {
    body = { total: 1, data: [{ id: 7, name: "Test Artist", picture_xl: "https://cdn.example.test/artist.jpg" }] };
  } else if (url.pathname === "/radio") {
    body = { data: [{ id: 9, title: "Pop Radio", picture_xl: "https://cdn.example.test/radio.jpg" }] };
  } else if (url.pathname === "/radio/9") {
    body = { id: 9, title: "Pop Radio", picture_xl: "https://cdn.example.test/radio.jpg" };
  } else if (url.pathname === "/radio/9/tracks") {
    body = { total: 1, data: [track(310)] };
  } else {
    throw new Error(`Unexpected Deezer REST request: ${url}`);
  }
  return Response.json(body);
};

function requestUrl(query) {
  const url = new URL("https://worker.test/graphql");
  url.searchParams.set("query", query);
  return url.toString();
}

try {
  const query = `query PublicDiscovery {
    tracksByIds(ids: ["1", "2"]) { id title bpm gain rank releaseDate contributors { id name } album { upc label } }
    similarTracks(id: "1", limit: 2) { totalNumberOfItems items { sources track { id title } } }
    trackMix(ids: ["1", "2"], limit: 4) { title items { id title } pagination { hasNextPage } }
    artistMix(ids: ["3", "4"], limit: 4) { title items { id title } }
    albumEditions(id: "50") { id title }
    podcastSearch(query: "science") { totalNumberOfItems items { id title } }
    podcast(id: "60") { id title episodes { id title duration releaseDate } pagination { totalNumberOfItems } }
    genres { id name picture }
    genreArtists(id: "1") { id name artists { id name } }
    radioStations { id title picture }
    radioStation(id: "9") { id title tracks { id title } pagination { totalNumberOfItems } }
  }`;
  const response = await worker.fetch(new Request(requestUrl(query), { headers: { Authorization: `Bearer ${env.API_KEY}` } }), env);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.errors, undefined, JSON.stringify(body.errors));
  assert.deepEqual(body.data.tracksByIds.map(x => x.id), ["1", "2"]);
  assert.equal(body.data.tracksByIds[0].bpm, 121.4);
  assert.equal(body.data.tracksByIds[0].gain, -8.2);
  assert.equal(body.data.tracksByIds[0].rank, 77);
  assert.equal(body.data.tracksByIds[0].releaseDate, "2025-01-02");
  assert.equal(body.data.tracksByIds[0].contributors.length, 2);
  assert.equal(body.data.tracksByIds[0].album.upc, "123456789012");
  assert.equal(body.data.tracksByIds[0].album.label, "Test Label");
  assert.deepEqual(body.data.trackMix.items.map(x => x.id), ["110", "120", "111", "121"]);
  assert.deepEqual(body.data.artistMix.items.map(x => x.id), ["210", "220", "211", "221"]);
  assert.deepEqual(body.data.albumEditions.map(x => x.id), ["51"]);
  assert.equal(body.data.podcastSearch.items[0].title, "Science Weekly");
  assert.equal(body.data.podcast.episodes[0].id, "600");
  assert.equal(body.data.genres[0].name, "Pop");
  assert.equal(body.data.genreArtists.artists[0].name, "Test Artist");
  assert.equal(body.data.radioStations[0].title, "Pop Radio");
  assert.equal(body.data.radioStation.tracks[0].id, "310");
  assert.ok(calls.every(url => url.hostname === "api.deezer.com"), "no unapproved upstream hosts are queried");

  const privateQuery = new URL(requestUrl("{ me { id } }"));
  const privateResponse = await worker.fetch(new Request(privateQuery.toString(), { headers: { Authorization: `Bearer ${env.API_KEY}` } }), env);
  assert.equal(privateResponse.status, 422, "account-specific fields must fail schema validation");
  assert.match((await privateResponse.text()), /Cannot query field/);

  const flowQuery = new URL(requestUrl("{ flowConfigs { moods { id } } }"));
  const flowResponse = await worker.fetch(new Request(flowQuery.toString(), { headers: { Authorization: `Bearer ${env.API_KEY}` } }), env);
  assert.equal(flowResponse.status, 422, "personalized Flow configuration must not be public");

  const invalidMixResponse = await worker.fetch(new Request(requestUrl('query { trackMix(ids: []) { items { id } } }'), { headers: { Authorization: `Bearer ${env.API_KEY}` } }), env);
  const invalidMixBody = await invalidMixResponse.json();
  assert.equal(invalidMixBody.errors?.[0]?.extensions?.code, "INVALID_ID_LIST", "mix seeds must be validated");

  const invalidCountryResponse = await worker.fetch(new Request(requestUrl('{ countryCharts(countryCode: "USA") { items { id } } }'), { headers: { Authorization: `Bearer ${env.API_KEY}` } }), env);
  const invalidCountryBody = await invalidCountryResponse.json();
  assert.equal(invalidCountryBody.errors?.[0]?.extensions?.code, "INVALID_COUNTRY_CODE");

  const chartResponse = await worker.fetch(new Request(requestUrl('{ countryCharts(countryCode: "US") { items { id } } }'), { headers: { Authorization: `Bearer ${env.API_KEY}` } }), env);
  const chartBody = await chartResponse.json();
  assert.equal(chartResponse.status, 200);
  assert.equal(chartBody.errors?.[0]?.extensions?.code, "ARL_REQUIRED", "country charts must not call account-backed Pipe without server credentials");

  console.log("Public discovery tests passed (catalog mix, batch lookup, public podcasts, genres, radio, album editions, metadata, input validation, and account-field exclusion). Country charts and Pipe schema candidates still require live validation.");
} finally {
  globalThis.fetch = originalFetch;
}
