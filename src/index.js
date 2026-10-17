import { distance } from "./wasm-match.js";
import { createPlaybackToken, makeHlsTimestampTag, playbackResponse, reportListen, resolveFullTrack, validatePlaybackToken } from "./playback.js";
import {
  getAlbum, getAlbumTracks, getArtist, getArtistAlbums, getArtistTop, getRelatedArtists,
  getPlaylist, getPlaylistTracks, getTrack, getTrackRadio, mapAlbum, mapAlbumSummary,
  mapArtist, mapPlaylist, mapTrack, pagination, pipeGetAlbum, pipeGetArtist, pipeGetTrackQualities, pipeGetTrackLyrics, rest, safeHttpsUrl, searchPipe, searchRest, version,
} from "./deezer.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-API-Key, Range",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, X-Audio-Format, X-Track-ID",
  "Access-Control-Max-Age": "86400",
};
const rateWindows = new Map();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();
    const route = url.pathname.replace(/\/+$/, "") || "/";
    const graphQLRoute = route === "/graphql";
    const signedPlaybackRoute = route === "/delivery/audio" && url.searchParams.get("playback") === "1";
    const signedManifestRoute = route === "/delivery/manifest" && url.searchParams.get("playback") === "manifest";

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: headers() });
    if (graphQLRoute && !["GET", "POST"].includes(request.method)) {
      return graphQLHttpError(405, "METHOD_NOT_ALLOWED", "Use GET for read-only GraphQL queries or POST for mutations.", { Allow: "GET, POST, OPTIONS" }, request);
    }
    if (graphQLRoute && !acceptsGraphQLResponse(request)) {
      return new Response("Not Acceptable", { status: 406, headers: headers({ "Content-Type": "text/plain; charset=utf-8" }) });
    }
    if (!graphQLRoute && (signedPlaybackRoute || signedManifestRoute) && request.method !== "GET") {
      return fail(405, "METHOD_NOT_ALLOWED", "This endpoint accepts GET requests only.", requestId, { Allow: "GET, OPTIONS" });
    }
    if (!graphQLRoute && !signedPlaybackRoute && !signedManifestRoute && route !== "/") {
      return fail(404, "ROUTE_MOVED_TO_GRAPHQL", "Catalog operations now use GET /graphql?query=... with a GraphQL selection set. See GET / for examples.", requestId);
    }
    // Signed media delivery is authorized using the short-lived token, not by sending
    // the long-lived API key in the audio URL. All GraphQL operations use API_KEY when set.
    if (signedPlaybackRoute || signedManifestRoute) {
      if (!env?.API_KEY) return fail(503, "PLAYBACK_API_KEY_REQUIRED", "Configure API_KEY as a Cloudflare secret to validate signed media URLs.", requestId);
    } else {
      const authError = authorize(request, env);
      if (authError) return graphQLRoute
        ? graphQLRequestError(401, "UNAUTHORIZED", authError, {}, request)
        : fail(401, "UNAUTHORIZED", authError, requestId);
    }

    const rateError = checkRateLimit(request);
    if (rateError) return graphQLRoute
      ? graphQLRequestError(429, "RATE_LIMITED", "Too many requests from this client. Retry shortly.", { "Retry-After": "15" }, request)
      : fail(429, "RATE_LIMITED", "Too many requests from this client. Retry shortly.", requestId, { "Retry-After": "15" });

    try {
      if (graphQLRoute) return await handleGraphQL(request, env, url);
      if (signedManifestRoute) return await fullTrackHlsManifest(url, env);
      if (signedPlaybackRoute) return await fullTrackAudio(request, url, env);
      if (route === "/") return json({
        name: "Deezer Graph API", version: version(), endpoint: "/graphql", methods: ["GET", "POST"],
        example: "/graphql?query=%7B%20search(query%3A%22Ella%20Mai%22)%20%7B%20items%20%7B%20id%20title%20duration%20%7D%20%7D%20%7D",
        note: "Uses GraphQL.js with a typed schema, specification validation, fragments, directives, introspection, and normal operation selection. GET is for queries; POST accepts JSON operations and mutations.",
      });
      return fail(404, "ROUTE_NOT_FOUND", "Unknown route.", requestId);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 502;
      const safeCode = String(error?.code || "");
      const diagnosticCode = /^(ARL_|USER_DATA_|GATEWAY_|TRACK_TOKEN_|MEDIA_|PLAYBACK_|UPSTREAM_AUDIO_|UNALIGNED_CDN_|RANGE_|INVALID_RANGE|GRAPHQL_)/.test(safeCode);
      const code = diagnosticCode ? safeCode : error?.status === 404 ? "NOT_FOUND" : status === 429 ? "UPSTREAM_RATE_LIMITED" : "UPSTREAM_ERROR";
      const message = diagnosticCode ? String(error?.message || code).slice(0, 300) : publicMessage(error?.message, status);
      return fail(status, code, message, requestId);
    }
  },
};

function graphQLAcceptQualities(request) {
  const accept = String(request?.headers?.get("Accept") || "").trim().toLowerCase();
  if (!accept) return { graphQL: 1, json: 0, present: false };
  const ranges = accept.split(",").map((entry, index) => {
    const [rawType, ...parameters] = entry.trim().split(";");
    const mediaType = rawType.trim();
    const qRaw = parameters.find(parameter => /^\s*q\s*=/.test(parameter));
    const q = qRaw ? Number(qRaw.split("=")[1]) : 1;
    return { mediaType, q: Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0, index };
  });
  const qualityFor = mediaType => {
    const matching = ranges.filter(range => range.mediaType === mediaType || range.mediaType === "application/*" || range.mediaType === "*/*");
    matching.sort((a, b) => {
      const specificity = value => value.mediaType === mediaType ? 2 : value.mediaType === "application/*" ? 1 : 0;
      return specificity(b) - specificity(a) || a.index - b.index;
    });
    return matching[0]?.q ?? 0;
  };
  return {
    graphQL: qualityFor("application/graphql-response+json"),
    json: qualityFor("application/json"),
    present: true,
  };
}

function acceptsGraphQLResponse(request) {
  const qualities = graphQLAcceptQualities(request);
  return !qualities.present || qualities.graphQL > 0 || qualities.json > 0;
}

function graphQLContentType(request) {
  const { graphQL, json } = graphQLAcceptQualities(request);
  return json > graphQL
    ? "application/json; charset=utf-8"
    : "application/graphql-response+json; charset=utf-8";
}

function graphQLJson(result, status = 200, extra = {}, request = null) {
  return new Response(JSON.stringify(result), {
    status,
    headers: headers({ "Content-Type": graphQLContentType(request), ...extra }),
  });
}

function graphQLHttpError(status, code, message, extraHeaders = {}, request = null) {
  return graphQLJson({ errors: [{ message, extensions: { code, httpStatus: status } }] }, status, extraHeaders, request);
}

function graphQLRequestError(status, code, message, extraHeaders = {}, request = null) {
  return graphQLHttpError(status, code, message, extraHeaders, request);
}

