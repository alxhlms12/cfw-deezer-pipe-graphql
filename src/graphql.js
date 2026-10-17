/**
 * GraphQL schema for the Deezer Graph API.
 *
 * Parsing, validation, variable coercion, directives, fragments, operation selection,
 * introspection, and execution are provided by GraphQL.js (the reference implementation).
 */
import {
  GraphQLEnumType,
  GraphQLFloat,
  GraphQLID,
  GraphQLInt,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  GraphQLBoolean,
  GraphQLError,
} from "graphql";

const listOf = type => new GraphQLList(type);
const nonNull = type => new GraphQLNonNull(type);
const enumValues = values => Object.fromEntries(values.map(value => [value, { value }]));

export const MAX_QUERY_LENGTH = 32_768;
export const MAX_FIELD_COUNT = 1_000;
export const MAX_SELECTION_DEPTH = 20;

const SearchType = new GraphQLEnumType({
  name: "SearchType",
  description: "The Deezer catalog category to search.",
  values: enumValues(["TRACK", "SONG", "ARTIST", "ALBUM", "PLAYLIST", "ISRC"]),
});

const ChartCategory = new GraphQLEnumType({
  name: "ChartCategory",
  description: "Public chart catalog category.",
  values: enumValues(["TRACK", "ALBUM", "ARTIST", "PLAYLIST"]),
});

const TrackQuality = new GraphQLEnumType({
  name: "TrackQuality",
  description: "A requested or reported audio format/quality.",
  values: enumValues(["PREVIEW", "MP3_PREVIEW", "FLAC", "LOSSLESS", "HIFI", "MP3_320", "MP3_128", "BEST", "AACLC", "HEAACV1", "FLAC_HIRES", "EAC3_JOC"]),
});

const ManifestType = new GraphQLEnumType({
  name: "ManifestType",
  values: enumValues(["PROGRESSIVE", "HLS", "MPEG_DASH"]),
});

const ManifestUsage = new GraphQLEnumType({
  name: "ManifestUsage",
  values: enumValues(["PLAYBACK", "DOWNLOAD"]),
});

const UriScheme = new GraphQLEnumType({
  name: "UriScheme",
  values: enumValues(["HTTPS", "DATA"]),
});

const LyricsForm = new GraphQLEnumType({
  name: "LyricsForm",
  values: enumValues(["ALL", "PLAIN", "LINE", "WORD"]),
});

const PlaybackEvent = new GraphQLEnumType({
  name: "PlaybackEvent",
  description: "A playback reporting event; THIRTY_SECONDS maps to Deezer's `30` event.",
  values: { START: { value: "START" }, THIRTY_SECONDS: { value: "30" } },
});

const PaginationType = new GraphQLObjectType({
  name: "Pagination",
  fields: {
    limit: { type: GraphQLInt },
    offset: { type: GraphQLInt },
    totalNumberOfItems: { type: GraphQLInt },
    hasNextPage: { type: GraphQLBoolean },
    nextCursor: { type: GraphQLString },
  },
});

const QualityFormatType = new GraphQLObjectType({
  name: "QualityFormat",
  fields: {
    format: { type: GraphQLString },
    audioQuality: { type: GraphQLString },
    estimatedSizeBytes: { type: GraphQLInt },
  },
});

const QualityRightsType = new GraphQLObjectType({
  name: "QualityRights",
  fields: {
    full: { type: GraphQLBoolean },
    subscription: { type: GraphQLBoolean },
  },
});

const QualityReportType = new GraphQLObjectType({
  name: "QualityReport",
  fields: {
    status: { type: GraphQLString },
    predictedQuality: { type: GraphQLString },
    bestFormat: { type: GraphQLString },
    formats: { type: listOf(QualityFormatType) },
    rights: { type: QualityRightsType },
    source: { type: GraphQLString },
    mediaUrlGenerated: { type: GraphQLBoolean },
    reason: { type: GraphQLString },
  },
});

const MediaMetadataType = new GraphQLObjectType({
  name: "MediaMetadata",
  fields: { tags: { type: listOf(GraphQLString) } },
});

