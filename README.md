# Deezer Graph API

Cloudflare Worker providing a typed GraphQL API backed by Deezer's catalog and playback services. The `/graphql` endpoint uses **GraphQL.js**, the reference implementation for JavaScript, for document parsing, standards-based validation, variable coercion, execution, introspection, fragments, directives, and operation selection. This replaces the previous home-grown GraphQL-like parser.

## How close is it to real GraphQL?

The **GraphQL language, schema validation, and execution layer now use the real GraphQL.js implementation**, rather than approximating the syntax and projection behavior in custom code. This enables standard operations, variables, aliases, fragments, built-in directives such as `@skip` and `@include`, multiple operations selected with `operationName`, schema introspection, typed arguments/enums, nested selection validation, standard field execution, and standard GraphQL error locations and paths.

The service is not a complete implementation of every possible GraphQL-over-HTTP deployment feature: it supports HTTP queries and mutations, but not subscription transport, multipart upload, incremental delivery (`@defer`/`@stream`), or persisted-query extensions. Those are transport/server features beyond ordinary GraphQL query and mutation execution. A query complexity guard limits documents to 32,768 characters, 1,000 fields, and a selection depth of 20. The service uses GraphQL.js v17, the current reference implementation release line.

## Features

- Public catalog search and metadata: tracks, artists, albums, playlists, ISRC lookup, artwork, artist relationships, advanced track metadata, and alternative album editions.
- Public discovery: similar tracks, round-robin track/artist mixes, batch track lookup, country-chart candidates through Pipe, podcasts, genres, genre artists, radio stations, and radio tracks.
- Account-data boundary: the GraphQL schema is an explicit allowlist. Personal Flow/configuration (`me { flowConfigs }`), account profiles, favorites, private playlists, listening history, user libraries, and playlist/favorite mutations are not exposed. Flow configuration is deliberately excluded because the Pipe operation is rooted under `me`.
- SongCatcher: no native Pipe audio-fingerprinting operation has been confirmed, so no fake SongCatcher operation is published. Audio recognition would require a separate recognition integration.
- Account-specific quality prediction through Deezer Pipe GraphQL when `DEEZER_ARL` is configured.
- Preview or full-track progressive playback manifests, HLS manifests, and signed media delivery URLs. MPEG-DASH and download usage are recognized by the API but are currently reported as unsupported by the adapter.
- Optional playback reporting through the `reportPlayback` mutation. Deezer's `log.listen` protocol is undocumented, so an accepted response is not proof of listening-history or royalty credit.
  `reportPlayback` is nullable at the schema level so expected playback-threshold errors remain scoped to that field instead of nulling the entire GraphQL `data` object.
- Legacy module-specific routes, fields, client helpers, settings, and tests have been removed; the API surface is GraphQL-first.
- The Worker never accepts arbitrary Pipe GraphQL text from clients; every Pipe query is hard-coded server-side. Do not add `me`, favorites, personal Flow, private playlists, or listening-history selections to public resolvers. Responses are not cached; `Cache-Control: no-store` is retained for repeatable testing. A per-isolate rate limiter is best-effort; use Cloudflare-level rate limiting for production.

## Install and deploy

1. Use Node.js 22 or newer (required by GraphQL.js v17).
2. Run `npm install` to install `graphql` and Wrangler.
3. Run `npm run check` and `npm test`.
4. Add the Deezer ARL as a Cloudflare Worker secret when authenticated Pipe catalog metadata and full-track playback are needed:

   ```sh
   npx wrangler secret put DEEZER_ARL
   ```

5. Add a long random API key as a second Cloudflare Worker secret:

   ```sh
   npx wrangler secret put API_KEY
   ```

   Use `Authorization: Bearer <API_KEY>` or `X-API-Key: <API_KEY>` for GraphQL requests when `API_KEY` is configured. The long-lived key and ARL must not be placed in public frontend code. Signed media URLs use a short-lived signed token and expire after 30 minutes.

6. Run `npm run dev` locally or deploy with `npm run deploy`.

Both secrets are required for authenticated full-track playback. Catalog-only search continues to use Deezer's public REST API without the secrets; if `DEEZER_ARL` is set, eligible catalog lookups use Pipe GraphQL first and fall back to REST if Pipe fails. Pipe and the underlying media service are unofficial/undocumented dependencies and can change without notice.


## Public discovery and account-data boundary