function formatGraphQLError(error, overrides = {}) {
  const original = error?.originalError || error;
  const status = Number.isInteger(original?.status) ? original.status : Number.isInteger(overrides.httpStatus) ? overrides.httpStatus : Number.isInteger(error?.extensions?.httpStatus) ? error.extensions.httpStatus : 500;
  const code = String(original?.code || overrides.code || error?.extensions?.code || (status === 404 ? "NOT_FOUND" : status === 403 ? "FORBIDDEN" : status >= 500 ? "UPSTREAM_ERROR" : "GRAPHQL_ERROR"));
  return {
    message: String(error?.message || "GraphQL request failed").slice(0, 500),
    ...(Array.isArray(error?.locations) && error.locations.length ? { locations: error.locations } : {}),
    ...(Array.isArray(error?.path) ? { path: error.path } : {}),
    extensions: { ...(error?.extensions || {}), code, httpStatus: status },
  };
}

let cachedGraphQLSchema;

async function handleGraphQL(request, env, requestUrl) {
  const { parse, validate, execute, getOperationAST, getVariableValues, specifiedRules } = await import("graphql");
  const { buildGraphQLSchema, queryComplexityRule, MAX_QUERY_LENGTH } = await import("./graphql.js");
  let query;
  let variables = {};
  let operationName;
  let extensions;

  if (request.method === "GET") {
    if (request.url.length > 65_536) {
      return graphQLHttpError(414, "URI_TOO_LARGE", "The GraphQL GET URL is too long; send the operation using POST instead.", {}, request);
    }
    query = requestUrl.searchParams.get("query");
    operationName = requestUrl.searchParams.has("operationName") ? requestUrl.searchParams.get("operationName") : undefined;
    try {
      if (requestUrl.searchParams.has("variables")) variables = JSON.parse(requestUrl.searchParams.get("variables")) ?? {};
      if (requestUrl.searchParams.has("extensions")) extensions = JSON.parse(requestUrl.searchParams.get("extensions")) ?? undefined;
    } catch {
      return graphQLHttpError(400, "INVALID_JSON_PARAMETER", "The variables and extensions URL parameters must contain valid JSON.", {}, request);
    }
  } else {
    const contentType = String(request.headers.get("Content-Type") || "").toLowerCase().split(";")[0].trim();
    if (contentType !== "application/json") {
      return graphQLHttpError(415, "UNSUPPORTED_MEDIA_TYPE", "POST /graphql requires Content-Type: application/json.", { "Accept": "application/json" }, request);
    }

    const bodyText = await request.text();
    if (bodyText.length > 65_536) {
      return graphQLHttpError(413, "GRAPHQL_REQUEST_TOO_LARGE", "GraphQL POST bodies must not exceed 65536 characters.", {}, request);
    }
    let payload;
    try { payload = JSON.parse(bodyText); }
    catch { return graphQLHttpError(400, "INVALID_JSON_BODY", "POST /graphql expects a valid JSON request object.", {}, request); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return graphQLHttpError(400, "INVALID_REQUEST_BODY", "POST /graphql expects a JSON object.", {}, request);
    }
    // The GraphQL-over-HTTP request object defines query, operationName,
    // variables, and extensions. Unknown members are ignored for forward compatibility.
    query = payload.query;
    variables = payload.variables ?? {};
    operationName = payload.operationName ?? undefined;
    extensions = payload.extensions ?? undefined;
    if (operationName !== undefined && typeof operationName !== "string") {
      return graphQLHttpError(422, "INVALID_OPERATION_NAME", "operationName must be a string or null.", {}, request);
    }
  }

  if (typeof query !== "string" || !query.trim()) {
    return graphQLHttpError(400, "GRAPHQL_QUERY_REQUIRED", "The GraphQL query source must be provided in the query field or URL parameter.", {}, request);
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return graphQLHttpError(413, "GRAPHQL_QUERY_TOO_LARGE", `GraphQL query exceeds the ${MAX_QUERY_LENGTH}-character limit.`, {}, request);
  }
  if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
    return graphQLHttpError(422, "INVALID_VARIABLES", "variables must be a JSON object or null.", {}, request);
  }
  if (extensions != null && (typeof extensions !== "object" || Array.isArray(extensions))) {
    return graphQLHttpError(422, "INVALID_EXTENSIONS", "extensions must be a JSON object or null.", {}, request);
  }

  let document;
  try { document = parse(query); }
  catch (error) {
    return graphQLJson({ errors: [formatGraphQLError(error, { code: "GRAPHQL_PARSE_FAILED", httpStatus: 400 })] }, 400, {}, request);
  }

  if (!cachedGraphQLSchema) {
    cachedGraphQLSchema = buildGraphQLSchema();
  }
  const validationErrors = validate(cachedGraphQLSchema, document, [...specifiedRules, queryComplexityRule]);
  if (validationErrors.length) {
    return graphQLJson({ errors: validationErrors.map(error => ({
      message: error.message,
      ...(error.locations?.length ? { locations: error.locations } : {}),
      ...(error.path ? { path: error.path } : {}),
      extensions: { ...(error.extensions || {}), code: error.extensions?.code || "GRAPHQL_VALIDATION_FAILED", httpStatus: 422 },
    })) }, 422, {}, request);
  }

  const operation = getOperationAST(document, operationName);
  if (!operation) {
    const opCount = document.definitions.filter(definition => definition.kind === "OperationDefinition").length;
    const code = operationName != null ? "GRAPHQL_UNKNOWN_OPERATION" : opCount > 1 ? "GRAPHQL_OPERATION_NAME_REQUIRED" : "GRAPHQL_OPERATION_NOT_FOUND";
    const message = operationName != null
      ? `No operation named '${operationName}' exists in this document.`
      : opCount > 1 ? "operationName is required when a document contains multiple operations." : "The document contains no executable operation.";
    return graphQLHttpError(422, code, message, {}, request);
  }
  if (operation.operation === "subscription") {
    return graphQLHttpError(422, "GRAPHQL_SUBSCRIPTIONS_UNSUPPORTED", "This HTTP endpoint does not implement GraphQL subscriptions. Queries and mutations are supported.", {}, request);
  }
  if (request.method === "GET" && operation.operation === "mutation") {
    return graphQLHttpError(405, "GET_MUTATION_NOT_ALLOWED", "Mutations must use POST; GET is reserved for read-only queries.", { Allow: "POST, OPTIONS" }, request);
  }

  const variableResult = getVariableValues(cachedGraphQLSchema, operation.variableDefinitions || [], variables, { maxErrors: 20 });
  if (variableResult.errors?.length) {
    return graphQLJson({ errors: variableResult.errors.map(error => formatGraphQLError(error, { code: "GRAPHQL_VARIABLE_COERCION_FAILED", httpStatus: 422 })) }, 422, {}, request);
  }

  const result = await execute({
    schema: cachedGraphQLSchema,
    document,
    contextValue: { env, origin: requestUrl.origin, request, resolveQueryField, resolveMutationField },
    variableValues: variables,
    operationName,
    options: { maxCoercionErrors: 20 },
  });
  const response = {
    ...(Object.prototype.hasOwnProperty.call(result, "data") ? { data: result.data } : {}),
    ...(result.errors?.length ? { errors: result.errors.map(formatGraphQLError) } : {}),
    ...(result.extensions ? { extensions: result.extensions } : {}),
  };
  // Parse, validation, and variable-coercion failures are 4xx request errors;
  // resolver failures follow GraphQL's partial-data model and return HTTP 200.
  return graphQLJson(response, 200, {}, request);
}

