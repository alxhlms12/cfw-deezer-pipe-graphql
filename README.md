# Deezer HiFi API rebuild

Cloudflare Worker implementation with a Tidal `hifi-api`-style response envelope and route naming where Deezer has an honest equivalent. This is a clean implementation; it does not import or modify the previous Deezer Worker.

## Scope at a glance

- Catalog requests stay separate from media resolution. Search, artist, album, and playlist routes do not fetch or decrypt audio.
- Public Deezer REST API is the fallback source for catalog lookups. If `DEEZER_ARL` is configured, page-zero catalog searches use Pipe GraphQL first and fall back to REST if Pipe fails. Pipe is unofficial and may change without notice.
- `GET /track` and `GET /trackManifests` return only Deezer's official short MP3 preview URL when one exists. They never label a preview as FLAC/full-track media.
- No `/stream` route, full-track audio decryption, arbitrary URL proxy, Widevine handler, or full lyrics relay is included.
- Catalog responses are not cached; all responses have `Cache-Control: no-store` for repeatable testing. Only the short-lived Pipe JWT is held in module memory for auth efficiency.
- The included WASM module calculates bounded Levenshtein distance for `/cover?q=` title matching. It is not an audio decoder or encryption/decryption module.

## Deploy

1. Install Node.js 20+.
2. From this folder run `npm install`.
3. Run `npm run check` and `npm test`.
4. Optional: add `DEEZER_ARL` as a Cloudflare Worker secret to enable Pipe GraphQL for search:

   ```sh
   npx wrangler secret put DEEZER_ARL
   ```

5. Optional: set `API_KEY` as a Cloudflare Worker secret if the deployed API should require client authentication:

   ```sh
   npx wrangler secret put API_KEY
   ```

   When configured, send `Authorization: Bearer <API_KEY>` or `X-API-Key: <API_KEY>`. This is deliberately optional because the safe default uses public catalog requests without credentials. Do not put `DEEZER_ARL` in frontend code or in query parameters.

6. Run locally using `npm run dev`, or deploy with `npm run deploy`.

There are **no required environment variables**. `DEEZER_ARL` and `API_KEY` are optional; the latter is recommended for any public deployment. The Worker also applies a best-effort per-isolate limit of 120 requests per IP per minute. Use Cloudflare-level rate limiting for a durable distributed limit if you expose it publicly.

## Routes

All routes are `GET` only except for `OPTIONS` CORS preflight. Query parameters are validated; errors use `{ "version": "3.0.0", "error": { "code", "message", "requestId" } }`. Routes return `Cache-Control: no-store`.

| Route | Query | Upstream / behavior | Response shape |
|---|---|---|---|
| `/` | none | Local service info | `{version, Repo}` |
| `/info` | `id` | Deezer `track/{id}` | `{version, data}`; maps supported track fields and marks preview availability honestly |
| `/track` | `id`; optional `quality` | Deezer `track/{id}` | Tidal-style track manifest wrapper holding a base64 JSON preview descriptor; preview only |
| `/trackManifests` | `id`; optional `formats`, `uriScheme` | Deezer `track/{id}` | Tidal v2.7-style `{data:{data:{id,type,attributes},links}}`, with `trackPresentation: PREVIEW` and `formats: ["MP3_PREVIEW"]` |
| `/recommendations` | `id`; optional `limit`, `offset` | Deezer `track/{id}/radio` | `{version,data:{limit,offset,totalNumberOfItems,items:[{track,sources}]}}` |
| `/search` | exactly one of `s`, `a`, `al`, `p`, `i`; optional `limit`, `offset` | Pipe GraphQL on first page when configured; REST fallback | track results under `data`; artist, album, playlist results nested under `data.artists`, `data.albums`, `data.playlists` |
| `/album` | `id`; optional `limit`, `offset` | Deezer `album/{id}` and `album/{id}/tracks` in parallel | `{version,data:{...album,numberOfTracks,items,pagination}}` |
| `/mix` | `id` (Deezer track ID); optional `limit`, `offset` | Deezer `track/{id}` and `track/{id}/radio` in parallel | `{version,mix,items,pagination}`; interpreted as track radio, not a Tidal mix token |
| `/playlist` | `id`; optional `limit`, `offset` | Deezer `playlist/{id}` and `playlist/{id}/tracks` in parallel | `{version,playlist:{...playlist,items,pagination}}` |
| `/cover` | either `id` (track ID) or `q` | Deezer track/track search; WASM assists best-match title scoring | `{version,covers:[{id,name,small,medium,large,xl}]}` |
| `/artist` | either `id` or `f`; `skip_tracks`, `limit`, `offset` for `f` | Deezer artist, albums, top tracks, album tracklists | `{version,artist,cover}` for `id`; `{version,albums,tracks}` for `f` |
| `/artist/similar` | `id`; optional `limit`, `offset` | Deezer `artist/{id}/related` | `{version,data:{artist,items,limit,offset,totalNumberOfItems}}` |

