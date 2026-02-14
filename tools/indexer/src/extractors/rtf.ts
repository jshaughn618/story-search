import parseRtf from "rtf-parser";
import type { ExtractionResult, ExtractorInput } from "../types.js";
import { decodeTextBuffer, runCommand } from "./shared.js";

interface RtfSpan {
  value?: string;
}

interface RtfParagraph {
  content?: RtfSpan[];
}

interface RtfDocument {
  content?: RtfParagraph[];
}

function parseRtfToText(rtfText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    parseRtf.string(rtfText, (error: Error | null, rawDocument: unknown) => {
      if (error) {
        reject(error);
        return;
      }
      const document = rawDocument as RtfDocument;

      const paragraphs = (document?.content ?? [])
        .map((paragraph) =>
          (paragraph.content ?? [])
            .map((span) => span.value ?? "")
            .join("")
            .replace(/\s+/g, " ")
            .trim(),
        )
        .filter(Boolean);

      resolve(paragraphs.join("\n\n"));
    });
  });
}

export async function extractRtf(input: ExtractorInput): Promise<ExtractionResult> {
  const decoded = decodeTextBuffer(input.bytes);
  const notes = [...decoded.notes];

  try {
    const extractedText = await parseRtfToText(decoded.text);
    return {
      sourceType: "rtf",
      extractMethod: "rtf_lib",
      titleFromSource: null,
      extractedText,
      notes,
    };
  } catch {
    notes.push("rtf-parser extraction failed");
  }

  const unrtf = await runCommand("unrtf", ["--text", "--nopict", input.filePath]);
  if (unrtf.ok && unrtf.stdout.trim()) {
    const cleaned = unrtf.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => !line.startsWith("###"))
      .join("\n");

    return {
      sourceType: "rtf",
      extractMethod: "unrtf_fallback",
      titleFromSource: null,
      extractedText: cleaned,
      notes,
    };
  }

  return {
    sourceType: "rtf",
    extractMethod: "failed",
    titleFromSource: null,
    extractedText: "",
    notes,
    errorMessage: unrtf.ok ? "RTF extraction produced no text" : `unrtf unavailable or failed: ${unrtf.stderr}`,
  };
}