async function resolveQueryField(name, args, env, origin) {
  if (name === "apiInfo") return {
    name: "Deezer Graph API", version: version(), endpoint: "/graphql", methods: ["GET", "POST"],
    queryTransport: "GET /graphql?query=...&variables=...", mutationTransport: "POST /graphql",
    features: ["catalog", "quality-reporting", "track-manifests", "hls", "lyrics", "playback-reporting", "artist-similarity", "graphql-js-schema-validation", "graphql-introspection"],
  };
  if (name === "search") {
    const q = String(args.query ?? args.q ?? args.term ?? "").trim();
    if (!q) throw Object.assign(new Error("search requires query: String!"), { code: "MISSING_QUERY", status: 400 });
    const typeKey = String(args.type || "TRACK").toUpperCase();
    const key = ({ TRACK: "s", SONG: "s", ARTIST: "a", ALBUM: "al", PLAYLIST: "p", ISRC: "i" })[typeKey];
    if (!key) throw Object.assign(new Error("search type must be TRACK, ARTIST, ALBUM, PLAYLIST, or ISRC."), { code: "INVALID_SEARCH_TYPE", status: 400 });
    const url = handlerUrl(origin, "/search", { [key]: q, limit: args.limit ?? 25, offset: args.offset ?? 0 });
    const body = await handlerBody(await search(url, env));
    let page = body.data;
    const nesting = ({ a: "artists", al: "albums", p: "playlists" })[key];
    if (nesting && page?.[nesting]) page = page[nesting];
    return { ...page, query: q, type: typeKey };
  }
  if (name === "track" || name === "trackInfo") {
    const id = requiredGraphQLId(args.id, name);
    const track = mapTrack(await getTrack(id));
    track.quality = await qualityReportFor(id, env, Boolean(track.preview));
    return track;
  }
  if (name === "quality") {
    const id = requiredGraphQLId(args.id, name);
    return qualityReportFor(id, env, Boolean(args.includePreview));
  }
  if (name === "trackManifest") {
    const id = requiredGraphQLId(args.id, name);
    const params = { id, quality: args.quality, manifestType: args.manifestType, usage: args.usage, uriScheme: args.uriScheme };
    if (args.formats != null) params.formats = Array.isArray(args.formats) ? args.formats.join(",") : args.formats;
    const body = await handlerBody(await trackManifests(handlerUrl(origin, "/trackManifests", params), env));
    const wrapper = body?.data;
    const node = wrapper?.data;
    if (node?.attributes) {
      const attributes = node.attributes;
      const trackPresentation = attributes.trackPresentation ?? attributes.assetPresentation ?? null;
      // Keep the former REST response fields available in GraphQL. `uri` can be a
      // data: manifest descriptor, while `streamUrl` must always be the actual
      // playable source (preview audio, progressive audio, or an HLS playlist).
      const streamUrl = attributes.streamUrl ?? attributes.previewUrl ?? (
        typeof attributes.uri === "string" && !attributes.uri.startsWith("data:")
          ? attributes.uri
          : null
      );
      return {
        id: node.id,
        type: node.type,
        ...attributes,
        trackId: attributes.trackId ?? node.id,
        assetPresentation: attributes.assetPresentation ?? trackPresentation,
        audioMode: attributes.audioMode ?? "STEREO",
        streamReady: attributes.streamReady ?? Boolean(streamUrl),
        streamUrl,
        previewUrl: attributes.previewUrl ?? (trackPresentation === "PREVIEW" ? streamUrl : null),
        links: wrapper.links || null,
      };
    }
    return wrapper ?? null;
  }
  if (name === "recommendations") {
    const body = await handlerBody(await recommendations(handlerUrl(origin, "/recommendations", { id: requiredGraphQLId(args.id, name), limit: args.limit, offset: args.offset })));
    return body.data;
  }
  if (name === "album") {
    const body = await handlerBody(await album(handlerUrl(origin, "/album", { id: requiredGraphQLId(args.id, name), limit: args.limit, offset: args.offset }), env));
    return body.data;
  }
  if (name === "mix") {
    const body = await handlerBody(await mix(handlerUrl(origin, "/mix", { id: requiredGraphQLId(args.id, name), limit: args.limit, offset: args.offset })));
    return { ...(body.mix || {}), items: body.items || [], pagination: body.pagination || null };
  }
  if (name === "playlist") {
    const body = await handlerBody(await playlist(handlerUrl(origin, "/playlist", { id: requiredGraphQLId(args.id, name), limit: args.limit, offset: args.offset })));
    return body.playlist;
  }
  if (name === "cover") {
    const body = await handlerBody(await cover(handlerUrl(origin, "/cover", { id: args.id, q: args.query ?? args.q })));
    return (body.covers || [])[0] || null;
  }
  if (name === "covers") {
    const body = await handlerBody(await cover(handlerUrl(origin, "/cover", { id: args.id, q: args.query ?? args.q })));
    return body.covers || [];
  }
  if (name === "artist") {
    const body = await handlerBody(await artist(handlerUrl(origin, "/artist", { id: requiredGraphQLId(args.id, name) }), env));
    // The legacy catalog response places the artist cover beside `artist`; fold
    // it into the typed GraphQL Artist object so `artist { cover { ... } }` works.
    if (!body.artist) return null;
    return { ...body.artist, ...(body.cover ? { cover: body.cover } : {}) };
  }
  if (name === "artistCatalog") {
    const body = await handlerBody(await artist(handlerUrl(origin, "/artist", {
      f: requiredGraphQLId(args.id, name), skip_tracks: args.skipTracks, limit: args.limit, offset: args.offset,
    }), env));
    return body;
  }
  if (name === "similarArtists") {
    const body = await handlerBody(await similarArtists(handlerUrl(origin, "/artist/similar", { id: requiredGraphQLId(args.id, name), limit: args.limit, offset: args.offset })));
    return body.data;
  }
  if (name === "lyrics") {
    const id = requiredGraphQLId(args.id, name);
    if (!env?.DEEZER_ARL) throw Object.assign(new Error("Set DEEZER_ARL to request account-authorized lyrics from Pipe GraphQL."), { code: "ARL_REQUIRED", status: 503 });
    const track = await pipeGetTrackLyrics(id, env);
    const lyrics = track?.lyrics;
    if (!lyrics) throw Object.assign(new Error("No lyrics are available for this track in the current region/account."), { code: "LYRICS_NOT_FOUND", status: 404 });
    const format = String(args.type || "all").toLowerCase();
    if (!(["all", "plain", "line", "word"].includes(format))) throw Object.assign(new Error("type must be all, plain, line, or word."), { code: "INVALID_LYRICS_TYPE", status: 400 });
    const lines = Array.isArray(lyrics.synchronizedLines) ? lyrics.synchronizedLines : [];
    const words = Array.isArray(lyrics.synchronizedWordByWordLines) ? lyrics.synchronizedWordByWordLines : [];
    const availableTypes = [...(typeof lyrics.text === "string" ? ["plain"] : []), ...(lines.length ? ["line"] : []), ...(words.length ? ["word"] : [])];
    if (format !== "all" && !availableTypes.includes(format)) throw Object.assign(new Error(`No ${format} lyrics are available for this track.`), { code: "LYRICS_FORMAT_UNAVAILABLE", status: 404 });
    return {
      trackId: Number(track.id || id), title: track.title || "", duration: Number(track.duration || 0), type: format, availableTypes,
      ...(lyrics.writers != null ? { writers: lyrics.writers } : {}),
      ...(lyrics.copyright != null ? { copyright: lyrics.copyright } : {}),
      ...(lyrics.licence != null ? { licence: lyrics.licence } : {}),
      ...(format === "all" || format === "plain" ? { plain: lyrics.text ?? null } : {}),
      ...(format === "all" || format === "line" ? { synchronizedLines: lines } : {}),
      ...(format === "all" || format === "word" ? { synchronizedWordByWordLines: words } : {}),
    };
  }
  throw Object.assign(new Error(`Unknown query field '${name}'. Use the Deezer Graph API schema at /graphql.`), { code: "GRAPHQL_UNKNOWN_FIELD", status: 400 });
}

