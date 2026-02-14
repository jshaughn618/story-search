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
  themes: string[];
  wordCount: number;
  updatedAt: string;
  storyStatus: StoryStatus;
  sourceCount: number;
  statusNotes: string | null;
  bestChunk: BestChunk | null;
}

export interface SearchResponse {
  mode: "browse" | "semantic";
  items: StoryResult[];
  nextOffset: number | null;
  totalCandidates?: number;
}

export interface SearchRequest {
  q: string;
  filters: {
    genre: string | null;
    tone: string | null;
    tags: string[];
    statuses: StoryStatus[];
  };
  limit: number;
  offset: number;
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

export type ReaderTheme = "light" | "dark" | "sepia";
export type ReaderWidth = "narrow" | "medium" | "wide";
export type ReaderLineHeight = "compact" | "normal" | "relaxed";

export interface ReaderPreferences {
  theme: ReaderTheme;
  width: ReaderWidth;
  lineHeight: ReaderLineHeight;
  fontSize: number;
}
