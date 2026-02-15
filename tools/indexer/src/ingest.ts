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

const HEADER_TAG_LINE_REGEX = /\(([^\)\n]{3,200})\)\s*[.!?"]?\s*$/;
const MAX_HEADER_SCAN_LINES = 60;

function dedupeTokens(tokens: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const token of tokens) {
    const key = token.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(token);
  }
  return output;
}

function parseHeaderTagCodes(rawList: string): string[] {
  if (!rawList.includes(",")) {
    return [];
  }

  const tokens = rawList
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length < 2 || tokens.length > 20) {
    return [];
  }

  if (tokens.some((token) => token.length > 40)) {
    return [];
  }

  return dedupeTokens(tokens);
}

function splitHeaderAndBody(canonicalText: string): {
  headerText: string;
  headerTagCodes: string[];
  bodyText: string;
  bodyStartChar: number;
} {
  const lines = canonicalText.split("\n");
  const lineOffsets: number[] = [];
  let cursor = 0;
  for (const line of lines) {
    lineOffsets.push(cursor);
    cursor += line.length + 1;
  }

  const scanLimit = Math.min(lines.length, MAX_HEADER_SCAN_LINES);
  let headerEndLine = scanLimit;
  for (let index = 0; index < scanLimit; index += 1) {
    if (lines[index].trim() === "") {
      headerEndLine = index;
      break;
    }
  }

  let bodyLineIndex = headerEndLine;
  while (bodyLineIndex < lines.length && lines[bodyLineIndex].trim() === "") {
    bodyLineIndex += 1;
  }

  const headerLines = lines.slice(0, headerEndLine);
  let headerTagCodes: string[] = [];
  for (let index = headerLines.length - 1; index >= 0; index -= 1) {
    const line = headerLines[index].trim();
    if (!line) {
      continue;
    }

    const match = line.match(HEADER_TAG_LINE_REGEX);
    if (!match) {
      continue;
    }

    const parsed = parseHeaderTagCodes(match[1]);
    if (parsed.length === 0) {
      continue;
    }

    headerTagCodes = parsed;
    headerLines[index] = headerLines[index].replace(HEADER_TAG_LINE_REGEX, "").replace(/[ \t]+$/g, "");
    break;
  }

  const headerText = headerLines.join("\n").trim();
  const rawBodyText = lines.slice(bodyLineIndex).join("\n").replace(/[ \t\r\n]+$/g, "");
  const bodyText = rawBodyText || canonicalText;
  const bodyStartChar = rawBodyText
    ? bodyLineIndex < lineOffsets.length
      ? lineOffsets[bodyLineIndex]
      : 0
    : 0;

  return {
    headerText,
    headerTagCodes,
    bodyText,
    bodyStartChar,
  };
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
): Promise<IngestedSource> {
  const bytes = await fs.readFile(absolutePath);
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
      headerText: "",
      bodyText: "",
      bodyStartChar: 0,
      headerTagCodes: [],
      rawHash: sha256Buffer(bytes),
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
  const split = splitHeaderAndBody(normalizedText);
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
    headerText: split.headerText,
    bodyText: split.bodyText,
    bodyStartChar: split.bodyStartChar,
    headerTagCodes: split.headerTagCodes,
    rawHash: sha256Buffer(bytes),
    canonHash: status.status === "EXTRACTION_FAILED" ? null : sha256Text(normalizedText),
    status: status.status,
    statusNotes: notes.length > 0 ? notes.join("; ") : null,
    fileSizeBytes: bytes.byteLength,
    originalBytes: bytes,
    extractedChars: normalizedText.length,
    extractionError: extraction.errorMessage ?? null,
  };
}