async function resolveMutationField(name, args, env) {
  if (name === "reportPlayback") {
    const result = await reportListen({ trackId: requiredGraphQLId(args.trackId, name), playToken: args.playToken, event: args.event }, env);
    return { accepted: Boolean(result.accepted), duplicate: Boolean(result.duplicate), event: result.event || args.event, playToken: result.playToken || null };
  }
  throw Object.assign(new Error(`Unknown mutation field '${name}'.`), { code: "GRAPHQL_UNKNOWN_FIELD", status: 400 });
}

async function qualityReportFor(id, env, includePreview = false) {
  let previewAvailable = Boolean(includePreview);
  if (!env?.DEEZER_ARL) return { status: "AUTH_REQUIRED", predictedQuality: previewAvailable ? "PREVIEW" : null, formats: [], source: "PIPE_GRAPHQL", mediaUrlGenerated: false, reason: "Configure DEEZER_ARL to report account-specific format availability." };
  try {
    const data = await pipeGetTrackQualities([id], env);
    return mapQualityReport(data[String(id)], { previewAvailable });
  } catch (_) {
    return { status: "UNKNOWN", predictedQuality: null, formats: [], source: "PIPE_GRAPHQL", mediaUrlGenerated: false, reason: "Quality metadata could not be retrieved." };
  }
}

function requiredGraphQLId(value, field) {
  const id = String(value ?? "");
  if (!/^\d+$/.test(id)) throw Object.assign(new Error(`Field '${field}' requires a numeric id argument.`), { code: "INVALID_ID", status: 400 });
  return id;
}

function handlerUrl(origin, path, params = {}) {
  const url = new URL(path, origin);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else url.searchParams.set(key, String(value));
  }
  return url;
}

async function handlerBody(response) {
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.error) {
    const error = new Error(body?.error?.message || `Resolver failed (HTTP ${response.status}).`);
    error.status = response.status || 502;
    error.code = body?.error?.code || "UPSTREAM_ERROR";
    throw error;
  }
  return body || {};
}



async function trackInfo(url) {
  const id = requiredId(url);
  const t = await getTrack(id);
  return json({ version: version(), data: mapTrack(t) });
}

async function trackManifestLegacy(url, env) {
  const id = requiredId(url);
  const requestedQuality = (url.searchParams.get("quality") || (env?.DEEZER_ARL ? "best" : "PREVIEW")).toUpperCase();
  if (["PREVIEW", "MP3_PREVIEW"].includes(requestedQuality)) return previewTrackManifest(id, url);
  if (!env?.DEEZER_ARL) return fail(503, "ARL_REQUIRED", "Set DEEZER_ARL to enable authenticated full-track resolution. Use quality=PREVIEW for public preview audio.");
  if (!env?.API_KEY) return fail(503, "PLAYBACK_API_KEY_REQUIRED", "Set API_KEY as a Cloudflare secret before issuing full-track playback URLs.");

  const resolved = await resolveFullTrack(id, requestedQuality, env);
  const { token } = await createPlaybackToken(id, resolved.format, env);
  const playbackUrl = makePlaybackUrl(url, id, resolved.format, token);
  const manifest = {
    mimeType: resolved.profile.mime, codecs: resolved.profile.codecs,
    encryptionType: "NONE", presentation: "FULL", urls: [playbackUrl],
  };
  return json({ version: "3.1", data: {
    trackId: Number(id), assetPresentation: "FULL", audioMode: "STEREO",
    audioQuality: resolved.profile.badge, format: resolved.format, streamReady: true,
    manifestMimeType: "application/json", manifest: toBase64(JSON.stringify(manifest)),
    streamUrl: playbackUrl, playbackToken: token,
  } });
}

async function previewTrackManifest(id, _url) {
  const t = await getTrack(id);
  const preview = safeHttpsUrl(t.preview);
  if (!preview) return fail(404, "PREVIEW_UNAVAILABLE", "Deezer did not provide a preview URL for this track.");
  const manifestObject = { mimeType: "audio/mpeg", codecs: "mp3", encryptionType: "NONE", presentation: "PREVIEW", urls: [preview] };
  return json({ version: "3.0", data: {
    trackId: Number(t.id), assetPresentation: "PREVIEW", audioMode: "STEREO", audioQuality: "PREVIEW",
    manifestMimeType: "application/json", manifest: toBase64(JSON.stringify(manifestObject)),
    previewDuration: 30, previewUrl: preview,
  } });
}

