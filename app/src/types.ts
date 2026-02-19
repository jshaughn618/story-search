export type StoryStatus =
  | "OK"
  | "TOO_SHORT"
  | "BINARY_GARBAGE"
  | "NEEDS_REVIEW"
  | "PDF_SCANNED_IMAGE"
  | "EXTRACTION_FAILED";

export interface TagCount {
  tag: string;
  count: number;
}

export interface StatusCount {
  status: StoryStatus;
  count: number;
}

export interface FiltersResponse {
  genres: string[];
  tones: string[];
  tags: TagCount[];
  statuses: StatusCount[];
  totalStories: number;
}

export interface BestChunk {
  chunkIndex: number;
  score: number;
  excerpt: string;
}

export interface StoryResult {
  storyId: string;
  title: string;
  author: string | null;
  summaryShort: string | null;
  summaryLong: string | null;
  genre: string | null;
  tone: string | null;
  setting: string | null;
  tags: string[];
  userTags: string[];
  themes: string[];
  wordCount: number;
  updatedAt: string;
  storyStatus: StoryStatus;
  sourceCount: number;
  statusNotes: string | null;
  isRead: boolean;
  bestChunk: BestChunk | null;
}

export interface SearchResponse {
  mode: "browse" | "semantic" | "exact";
  items: StoryResult[];
  nextOffset: number | null;
  totalCandidates?: number;
  scannedCandidates?: number;
  nextCursor?: string | null;
  facetTags?: TagCount[];
}

export interface SearchRequest {
  q: string;
  filters: {
    genre: string | null;
    tone: string | null;
    tags: string[];
    excludedTags?: string[];
    statuses: StoryStatus[];
    hideRead?: boolean;
  };
  limit: number;
  offset: number;
  cursor?: string | null;
}

export interface ChunkMapItem {
  chunkIndex: number;
  startChar: number;
  endChar: number;
  excerpt: string;
}

export interface StoryDetailResponse {
  story: Omit<StoryResult, "bestChunk">;
  text: string;
  chunks: ChunkMapItem[];
  anchor: ChunkMapItem | null;
}

export interface DeleteStoryResponse {
  ok: boolean;
  storyId: string;
}

export interface StoryUpdateRequest {
  isRead?: boolean;
  addUserTag?: string;
  removeUserTag?: string;
  title?: string;
  author?: string | null;
}

export interface StoryUpdateResponse {
  ok: boolean;
  story: Omit<StoryResult, "bestChunk">;
}

export type ReaderTheme = "light" | "dark" | "sepia";
export type ReaderWidth = "narrow" | "medium" | "wide";
export type ReaderLineHeight = "compact" | "normal" | "relaxed";

export interface ReaderPreferences {
  theme: ReaderTheme;
  width: ReaderWidth;
  lineHeight: ReaderLineHeight;
  fontSize: number;
}
