import path from "node:path";
import { DEFAULT_CF_AI_EMBED_MODEL } from "@story-search/shared";
import type { IndexerConfig } from "./types.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function asNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Env var ${name} must be a positive integer`);
  }

  return parsed;
}

function asBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseExtensions(value: string | undefined): string[] {
  const fallback = [".txt", ".html", ".htm", ".rtf", ".doc", ".docx", ".pdf"];
  if (!value) {
    return fallback;
  }

  const parsed = value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .map((item) => (item.startsWith(".") ? item : `.${item}`));

  return parsed.length > 0 ? [...new Set(parsed)] : fallback;
}

function resolveLocalPath(value: string): string {
  if (path.isAbsolute(value)) {
    return value;
  }

  const envPath = process.env.STORY_INDEXER_ENV_PATH;
  if (envPath) {
    return path.resolve(path.dirname(envPath), value);
  }

  return path.resolve(value);
}

export function loadConfig(): IndexerConfig {
  const accountId = process.env.CF_ACCOUNT_ID ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CF_API_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId) {
    throw new Error("Missing required env var: CF_ACCOUNT_ID");
  }
  if (!apiToken) {
    throw new Error("Missing required env var: CF_API_TOKEN");
  }
  const extractMode = (process.env.HTML_EXTRACT_MODE ?? "readability_first").trim().toLowerCase();

  if (extractMode !== "readability_first" && extractMode !== "dom_only") {
    throw new Error("HTML_EXTRACT_MODE must be readability_first or dom_only");
  }

  return {
    lmStudioBaseUrl: (process.env.LMSTUDIO_BASE_URL ?? "http://localhost:1234/v1").replace(/\/+$/, ""),
    lmStudioApiKey: process.env.LMSTUDIO_API_KEY ?? "lm-studio",
    lmStudioMetadataModel: process.env.LMSTUDIO_METADATA_MODEL ?? "local-metadata-model",
    lmStudioSystemPromptPath: resolveLocalPath(
      process.env.LMSTUDIO_SYSTEM_PROMPT_PATH ?? "tools/indexer/prompts/system_prompt.txt",
    ),
    lmStudioTimeoutMs: asNumber("LMSTUDIO_TIMEOUT_MS", 120000),
    lmStudioMaxRetries: asNumber("LMSTUDIO_MAX_RETRIES", 2),
    cfAiEmbedModel: process.env.CF_AI_EMBED_MODEL ?? DEFAULT_CF_AI_EMBED_MODEL,
    cloudflareAccountId: accountId,
    cloudflareApiToken: apiToken,
    r2BucketName: required("R2_BUCKET_NAME"),
    r2Endpoint: process.env.R2_ENDPOINT ?? `https://${accountId}.r2.cloudflarestorage.com`,
    r2AccessKeyId: required("R2_ACCESS_KEY_ID"),
    r2SecretAccessKey: required("R2_SECRET_ACCESS_KEY"),
    d1DatabaseId: required("D1_DATABASE_ID"),
    vectorizeIndexName: required("VECTORIZE_INDEX_NAME"),
    chunkSizeChars: asNumber("CHUNK_SIZE_CHARS", 1800),
    chunkOverlapChars: asNumber("CHUNK_OVERLAP_CHARS", 280),
    embeddingBatchSize: asNumber("EMBEDDING_BATCH_SIZE", 24),
    vectorBatchSize: asNumber("VECTOR_BATCH_SIZE", 200),
    acceptExtensions: parseExtensions(process.env.INDEXER_ACCEPT_EXTENSIONS),
    minExtractChars: asNumber("MIN_EXTRACT_CHARS", 500),
    pdfMinTextChars: asNumber("PDF_MIN_TEXT_CHARS", 800),
    reportDir: resolveLocalPath(process.env.REPORT_DIR ?? "tools/indexer/reports"),
    outputTextDir: resolveLocalPath(process.env.OUTPUT_TEXT_DIR ?? "tools/indexer/output_text"),
    htmlExtractMode: extractMode,
    storeOriginalBinary: asBoolean("STORE_ORIGINAL_BINARY", false),
    vectorBatchMaxBytes: asNumber("VECTOR_BATCH_MAX_BYTES", 95 * 1024 * 1024),
    hashConcurrency: asNumber("INDEXER_HASH_CONCURRENCY", 8),
    storyConcurrency: asNumber("INDEXER_STORY_CONCURRENCY", 1),
  };
}