// GraphQL.js calls an abstract type's `resolveType` function (resolver-map
// integrations usually name the same hook `__resolveType`). GraphQL.js expects
// the concrete GraphQL type *name* as a string, not a GraphQLObjectType instance.
function resolveSearchItemType(value) {
  if (!value || typeof value !== "object") return null;

  const normalize = input => String(input).trim().replace(/[\s_-]/g, "").toUpperCase();
  const aliases = {
    TRACK: "Track",
    SONG: "Track",
    ARTIST: "Artist",
    ALBUM: "AlbumSummary",
    ALBUMSUMMARY: "AlbumSummary",
    PLAYLIST: "Playlist",
  };

  // Prefer explicit discriminators when the source API provides one.
  for (const key of ["__typename", "__type", "itemType", "item_type", "objectType", "kind", "type"]) {
    if (typeof value[key] !== "string" || !value[key].trim()) continue;
    const discriminator = normalize(value[key]);
    if (["TRACK", "ARTIST", "ALBUMSUMMARY", "PLAYLIST"].includes(discriminator)) {
      return discriminator === "ALBUMSUMMARY" ? "AlbumSummary" : discriminator[0] + discriminator.slice(1).toLowerCase();
    }
    if (aliases[discriminator]) return aliases[discriminator];
  }

  const hasValue = key => value[key] !== undefined && value[key] !== null;

  // Playlists can also have title/duration fields, so test their unique fields
  // before the more general track/album checks. numberOfVolumes distinguishes
  // Pipe album objects from playlist objects that also expose numberOfTracks.
  if (
    hasValue("image") || hasValue("creator") || hasValue("publicPlaylist") ||
    hasValue("created") || hasValue("estimatedTracksCount") ||
    (hasValue("numberOfTracks") && !hasValue("numberOfVolumes") && !hasValue("upc") && !hasValue("cover"))
  ) return "Playlist";

  if (hasValue("name") && !hasValue("title")) return "Artist";

  // These fields identify tracks reliably across both REST and Pipe mappings.
  if (
    hasValue("isrc") || hasValue("preview") || hasValue("trackNumber") ||
    hasValue("volumeNumber") || hasValue("album") || hasValue("audioQuality") ||
    hasValue("mediaMetadata") || hasValue("streamReady") || hasValue("allowStreaming")
  ) return "Track";

  if (
    hasValue("numberOfVolumes") || hasValue("releaseDate") || hasValue("upc") ||
    hasValue("record_type") || (hasValue("title") && hasValue("cover"))
  ) return "AlbumSummary";

  // Duration is the final useful heuristic when an object has no discriminator.
  // A title-only item defaults to Track to preserve the previous fallback behavior.
  if (hasValue("title") && hasValue("duration")) return "Track";
  if (hasValue("title")) return Object.prototype.hasOwnProperty.call(value, "cover") ? "AlbumSummary" : "Track";
  return null;
}

// Shared interface keeps common fields directly selectable from search results,
// while concrete object types expose their category-specific metadata.
const SearchItemType = new GraphQLInterfaceType({
  name: "SearchItem",
  fields: {
    id: { type: nonNull(GraphQLID) },
    title: { type: GraphQLString },
    name: { type: GraphQLString },
    url: { type: GraphQLString },
    duration: { type: GraphQLInt },
    quality: { type: QualityReportType },
  },
  resolveType: resolveSearchItemType,
});

const CreatorType = new GraphQLObjectType({
  name: "Creator",
  fields: { id: { type: GraphQLID }, name: { type: GraphQLString } },
});

const ArtistType = new GraphQLObjectType({
  name: "Artist",
  interfaces: [SearchItemType],
  fields: () => ({
    id: { type: nonNull(GraphQLID) },
    title: { type: GraphQLString },
    name: { type: GraphQLString },
    url: { type: GraphQLString },
    duration: { type: GraphQLInt },
    quality: { type: QualityReportType },
    picture: { type: GraphQLString },
    artistTypes: { type: listOf(GraphQLString) },
    numberOfAlbums: { type: GraphQLInt },
    fans: { type: GraphQLInt },
    fansCount: { type: GraphQLInt },
    biography: { type: GraphQLString },
    cover: { type: CoverType },
  }),
});