async function trackManifests(url, env) {
  const id = requiredId(url);
  const normalized = url.searchParams.getAll("formats").flatMap(v => v.split(",")).map(v => v.trim().toUpperCase()).filter(Boolean);
  const qualityParam = String(url.searchParams.get("quality") || "").toUpperCase();
  const requestedManifestType = String(url.searchParams.get("manifestType") || "").toUpperCase();
  const manifestType = requestedManifestType || "PROGRESSIVE";
  const usage = String(url.searchParams.get("usage") || url.searchParams.get("usgae") || "PLAYBACK").toUpperCase();
  if (!["PLAYBACK", "DOWNLOAD"].includes(usage)) return fail(400, "INVALID_USAGE", "usage must be PLAYBACK or DOWNLOAD.");
  if (usage === "DOWNLOAD") return fail(501, "USAGE_UNSUPPORTED", "This Deezer adapter currently issues playback manifests only; download manifests are not implemented.");
  if (!["PROGRESSIVE", "HLS", "MPEG_DASH"].includes(manifestType)) return fail(400, "INVALID_MANIFEST_TYPE", "manifestType must be HLS or MPEG_DASH.");
  if (manifestType === "MPEG_DASH") return fail(406, "MANIFEST_TYPE_UNSUPPORTED", "MPEG_DASH is not generated by this Deezer adapter. Use manifestType=HLS or omit manifestType for progressive audio.");

  const previewOnly = (normalized.length > 0 && normalized.every(v => ["PREVIEW", "MP3_PREVIEW"].includes(v))) || ["PREVIEW", "MP3_PREVIEW"].includes(qualityParam);
  const supported = new Set(["PREVIEW", "MP3_PREVIEW", "FLAC", "LOSSLESS", "HIFI", "MP3_320", "320", "MP3_128", "128", "BEST", "AACLC", "HEAACV1", "FLAC_HIRES", "EAC3_JOC"]);
  const invalid = normalized.filter(v => !supported.has(v));
  if (invalid.length) return fail(406, "FORMAT_UNAVAILABLE", `Unsupported formats: ${invalid.join(", ")}. Supported Deezer formats: PREVIEW, FLAC, MP3_320, MP3_128, BEST.`);

  if (manifestType === "HLS") {
    if (previewOnly) return fail(406, "HLS_REQUIRES_FULL_AUDIO", "This HLS route wraps full MP3 audio; request a full-track format instead of PREVIEW.");
    if (!env?.DEEZER_ARL) return fail(503, "ARL_REQUIRED", "Set DEEZER_ARL to enable authenticated full-track HLS playback.");
    if (!env?.API_KEY) return fail(503, "PLAYBACK_API_KEY_REQUIRED", "Set API_KEY as a Cloudflare secret before issuing full-track playback URLs.");
    // HLS packed-audio segments support MP3, not a raw FLAC object. Resolve the
    // highest available MP3 variant and keep the format in the signed token.
    const hlsQuality = ["128", "MP3_128"].includes(qualityParam) || (normalized.length && normalized.every(v => ["128", "MP3_128"].includes(v))) ? "MP3_128" : "MP3_320";
    const resolved = await resolveFullTrack(id, hlsQuality, env);
    if (!["MP3_320", "MP3_128"].includes(resolved.format)) return fail(502, "HLS_AUDIO_FORMAT_UNAVAILABLE", "Deezer did not provide a compatible MP3 format for HLS.");
    const { token } = await createPlaybackToken(id, resolved.format, env);
    const manifestUrl = makeHlsManifestUrl(url, id, resolved.format, token);
    let uri = manifestUrl;
    if ((url.searchParams.get("uriScheme") || "HTTPS").toUpperCase() === "DATA") {
      const track = await getTrack(id);
      const duration = validDuration(track?.duration ?? resolved.duration);
      if (!duration) return fail(502, "TRACK_DURATION_UNAVAILABLE", "Deezer did not provide a valid track duration for HLS.");
      const segmentUrl = makePlaybackUrl(url, id, resolved.format, token, true);
      const playlist = makeHlsPlaylist(duration, segmentUrl);
      uri = `data:application/vnd.apple.mpegurl;base64,${toBase64(playlist)}`;
    }
    return json({ version: "2.7", data: { data: {
      id: String(id), type: "trackManifests", attributes: {
        trackId: Number(id), trackPresentation: "FULL", assetPresentation: "FULL", audioMode: "STEREO",
        uri, streamUrl: manifestUrl, manifestMimeType: "application/vnd.apple.mpegurl",
        ...(uri.startsWith("data:") ? { manifest: uri.slice(uri.indexOf(",") + 1) } : {}),
        formats: [resolved.format], audioQuality: resolved.profile.badge, format: resolved.format,
        streamReady: true, playbackToken: token,
      },
    }, links: { self: `${url.pathname}${url.search}` } } });
  }

  if (previewOnly || !env?.DEEZER_ARL) {
    if (!previewOnly && ((normalized.length && normalized.some(v => !["PREVIEW", "MP3_PREVIEW"].includes(v))) || (qualityParam && !["PREVIEW", "MP3_PREVIEW"].includes(qualityParam)))) {
      return fail(503, "ARL_REQUIRED", "Set DEEZER_ARL to enable authenticated full-track resolution.");
    }
    const t = await getTrack(id);
    const preview = safeHttpsUrl(t.preview);
    if (!preview) return fail(404, "PREVIEW_UNAVAILABLE", "Deezer did not provide a preview URL for this track.");
    const useData = (url.searchParams.get("uriScheme") || "HTTPS").toUpperCase() === "DATA";
    const manifest = { mimeType: "audio/mpeg", codecs: "mp3", encryptionType: "NONE", presentation: "PREVIEW", urls: [preview] };
    const self = `${url.pathname}${url.search}`;
    const encodedManifest = toBase64(JSON.stringify(manifest));
    return json({ version: "2.7", data: { data: {
      id: String(t.id), type: "trackManifests", attributes: {
        trackId: Number(t.id), trackPresentation: "PREVIEW", assetPresentation: "PREVIEW", audioMode: "STEREO",
        uri: useData ? `data:application/json;base64,${encodedManifest}` : preview,
        streamUrl: preview, previewUrl: preview, manifest: encodedManifest, manifestMimeType: "application/json",
        formats: ["MP3_PREVIEW"], audioQuality: "PREVIEW", format: "MP3_PREVIEW", streamReady: true, previewDuration: 30,
      },
    }, links: { self } } });
  }
  if (!env?.API_KEY) return fail(503, "PLAYBACK_API_KEY_REQUIRED", "Set API_KEY as a Cloudflare secret before issuing full-track playback URLs.");

  let quality = url.searchParams.get("quality");
  if (!quality && normalized.length) quality = normalized.find(v => !["PREVIEW", "MP3_PREVIEW", "AACLC", "HEAACV1", "FLAC_HIRES", "EAC3_JOC"].includes(v));
  const resolved = await resolveFullTrack(id, quality || "best", env);
  const { token } = await createPlaybackToken(id, resolved.format, env);
  const playbackUrl = makePlaybackUrl(url, id, resolved.format, token);
  const manifest = { mimeType: resolved.profile.mime, codecs: resolved.profile.codecs, encryptionType: "NONE", presentation: "FULL", urls: [playbackUrl] };
  const useData = (url.searchParams.get("uriScheme") || "HTTPS").toUpperCase() === "DATA";
  const self = `${url.pathname}${url.search}`;
  const encodedManifest = toBase64(JSON.stringify(manifest));
  return json({ version: "2.7", data: { data: {
    id: String(id), type: "trackManifests", attributes: {
      trackId: Number(id), trackPresentation: "FULL", assetPresentation: "FULL", audioMode: "STEREO",
      uri: useData ? `data:application/json;base64,${encodedManifest}` : playbackUrl,
      streamUrl: playbackUrl, manifest: encodedManifest, manifestMimeType: "application/json",
      formats: [resolved.format], audioQuality: resolved.profile.badge, format: resolved.format,
      streamReady: true, playbackToken: token,
    },
  }, links: { self } } });
}

function makePlaybackUrl(baseUrl, id, format, token, hlsSegment = false) {
  const playback = new URL("/delivery/audio", baseUrl.origin);
  playback.searchParams.set("id", String(id));
  playback.searchParams.set("quality", String(format));
  playback.searchParams.set("playback", "1");
  playback.searchParams.set("pt", token);
  if (hlsSegment) playback.searchParams.set("hlsSegment", "1");
  return playback.toString();
}

function makeHlsManifestUrl(baseUrl, id, format, token) {
  const manifest = new URL("/delivery/manifest", baseUrl.origin);
  manifest.searchParams.set("id", String(id));
  manifest.searchParams.set("quality", String(format));
  manifest.searchParams.set("playback", "manifest");
  manifest.searchParams.set("pt", token);
  return manifest.toString();
}

function validDuration(value) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration >= 1 && duration <= 7200 ? duration : 0;
}

function makeHlsPlaylist(duration, segmentUrl) {
  return `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(duration))}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:${duration.toFixed(3)},\n${segmentUrl}\n#EXT-X-ENDLIST\n`;
}

