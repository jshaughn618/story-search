import type { ExtractionResult, ExtractorInput } from "../types.js";
import { extractDoc } from "./doc.js";
import { extractDocx } from "./docx.js";
import { extractHtml } from "./html.js";
import { extractPdf } from "./pdf.js";
import { extractRtf } from "./rtf.js";
import { extractTxt } from "./txt.js";

export type SourceExtractor = (input: ExtractorInput) => Promise<ExtractionResult>;

const extractorRegistry: Record<string, SourceExtractor> = {
  ".txt": extractTxt,
  ".html": extractHtml,
  ".htm": extractHtml,
  ".rtf": extractRtf,
  ".docx": extractDocx,
  ".doc": extractDoc,
  ".pdf": extractPdf,
};

export function getExtractorByExtension(extension: string): SourceExtractor | null {
  return extractorRegistry[extension.toLowerCase()] ?? null;
}