// A lazily-referenced nested type is used here to avoid circular declaration order.
const CoverType = new GraphQLObjectType({
  name: "Cover",
  fields: {
    id: { type: GraphQLID },
    name: { type: GraphQLString },
    small: { type: GraphQLString },
    medium: { type: GraphQLString },
    large: { type: GraphQLString },
    xl: { type: GraphQLString },
  },
});

const AlbumSummaryType = new GraphQLObjectType({
  name: "AlbumSummary",
  interfaces: [SearchItemType],
  fields: {
    id: { type: nonNull(GraphQLID) },
    title: { type: GraphQLString },
    name: { type: GraphQLString },
    url: { type: GraphQLString },
    duration: { type: GraphQLInt },
    quality: { type: QualityReportType },
    cover: { type: GraphQLString },
    releaseDate: { type: GraphQLString },
    explicit: { type: GraphQLBoolean },
    type: { type: GraphQLString },
    upc: { type: GraphQLString },
    label: { type: GraphQLString },
    artists: { type: listOf(ArtistType) },
    artist: { type: ArtistType },
  },
});

const TrackType = new GraphQLObjectType({
  name: "Track",
  interfaces: [SearchItemType],
  fields: {
    id: { type: nonNull(GraphQLID) },
    title: { type: GraphQLString },
    name: { type: GraphQLString },
    url: { type: GraphQLString },
    duration: { type: GraphQLInt },
    quality: { type: QualityReportType },
    allowStreaming: { type: GraphQLBoolean },
    streamReady: { type: GraphQLBoolean },
    trackNumber: { type: GraphQLInt },
    volumeNumber: { type: GraphQLInt },
    version: { type: GraphQLString },
    explicit: { type: GraphQLBoolean },
    isrc: { type: GraphQLString },
    bpm: { type: GraphQLFloat },
    gain: { type: GraphQLFloat },
    rank: { type: GraphQLInt },
    releaseDate: { type: GraphQLString },
    audioQuality: { type: GraphQLString },
    mediaMetadata: { type: MediaMetadataType },
    artist: { type: ArtistType },
    artists: { type: listOf(ArtistType) },
    contributors: { type: listOf(ArtistType) },
    album: { type: AlbumSummaryType },
    preview: { type: GraphQLString },
  },
});

const PlaylistType = new GraphQLObjectType({
  name: "Playlist",
  interfaces: [SearchItemType],
  fields: () => ({
    id: { type: nonNull(GraphQLID) },
    title: { type: GraphQLString },
    name: { type: GraphQLString },
    url: { type: GraphQLString },
    duration: { type: GraphQLInt },
    quality: { type: QualityReportType },
    numberOfTracks: { type: GraphQLInt },
    description: { type: GraphQLString },
    created: { type: GraphQLString },
    publicPlaylist: { type: GraphQLBoolean },
    image: { type: GraphQLString },
    creator: { type: CreatorType },
    items: { type: listOf(AlbumTrackItemTypePlaceholder) },
    pagination: { type: PaginationType },
  }),
});

const AlbumTrackItemTypePlaceholder = new GraphQLObjectType({
  name: "AlbumTrackItem",
  fields: {
    item: { type: TrackType },
    type: { type: GraphQLString },
  },
});

const SearchResultType = new GraphQLObjectType({
  name: "SearchResult",
  fields: {
    query: { type: GraphQLString },
    type: { type: GraphQLString },
    limit: { type: GraphQLInt },
    offset: { type: GraphQLInt },
    totalNumberOfItems: { type: GraphQLInt },
    hasNextPage: { type: GraphQLBoolean },
    nextCursor: { type: GraphQLString },
    items: { type: listOf(SearchItemType) },
  },
});

