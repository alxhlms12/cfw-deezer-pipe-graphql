import assert from "node:assert/strict";
import { execute, getOperationAST, parse, specifiedRules, validate } from "graphql";
import { buildGraphQLSchema, queryComplexityRule } from "../src/graphql.js";

const resolver = async (name, args) => {
  if (name === "apiInfo") return {
    name: "Deezer Graph API", version: "3.2.1", endpoint: "/graphql", methods: ["GET", "POST"],
    queryTransport: "GET /graphql?query=...&variables=...", mutationTransport: "POST /graphql", features: ["graphql-introspection"],
    supportedFeatures: ["graphql-introspection"], transportDescription: "Queries use GET or POST; mutations use POST.",
  };
  if (name === "search") {
    const items = args.query === "mixed"
      ? [
          { id: "21", type: "track", title: "Track by discriminator", duration: 180, preview: "https://cdn.example.test/track.mp3" },
          { id: "22", name: "Artist by shape", picture: "https://cdn.example.test/artist.jpg" },
          { id: "23", title: "Album by shape", cover: "https://cdn.example.test/album.jpg", releaseDate: "2024-01-01" },
          { id: "24", title: "Playlist by shape", numberOfTracks: 18, duration: 600, image: "https://cdn.example.test/playlist.jpg" },
        ]
      : [{ id: "12", title: "Example Track", duration: 199, preview: "https://cdn.example.test/preview.mp3", artist: { id: "7", name: "Example Artist" }, album: { id: "4", title: "Example Album", cover: null } }];
    return {
      query: args.query ?? args.q ?? args.term, type: args.type || "TRACK", limit: args.limit || 25, offset: args.offset || 0,
      totalNumberOfItems: items.length, items,
    };
  }
  return null;
};
const schema = buildGraphQLSchema();
const document = parse(`
  query Search($term: String!, $showPreview: Boolean! = false) {
    results: search(query: $term, type: TRACK, limit: 5) {
      query type totalNumberOfItems
      items {
        id title duration
        ...TrackDetails
      }
    }
  }
  fragment TrackDetails on Track {
    preview @include(if: $showPreview)
    artist { id name }
    album { id title }
  }
`);
const validationErrors = validate(schema, document, [...specifiedRules, queryComplexityRule]);
assert.deepEqual(validationErrors, []);
const result = await execute({
  schema,
  document,
  variableValues: { term: "Ella Mai" },
  contextValue: { env: {}, origin: "https://worker.test", resolveQueryField: resolver, resolveMutationField: resolver },
});
assert.equal(result.errors, undefined, JSON.stringify(result.errors));
assert.equal(result.data.results.items[0].id, "12");
assert.equal(result.data.results.items[0].artist.name, "Example Artist");
assert.equal("preview" in result.data.results.items[0], false, "@include should honour its variable default");

const apiInfoResult = await execute({
  schema,
  document: parse("{ apiInfo { name version supportedFeatures transportDescription } }"),
  contextValue: { env: {}, origin: "https://worker.test", resolveQueryField: resolver, resolveMutationField: resolver },
});
assert.equal(apiInfoResult.errors, undefined, JSON.stringify(apiInfoResult.errors));
assert.deepEqual(apiInfoResult.data.apiInfo.supportedFeatures, ["graphql-introspection"]);
assert.match(apiInfoResult.data.apiInfo.transportDescription, /GET|POST/);

const mixedDocument = parse(`{
  search(query: "mixed") {
    items {
      __typename id title name duration
      ... on Track { preview }
      ... on Artist { picture }
      ... on AlbumSummary { cover releaseDate }
      ... on Playlist { numberOfTracks image }
    }
  }
}`);
const mixedResult = await execute({
  schema,
  document: mixedDocument,
  contextValue: { env: {}, origin: "https://worker.test", resolveQueryField: resolver, resolveMutationField: resolver },
});
assert.equal(mixedResult.errors, undefined, JSON.stringify(mixedResult.errors));
assert.deepEqual(
  mixedResult.data.search.items.map(item => item.__typename),
  ["Track", "Artist", "AlbumSummary", "Playlist"],
  "SearchItem.resolveType must return concrete GraphQL type-name strings for every supported item kind",
);
assert.equal(mixedResult.data.search.items[2].cover, "https://cdn.example.test/album.jpg");
assert.equal(mixedResult.data.search.items[3].numberOfTracks, 18);

const multi = parse("query First { apiInfo { name } } query Second { __typename }");
assert.equal(getOperationAST(multi, "Second").name.value, "Second", "named operation selection should work");
assert.equal(validate(schema, multi, [...specifiedRules, queryComplexityRule]).length, 0);

const introspection = parse("{ __schema { queryType { name } } }");
const introspectionResult = await execute({ schema, document: introspection, contextValue: { env: {}, origin: "https://worker.test", resolveQueryField: resolver, resolveMutationField: resolver } });
assert.equal(introspectionResult.data.__schema.queryType.name, "Query");

const unknownField = validate(schema, parse("{ notARealField }") );
assert.ok(unknownField.some(error => /Cannot query field/.test(error.message)));
const invalidSelection = validate(schema, parse('{ search(query: \"x\") }'));
assert.ok(invalidSelection.length > 0);
console.log("GraphQL schema tests passed (typed schema, fragments, directives, variables, multiple operations, introspection, and validation).");
