import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import type { ExtractionResult, ExtractorInput } from "../types.js";
import { decodeTextBuffer } from "./shared.js";

function extractDomBlocks(document: Document): string {
  document.querySelectorAll("script,style,noscript").forEach((node) => node.remove());

  document.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));

  const blockSelectors = ["p", "div", "li", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6"];
  const blocks = Array.from(document.querySelectorAll(blockSelectors.join(",")));
  const lines: string[] = [];

  for (const block of blocks) {
    if (block.tagName === "DIV" && block.querySelector(blockSelectors.join(","))) {
      continue;
    }

    const text = block.textContent?.replace(/\s+/g, " ").trim() ?? "";
    if (text) {
      lines.push(text);
    }
  }

  if (lines.length === 0) {
    return document.body?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  }

  return lines.join("\n\n");
}

export async function extractHtml(input: ExtractorInput): Promise<ExtractionResult> {
  const decoded = decodeTextBuffer(input.bytes);
  const notes = [...decoded.notes];
  const dom = new JSDOM(decoded.text);

  const titleFromSource = dom.window.document.title?.trim() || null;

  if (input.config.htmlExtractMode === "readability_first") {
    try {
      const article = new Readability(dom.window.document.cloneNode(true) as Document).parse();
      if (article?.textContent?.trim()) {
        return {
          sourceType: "html",
          extractMethod: "readability",
          titleFromSource: article.title?.trim() || titleFromSource,
          extractedText: article.textContent,
          notes,
        };
      }
      notes.push("Readability returned empty content");
    } catch {
      notes.push("Readability extraction failed");
    }
  }

  try {
    const domText = extractDomBlocks(dom.window.document);
    if (domText.trim()) {
      return {
        sourceType: "html",
        extractMethod: "dom_text",
        titleFromSource,
        extractedText: domText,
        notes,
      };
    }
  } catch {
    notes.push("DOM text extraction failed");
  }

  return {
    sourceType: "html",
    extractMethod: "fallback",
    titleFromSource,
    extractedText: dom.window.document.body?.textContent ?? "",
    notes,
  };
}