The discovery fields are public-catalog wrappers or fixed Pipe queries—not a general-purpose Pipe proxy. `countryCharts` is a candidate against the private Pipe schema and requires a configured `DEEZER_ARL`; validate it against the live upstream schema before depending on it. It uses cursor pagination (`after`) rather than an offset. Track/artist mixes are composed from public Deezer REST track-radio and artist-top responses, so they are not promised to match Deezer's proprietary personalized Mix algorithms. Public REST podcast, genre, and radio routes can change or be region-limited.

Flow is intentionally not exposed: the available Pipe flow-configuration operation is account-rooted (`me { flowConfigs { ... } }`). There is no public `me`, favorites, listening-history, user-library, private-playlist, personal Flow, or account mutation field in this schema. No client-supplied GraphQL is forwarded to Pipe.

SongCatcher is not implemented as a Pipe feature because no native Pipe audio-recognition operation has been confirmed. These changes do not claim to identify an audio recording. That would require a separate fingerprinting provider or a confirmed upstream operation.

## HTTP transport

### GET query

Use a URL-encoded GraphQL document in `query`. Optional `variables`, `extensions`, and `operationName` parameters are JSON/text URL parameters. GET is for read-only queries; mutations receive HTTP 405 on GET.

```text
GET /graphql?query=%7B%20search(query%3A%22Ella%20Mai%22)%20%7B%20totalNumberOfItems%20items%20%7B%20id%20title%20duration%20%7D%20%7D%20%7D
```

### POST query or mutation

Send a JSON body with `query`, and optionally `variables`, `operationName`, and `extensions`:

```http
POST /graphql
Content-Type: application/json

{"query":"query Search($term: String!) { search(query: $term) { query totalNumberOfItems items { id title duration } } }","variables":{"term":"Ella Mai"}}
```

POST follows the GraphQL-over-HTTP JSON request format (`Content-Type: application/json`). The response uses proper `Accept` content negotiation between `application/graphql-response+json` and the legacy-compatible `application/json`. Request parse failures use HTTP 400, validation and operation-selection failures use HTTP 422, GET mutations use HTTP 405, and execution errors use HTTP 200 with a GraphQL `errors` array.

### Fragments and runtime type fields

The `search.items` field is a typed `SearchItem` interface. Shared fields (`id`, `title`, `name`, `url`, `duration`, `quality`) can be selected directly. Type-specific fields need an inline fragment or named fragment, as in a normal GraphQL schema:

```graphql
query Search($term: String!, $showPreview: Boolean!) {
  search(query: $term, type: TRACK) {
    items {
      id
      title
      ... on Track {
        preview @include(if: $showPreview)
        artist { id name }
        album { id title cover }
      }
    }
  }
}
```

Example URL with variables and an operation name, after encoding the `query` and `variables` values:

```text
/graphql?query=query%20FindTracks(%24term%3A%20String!)%20%7B%20search(query%3A%24term%2C%20type%3ATRACK)%20%7B%20items%20%7B%20id%20title%20quality%20%7B%20status%20predictedQuality%20bestFormat%20%7D%20%7D%20%7D%20%7D&variables=%7B%22term%22%3A%22Ella%20Mai%22%7D&operationName=FindTracks
```

## Schema fields

