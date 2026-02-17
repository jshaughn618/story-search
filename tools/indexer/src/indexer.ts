import { promises as fs } from "node:fs";
import path from "node:path";
import { chunkText } from "./chunking.js";
import { CloudflareClient } from "./cloudflare.js";
import { ingestSourceFile, loadSourceRaw } from "./ingest.js";
import { extractStoryMetadata } from "./lmstudio.js";
import { createWorkersAiEmbeddings } from "./workers-ai.js";
import type {
  CleanupSummary,
  ExistingSourceRow,
  ExistingStoryRow,
  ExtractionFailureItem,
  IndexedStory,
  IndexerConfig,
  StatusReportItem,
  StoryMetadata,
  StoryStatus,
  VectorRecord,
} from "./types.js";

interface RunOptions {
  changedOnly: boolean;
  forceReindex: boolean;
  reprocessExisting: boolean;
  metadataFallbackOnly: boolean;
  profile: boolean;
}

interface RunSummary {
  scanned: number;
  indexed: number;
  deduped: number;
  skipped: number;
  failed: number;
  vectorsUpserted: number;
  reports: {
    ingestSummaryPath: string;
    duplicateGroupsPath: string;
    flaggedFilesPath: string;
    extractionFailuresPath: string;
  };
  profile?: {
    timingsMs: Record<string, number>;
    counts: Record<string, number>;
  };
}

interface ProfileStats {
  enabled: boolean;
  timingsMs: Record<string, number>;
  counts: Record<string, number>;
}

function shouldGenerateEmbeddings(status: StoryStatus): boolean {
  return !["EXTRACTION_FAILED", "PDF_SCANNED_IMAGE", "BINARY_GARBAGE"].includes(status);
}

function sourceTypeFromExtension(extension: string) {
  switch (extension.toLowerCase()) {
    case ".html":
    case ".htm":
      return "html" as const;
    case ".rtf":
      return "rtf" as const;
    case ".doc":
      return "doc" as const;
    case ".docx":
      return "docx" as const;
    case ".pdf":
      return "pdf" as const;
    default:
      return "txt" as const;
  }
}

function normalizePathForDb(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function createStoryId(canonHash: string): string {
  return canonHash.slice(0, 40);
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

async function collectFiles(root: string, acceptedExtensions: string[]): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return collectFiles(fullPath, acceptedExtensions);
      }

      if (entry.isFile() && acceptedExtensions.includes(path.extname(entry.name).toLowerCase())) {
        return [fullPath];
      }

      return [];
    }),
  );

  return nested.flat().sort();
}

function createProfile(enabled: boolean): ProfileStats {
  return {
    enabled,
    timingsMs: {},
    counts: {},
  };
}

function addTiming(profile: ProfileStats, key: string, durationMs: number) {
  if (!profile.enabled) {
    return;
  }
  profile.timingsMs[key] = (profile.timingsMs[key] ?? 0) + durationMs;
}

function incrementCount(profile: ProfileStats, key: string, amount = 1) {
  if (!profile.enabled) {
    return;
  }
  profile.counts[key] = (profile.counts[key] ?? 0) + amount;
}

async function withTiming<T>(profile: ProfileStats, key: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    addTiming(profile, key, performance.now() - start);
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => runWorker()),
  );

  return results;
}

function createInitialStatusCounts(): Record<StoryStatus, number> {
  return {
    OK: 0,
    TOO_SHORT: 0,
    BINARY_GARBAGE: 0,
    NEEDS_REVIEW: 0,
    PDF_SCANNED_IMAGE: 0,
    EXTRACTION_FAILED: 0,
  };
}

function fallbackMetadata(
  relativePath: string,
  status: StoryStatus,
  statusNotes: string | null,
): StoryMetadata {
  const filename = path.basename(relativePath, path.extname(relativePath));
  const title = filename.replace(/[_-]+/g, " ").trim() || "Untitled Story";

  return {
    title,
    author: null,
    summary_short: statusNotes ?? `Ingestion status: ${status}`,
    summary_long: `This source was ingested with status ${status}. Review before relying on generated metadata.`,
    genre: "",
    tone: "",
    setting: "",
    themes: [],
    tags: [],
    content_notes: statusNotes ? [statusNotes] : [],
  };
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function csvEscape(value: string | number | null | undefined): string {
  const normalized = value === null || value === undefined ? "" : String(value);
  return `"${normalized.replace(/"/g, '""')}"`;
}

function getBinaryContentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".html":
    case ".htm":
      return "text/html; charset=utf-8";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".rtf":
      return "application/rtf";
    case ".doc":
      return "application/msword";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

async function embedInBatches(config: IndexerConfig, inputs: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let start = 0; start < inputs.length; start += config.embeddingBatchSize) {
    const batch = inputs.slice(start, start + config.embeddingBatchSize);
    const batchVectors = await createWorkersAiEmbeddings(config, batch);
    vectors.push(...batchVectors);
  }
  return vectors;
}

