import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getExtractorByExtension } from "./extractors/index.js";
import type {
  ExtractMethod,
  ExtractorInput,
  IngestedSource,
  IndexerConfig,
  SourceType,
  StoryStatus,
} from "./types.js";

function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeToUtf8(text: string): string {
  return Buffer.from(text, "utf8").toString("utf8");
}

export function normalizeCanonicalText(input: string): string {
  const normalized = input
    .normalize("NFKC")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return normalizeToUtf8(normalized);
}

function inferSourceType(extension: string): SourceType {
  switch (extension.toLowerCase()) {
    case ".html":
    case ".htm":
      return "html";
    case ".rtf":
      return "rtf";
    case ".doc":
      return "doc";
    case ".docx":
      return "docx";
    case ".pdf":
      return "pdf";
    default:
      return "txt";
  }
}

function detectBinaryGarbage(extractedText: string): boolean {
  if (!extractedText) {
    return false;
  }

  const controlCount = (extractedText.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g) ?? []).length;
  const replacementCount = (extractedText.match(/�/g) ?? []).length;
  const ratio = (controlCount + replacementCount) / extractedText.length;
  return ratio > 0.01;
}

function detectPdfScannedImage(extractedChars: number, fileSizeBytes: number, config: IndexerConfig): boolean {
  if (extractedChars >= config.pdfMinTextChars) {
    return false;
  }

  if (fileSizeBytes < 120 * 1024) {
    return false;
  }

  const charsPerKb = extractedChars / Math.max(1, fileSizeBytes / 1024);
  return charsPerKb < 2.5;
}

function detectNeedsReview(sourceType: SourceType, extractedChars: number, fileSizeBytes: number, config: IndexerConfig): boolean {
  if (!["html", "rtf", "doc"].includes(sourceType)) {
    return false;
  }

  return extractedChars < config.minExtractChars && fileSizeBytes > config.minExtractChars * 8;
}

function determineStatus(params: {
  sourceType: SourceType;
  extractMethod: ExtractMethod;
  extractedText: string;
  normalizedText: string;
  fileSizeBytes: number;
  extractionError?: string;
  config: IndexerConfig;
}): { status: StoryStatus; notes: string[] } {
  const notes: string[] = [];

  if (params.extractionError || params.extractMethod === "failed") {
    notes.push(params.extractionError ?? "Extraction failed");
    return { status: "EXTRACTION_FAILED", notes };
  }

  if (detectBinaryGarbage(params.extractedText)) {
    notes.push("Extracted text contains excessive control/replacement characters");
    return { status: "BINARY_GARBAGE", notes };
  }

  const extractedChars = params.normalizedText.length;

  if (params.sourceType === "pdf" && detectPdfScannedImage(extractedChars, params.fileSizeBytes, params.config)) {
    notes.push("PDF appears scanned/image-based (OCR deferred)");
    return { status: "PDF_SCANNED_IMAGE", notes };
  }

  if (detectNeedsReview(params.sourceType, extractedChars, params.fileSizeBytes, params.config)) {
    notes.push("Extraction suspiciously short relative to file size");
    return { status: "NEEDS_REVIEW", notes };
  }

  if (extractedChars < params.config.minExtractChars) {
    notes.push(`Extracted text shorter than MIN_EXTRACT_CHARS (${params.config.minExtractChars})`);
    return { status: "TOO_SHORT", notes };
  }

  return { status: "OK", notes };
}

export async function ingestSourceFile(
  absolutePath: string,
  relativePath: string,
  config: IndexerConfig,
  preloaded?: { bytes: Buffer; rawHash: string },
): Promise<IngestedSource> {
  const bytes = preloaded?.bytes ?? (await fs.readFile(absolutePath));
  const rawHash = preloaded?.rawHash ?? sha256Buffer(bytes);
  const extension = path.extname(absolutePath).toLowerCase();
  const sourceType = inferSourceType(extension);
  const extractor = getExtractorByExtension(extension);

  if (!extractor) {
    return {
      sourcePath: relativePath,
      sourceType,
      extractMethod: "failed",
      titleFromSource: null,
      normalizedText: "",
      rawHash,
      canonHash: null,
      status: "EXTRACTION_FAILED",
      statusNotes: `No extractor registered for extension: ${extension}`,
      fileSizeBytes: bytes.byteLength,
      originalBytes: bytes,
      extractedChars: 0,
      extractionError: `Unsupported extension: ${extension}`,
    };
  }

  const input: ExtractorInput = {
    filePath: absolutePath,
    sourcePath: relativePath,
    extension,
    bytes,
    config,
  };

  const extraction = await extractor(input);
  const normalizedText = normalizeCanonicalText(extraction.extractedText);
  const status = determineStatus({
    sourceType: extraction.sourceType,
    extractMethod: extraction.extractMethod,
    extractedText: extraction.extractedText,
    normalizedText,
    fileSizeBytes: bytes.byteLength,
    extractionError: extraction.errorMessage,
    config,
  });

  const notes = [...extraction.notes, ...status.notes].filter(Boolean);

  return {
    sourcePath: relativePath,
    sourceType: extraction.sourceType,
    extractMethod: extraction.extractMethod,
    titleFromSource: extraction.titleFromSource,
    normalizedText,
    rawHash,
    canonHash: status.status === "EXTRACTION_FAILED" ? null : sha256Text(normalizedText),
    status: status.status,
    statusNotes: notes.length > 0 ? notes.join("; ") : null,
    fileSizeBytes: bytes.byteLength,
    originalBytes: bytes,
    extractedChars: normalizedText.length,
    extractionError: extraction.errorMessage ?? null,
  };
}

export async function loadSourceRaw(absolutePath: string): Promise<{ bytes: Buffer; rawHash: string }> {
  const bytes = await fs.readFile(absolutePath);
  return {
    bytes,
    rawHash: sha256Buffer(bytes),
  };
}
