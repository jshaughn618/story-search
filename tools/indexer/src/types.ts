export type StoryStatus =
  | "OK"
  | "TOO_SHORT"
  | "BINARY_GARBAGE"
  | "NEEDS_REVIEW"
  | "PDF_SCANNED_IMAGE"
  | "EXTRACTION_FAILED";

export type SourceType = "txt" | "html" | "rtf" | "doc" | "docx" | "pdf";

export type ExtractMethod =
  | "txt_utf8"
  | "txt_iconv_fallback"
  | "readability"
  | "dom_text"
  | "fallback"
  | "rtf_lib"
  | "unrtf_fallback"
  | "mammoth"
  | "textract"
  | "antiword"
  | "pdf_parse"
  | "pdfjs_fallback"
  | "failed";

export interface StoryMetadata {
  title: string;
  author: string | null;
  summary_short: string;
  summary_long: string;
  genre: string;
  tone: string;
  setting: string;
  themes: string[];
  tags: string[];
  content_notes: string[];
}

export interface ChunkRecord {
  chunkIndex: number;
  startChar: number;
  endChar: number;
  text: string;
  excerpt: string;
}

export interface IndexedStory {
  storyId: string;
  sourcePath: string;
  contentHash: string;
  rawHash: string;
  canonHash: string;
  storyStatus: StoryStatus;
  sourceCount: number;
  canonTextSource: SourceType;
  extractMethod: ExtractMethod;
  statusNotes: string | null;
  title: string;
  author: string | null;
  summaryShort: string;
  summaryLong: string;
  genre: string;
  tone: string;
  setting: string;
  tags: string[];
  themes: string[];
  contentNotes: string[];
  wordCount: number;
  chunkCount: number;
  r2Key: string;
  chunksKey: string;
  updatedAt: string;
}

export interface StorySourceRecord {
  storyId: string;
  sourcePath: string;
  rawHash: string;
  ingestedAt: string;
  sourceType: SourceType;
  extractMethod: ExtractMethod;
  titleFromSource: string | null;
}

export interface VectorRecord {
  id: string;
  values: number[];
  metadata: {
    storyId: string;
    chunkIndex: number;
    genre: string;
    tone: string;
    title: string;
    excerpt: string;
    storyStatus: StoryStatus;
  };
}

export interface ExistingStoryRow {
  STORY_ID: string;
  SOURCE_PATH: string;
  RAW_HASH: string;
  CANON_HASH: string;
  R2_KEY: string;
  CHUNKS_KEY: string | null;
  STORY_STATUS: StoryStatus;
  CHUNK_COUNT: number;
  SOURCE_COUNT: number;
  TITLE: string;
  AUTHOR: string | null;
}

export interface ExistingSourceRow {
  STORY_ID: string;
  SOURCE_PATH: string;
  RAW_HASH: string;
}

export interface SourcePathRow {
  SOURCE_PATH: string;
}

export interface DuplicateGroupRow {
  storyId: string;
  canonHash: string;
  sourceCount: number;
  title: string;
  sampleSourcePaths: string[];
}

export interface IndexerConfig {
  lmStudioBaseUrl: string;
  lmStudioApiKey: string;
  lmStudioMetadataModel: string;
  lmStudioSystemPromptPath: string;
  lmStudioTimeoutMs: number;
  lmStudioMaxRetries: number;
  cfAiEmbedModel: string;
  cloudflareAccountId: string;
  cloudflareApiToken: string;
  r2BucketName: string;
  r2Endpoint: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  d1DatabaseId: string;
  vectorizeIndexName: string;
  chunkSizeChars: number;
  chunkOverlapChars: number;
  embeddingBatchSize: number;
  vectorBatchSize: number;
  acceptExtensions: string[];
  minExtractChars: number;
  pdfMinTextChars: number;
  reportDir: string;
  outputTextDir: string;
  htmlExtractMode: "readability_first" | "dom_only";
  storeOriginalBinary: boolean;
  vectorBatchMaxBytes: number;
  hashConcurrency: number;
}

export interface ExtractorInput {
  filePath: string;
  sourcePath: string;
  extension: string;
  bytes: Buffer;
  config: IndexerConfig;
}

export interface ExtractionResult {
  sourceType: SourceType;
  extractMethod: ExtractMethod;
  titleFromSource: string | null;
  extractedText: string;
  notes: string[];
  errorMessage?: string;
}

export interface IngestedSource {
  sourcePath: string;
  sourceType: SourceType;
  extractMethod: ExtractMethod;
  titleFromSource: string | null;
  normalizedText: string;
  rawHash: string;
  canonHash: string | null;
  status: StoryStatus;
  statusNotes: string | null;
  fileSizeBytes: number;
  originalBytes: Buffer;
  extractedChars: number;
  extractionError: string | null;
}

export interface StatusReportItem {
  sourcePath: string;
  sourceType: SourceType;
  status: StoryStatus;
  statusNotes: string | null;
  fileSizeBytes: number;
  extractedChars: number;
  extractMethod: ExtractMethod;
}

export interface ExtractionFailureItem {
  sourcePath: string;
  sourceType: SourceType;
  errorMessage: string;
}

export interface CleanupSummary {
  generatedAt: string;
  scannedFiles: number;
  indexedStories: number;
  dedupedSources: number;
  skippedUnchanged: number;
  failedFiles: number;
  totalsBySourceType: Record<string, number>;
  countsByStatus: Record<StoryStatus, number>;
  averageWordCount: number;
  medianWordCount: number;
}
