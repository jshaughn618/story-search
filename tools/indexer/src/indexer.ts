import { promises as fs } from "node:fs";
import path from "node:path";
import { chunkText } from "./chunking.js";
import { CloudflareClient } from "./cloudflare.js";
import { ingestSourceFile } from "./ingest.js";
import { extractStoryMetadata } from "./lmstudio.js";
import { createWorkersAiEmbeddings } from "./workers-ai.js";
import type {
  CleanupSummary,
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
  const absoluteFolder = path.resolve(folder);
  const files = await collectFiles(absoluteFolder, config.acceptExtensions);
  const client = new CloudflareClient(config);

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

  const probeVectors = await createWorkersAiEmbeddings(config, ["embedding dimension probe"]);
  const runtimeDimension = probeVectors[0]?.length ?? 0;
  if (runtimeDimension <= 0) {
    throw new Error("Workers AI embedding dimension probe failed");
  }

  const settings = await loadEmbeddingSettings(client);
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

  const flushVectorBatch = async () => {
    if (vectorBatch.length === 0) {
      return;
    }
    summary.vectorsUpserted += await client.upsertVectors(vectorBatch);
    vectorBatch.length = 0;
    vectorBatchBytes = 0;
  };

  await fs.mkdir(config.outputTextDir, { recursive: true });

  for (const filePath of files) {
    const relativePath = normalizePathForDb(absoluteFolder, filePath);

    try {
      const ingest = await ingestSourceFile(filePath, relativePath, config);
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
      const previousSource = await client.getSourceByPath(ingest.sourcePath);

      if (options.changedOnly && previousSource?.RAW_HASH === ingest.rawHash) {
        summary.skipped += 1;
        console.log(`- unchanged: ${ingest.sourcePath}`);
        continue;
      }

      const existingCanonical = await client.getStoryByCanonHash(ingest.canonHash);
      const storyId = existingCanonical?.STORY_ID ?? derivedStoryId;
      const ingestedAt = new Date().toISOString();
      await fs.writeFile(path.join(config.outputTextDir, `${storyId}.txt`), ingest.normalizedText, "utf8");

      if (config.storeOriginalBinary) {
        const originalKey = `sources/original/${storyId}/${Buffer.from(ingest.sourcePath).toString("hex")}${path.extname(filePath).toLowerCase()}`;
        await client.uploadRawObject(originalKey, ingest.originalBytes, getBinaryContentType(filePath));
      }

      if (existingCanonical && !options.reprocessExisting) {
        await client.upsertStorySource({
          storyId,
          sourcePath: ingest.sourcePath,
          rawHash: ingest.rawHash,
          ingestedAt,
          sourceType: ingest.sourceType,
          extractMethod: ingest.extractMethod,
          titleFromSource: ingest.titleFromSource,
        });

        if (previousSource && previousSource.STORY_ID !== storyId) {
          await client.deleteStoryIfOrphan(previousSource.STORY_ID);
        }

        await client.refreshSourceCount(storyId);
        summary.deduped += 1;
        console.log(`= deduped: ${ingest.sourcePath} -> ${storyId}`);
        continue;
      }

      const shouldRunAi = shouldGenerateEmbeddings(ingest.status);
      let metadata = fallbackMetadata(ingest.sourcePath, ingest.status, ingest.statusNotes);
      let metadataFailureNote: string | null = null;
      if (shouldRunAi) {
        try {
          metadata = await extractStoryMetadata(config, ingest.normalizedText, ingest.sourcePath);
        } catch (metadataError) {
          const message = metadataError instanceof Error ? metadataError.message : "unknown metadata error";
          metadataFailureNote = `Metadata extraction fallback used: ${message}`;
          metadata = fallbackMetadata(ingest.sourcePath, ingest.status, metadataFailureNote);
          console.warn(`! metadata fallback: ${ingest.sourcePath} (${message})`);
        }
      }

      const chunks = chunkText(ingest.normalizedText, {
        chunkSizeChars: config.chunkSizeChars,
        overlapChars: config.chunkOverlapChars,
      });

      const r2Key = `stories/${storyId}.txt`;
      const chunksKey = `stories/${storyId}.chunks.json`;

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

      if (previousSource && previousSource.STORY_ID !== storyId) {
        await client.deleteStoryIfOrphan(previousSource.STORY_ID);
      }

      await client.refreshSourceCount(storyId);

      if (shouldRunAi) {
        const embeddings = await embedInBatches(
          config,
          chunks.map((chunk) => chunk.text),
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

  const duplicateGroups = await client.getDuplicateGroups(500);

  summary.reports = await writeReports({
    config,
    summary: cleanupSummary,
    duplicateGroups,
    flaggedFiles,
    extractionFailures,
  });

  await client.setSetting("embedding_model_name", config.cfAiEmbedModel);
  await client.setSetting("embedding_dimension", String(runtimeDimension));
  await client.setSetting("indexed_at", new Date().toISOString());

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
