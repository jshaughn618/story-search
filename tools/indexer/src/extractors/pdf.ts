import { PDFParse } from "pdf-parse";
import type { ExtractionResult, ExtractorInput } from "../types.js";

function shouldJoinLines(previous: string, next: string): boolean {
  if (!previous || !next) {
    return false;
  }

  const previousTrimmed = previous.trim();
  const nextTrimmed = next.trim();

  if (!previousTrimmed || !nextTrimmed) {
    return false;
  }

  const lastChar = previousTrimmed.at(-1) ?? "";
  if (/[.!?;:]$/.test(lastChar)) {
    return false;
  }

  return /^[a-z0-9(\["']/.test(nextTrimmed);
}

function reflowPdfText(text: string): string {
  const lines = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim());

  const paragraphs: string[] = [];
  let current = "";

  for (const line of lines) {
    if (!line) {
      if (current) {
        paragraphs.push(current.trim());
        current = "";
      }
      continue;
    }

    if (!current) {
      current = line;
      continue;
    }

    if (shouldJoinLines(current, line)) {
      current = `${current} ${line}`;
    } else {
      paragraphs.push(current.trim());
      current = line;
    }
  }

  if (current) {
    paragraphs.push(current.trim());
  }

  return paragraphs.join("\n\n");
}

async function extractWithPdfParse(bytes: Buffer): Promise<string> {
  const parser = new PDFParse({ data: bytes });
  try {
    const result = await parser.getText();
    return result.text ?? "";
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

async function extractWithPdfJs(bytes: Buffer): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes) });
  const doc = await loadingTask.promise;

  const pages: string[] = [];

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const items = content.items as Array<{ str?: string; transform?: number[] }>;

    let lastY: number | null = null;
    let line = "";
    const lines: string[] = [];

    for (const item of items) {
      const y: number =
        typeof item.transform?.[5] === "number" ? item.transform[5] : (lastY ?? 0);
      const chunk = (item.str ?? "").trim();
      if (!chunk) {
        continue;
      }

      if (lastY !== null && Math.abs(lastY - y) > 2.5 && line.trim()) {
        lines.push(line.trim());
        line = "";
      }

      line = line ? `${line} ${chunk}` : chunk;
      lastY = y;
    }

    if (line.trim()) {
      lines.push(line.trim());
    }

    pages.push(lines.join("\n"));
  }

  await loadingTask.destroy();
  return pages.join("\n\n");
}

export async function extractPdf(input: ExtractorInput): Promise<ExtractionResult> {
  const notes: string[] = [];

  try {
    const parsed = await extractWithPdfParse(input.bytes);
    const reflowed = reflowPdfText(parsed);

    if (reflowed.trim().length >= Math.max(120, Math.floor(input.config.pdfMinTextChars * 0.3))) {
      return {
        sourceType: "pdf",
        extractMethod: "pdf_parse",
        titleFromSource: null,
        extractedText: reflowed,
        notes,
      };
    }

    notes.push("pdf-parse output suspiciously short, trying pdfjs fallback");
  } catch (error) {
    notes.push(`pdf-parse failed: ${error instanceof Error ? error.message : "unknown"}`);
  }

  try {
    const fallback = await extractWithPdfJs(input.bytes);
    return {
      sourceType: "pdf",
      extractMethod: "pdfjs_fallback",
      titleFromSource: null,
      extractedText: reflowPdfText(fallback),
      notes,
    };
  } catch (error) {
    return {
      sourceType: "pdf",
      extractMethod: "failed",
      titleFromSource: null,
      extractedText: "",
      notes,
      errorMessage: error instanceof Error ? error.message : "PDF extraction failed",
    };
  }
}
