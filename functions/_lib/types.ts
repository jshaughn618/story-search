export interface Env {
  STORY_DB: D1Database;
  STORY_BUCKET: R2Bucket;
  STORY_VECTORS: VectorizeIndex;
  AI: {
    run: (model: string, input: unknown) => Promise<unknown>;
  };
  APP_VERSION?: string;
  CF_AI_EMBED_MODEL?: string;
}

export type StoryStatus =
  | "OK"
  | "TOO_SHORT"
  | "BINARY_GARBAGE"
  | "NEEDS_REVIEW"
  | "PDF_SCANNED_IMAGE"
  | "EXTRACTION_FAILED";

export interface SearchFilters {
  genre?: string | null;
  tone?: string | null;
  tags?: string[];
  statuses?: StoryStatus[];
  hideRead?: boolean;
}

export interface SearchRequestBody {
  q?: string;
  filters?: SearchFilters;
  limit?: number;
  offset?: number;
  cursor?: string | null;
}

export interface StoryRow {
  STORY_ID: string;
  TITLE: string;
  AUTHOR: string | null;
  SUMMARY_SHORT: string | null;
  SUMMARY_LONG: string | null;
  GENRE: string | null;
  TONE: string | null;
  SETTING: string | null;
  TAGS_JSON: string;
  THEMES_JSON: string;
  WORD_COUNT: number;
  R2_KEY: string;
  CHUNKS_KEY: string | null;
  UPDATED_AT: string;
  STORY_STATUS: StoryStatus;
  SOURCE_COUNT: number;
  STATUS_NOTES: string | null;
  IS_READ: number;
  USER_TAGS_JSON: string;
}

export interface ChunkMapItem {
  chunkIndex: number;
  startChar: number;
  endChar: number;
  excerpt: string;
}

export interface VectorMetadata {
  storyId: string;
  chunkIndex: number;
  genre?: string;
  tone?: string;
  title?: string;
  excerpt?: string;
  storyStatus?: StoryStatus;
}