`/lyrics` is retained as an explicit `501 LYRICS_NOT_EXPOSED` response: Deezer's public REST catalog doesn't offer a supported lyrics endpoint, and this project doesn't proxy full copyrighted lyrics. `/widevine`, `/video`, `/topvideos`, and `/album/similar` are not implemented because they do not have a suitable supported Deezer public-catalog equivalent. The Tidal-only video-search key `v` is rejected explicitly.

### Search examples

```text
GET /search?s=track%3A%22Get%20Lucky%22
GET /search?a=Daft%20Punk&limit=10
GET /search?al=Discovery&limit=20&offset=0
GET /search?p=electronic&limit=10
GET /search?i=USQX91400008
GET /trackManifests?id=3135556
GET /recommendations?id=3135556&limit=20
GET /artist/similar?id=27
```

The track identifier examples are illustrative; a route can return `404` or a preview-unavailable error when a track is removed, region-limited, or has no preview.

## Upstream endpoint research

### Public REST

Base URL: `https://api.deezer.com`. The Worker uses these public catalog resources:

- `GET /track/{id}`
- `GET /album/{id}` and `GET /album/{id}/tracks?limit=&index=`
- `GET /artist/{id}`, `GET /artist/{id}/top?limit=`, `GET /artist/{id}/albums?limit=&index=`, `GET /artist/{id}/related?limit=`
- `GET /playlist/{id}` and `GET /playlist/{id}/tracks?limit=&index=`
- `GET /search`, `GET /search/artist`, `GET /search/album`, `GET /search/playlist`
- `GET /track/{id}/radio?limit=`

The public REST search supports `index` rather than the Tidal README's `offset`; the Worker translates `offset` to `index`. Requested page size is capped at 100 to avoid sending unsupported, overly large REST requests. No automatic retries are performed for the catalog path; retry logic could multiply latency and upstream load.

### Pipe GraphQL (optional)

- Authentication: `POST https://auth.deezer.com/login/arl?jo=p&rto=c&i=c`, sending the ARL only as a server-side cookie.
- Catalog query: `POST https://pipe.deezer.com/api`, with a short-lived Bearer JWT and GraphQL variables.
- The implementation refreshes its JWT with a 30-second expiry margin and coalesces concurrent refresh requests within an isolate. It doesn't log credentials or return tokens to clients.
- GraphQL is undocumented and unofficial. It is used only for page-zero metadata search; offset pages deliberately use REST so the Worker doesn't fake numeric pagination from a missing GraphQL cursor.

### Response contract decisions

The Tidal README is the compatibility reference for route names, wrappers, pagination keys, and `trackManifests` nesting. Deezer fields are mapped where their meaning is comparable. The build intentionally doesn't invent Tidal-only `bpm`, key, replay gain, DRM, Atmos, FLAC, or audio-normalization information. The preview manifest says `PREVIEW` and returns `MP3_PREVIEW`; if a track has no official preview URL, the route returns a clear `404` instead of manufacturing a media URL.

## WASM layout

```text
wasm/match.wasm          compiled bounded string-distance helper
src/match.c              source for that helper
src/wasm-match.js        Worker wrapper with JavaScript fallback
```

The `CompiledWasm` rule in `wrangler.toml` is required so Wrangler bundles the module correctly. The binary was smoke-tested by instantiating it and checking a string edit distance. The Worker wrapper handles Wrangler’s `CompiledWasm` module import as well as byte-based instantiation, and falls back to a JavaScript implementation if the optional helper cannot run.

## Sources checked

- [Deezer developer API](https://developers.deezer.com/api)
- [Deezer public API endpoint index](https://apis.io/apis/deezer/platform/)
- [Pipe GraphQL current client authentication flow](https://github.com/music-assistant/deezer-python-gql/blob/main/deezer_python_gql/base_client.py)
- [Pipe GraphQL search query schema](https://github.com/music-assistant/deezer-python-gql/blob/main/queries/search.graphql)
- [Pipe GraphQL track query schema](https://github.com/music-assistant/deezer-python-gql/blob/main/queries/get_track.graphql)
- [Deezer Python client route methods](https://deezer-python.readthedocs.io/en/v7.0.0/api_reference/client.html)

Pipe field names and authentication behavior were checked against the current public source on 2026-10-15. Because Pipe is not a stable public API, deploy-time/live behavior still needs verification with the target Deezer account.