async function loadEmbeddingSettings(client: CloudflareClient) {
  const [storedModelName, storedDimensionRaw] = await Promise.all([
    client.getSetting("embedding_model_name"),
    client.getSetting("embedding_dimension"),
  ]);

  return {
    storedModelName,
    storedDimension:
      storedDimensionRaw && Number.parseInt(storedDimensionRaw, 10) > 0
        ? Number.parseInt(storedDimensionRaw, 10)
        : null,
  };
}

async function writeReports(params: {
  config: IndexerConfig;
  summary: CleanupSummary;
  duplicateGroups: Array<{
    canonHash: string;
    storyId: string;
    sourceCount: number;
    sampleSourcePaths: string[];
  }>;
  flaggedFiles: StatusReportItem[];
  extractionFailures: ExtractionFailureItem[];
}) {
  const reportDir = params.config.reportDir;
  await fs.mkdir(reportDir, { recursive: true });

  const ingestSummaryPath = path.join(reportDir, "ingest_summary.json");
  const duplicateGroupsPath = path.join(reportDir, "duplicate_groups.csv");
  const flaggedFilesPath = path.join(reportDir, "flagged_files.csv");
  const extractionFailuresPath = path.join(reportDir, "extraction_failures.csv");

  await fs.writeFile(ingestSummaryPath, JSON.stringify(params.summary, null, 2), "utf8");

  const duplicateRows = ["canon_hash,story_id,source_count,sample_source_paths"];
  for (const group of params.duplicateGroups) {
    duplicateRows.push(
      [
        csvEscape(group.canonHash),
        csvEscape(group.storyId),
        csvEscape(group.sourceCount),
        csvEscape(group.sampleSourcePaths.join(" | ")),
      ].join(","),
    );
  }
  await fs.writeFile(duplicateGroupsPath, `${duplicateRows.join("\n")}\n`, "utf8");

  const flaggedRows = [
    "source_path,source_type,status,status_notes,file_size_bytes,extracted_chars,extract_method",
  ];
  for (const file of params.flaggedFiles) {
    flaggedRows.push(
      [
        csvEscape(file.sourcePath),
        csvEscape(file.sourceType),
        csvEscape(file.status),
        csvEscape(file.statusNotes),
        csvEscape(file.fileSizeBytes),
        csvEscape(file.extractedChars),
        csvEscape(file.extractMethod),
      ].join(","),
    );
  }
  await fs.writeFile(flaggedFilesPath, `${flaggedRows.join("\n")}\n`, "utf8");

  const failureRows = ["source_path,source_type,error_message"];
  for (const failure of params.extractionFailures) {
    failureRows.push(
      [
        csvEscape(failure.sourcePath),
        csvEscape(failure.sourceType),
        csvEscape(failure.errorMessage),
      ].join(","),
    );
  }
  await fs.writeFile(extractionFailuresPath, `${failureRows.join("\n")}\n`, "utf8");

  return {
    ingestSummaryPath,
    duplicateGroupsPath,
    flaggedFilesPath,
    extractionFailuresPath,
  };
}

