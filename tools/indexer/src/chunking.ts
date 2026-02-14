import type { ChunkRecord } from "./types.js";

export interface ChunkingOptions {
  chunkSizeChars: number;
  overlapChars: number;
}

function normalizeExcerpt(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 220);
}

export function chunkText(text: string, options: ChunkingOptions): ChunkRecord[] {
  const cleaned = text.replace(/\r\n/g, "\n").trim();
  if (!cleaned) {
    return [];
  }

  const chunks: ChunkRecord[] = [];
  let start = 0;
  const { chunkSizeChars, overlapChars } = options;

  while (start < cleaned.length) {
    let end = Math.min(start + chunkSizeChars, cleaned.length);

    if (end < cleaned.length) {
      const paragraphBreak = cleaned.lastIndexOf("\n\n", end);
      if (paragraphBreak > start + Math.floor(chunkSizeChars * 0.6)) {
        end = paragraphBreak;
      } else {
        const sentenceBreak = cleaned.lastIndexOf(". ", end);
        if (sentenceBreak > start + Math.floor(chunkSizeChars * 0.55)) {
          end = sentenceBreak + 1;
        }
      }
    }

    if (end <= start) {
      end = Math.min(start + chunkSizeChars, cleaned.length);
    }

    const raw = cleaned.slice(start, end).trim();
    if (raw.length > 0) {
      chunks.push({
        chunkIndex: chunks.length,
        startChar: start,
        endChar: end,
        text: raw,
        excerpt: normalizeExcerpt(raw),
      });
    }

    if (end >= cleaned.length) {
      break;
    }

    start = Math.max(0, end - overlapChars);
  }

  return chunks;
}
