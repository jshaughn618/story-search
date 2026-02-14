import mammoth from "mammoth";
import type { ExtractionResult, ExtractorInput } from "../types.js";

export async function extractDocx(input: ExtractorInput): Promise<ExtractionResult> {
  try {
    const result = await mammoth.extractRawText({ buffer: input.bytes });
    const notes = result.messages.map((message) => message.message);

    return {
      sourceType: "docx",
      extractMethod: "mammoth",
      titleFromSource: null,
      extractedText: result.value,
      notes,
    };
  } catch (error) {
    return {
      sourceType: "docx",
      extractMethod: "failed",
      titleFromSource: null,
      extractedText: "",
      notes: [],
      errorMessage: error instanceof Error ? error.message : "mammoth extraction failed",
    };
  }
}