export async function runIndexing(config: IndexerConfig, folder: string, options: RunOptions): Promise<RunSummary> {
  const profile = createProfile(options.profile);
  const runStartedAt = performance.now();
  const absoluteFolder = path.resolve(folder);
  const discoveredFiles = await withTiming(profile, "collect_files_ms", () =>
    collectFiles(absoluteFolder, config.acceptExtensions),
  );
  const client = new CloudflareClient(config);
  let files = discoveredFiles;

  if (options.metadataFallbackOnly) {
    const fallbackPaths = await withTiming(profile, "d1_read_targeted_sources_ms", () =>
      client.getSourcePathsForMetadataFallbackStories(),
    );
    const targetSet = new Set(fallbackPaths);
    const targetBasenames = new Set(fallbackPaths.map((value) => path.basename(value)));
    files = discoveredFiles.filter((filePath) => {
      const relativePath = normalizePathForDb(absoluteFolder, filePath);
      return targetSet.has(relativePath) || targetBasenames.has(path.basename(relativePath));
    });
    if (files.length === 0 && fallbackPaths.length > 0) {
      console.warn(
        `! metadata-fallback-only matched 0 local files. Folder may differ from original ingest base. D1 targets: ${fallbackPaths.length}`,
      );
    }
    console.log(`- metadata-fallback-only: ${files.length}/${discoveredFiles.length} source files selected`);
  }

  const summary: RunSummary = {
    scanned: files.length,
    indexed: 0,
    deduped: 0,
    skipped: 0,
    failed: 0,
    vectorsUpserted: 0,
    reports: {
      ingestSummaryPath: "",
      duplicateGroupsPath: "",
      flaggedFilesPath: "",
      extractionFailuresPath: "",
    },
  };

  const totalsBySourceType: Record<string, number> = {};
  const countsByStatus = createInitialStatusCounts();
  const flaggedFiles: StatusReportItem[] = [];
  const extractionFailures: ExtractionFailureItem[] = [];
  const extractedWordCounts: number[] = [];

  const probeVectors = await withTiming(profile, "embedding_probe_ms", () =>
    createWorkersAiEmbeddings(config, ["embedding dimension probe"]),
  );
  const runtimeDimension = probeVectors[0]?.length ?? 0;
  if (runtimeDimension <= 0) {
    throw new Error("Workers AI embedding dimension probe failed");
  }

  const settings = await withTiming(profile, "settings_load_ms", () =>
    loadEmbeddingSettings(client),
  );
  if (
    settings.storedModelName &&
    settings.storedModelName !== config.cfAiEmbedModel &&
    !options.forceReindex
  ) {
    throw new Error(
      `Embedding model mismatch. D1 has '${settings.storedModelName}', current is '${config.cfAiEmbedModel}'. Re-run with --force-reindex to override.`,
    );
  }

  if (
    settings.storedDimension !== null &&
    settings.storedDimension !== runtimeDimension &&
    !options.forceReindex
  ) {
    throw new Error(
      `Embedding dimension mismatch. D1 has '${settings.storedDimension}', current model returns '${runtimeDimension}'. Re-run with --force-reindex to override.`,
    );
  }

  const vectorBatch: VectorRecord[] = [];
  let vectorBatchBytes = 0;

  const sourceByPath = new Map<string, ExistingSourceRow>();
  for (const source of await withTiming(profile, "d1_prefetch_sources_ms", () => client.getAllSources())) {
    sourceByPath.set(source.SOURCE_PATH, source);
  }

  const canonicalByHash = new Map<string, ExistingStoryRow>();
  for (const story of await withTiming(profile, "d1_prefetch_canonical_ms", () =>
    client.getAllStoriesByCanonHash(),
  )) {
    if (story.CANON_HASH) {
      canonicalByHash.set(story.CANON_HASH, story);
    }
  }

  const unchangedByPath = new Set<string>();
  const preloadedByPath = new Map<string, { bytes: Buffer; rawHash: string }>();
  if (options.changedOnly) {
    await withTiming(profile, "prehash_stage_ms", async () => {
      await mapWithConcurrency(files, config.hashConcurrency, async (filePath) => {
        const relativePath = normalizePathForDb(absoluteFolder, filePath);
        const previousSource = sourceByPath.get(relativePath);
        if (!previousSource) {
          return;
        }

        const preloadedSource = await withTiming(profile, "hash_file_ms", () => loadSourceRaw(filePath));
        if (previousSource.RAW_HASH === preloadedSource.rawHash) {
          unchangedByPath.add(relativePath);
          incrementCount(profile, "prefilter_unchanged");
          return;
        }

        preloadedByPath.set(relativePath, preloadedSource);
        incrementCount(profile, "prefilter_changed");
      });
    });
  }

  const flushVectorBatch = async () => {
    if (vectorBatch.length === 0) {
      return;
    }
    summary.vectorsUpserted += await withTiming(profile, "vector_upsert_ms", () =>
      client.upsertVectors(vectorBatch),
    );
    incrementCount(profile, "vector_upsert_batches");
    incrementCount(profile, "vectors_upserted", vectorBatch.length);
    vectorBatch.length = 0;
    vectorBatchBytes = 0;
  };

  await fs.mkdir(config.outputTextDir, { recursive: true });

  for (const filePath of files) {
    const relativePath = normalizePathForDb(absoluteFolder, filePath);

    try {
      let previousSource = sourceByPath.get(relativePath) ?? null;
      const preloadedSource = preloadedByPath.get(relativePath);

      if (options.changedOnly && unchangedByPath.has(relativePath)) {
        summary.skipped += 1;
        incrementCount(profile, "skipped_unchanged");
        console.log(`- unchanged: ${relativePath}`);
        continue;
      }

      if (options.changedOnly && previousSource && !preloadedSource) {
        const fallbackRaw = await withTiming(profile, "hash_file_ms", () => loadSourceRaw(filePath));
        if (previousSource.RAW_HASH === fallbackRaw.rawHash) {
          summary.skipped += 1;
          incrementCount(profile, "skipped_unchanged");
          console.log(`- unchanged: ${relativePath}`);
          continue;
        }
      }

      const ingest = await withTiming(profile, "ingest_extract_normalize_ms", () =>
        ingestSourceFile(filePath, relativePath, config, preloadedSource),
      );
      incrementCount(profile, "files_processed");
      totalsBySourceType[ingest.sourceType] = (totalsBySourceType[ingest.sourceType] ?? 0) + 1;
      countsByStatus[ingest.status] += 1;

      if (ingest.status !== "OK") {
        flaggedFiles.push({
          sourcePath: ingest.sourcePath,
          sourceType: ingest.sourceType,
          status: ingest.status,
          statusNotes: ingest.statusNotes,
          fileSizeBytes: ingest.fileSizeBytes,
          extractedChars: ingest.extractedChars,
          extractMethod: ingest.extractMethod,
        });
      }

      if (ingest.status === "EXTRACTION_FAILED" || !ingest.canonHash) {
        summary.failed += 1;
        incrementCount(profile, "files_failed_extraction");
        extractionFailures.push({
          sourcePath: ingest.sourcePath,
          sourceType: ingest.sourceType,
          errorMessage: ingest.extractionError ?? ingest.statusNotes ?? "Extraction failed",
        });
        console.log(`! extraction failed: ${ingest.sourcePath}`);
        continue;
      }

      extractedWordCounts.push(countWords(ingest.normalizedText));

      const derivedStoryId = createStoryId(ingest.canonHash);

      const existingCanonical = canonicalByHash.get(ingest.canonHash) ?? null;
      const storyId = existingCanonical?.STORY_ID ?? derivedStoryId;
      const ingestedAt = new Date().toISOString();
      await withTiming(profile, "local_artifact_write_ms", () =>
        fs.writeFile(path.join(config.outputTextDir, `${storyId}.txt`), ingest.normalizedText, "utf8"),
      );

      if (config.storeOriginalBinary) {
        const originalKey = `sources/original/${storyId}/${Buffer.from(ingest.sourcePath).toString("hex")}${path.extname(filePath).toLowerCase()}`;
        await withTiming(profile, "r2_upload_ms", () =>
          client.uploadRawObject(originalKey, ingest.originalBytes, getBinaryContentType(filePath)),
        );
      }

      if (existingCanonical && !options.reprocessExisting) {
        await withTiming(profile, "d1_write_ms", () =>
          client.upsertStorySource({
            storyId,
            sourcePath: ingest.sourcePath,
            rawHash: ingest.rawHash,
            ingestedAt,
            sourceType: ingest.sourceType,
            extractMethod: ingest.extractMethod,
            titleFromSource: ingest.titleFromSource,
          }),
        );

        if (previousSource && previousSource.STORY_ID !== storyId) {
          await withTiming(profile, "d1_write_ms", () => client.deleteStoryIfOrphan(previousSource.STORY_ID));
          for (const [canonHash, story] of canonicalByHash.entries()) {
            if (story.STORY_ID === previousSource.STORY_ID) {
              canonicalByHash.delete(canonHash);
            }
          }
        }

        await withTiming(profile, "d1_write_ms", () => client.refreshSourceCount(storyId));
        sourceByPath.set(ingest.sourcePath, {
          STORY_ID: storyId,
          SOURCE_PATH: ingest.sourcePath,
          RAW_HASH: ingest.rawHash,
        });
        summary.deduped += 1;
        incrementCount(profile, "files_deduped");
        console.log(`= deduped: ${ingest.sourcePath} -> ${storyId}`);
        continue;
      }

      const shouldRunAi = shouldGenerateEmbeddings(ingest.status);
      let metadata = fallbackMetadata(ingest.sourcePath, ingest.status, ingest.statusNotes);
      let metadataFailureNote: string | null = null;
      if (shouldRunAi) {
        try {
          metadata = await withTiming(profile, "metadata_lm_ms", () =>
            extractStoryMetadata(config, ingest.normalizedText, ingest.sourcePath),
          );
        } catch (metadataError) {
          const message = metadataError instanceof Error ? metadataError.message : "unknown metadata error";
          metadataFailureNote = `Metadata extraction fallback used: ${message}`;
          metadata = fallbackMetadata(ingest.sourcePath, ingest.status, metadataFailureNote);
          console.warn(`! metadata fallback: ${ingest.sourcePath} (${message})`);
        }
      }

      const chunks = await withTiming(profile, "chunking_ms", async () =>
        chunkText(ingest.normalizedText, {
          chunkSizeChars: config.chunkSizeChars,
          overlapChars: config.chunkOverlapChars,
        }),
      );

      const r2Key = `stories/${storyId}.txt`;
      const chunksKey = `stories/${storyId}.chunks.json`;

      await withTiming(profile, "r2_upload_ms", async () => {
        await client.uploadTextObject(r2Key, ingest.normalizedText);
        await client.uploadJsonObject(
          chunksKey,
          chunks.map((chunk) => ({
            chunkIndex: chunk.chunkIndex,
            startChar: chunk.startChar,
            endChar: chunk.endChar,
            excerpt: chunk.excerpt,
          })),
        );
      });

      const indexedStory: IndexedStory = {
        storyId,
        sourcePath: ingest.sourcePath,
        contentHash: ingest.canonHash,
        rawHash: ingest.rawHash,
        canonHash: ingest.canonHash,
        storyStatus: ingest.status,
        sourceCount: 1,
        canonTextSource: ingest.sourceType,
        extractMethod: ingest.extractMethod,
        statusNotes: ingest.statusNotes,
        title: metadata.title,
        author: metadata.author,
        summaryShort: metadata.summary_short,
        summaryLong: metadata.summary_long,
        genre: metadata.genre,
        tone: metadata.tone,
        setting: metadata.setting,
        tags: metadata.tags,
        themes: metadata.themes,
        contentNotes: metadata.content_notes,
        wordCount: countWords(ingest.normalizedText),
        chunkCount: Math.max(0, chunks.length),
        r2Key,
        chunksKey,
        updatedAt: ingestedAt,
      };

      if (metadataFailureNote) {
        indexedStory.statusNotes = indexedStory.statusNotes
          ? `${indexedStory.statusNotes} | ${metadataFailureNote}`
          : metadataFailureNote;
      }

      await withTiming(profile, "d1_write_ms", async () => {
        await client.upsertStory(indexedStory);
        await client.replaceStoryTags(storyId, shouldRunAi ? metadata.tags : []);
        await client.upsertStorySource({
          storyId,
          sourcePath: ingest.sourcePath,
          rawHash: ingest.rawHash,
          ingestedAt,
          sourceType: ingest.sourceType,
          extractMethod: ingest.extractMethod,
          titleFromSource: ingest.titleFromSource,
        });
      });

      if (previousSource && previousSource.STORY_ID !== storyId) {
        await withTiming(profile, "d1_write_ms", () => client.deleteStoryIfOrphan(previousSource.STORY_ID));
        for (const [canonHash, story] of canonicalByHash.entries()) {
          if (story.STORY_ID === previousSource.STORY_ID) {
            canonicalByHash.delete(canonHash);
          }
        }
      }

      await withTiming(profile, "d1_write_ms", () => client.refreshSourceCount(storyId));
      sourceByPath.set(ingest.sourcePath, {
        STORY_ID: storyId,
        SOURCE_PATH: ingest.sourcePath,
        RAW_HASH: ingest.rawHash,
      });
      canonicalByHash.set(ingest.canonHash, {
        STORY_ID: storyId,
        SOURCE_PATH: ingest.sourcePath,
        RAW_HASH: ingest.rawHash,
        CANON_HASH: ingest.canonHash,
        R2_KEY: r2Key,
        CHUNKS_KEY: chunksKey,
        STORY_STATUS: ingest.status,
        CHUNK_COUNT: chunks.length,
        SOURCE_COUNT: 1,
        TITLE: metadata.title,
        AUTHOR: metadata.author,
      });

      if (shouldRunAi) {
        const embeddings = await withTiming(profile, "embedding_docs_ms", () =>
          embedInBatches(
            config,
            chunks.map((chunk) => chunk.text),
          ),
        );

        for (let index = 0; index < chunks.length; index += 1) {
          const chunk = chunks[index];
          const vector: VectorRecord = {
            id: `${storyId}:${String(index).padStart(5, "0")}`,
            values: embeddings[index],
            metadata: {
              storyId,
              chunkIndex: chunk.chunkIndex,
              genre: metadata.genre,
              tone: metadata.tone,
              title: metadata.title,
              excerpt: chunk.excerpt,
              storyStatus: ingest.status,
            },
          };

          const vectorBytes = Buffer.byteLength(JSON.stringify(vector), "utf8") + 1;
          if (
            vectorBatch.length >= config.vectorBatchSize ||
            vectorBatchBytes + vectorBytes > config.vectorBatchMaxBytes
          ) {
            await flushVectorBatch();
          }

          vectorBatch.push(vector);
          vectorBatchBytes += vectorBytes;
        }
      }

      summary.indexed += 1;
      console.log(`+ indexed: ${ingest.sourcePath} (${chunks.length} chunks, ${ingest.status})`);
    } catch (error) {
      summary.failed += 1;
      incrementCount(profile, "files_failed_runtime");
      extractionFailures.push({
        sourcePath: relativePath,
        sourceType: sourceTypeFromExtension(path.extname(relativePath)),
        errorMessage: error instanceof Error ? error.message : "Unknown failure",
      });
      console.error(`! failed: ${relativePath}`, error);
    }
  }

  await flushVectorBatch();

  const averageWordCount =
    extractedWordCounts.length === 0
      ? 0
      : extractedWordCounts.reduce((sum, value) => sum + value, 0) / extractedWordCounts.length;

  const cleanupSummary: CleanupSummary = {
    generatedAt: new Date().toISOString(),
    scannedFiles: summary.scanned,
    indexedStories: summary.indexed,
    dedupedSources: summary.deduped,
    skippedUnchanged: summary.skipped,
    failedFiles: summary.failed,
    totalsBySourceType,
    countsByStatus,
    averageWordCount: Number(averageWordCount.toFixed(2)),
    medianWordCount: Number(median(extractedWordCounts).toFixed(2)),
  };

  const duplicateGroups = await withTiming(profile, "d1_read_reporting_ms", () =>
    client.getDuplicateGroups(500),
  );

  summary.reports = await withTiming(profile, "report_write_ms", () =>
    writeReports({
      config,
      summary: cleanupSummary,
      duplicateGroups,
      flaggedFiles,
      extractionFailures,
    }),
  );

  await withTiming(profile, "settings_write_ms", async () => {
    await client.setSetting("embedding_model_name", config.cfAiEmbedModel);
    await client.setSetting("embedding_dimension", String(runtimeDimension));
    await client.setSetting("indexed_at", new Date().toISOString());
  });

  if (profile.enabled) {
    addTiming(profile, "total_run_ms", performance.now() - runStartedAt);
    summary.profile = {
      timingsMs: Object.fromEntries(
        Object.entries(profile.timingsMs)
          .map(([key, value]) => [key, Number(value.toFixed(2))])
          .sort((a, b) => (b[1] as number) - (a[1] as number)),
      ),
      counts: profile.counts,
    };
  }

  return summary;
}

export async function printStatus(config: IndexerConfig) {
  const client = new CloudflareClient(config);
  const status = await client.status();

  console.log("Story library status");
  console.log(`- stories: ${status.storyCount}`);
  console.log(`- total words: ${status.totalWords}`);
  console.log(`- tags: ${status.tagCount}`);
  console.log(`- flagged (non-OK): ${status.flaggedCount}`);
  console.log(`- latest update: ${status.latestUpdate || "n/a"}`);
}
