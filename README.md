# Deezer HiFi API rebuild

Cloudflare Worker implementation with a Tidal `hifi-api`-style response envelope and route naming where Deezer has an honest equivalent. This is a clean implementation; it does not import or modify the previous Deezer Worker.

## Scope at a glance

- Catalog requests stay separate from media resolution. Search, artist, album, and playlist routes do not fetch or decrypt audio.
- Public Deezer REST API is the fallback source for catalog lookups. If `DEEZER_ARL` is configured, page-zero catalog searches use Pipe GraphQL first and fall back to REST if Pipe fails. Pipe is unofficial and may change without notice.
- Catalog routes do not resolve audio. `GET /track` and `GET /trackManifests` use the official 30-second preview when `quality=PREVIEW` is requested or no ARL is configured; with a server-side `DEEZER_ARL`, they can resolve an account-entitled full-track format.
- Full audio is served through `GET /track?id=...&playback=1&quality=...&pt=...`; this is deliberately not a separate `/stream` route. The short-lived signed `pt` token binds playback to one track and format, and the Worker fetches only HTTPS Deezer media hosts.
- `POST /track?log=listen` sends best-effort start/30-second listen events to Deezer's undocumented `log.listen` gateway method. The `start` event returns a refreshed signed `playToken` containing the listening start time; use that token for the 30-second event. This is an unofficial gateway protocol, so an accepted HTTP response is not proof of royalties, play-count, or listening-history credit.
- Full-track resolution uses Deezer's authenticated media endpoint and its `BF_CBC_STRIPE` format, decrypted inside the Worker. It is unofficial and may break if Deezer changes the private endpoint; the Worker only asks for formats currently offered to the configured account. No arbitrary URL proxy or Widevine route is included.
- Catalog responses are not cached; all responses have `Cache-Control: no-store` for repeatable testing. Only the short-lived Pipe JWT is held in module memory for auth efficiency.
- The project includes two compiled WASM modules: bounded Levenshtein distance for `/cover?q=` matching and the Blowfish stripe transform used by the authenticated progressive/HLS MP3 playback path. The MD5-derived track-key setup remains in JavaScript; the per-stripe decryption transform runs in WASM.

## Deploy

1. Install Node.js 20+.
2. From this folder run `npm install`.
3. Run `npm run check` and `npm test`.
4. Add the Deezer ARL as a Cloudflare Worker secret:

   ```sh
   npx wrangler secret put DEEZER_ARL
   ```

5. Add a long random API key as a second secret:

   ```sh
   npx wrangler secret put API_KEY
   ```

   Use `Authorization: Bearer <API_KEY>` or `X-API-Key: <API_KEY>` when requesting manifests/catalog routes. The generated signed audio URL and listen-reporting requests don't need the long-lived key header, but their signed token expires after 30 minutes. Do not put the ARL or the long-lived API key in public frontend code, logs, or a public repository.

6. Run locally using `npm run dev`, or deploy with `npm run deploy`.

`DEEZER_ARL` and `API_KEY` are both required for full-track playback. Catalog-only use without those secrets still works through the public REST API. The Worker applies a best-effort per-isolate limit of 120 requests per IP per minute; use Cloudflare-level rate limiting for durable distributed limits on public deployments.

## Routes

Routes are `GET` except `POST /track?log=listen` and `OPTIONS` CORS preflight. Query parameters are validated; errors use `{ "version": "3.0.0", "error": { "code", "message", "requestId" } }`. Responses are not cached.

