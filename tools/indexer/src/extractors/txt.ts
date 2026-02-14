import type { ExtractionResult, ExtractorInput } from "../types.js";
import { decodeTextBuffer } from "./shared.js";

export async function extractTxt(input: ExtractorInput): Promise<ExtractionResult> {
  const decoded = decodeTextBuffer(input.bytes);

  const text = decoded.text.replace(/\u0000/g, "");

  return {
    sourceType: "txt",
    extractMethod: decoded.method === "utf8" ? "txt_utf8" : "txt_iconv_fallback",
    titleFromSource: null,
    extractedText: text,
    notes: decoded.notes,
  };
}
