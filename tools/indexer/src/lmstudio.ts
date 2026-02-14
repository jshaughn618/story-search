import type { IndexerConfig, StoryMetadata } from "./types.js";

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

function buildMetadataPrompt(storyText: string) {
  const maxSection = 7000;
  if (storyText.length <= maxSection * 2) {
    return storyText;
  }

  const middleStart = Math.max(0, Math.floor(storyText.length / 2) - Math.floor(maxSection / 2));
  const middleEnd = Math.min(storyText.length, middleStart + maxSection);

  return [
    "[BEGINNING]",
    storyText.slice(0, maxSection),
    "[MIDDLE]",
    storyText.slice(middleStart, middleEnd),
    "[END]",
    storyText.slice(-maxSection),
  ].join("\n\n");
}

function extractJson(raw: string): string {
  const trimmed = raw.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch) {
    return fencedMatch[1].trim();
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  return trimmed;
}

function asArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .slice(0, limit);
}

function normalizeMetadata(input: unknown): StoryMetadata {
  const value = (input ?? {}) as Record<string, unknown>;

  const title = typeof value.title === "string" && value.title.trim() ? value.title.trim() : "Untitled Story";
  const authorRaw = typeof value.author === "string" ? value.author.trim() : "";
  const summaryShortRaw = typeof value.summary_short === "string" ? value.summary_short.trim() : "";
  const summaryLongRaw = typeof value.summary_long === "string" ? value.summary_long.trim() : "";

  return {
    title,
    author: authorRaw ? authorRaw.slice(0, 160) : null,
    summary_short: summaryShortRaw.slice(0, 280),
    summary_long: summaryLongRaw || summaryShortRaw,
    genre: typeof value.genre === "string" ? value.genre.trim().slice(0, 64) : "Unknown",
    tone: typeof value.tone === "string" ? value.tone.trim().slice(0, 64) : "Unknown",
    setting: typeof value.setting === "string" ? value.setting.trim().slice(0, 160) : "",
    themes: asArray(value.themes, 5),
    tags: asArray(value.tags, 12),
    content_notes: asArray(value.content_notes, 8),
  };
}

async function callChatCompletion(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: Array<{ role: "system" | "user"; content: string }>,
): Promise<string> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages,
    }),
  });

  if (!response.ok) {
    throw new Error(`LM Studio chat request failed (${response.status}): ${await response.text()}`);
  }

  const data = (await response.json()) as ChatCompletionResponse;
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("LM Studio chat response did not include content");
  }

  return content;
}

export async function extractStoryMetadata(
  config: IndexerConfig,
  storyText: string,
  sourcePath: string,
): Promise<StoryMetadata> {
  const textForModel = buildMetadataPrompt(storyText);

  const systemPrompt = `You are a story cataloging assistant. Return STRICT JSON only with this schema:
{
  "title": "string",
  "author": "string | null (null if unknown)",
  "summary_short": "<=280 chars",
  "summary_long": "3-6 sentences",
  "genre": "single best genre",
  "tone": "single best tone",
  "setting": "short setting",
  "themes": ["up to 5 strings"],
  "tags": ["up to 12 strings, consistent casing"],
  "content_notes": ["optional strings"]
}
Do not include markdown or extra keys.`;

  const userPrompt = `Source path: ${sourcePath}
Analyze the story text below and return only JSON.

${textForModel}`;

  const raw = await callChatCompletion(config.lmStudioBaseUrl, config.lmStudioApiKey, config.lmStudioMetadataModel, [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]);

  try {
    return normalizeMetadata(JSON.parse(extractJson(raw)));
  } catch {
    const repairPrompt = `Fix this so it is valid JSON for the required schema and return JSON only:\n\n${raw}`;
    const repaired = await callChatCompletion(config.lmStudioBaseUrl, config.lmStudioApiKey, config.lmStudioMetadataModel, [
      { role: "system", content: "Return valid JSON only. No prose." },
      { role: "user", content: repairPrompt },
    ]);

    return normalizeMetadata(JSON.parse(extractJson(repaired)));
  }
}