const AlbumType = new GraphQLObjectType({
  name: "Album",
  fields: {
    id: { type: GraphQLID },
    title: { type: GraphQLString },
    duration: { type: GraphQLInt },
    numberOfTracks: { type: GraphQLInt },
    numberOfVolumes: { type: GraphQLInt },
    releaseDate: { type: GraphQLString },
    type: { type: GraphQLString },
    upc: { type: GraphQLString },
    explicit: { type: GraphQLBoolean },
    url: { type: GraphQLString },
    copyright: { type: GraphQLString },
    label: { type: GraphQLString },
    cover: { type: GraphQLString },
    allowStreaming: { type: GraphQLBoolean },
    artist: { type: ArtistType },
    artists: { type: listOf(ArtistType) },
    items: { type: listOf(AlbumTrackItemTypePlaceholder) },
    pagination: { type: PaginationType },
  },
});

const RecommendationItemType = new GraphQLObjectType({
  name: "RecommendationItem",
  fields: {
    track: { type: TrackType },
    sources: { type: listOf(GraphQLString) },
  },
});

const RecommendationConnectionType = new GraphQLObjectType({
  name: "RecommendationConnection",
  fields: {
    limit: { type: GraphQLInt },
    offset: { type: GraphQLInt },
    totalNumberOfItems: { type: GraphQLInt },
    items: { type: listOf(RecommendationItemType) },
  },
});

const MixImageType = new GraphQLObjectType({
  name: "MixImage",
  fields: { width: { type: GraphQLInt }, height: { type: GraphQLInt }, url: { type: GraphQLString } },
});
const MixImagesType = new GraphQLObjectType({
  name: "MixImages",
  fields: { LARGE: { type: MixImageType } },
});
const MixType = new GraphQLObjectType({
  name: "Mix",
  fields: {
    id: { type: GraphQLID },
    title: { type: GraphQLString },
    subTitle: { type: GraphQLString },
    description: { type: GraphQLString },
    mixType: { type: GraphQLString },
    contentBehavior: { type: GraphQLString },
    images: { type: MixImagesType },
    items: { type: listOf(TrackType) },
    pagination: { type: PaginationType },
  },
});

const AlbumConnectionType = new GraphQLObjectType({
  name: "AlbumConnection",
  fields: {
    limit: { type: GraphQLInt },
    offset: { type: GraphQLInt },
    totalNumberOfItems: { type: GraphQLInt },
    items: { type: listOf(AlbumType) },
    hasNextPage: { type: GraphQLBoolean },
    nextCursor: { type: GraphQLString },
  },
});
const ArtistCatalogType = new GraphQLObjectType({
  name: "ArtistCatalog",
  fields: {
    version: { type: GraphQLString },
    albums: { type: AlbumConnectionType },
    tracks: { type: listOf(TrackType) },
  },
});
const ArtistConnectionType = new GraphQLObjectType({
  name: "ArtistConnection",
  fields: {
    limit: { type: GraphQLInt },
    offset: { type: GraphQLInt },
    totalNumberOfItems: { type: GraphQLInt },
    artist: { type: ArtistType },
    items: { type: listOf(ArtistType) },
  },
});

const TrackManifestType = new GraphQLObjectType({
  name: "TrackManifest",
  fields: () => ({
    id: { type: GraphQLID },
    type: { type: GraphQLString },
    trackId: { type: GraphQLID },
    trackPresentation: { type: GraphQLString },
    assetPresentation: { type: GraphQLString },
    audioMode: { type: GraphQLString },
    uri: { type: GraphQLString },
    manifestMimeType: { type: GraphQLString },
    manifest: { type: GraphQLString },
    formats: { type: listOf(GraphQLString) },
    audioQuality: { type: GraphQLString },
    format: { type: GraphQLString },
    streamReady: { type: GraphQLBoolean },
    streamUrl: { type: GraphQLString },
    playbackToken: { type: GraphQLString },
    previewUrl: { type: GraphQLString },
    previewDuration: { type: GraphQLInt },
    links: { type: ManifestLinksTypePlaceholder },
  }),
});
const ManifestLinksTypePlaceholder = new GraphQLObjectType({
  name: "ManifestLinks",
  fields: { self: { type: GraphQLString } },
});

