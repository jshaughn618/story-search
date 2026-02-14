import type { ExtractionResult, ExtractorInput } from "../types.js";
import { runCommand } from "./shared.js";

export async function extractDoc(input: ExtractorInput): Promise<ExtractionResult> {
  const antiword = await runCommand("antiword", [input.filePath]);

  if (antiword.ok && antiword.stdout.trim()) {
    return {
      sourceType: "doc",
      extractMethod: "antiword",
      titleFromSource: null,
      extractedText: antiword.stdout,
      notes: [],
    };
  }

  return {
    sourceType: "doc",
    extractMethod: "failed",
    titleFromSource: null,
    extractedText: "",
    notes: [],
    errorMessage: antiword.ok ? "antiword returned empty output" : `antiword failed: ${antiword.stderr}`,
  };
}