| Field | Arguments | Result |
|---|---|---|
| `apiInfo` | none | Name, version, `supportedFeatures`, `transportDescription`, and backward-compatible transport/feature aliases (`features`, `queryTransport`, `mutationTransport`) |
| `search` | `query` or `q`/`term`, `type`, `limit`, `offset` | Typed search result page; default `type` is `TRACK` |
| `track`, `trackInfo` | `id: ID!` | Track metadata and quality prediction; does not create a media URL |
| `quality` | `id: ID!`, `includePreview` | Account-specific format-availability report |
| `trackManifest` | `id: ID!`, `quality`, `formats`, `manifestType`, `usage`, `uriScheme` | Preview or full-playback manifest; HLS is supported; MPEG-DASH and download remain unsupported |
| `recommendations` | `id: ID!`, `limit`, `offset` | Track-radio recommendations |
| `album` | `id: ID!`, `limit`, `offset` | Album metadata, tracks, and pagination |
| `mix` | `id: ID!`, `limit`, `offset` | Track-radio mix and tracks |
| `playlist` | `id: ID!`, `limit`, `offset` | Playlist metadata, tracks, and pagination |
| `cover`, `covers` | `id` or `query`/`q` | Artwork from a track or title search |
| `artist` | `id: ID!` | Artist metadata |
| `artistCatalog` | `id: ID!`, `skipTracks`, `limit`, `offset` | Artist albums and track catalog |
| `similarArtists` | `id: ID!`, `limit`, `offset` | Related artists |
| `similarTracks` | `id: ID!`, `limit`, `offset` | Track-radio recommendations |
| `trackMix` | `ids: [ID!]!`, `limit`, `offset` | Public multi-seed mix assembled from track-radio catalogs |
| `artistMix` | `ids: [ID!]!`, `limit`, `offset` | Public multi-artist mix assembled from artist top-track catalogs |
| `tracksByIds` | `ids: [ID!]!` (up to 100) | Batch public track lookup, preserving input order |
| `albumEditions` | `id: ID!`, `limit` | Same-title album editions with artist matching |
| `countryCharts` | `countryCode`, `category`, `limit`, `after` | Country-chart candidate via Pipe cursor pagination; live schema acceptance must be checked against Deezer |
| `podcastSearch` | `query`, `limit`, `offset` | Public podcast search |
| `podcast` | `id`, `limit`, `offset` | Public podcast metadata and episodes |
| `genres` | none | Public genre catalog |
| `genreArtists` | `id`, `limit`, `offset` | Artists in a public genre |
| `radioStations` | none | Public radio-station catalog |
| `radioStation` | `id`, `limit`, `offset` | Public radio metadata and tracks |
| `lyrics` | `id: ID!`, `type` (`ALL`, `PLAIN`, `LINE`, `WORD`) | Lyrics and available synchronized forms when Deezer returns them for the configured account/region |
| `reportPlayback` mutation | `trackId: ID!`, `playToken: String!`, `event: PlaybackEvent!` | Best-effort listen-reporting result; `event` is `START` or `THIRTY_SECONDS` |

`SearchType`, `ChartCategory`, `TrackQuality`, `ManifestType`, `ManifestUsage`, `UriScheme`, `LyricsForm`, and `PlaybackEvent` are schema enums. Use enum values without quotes, for example `type: TRACK`, `quality: BEST`, and `type: WORD` for lyrics.

## More examples

Track manifest:

```graphql
query Manifest($id: ID!) {
  trackManifest(id: $id, quality: BEST, manifestType: PROGRESSIVE) {
    id trackPresentation uri manifestMimeType formats audioQuality streamUrl
  }
}
```

Lyrics, when provided by Pipe for the current authenticated session/region:

```graphql
query Lyrics($id: ID!) {
  lyrics(id: $id, type: WORD) {
    trackId title synchronizedWordByWordLines {
      start end words { start end word }
    }
  }
}
```

Playback reporting is a mutation and therefore must use POST:

```graphql
mutation Report($id: ID!, $token: String!, $event: PlaybackEvent!) {
  reportPlayback(trackId: $id, playToken: $token, event: $event) {
    accepted duplicate event playToken
  }
}
```

GraphQL introspection is enabled through the standard `__schema` and `__type` fields. All old catalog REST routes such as `/search`, `/album`, `/trackManifests`, and `/artist/similar` return `404 ROUTE_MOVED_TO_GRAPHQL`. `/delivery/audio` and `/delivery/manifest` are signed internal media transports returned through playback manifests, not catalog endpoints.

## Quality reporting

Track search items may include a `quality` object. With `DEEZER_ARL` configured, the Worker requests Pipe GraphQL `media.estimatedSizes` and `media.rights` and predicts the highest reported format in this order: FLAC, MP3 320, MP3 128. The exact response depends on Pipe. Without `DEEZER_ARL`, the report is `AUTH_REQUIRED`; if Pipe fails, it is `UNKNOWN`. This is an availability prediction, not a guarantee that later media resolution will succeed.

## Playback notes

The `trackManifest` field returns the official 30-second preview when `quality: PREVIEW` is requested or the Worker has no authenticated ARL. With a configured ARL, it may resolve a format that the account can play. `streamUrl` remains the backwards-compatible playable URL: a preview URL for previews, a signed `/delivery/audio` URL for progressive audio, or the HLS playlist URL for HLS. `uri` may instead be a `data:` URI when `uriScheme: DATA` is requested. Full audio is delivered through a signed `/delivery/audio` URL; the short-lived `pt` token binds playback to a track and format. The Worker fetches only approved HTTPS Deezer media hosts. The Blowfish stripe transform runs in WASM; media token negotiation and decryption formats are undocumented and can change.