const LyricLineType = new GraphQLObjectType({
  name: "LyricLine",
  fields: {
    lrcTimestamp: { type: GraphQLString },
    line: { type: GraphQLString },
    lineTranslated: { type: GraphQLString },
    milliseconds: { type: GraphQLInt },
    duration: { type: GraphQLInt },
  },
});
const LyricWordType = new GraphQLObjectType({
  name: "LyricWord",
  fields: { start: { type: GraphQLFloat }, end: { type: GraphQLFloat }, word: { type: GraphQLString } },
});
const LyricWordLineType = new GraphQLObjectType({
  name: "LyricWordLine",
  fields: {
    start: { type: GraphQLFloat },
    end: { type: GraphQLFloat },
    words: { type: listOf(LyricWordType) },
  },
});
const LyricsType = new GraphQLObjectType({
  name: "Lyrics",
  fields: {
    trackId: { type: GraphQLID },
    title: { type: GraphQLString },
    duration: { type: GraphQLInt },
    type: { type: GraphQLString },
    availableTypes: { type: listOf(GraphQLString) },
    plain: { type: GraphQLString },
    writers: { type: GraphQLString },
    copyright: { type: GraphQLString },
    licence: { type: GraphQLString },
    synchronizedLines: { type: listOf(LyricLineType) },
    synchronizedWordByWordLines: { type: listOf(LyricWordLineType) },
  },
});

const PodcastEpisodeType = new GraphQLObjectType({
  name: "PodcastEpisode",
  fields: {
    id: { type: nonNull(GraphQLID) }, title: { type: GraphQLString }, description: { type: GraphQLString },
    duration: { type: GraphQLInt }, releaseDate: { type: GraphQLString }, image: { type: GraphQLString },
    url: { type: GraphQLString },
  },
});
const PodcastType = new GraphQLObjectType({
  name: "Podcast",
  fields: {
    id: { type: nonNull(GraphQLID) }, title: { type: GraphQLString }, description: { type: GraphQLString },
    available: { type: GraphQLBoolean }, explicit: { type: GraphQLBoolean }, image: { type: GraphQLString },
    url: { type: GraphQLString }, episodes: { type: listOf(PodcastEpisodeType) }, pagination: { type: PaginationType },
  },
});
const PodcastSearchResultType = new GraphQLObjectType({
  name: "PodcastSearchResult",
  fields: {
    query: { type: GraphQLString }, limit: { type: GraphQLInt }, offset: { type: GraphQLInt },
    totalNumberOfItems: { type: GraphQLInt }, items: { type: listOf(PodcastType) },
  },
});
const GenreType = new GraphQLObjectType({
  name: "Genre",
  fields: {
    id: { type: nonNull(GraphQLID) }, name: { type: GraphQLString }, picture: { type: GraphQLString },
    artists: { type: listOf(ArtistType) }, pagination: { type: PaginationType },
  },
});
const RadioStationType = new GraphQLObjectType({
  name: "RadioStation",
  fields: {
    id: { type: nonNull(GraphQLID) }, title: { type: GraphQLString }, description: { type: GraphQLString },
    picture: { type: GraphQLString }, category: { type: GraphQLString }, tracks: { type: listOf(TrackType) },
    pagination: { type: PaginationType },
  },
});

const ApiInfoType = new GraphQLObjectType({
  name: "ApiInfo",
  fields: {
    name: { type: GraphQLString },
    version: { type: GraphQLString },
    endpoint: { type: GraphQLString },
    methods: { type: listOf(GraphQLString) },
    queryTransport: { type: GraphQLString },
    mutationTransport: { type: GraphQLString },
    features: { type: listOf(GraphQLString), description: "Backward-compatible alias for supportedFeatures." },
    supportedFeatures: { type: listOf(GraphQLString), description: "Feature identifiers implemented by this API deployment." },
    transportDescription: { type: GraphQLString, description: "How to send query and mutation operations to this endpoint." },
  },
});

const PlaybackReportType = new GraphQLObjectType({
  name: "PlaybackReport",
  fields: {
    accepted: { type: GraphQLBoolean },
    duplicate: { type: GraphQLBoolean },
    event: { type: GraphQLString },
    playToken: { type: GraphQLString },
  },
});