async function fullTrackHlsManifest(url, env) {
  const id = requiredId(url);
  const claims = await validatePlaybackToken(url.searchParams.get("pt"), env, id);
  if (!claims) return fail(401, "PLAYBACK_TOKEN_INVALID", "Playback URL is invalid or expired; request a fresh track manifest.");
  if (!["MP3_320", "MP3_128"].includes(claims.format)) return fail(406, "HLS_AUDIO_FORMAT_UNAVAILABLE", "HLS playback requires an MP3 format. Request a fresh HLS manifest.");
  const track = await getTrack(id);
  const duration = validDuration(track?.duration);
  if (!duration) return fail(502, "TRACK_DURATION_UNAVAILABLE", "Deezer did not provide a valid track duration for HLS.");
  const segmentUrl = makePlaybackUrl(url, id, claims.format, url.searchParams.get("pt"), true);
  return new Response(makeHlsPlaylist(duration, segmentUrl), {
    status: 200,
    headers: headers({ "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }),
  });
}

async function fullTrackAudio(request, url, env) {
  const id = requiredId(url);
  const claims = await validatePlaybackToken(url.searchParams.get("pt"), env, id);
  if (!claims) return fail(401, "PLAYBACK_TOKEN_INVALID", "Playback URL is invalid or expired; request a fresh track manifest.");
  const requestedQuality = (url.searchParams.get("quality") || claims.format).toUpperCase();
  if (requestedQuality !== claims.format) return fail(403, "PLAYBACK_FORMAT_MISMATCH", "Playback quality does not match the signed URL.");
  const resolved = await resolveFullTrack(id, claims.format, env);
  if (resolved.format !== claims.format) return fail(403, "PLAYBACK_ENTITLEMENT_CHANGED", "The requested format is no longer available for this account. Request a fresh manifest.");
  try {
    const hlsSegment = url.searchParams.get("hlsSegment") === "1";
    if (hlsSegment && !["MP3_320", "MP3_128"].includes(resolved.format)) return fail(406, "HLS_AUDIO_FORMAT_UNAVAILABLE", "HLS packed-audio segments require MP3.");
    return await playbackResponse(request, resolved, hlsSegment ? { prefixBytes: makeHlsTimestampTag(), ignoreRange: true } : {});
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 502;
    return fail(status, error?.code || "PLAYBACK_FAILED", error?.message || "Playback failed.");
  }
}

async function trackListen(request, url, env) {
  let body;
  try { body = JSON.parse(await request.text()); }
  catch { return fail(400, "INVALID_LISTEN_BODY", "POST a JSON body containing trackId, playToken, and event."); }
  const id = String(body?.trackId ?? url.searchParams.get("id") ?? "");
  if (!/^\d+$/.test(id)) return fail(400, "INVALID_ID", "trackId must be a numeric Deezer track ID.");
  try {
    const result = await reportListen({ trackId: id, playToken: body?.playToken ?? url.searchParams.get("pt"), event: body?.event }, env);
    return json({ version: version(), ...result }, 202);
  } catch (error) {
    return fail(Number.isInteger(error?.status) ? error.status : 502, error?.code || "LISTEN_REPORT_FAILED", error?.message || "Deezer listen reporting failed.");
  }
}

async function recommendations(url) {
  const id = requiredId(url);
  const limit = numberParam(url, "limit", 20, 1, 100);
  const offset = numberParam(url, "offset", 0, 0, 5000);
  const radio = await getTrackRadio(id, limit, offset);
  const tracks = (radio.data || []).map(t => ({ track: mapTrack(t), sources: ["SUGGESTED_TRACKS"] }));
  return json({ version: version(), data: { limit, offset, totalNumberOfItems: Number(radio.total ?? radio.data?.length ?? 0), items: tracks } });
}

async function search(url, env) {
  const keys = ["s", "a", "al", "p", "i", "v"].filter(k => url.searchParams.has(k) && url.searchParams.get(k) !== "");
  if (keys.length !== 1) return fail(400, "INVALID_SEARCH", "Specify exactly one search parameter: s (track), a (artist), al (album), p (playlist), or i (ISRC). The Tidal-only video search key v is not supported.");
  const key = keys[0];
  if (key === "v") return fail(404, "ROUTE_NOT_SUPPORTED", "Deezer's public catalog does not expose the Tidal video-search route.");
  const q = url.searchParams.get(key).trim();
  if (!q) return fail(400, "MISSING_QUERY", "Search query must not be empty.");
  const limit = numberParam(url, "limit", 25, 1, 100);
  const offset = numberParam(url, "offset", 0, 0, 5000);
  const type = ({ s: "track", a: "artist", al: "album", p: "playlist", i: "track" })[key];

  // Use Pipe GraphQL first for page-zero catalog search when configured. Offset paging stays on REST,
  // because Pipe is cursor-paginated and should not fake an offset from a cursor-less request.
  if (env?.DEEZER_ARL && offset === 0 && key !== "i") {
    try {
      const [pipe, countResponse] = await Promise.all([searchPipe(q, limit, env), searchRest(type === "track" ? "" : type, q, 1, 0).catch(() => null)]);
      const results = pipe?.search?.results;
      if (results) {
        const branch = ({ s: results.tracks, a: results.artists, al: results.albums, p: results.playlists })[key];
        const pipeNodes = edges(branch);
        const nodes = pipeNodes.map(n => mapPipeSearchItem(key, n));
        const dataKey = ({ a: "artists", al: "albums", p: "playlists" })[key];
        const payload = { limit, offset, totalNumberOfItems: Number(countResponse?.total ?? nodes.length), items: nodes };
        return json({ version: version(), data: dataKey ? { [dataKey]: payload } : payload });
      }
    } catch (_) {
      // Public REST fallback is intentional: catalog access remains functional if Pipe changes.
    }
  }
  const found = await searchRest(type === "track" ? "" : type, q, Math.min(100, limit), offset);
  let list = Array.isArray(found.data) ? found.data : [];
  if (key === "i") {
    const target = q.toUpperCase();
    list = list.filter(x => String(x.isrc || "").toUpperCase() === target);
  }
  const mapped = list.map(item => key === "a" ? mapArtist(item) : key === "al" ? mapAlbumSummary(item) : key === "p" ? mapPlaylist(item) : mapTrack(item));
  if (key === "s" || key === "i") {
    if (env?.DEEZER_ARL && mapped.length) {
      try {
        const qualities = await pipeGetTrackQualities(mapped.map(item => item.id), env);
        for (const item of mapped) item.quality = mapQualityReport(qualities[String(item.id)], { previewAvailable: Boolean(item.preview) });
      } catch (_) {
        for (const item of mapped) item.quality = { status: "UNKNOWN", predictedQuality: null, formats: [], source: "PIPE_GRAPHQL", mediaUrlGenerated: false, reason: "Quality metadata could not be retrieved; search results are unaffected." };
      }
    } else {
      for (const item of mapped) item.quality = { status: "AUTH_REQUIRED", predictedQuality: null, formats: [], source: "PIPE_GRAPHQL", mediaUrlGenerated: false, reason: "Configure DEEZER_ARL to report account-specific full-track quality." };
    }
  }
  const dataKey = ({ a: "artists", al: "albums", p: "playlists" })[key];
  const payload = { limit: Math.min(100, limit), offset, totalNumberOfItems: key === "i" ? mapped.length : Number(found.total ?? mapped.length), items: mapped };
  return json({ version: version(), data: dataKey ? { [dataKey]: payload } : payload });
}

function mapQualityReport(media, options = {}) {
  if (!media) return {
    status: options.previewAvailable ? "PREVIEW_ONLY" : "UNKNOWN",
    predictedQuality: options.previewAvailable ? "PREVIEW" : null,
    formats: [], source: "PIPE_GRAPHQL", mediaUrlGenerated: false,
    reason: "Pipe did not return format metadata for this track.",
  };
  const sizes = media.estimatedSizes || {};
  const full = media?.rights?.user?.full?.available;
  const subscription = media?.rights?.sub?.available;
  const rightsDenied = full === false && subscription === false;
  const candidates = [
    { format: "FLAC", size: Number(sizes.FLAC || 0), audioQuality: "LOSSLESS" },
    { format: "MP3_320", size: Number(sizes.MP3_320 || 0), audioQuality: "HIGH" },
    { format: "MP3_128", size: Number(sizes.MP3_128 || 0), audioQuality: "STANDARD" },
  ].filter(item => Number.isFinite(item.size) && item.size > 0);
  const best = rightsDenied ? null : candidates[0] || null;
  return {
    status: best ? "AVAILABLE" : rightsDenied ? "NOT_ENTITLED" : "UNKNOWN",
    predictedQuality: best?.audioQuality || (options.previewAvailable ? "PREVIEW" : null),
    bestFormat: best?.format || (options.previewAvailable ? "MP3_PREVIEW" : null),
    formats: candidates.map(item => ({ format: item.format, audioQuality: item.audioQuality, estimatedSizeBytes: item.size })),
    rights: { full: typeof full === "boolean" ? full : null, subscription: typeof subscription === "boolean" ? subscription : null },
    source: "PIPE_GRAPHQL", mediaUrlGenerated: false,
    reason: "Prediction uses current Pipe format-size and rights metadata; final media resolution can still fail.",
  };
}

function mapPipeSearchItem(key, n) {
  const urlOf = x => {
    if (!x) return null;
    if (typeof x === "string") return x;
    if (Array.isArray(x)) return urlOf(x[0]);
    return x.url || x.webUrl || x.src || x.href || null;
  };
  const arts = edges(n.contributors).map(e => e.node || e).filter(a => a?.id != null).map(a => ({ id: numericId(a.id), name: a.name || "" }));
  if (key === "s") return {
    id: numericId(n.id), title: n.title || "", duration: Number(n.duration || 0), explicit: Boolean(n.isExplicit),
    quality: mapQualityReport(n.media),
    url: `https://www.deezer.com/track/${encodeURIComponent(n.id)}`,
    ...(arts.length ? { artist: arts[0], artists: arts } : {}),
    ...(n.album ? { album: { id: numericId(n.album.id), title: n.album.displayTitle || "", cover: (Array.isArray(n.album.cover?.urls) ? n.album.cover.urls[0] : n.album.cover?.urls) || null, url: `https://www.deezer.com/album/${encodeURIComponent(n.album.id)}` } } : {}),
  };
  if (key === "a") return { id: numericId(n.id), name: n.name || "", url: `https://www.deezer.com/artist/${encodeURIComponent(n.id)}`, picture: urlOf(n.picture?.urls) };
  if (key === "al") return { id: numericId(n.id), title: n.displayTitle || "", type: n.type || null, url: `https://www.deezer.com/album/${encodeURIComponent(n.id)}`, cover: urlOf(n.cover?.urls), releaseDate: n.releaseDate || null, artists: edges(n.contributors).map(e => ({ id: numericId((e.node || e).id), name: (e.node || e).name || "" })) };
  return { id: numericId(n.id), title: n.title || "", numberOfTracks: Number(n.estimatedTracksCount || 0), url: `https://www.deezer.com/playlist/${encodeURIComponent(n.id)}`, image: urlOf(n.picture?.urls), ...(n.owner ? { creator: { id: numericId(n.owner.id), name: n.owner.name || "" } } : {}) };
}

async function album(url, env) {
  const id = requiredId(url);
  const limit = numberParam(url, "limit", 100, 1, 100);
  const offset = numberParam(url, "offset", 0, 0, 5000);
  if (env?.DEEZER_ARL && offset === 0) {
    try {
      const p = await pipeGetAlbum(id, limit, env);
      if (p) {
        const mapped = mapPipeAlbum(p);
        const trackNodes = edges(p.tracks);
        return json({ version: version(), data: {
          ...mapped, numberOfTracks: Number(p.tracksCount ?? trackNodes.length),
          items: trackNodes.map(t => ({ item: mapPipeSearchItem("s", t), type: "track" })),
          pagination: { limit, offset, totalNumberOfItems: Number(p.tracksCount ?? trackNodes.length), hasNextPage: Boolean(p.tracks?.pageInfo?.hasNextPage), nextCursor: p.tracks?.pageInfo?.endCursor || null },
        } });
      }
    } catch (_) { /* REST fallback below. */ }
  }
  const [a, tracks] = await Promise.all([getAlbum(id), getAlbumTracks(id, limit, offset)]);
  return json({ version: version(), data: { ...mapAlbum(a), numberOfTracks: Number(a.nb_tracks ?? tracks.total ?? 0), items: (tracks.data || []).map(t => ({ item: mapTrack(t, a), type: "track" })), pagination: { limit, offset, totalNumberOfItems: Number(tracks.total ?? 0) } } });
}

async function mix(url) {
  const id = requiredId(url);
  const limit = numberParam(url, "limit", 60, 1, 100);
  const offset = numberParam(url, "offset", 0, 0, 5000);
  const [source, radio] = await Promise.all([getTrack(id), getTrackRadio(id, limit, offset)]);
  const items = (radio.data || []).map(mapTrack);
  const cover = source.album?.cover_xl || source.album?.cover_big || source.album?.cover || null;
  return json({ version: version(), mix: {
    id: String(source.id), title: `${source.title || "Track"} Radio`, subTitle: source.artist?.name || "Deezer",
    description: "Tracks related to the selected Deezer track.", mixType: "TRACK_RADIO", contentBehavior: "UNRESTRICTED",
    ...(cover ? { images: { LARGE: { width: 1000, height: 1000, url: cover } } } : {}),
  }, items, pagination: { limit, offset, totalNumberOfItems: Number(radio.total ?? radio.data?.length ?? 0) } });
}

async function playlist(url) {
  const id = requiredId(url);
  const limit = numberParam(url, "limit", 100, 1, 100);
  const offset = numberParam(url, "offset", 0, 0, 5000);
  const [p, tracks] = await Promise.all([getPlaylist(id), getPlaylistTracks(id, limit, offset)]);
  return json({ version: version(), playlist: {
    ...mapPlaylist(p), items: (tracks.data || []).map(t => ({ item: mapTrack(t), type: "track" })),
    pagination: { limit, offset, totalNumberOfItems: Number(tracks.total ?? p.nb_tracks ?? 0) },
  } });
}

function mapPipePicture(value) {
  if (!value) return null;
  const urls = value.urls;
  if (typeof urls === "string") return urls;
  if (Array.isArray(urls)) {
    const first = urls[0];
    return typeof first === "string" ? first : first?.url || first?.webUrl || null;
  }
  if (urls && typeof urls === "object") return urls.url || urls.webUrl || urls.src || null;
  return null;
}
function mapPipeArtist(a) {
  return {
    id: numericId(a.id), name: a.name || "", link: a.url?.webUrl || `https://www.deezer.com/artist/${encodeURIComponent(a.id)}`,
    picture: mapPipePicture(a.picture), fansCount: a.fansCount ?? null, biography: a.bio?.full || null,
  };
}
function mapPipeAlbum(a) {
  const artists = edges(a.contributors).map(n => n.node || n).filter(x => x?.id != null).map(x => ({ id: numericId(x.id), name: x.name || "" }));
  return {
    id: numericId(a.id), title: a.displayTitle || "", duration: Number(a.duration || 0),
    numberOfTracks: Number(a.tracksCount || 0), numberOfVolumes: Number(a.discsCount || 1),
    ...(a.releaseDate ? { releaseDate: a.releaseDate } : {}), ...(a.type ? { type: String(a.type) } : {}),
    ...(a.isTakenDown ? { allowStreaming: false } : {}),
    url: a.url?.webUrl || `https://www.deezer.com/album/${encodeURIComponent(a.id)}`,
    ...(mapPipePicture(a.cover) ? { cover: mapPipePicture(a.cover) } : {}),
    ...(artists.length ? { artists, artist: artists[0] } : {}),
  };
}

async function cover(url) {
  const id = url.searchParams.get("id");
  const q = url.searchParams.get("q");
  if (!id && !q) return fail(400, "MISSING_IDENTIFIER", "Provide a track id or search query q.");
  let t;
  if (id) {
    if (!/^\d+$/.test(id)) return fail(400, "INVALID_ID", "Track id must be numeric.");
    t = await getTrack(id);
  } else {
    const found = await searchRest("", q, 25, 0);
    const list = found.data || [];
    if (!list.length) return json({ version: version(), covers: [] });
    const needle = cleanForMatch(q);
    let best = list[0];
    let bestScore = Infinity;
    for (const candidate of list) {
      const titleScore = await distance(needle, cleanForMatch(candidate.title || ""));
      const artistScore = await distance(needle, cleanForMatch(candidate.artist?.name || ""));
      const score = Math.min(titleScore, artistScore + Math.max(0, needle.length - 4));
      if (score < bestScore) { bestScore = score; best = candidate; }
    }
    t = best;
  }
  const a = t.album || {};
  const small = a.cover_small || a.cover || t.album?.cover;
  const medium = a.cover_medium || a.cover_big || small;
  const large = a.cover_big || a.cover_xl || medium;
  const xl = a.cover_xl || large;
  return json({ version: version(), covers: [{
    id: numericId(a.id ?? t.id), name: a.title || t.title || "",
    small: small || null, medium: medium || null, large: large || null, xl: xl || null,
  }] });
}

async function artist(url, env) {
  const id = url.searchParams.get("id");
  const f = url.searchParams.get("f");
  if (!id && !f) return fail(400, "MISSING_IDENTIFIER", "Provide id for artist metadata or f for discography/track aggregation.");
  const artistId = id || f;
  if (!/^\d+$/.test(artistId)) return fail(400, "INVALID_ID", "Artist id must be numeric.");
  let pipeArtist = null;
  if (env?.DEEZER_ARL) {
    try { pipeArtist = await pipeGetArtist(artistId, env); } catch (_) { /* REST fallback below. */ }
  }
  const a = pipeArtist ? mapPipeArtist(pipeArtist) : await getArtist(artistId);
  const image = a.picture_xl || a.picture_big || a.picture_medium || a.picture || null;
  if (!f) return json({ version: version(), artist: {
    ...mapArtist(a), ...(a.nb_album != null ? { numberOfAlbums: Number(a.nb_album) } : {}),
    ...(a.nb_fan != null ? { fans: Number(a.nb_fan) } : {}), ...(a.fansCount != null ? { fans: Number(a.fansCount) } : {}),
    ...(a.biography ? { biography: a.biography } : {}),
  }, ...(image ? { cover: { id: numericId(a.id), name: a.name, large: image } } : {}) });

  const skipTracks = ["1", "true", "yes"].includes(String(url.searchParams.get("skip_tracks") || "false").toLowerCase());
  const limit = numberParam(url, "limit", 25, 1, 100);
  const offset = numberParam(url, "offset", 0, 0, 5000);
  const albumsResponse = await getArtistAlbums(artistId, limit, offset);
  const albums = albumsResponse.data || [];
  let tracks = [];
  if (skipTracks) {
    const top = await getArtistTop(artistId, Math.min(100, limit));
    tracks = (top.data || []).map(mapTrack);
  } else {
    // Aggregation is only performed on explicit f-mode requests, bounded to four album requests at once.
    const selected = albums.slice(0, Math.min(albums.length, 40));
    const chunks = [];
    for (let i = 0; i < selected.length; i += 4) {
      const group = selected.slice(i, i + 4);
      const pages = await Promise.all(group.map(al => rest(`album/${encodeURIComponent(String(al.id))}/tracks`, { limit: 100, index: 0 }).catch(() => ({ data: [] }))));
      chunks.push(...pages);
    }
    tracks = chunks.flatMap(p => p.data || []).map(mapTrack);
  }
  return json({ version: version(), albums: pagination({ ...albumsResponse, data: albums.map(a => mapAlbum(a)) }, limit, offset), tracks });
}

async function similarArtists(url) {
  const id = requiredId(url);
  const limit = numberParam(url, "limit", 25, 1, 100);
  const offset = numberParam(url, "offset", 0, 0, 5000);
  const [source, response] = await Promise.all([getArtist(id), getRelatedArtists(id, limit, offset)]);
  const items = (response.data || []).map(mapArtist);
  return json({ version: version(), data: {
    limit, offset, totalNumberOfItems: Number(response.total ?? response.data?.length ?? 0),
    artist: mapArtist(source), items,
  } });
}

function requiredId(url) {
  const id = url.searchParams.get("id");
  if (!id) throw Object.assign(new Error("Required query parameter: id"), { status: 400 });
  if (!/^\d+$/.test(id)) throw Object.assign(new Error("id must be a numeric Deezer catalog identifier"), { status: 400 });
  return id;
}
function numberParam(url, name, fallback, min, max) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw Object.assign(new Error(`${name} must be a non-negative integer`), { status: 400 });
  return Math.max(min, Math.min(max, Number(raw)));
}
function edges(x) { return Array.isArray(x) ? x.map(e => e?.node ?? e).filter(Boolean) : (Array.isArray(x?.edges) ? x.edges.map(e => e?.node ?? e).filter(Boolean) : []); }
function numericId(value) { const n = Number(value); return Number.isFinite(n) ? n : String(value ?? ""); }
function cleanForMatch(value) { return String(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\b(track|artist|album):/g, " ").replace(/[\"'()[\]{}]/g, " ").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim(); }
function toBase64(text) { return btoa(Array.from(new TextEncoder().encode(text), b => String.fromCharCode(b)).join("")); }
function authorize(request, env) {
  if (!env?.API_KEY) return null;
  const bearer = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  const provided = bearer || request.headers.get("X-API-Key");
  return provided === env.API_KEY ? null : "Provide the configured API key in Authorization: Bearer or X-API-Key.";
}
function checkRateLimit(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const now = Date.now();
  const current = rateWindows.get(ip);
  if (!current || now >= current.reset) {
    rateWindows.set(ip, { count: 1, reset: now + 60_000 });
    if (rateWindows.size > 2000) for (const [k, v] of rateWindows) if (now >= v.reset) rateWindows.delete(k);
    return false;
  }
  current.count += 1;
  return current.count > 120;
}
function headers(extra = {}) { return { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store, max-age=0", "X-Content-Type-Options": "nosniff", ...extra }; }
function json(value, status = 200, extra = {}) { return new Response(JSON.stringify(value), { status, headers: headers(extra) }); }
function fail(status, code, message, requestId = crypto.randomUUID(), extra = {}) { return json({ version: version(), error: { code, message, requestId } }, status, extra); }
function publicMessage(message, status) {
  if (status >= 500) return "The upstream service failed or returned an unsupported response. Retry later; no catalog response has been cached.";
  return String(message || "Request failed").slice(0, 240);
}