| Route | Query | Upstream / behavior | Response shape |
|---|---|---|---|
| `/` | none | Local service info | `{version, Repo}` |
| `/info` | `id` | Deezer `track/{id}` | `{version, data}`; maps supported track fields and marks preview availability honestly |
| `/track` | `id`; optional `quality`; internal signed playback URL uses `playback=1&pt=...` | Deezer preview API or authenticated `song.getListData` → `media.deezer.com/v1/get_url` → Deezer CDN | Tidal-style manifest wrapper for preview/full format; with `playback=1`, returns decrypted audio bytes and supports single byte ranges |
| `/trackManifests` | `id`; optional `formats`, `quality`, `uriScheme` | Deezer preview API or authenticated media resolver | Tidal v2.7-style manifest wrapper with preview/progressive full-audio URLs; `manifestType=HLS` returns a single packed-MP3 VOD playlist and short-lived signed segment URL. MPEG-DASH is explicitly unsupported. |
| `POST /track?log=listen` | JSON body `{trackId, playToken, event}` where `event` is `start` or `30` | Deezer internal `gw-light.php` `log.listen` method | Best-effort telemetry result; the `start` response returns an updated `playToken` for the 30-second event |
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
GET /trackManifests?id=3135556&quality=FLAC
GET /recommendations?id=3135556&limit=20
GET /artist/similar?id=27
```

The track identifier examples are illustrative; a route can return `404` or a preview-unavailable error when a track is removed, region-limited, or has no preview. For full playback, `MEDIA_RESOLUTION_FAILED` includes sanitized per-format HTTP/error codes (for example, HTTP 403) so an upstream entitlement/session rejection is distinguishable from a Worker parser failure. Raw upstream response bodies and credentials are not returned.


### Full-track playback and listen reporting

With both secrets configured, request a manifest with `GET /trackManifests?id=<id>` or `GET /track?id=<id>`, authenticating that request with `Authorization: Bearer <API_KEY>`. The response contains a `playbackToken` and a signed progressive URL; the signed URL expires after 30 minutes and is bound to the requested track and format. `quality=best` tries FLAC, then MP3 320, then MP3 128 subject to account entitlement. `quality=PREVIEW` explicitly requests only the public preview. `manifestType=HLS` returns a single-file HLS VOD playlist using MP3_320 (falling back to MP3_128) because raw FLAC is not a supported HLS packed-audio segment. The playlist URI itself is signed and expires with the token. `manifestType=MPEG_DASH` is not implemented and returns `MANIFEST_TYPE_UNSUPPORTED`; omit `manifestType` for progressive FLAC/MP3 playback. `usage=DOWNLOAD` returns `USAGE_UNSUPPORTED`; the legacy misspelling `usgae=PLAYBACK` is accepted for compatibility.

The Worker cannot observe whether a client actually plays audio, so the client should report the events from its media player's real playback events—not merely from a manifest request. At `playing`, POST `{ "trackId": "<id>", "playToken": "<manifest playbackToken>", "event": "start" }` to `/track?log=listen`. Save the returned updated `playToken`; once `audio.currentTime >= 30`, POST the same body with that updated token and `event: "30"`. These telemetry requests can run asynchronously and should not block playback. Use `fetch(..., {method:"POST", keepalive:true, headers:{"Content-Type":"text/plain"}, body:JSON.stringify(body)})` or a `sendBeacon` for transport. The Worker enforces that the 30-second event follows a signed start event at least 30 seconds earlier, but because Deezer's gateway and listen-count rules are undocumented, the endpoint response cannot guarantee that Deezer credited a qualifying play or royalties.

This path uses private, undocumented Deezer endpoints, not a public SDK contract. Test with your own account and verify listening history in Deezer rather than treating a successful HTTP response as proof that tracking worked.

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

The Tidal README is the compatibility reference for route names, wrappers, pagination keys, and `trackManifests` nesting. Deezer fields are mapped where their meaning is comparable. Full media resolution is isolated to `/track` and `/trackManifests` requests; ordinary search and metadata requests never fetch or decrypt audio. Preview manifests say `PREVIEW` and return `MP3_PREVIEW`; if a track has no official preview URL, the route returns `404` instead of manufacturing a preview URL.

## WASM layout

```text
wasm/match.wasm          compiled bounded string-distance helper
src/match.c              source for the string-distance helper
src/wasm-match.js        Worker wrapper with JavaScript fallback
wasm/decrypt.wasm        compiled Blowfish stripe transform
src/decrypt.c            source for the Blowfish transform
src/wasm-decrypt.js      key setup, per-track cipher cache, batched WASM calls
```

The `CompiledWasm` rule in `wrangler.toml` is required so Wrangler bundles the modules correctly. The decryption wrapper caches up to 64 initialized ciphers per isolate and batches selected encrypted stripes to reduce JavaScript/WASM boundary crossings. Tests compare the WASM output with three single-stripe and two aligned-buffer reference vectors, including a multi-batch buffer. Local synthetic-buffer benchmarks show performance close to the previous JavaScript path; WASM is not guaranteed to be faster on every runtime or chunk size. Playback tests mock Deezer authentication, media resolution, CDN responses, byte-range playback, single-file HLS output, and listen events; mocks do not prove live Deezer access or royalty credit.

## Sources checked

- [Deezer developer API](https://developers.deezer.com/api)
- [Deezer public API endpoint index](https://apis.io/apis/deezer/platform/)
- [Pipe GraphQL current client authentication flow](https://github.com/music-assistant/deezer-python-gql/blob/main/deezer_python_gql/base_client.py)
- [Pipe GraphQL search query schema](https://github.com/music-assistant/deezer-python-gql/blob/main/queries/search.graphql)
- [Pipe GraphQL track query schema](https://github.com/music-assistant/deezer-python-gql/blob/main/queries/get_track.graphql)
- [Deezer Python client route methods](https://deezer-python.readthedocs.io/en/v7.0.0/api_reference/client.html)
- [OpenDeezer private media-resolution and authenticated playback overview](https://github.com/Cycl0o0/OpenDeezer)
- [Observed `log.listen` request structure](https://gist.github.com/TavoElgueaLopez/d15827f246b27cf3130e77b5468fe434)

Pipe field names and authentication behavior were checked against the current public source on 2026-10-15. Because Pipe is not a stable public API, deploy-time/live behavior still needs verification with the target Deezer account.