function queryField(name, type, args = {}) {
  return {
    type,
    args,
    resolve: (_source, fieldArgs, context) => context.resolveQueryField(name, fieldArgs, context.env, context.origin),
  };
}
function mutationField(name, type, args = {}) {
  return {
    type,
    args,
    resolve: (_source, fieldArgs, context) => context.resolveMutationField(name, fieldArgs, context.env, context.origin),
  };
}

export function buildGraphQLSchema() {
  const QueryType = new GraphQLObjectType({
    name: "Query",
    fields: {
      apiInfo: queryField("apiInfo", nonNull(ApiInfoType)),
      search: queryField("search", nonNull(SearchResultType), {
        query: { type: GraphQLString },
        q: { type: GraphQLString },
        term: { type: GraphQLString },
        type: { type: SearchType, default: { value: "TRACK" } },
        limit: { type: GraphQLInt, default: { value: 25 } },
        offset: { type: GraphQLInt, default: { value: 0 } },
      }),
      track: queryField("track", TrackType, { id: { type: nonNull(GraphQLID) } }),
      trackInfo: queryField("trackInfo", TrackType, { id: { type: nonNull(GraphQLID) } }),
      quality: queryField("quality", QualityReportType, {
        id: { type: nonNull(GraphQLID) },
        includePreview: { type: GraphQLBoolean, default: { value: false } },
      }),
      trackManifest: queryField("trackManifest", TrackManifestType, {
        id: { type: nonNull(GraphQLID) },
        quality: { type: TrackQuality },
        formats: { type: listOf(nonNull(TrackQuality)) },
        manifestType: { type: ManifestType, default: { value: "PROGRESSIVE" } },
        usage: { type: ManifestUsage, default: { value: "PLAYBACK" } },
        uriScheme: { type: UriScheme, default: { value: "HTTPS" } },
      }),
      recommendations: queryField("recommendations", RecommendationConnectionType, {
        id: { type: nonNull(GraphQLID) }, limit: { type: GraphQLInt, default: { value: 20 } }, offset: { type: GraphQLInt, default: { value: 0 } },
      }),
      album: queryField("album", AlbumType, {
        id: { type: nonNull(GraphQLID) }, limit: { type: GraphQLInt, default: { value: 100 } }, offset: { type: GraphQLInt, default: { value: 0 } },
      }),
      mix: queryField("mix", MixType, {
        id: { type: nonNull(GraphQLID) }, limit: { type: GraphQLInt, default: { value: 60 } }, offset: { type: GraphQLInt, default: { value: 0 } },
      }),
      playlist: queryField("playlist", PlaylistType, {
        id: { type: nonNull(GraphQLID) }, limit: { type: GraphQLInt, default: { value: 100 } }, offset: { type: GraphQLInt, default: { value: 0 } },
      }),
      cover: queryField("cover", CoverType, { id: { type: GraphQLID }, query: { type: GraphQLString }, q: { type: GraphQLString } }),
      covers: queryField("covers", listOf(CoverType), { id: { type: GraphQLID }, query: { type: GraphQLString }, q: { type: GraphQLString } }),
      artist: queryField("artist", ArtistType, { id: { type: nonNull(GraphQLID) } }),
      artistCatalog: queryField("artistCatalog", ArtistCatalogType, {
        id: { type: nonNull(GraphQLID) },
        skipTracks: { type: GraphQLBoolean, default: { value: false } },
        limit: { type: GraphQLInt, default: { value: 25 } }, offset: { type: GraphQLInt, default: { value: 0 } },
      }),
      similarArtists: queryField("similarArtists", ArtistConnectionType, {
        id: { type: nonNull(GraphQLID) }, limit: { type: GraphQLInt, default: { value: 25 } }, offset: { type: GraphQLInt, default: { value: 0 } },
      }),
      lyrics: queryField("lyrics", LyricsType, { id: { type: nonNull(GraphQLID) }, type: { type: LyricsForm, default: { value: "ALL" } } }),
      similarTracks: queryField("similarTracks", nonNull(RecommendationConnectionType), {
        id: { type: nonNull(GraphQLID) }, limit: { type: GraphQLInt, default: { value: 20 } }, offset: { type: GraphQLInt, default: { value: 0 } },
      }),
      trackMix: queryField("trackMix", nonNull(MixType), {
        ids: { type: nonNull(listOf(nonNull(GraphQLID))) }, limit: { type: GraphQLInt, default: { value: 40 } }, offset: { type: GraphQLInt, default: { value: 0 } },
      }),
      artistMix: queryField("artistMix", nonNull(MixType), {
        ids: { type: nonNull(listOf(nonNull(GraphQLID))) }, limit: { type: GraphQLInt, default: { value: 40 } }, offset: { type: GraphQLInt, default: { value: 0 } },
      }),
      tracksByIds: queryField("tracksByIds", nonNull(listOf(TrackType)), {
        ids: { type: nonNull(listOf(nonNull(GraphQLID))) },
      }),
      albumEditions: queryField("albumEditions", nonNull(listOf(AlbumSummaryType)), {
        id: { type: nonNull(GraphQLID) }, limit: { type: GraphQLInt, default: { value: 25 } },
      }),
      countryCharts: queryField("countryCharts", nonNull(SearchResultType), {
        countryCode: { type: nonNull(GraphQLString) }, category: { type: ChartCategory, default: { value: "TRACK" } },
        limit: { type: GraphQLInt, default: { value: 25 } }, after: { type: GraphQLString },
      }),
      podcastSearch: queryField("podcastSearch", nonNull(PodcastSearchResultType), {
        query: { type: nonNull(GraphQLString) }, limit: { type: GraphQLInt, default: { value: 25 } }, offset: { type: GraphQLInt, default: { value: 0 } },
      }),
      podcast: queryField("podcast", PodcastType, {
        id: { type: nonNull(GraphQLID) }, limit: { type: GraphQLInt, default: { value: 25 } }, offset: { type: GraphQLInt, default: { value: 0 } },
      }),
      genres: queryField("genres", nonNull(listOf(GenreType))),
      genreArtists: queryField("genreArtists", GenreType, {
        id: { type: nonNull(GraphQLID) }, limit: { type: GraphQLInt, default: { value: 25 } }, offset: { type: GraphQLInt, default: { value: 0 } },
      }),
      radioStations: queryField("radioStations", nonNull(listOf(RadioStationType))),
      radioStation: queryField("radioStation", RadioStationType, {
        id: { type: nonNull(GraphQLID) }, limit: { type: GraphQLInt, default: { value: 25 } }, offset: { type: GraphQLInt, default: { value: 0 } },
      }),
    },
  });

  const MutationType = new GraphQLObjectType({
    name: "Mutation",
    fields: {
      reportPlayback: mutationField("reportPlayback", PlaybackReportType, {
        trackId: { type: nonNull(GraphQLID) },
        playToken: { type: nonNull(GraphQLString) },
        event: { type: nonNull(PlaybackEvent) },
      }),
    },
  });

  return new GraphQLSchema({ query: QueryType, mutation: MutationType });
}

/** GraphQL.js validation rule limiting selection depth and field count. */
export function queryComplexityRule(context) {
  let selectionDepth = 0;
  let fieldCount = 0;
  let depthErrorReported = false;
  let fieldErrorReported = false;
  return {
    SelectionSet: {
      enter(node) {
        selectionDepth += 1;
        if (selectionDepth > MAX_SELECTION_DEPTH && !depthErrorReported) {
          depthErrorReported = true;
          context.reportError(new GraphQLError(`GraphQL selection depth exceeds the ${MAX_SELECTION_DEPTH}-level limit.`, { nodes: node }));
        }
      },
      leave() { selectionDepth -= 1; },
    },
    Field: {
      enter(node) {
        fieldCount += 1;
        if (fieldCount > MAX_FIELD_COUNT && !fieldErrorReported) {
          fieldErrorReported = true;
          context.reportError(new GraphQLError(`GraphQL operation exceeds the ${MAX_FIELD_COUNT}-field limit.`, { nodes: node }));
        }
      },
    },
  };
}
