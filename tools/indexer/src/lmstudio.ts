import type { IndexerConfig, StoryMetadata } from "./types.js";

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

class LmStudioRequestError extends Error {
  constructor(
    readonly status: number,
    readonly responseText: string,
  ) {
    super(`LM Studio chat request failed (${status}): ${responseText}`);
  }
}

const STORY_METADATA_JSON_SCHEMA = {
  name: "story_metadata",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "summary_short", "summary_long", "themes", "tags"],
    properties: {
      title: { type: "string" },
      summary_short: { type: "string" },
      summary_long: { type: "string" },
      themes: { type: "array", items: { type: "string" }, maxItems: 8 },
      tags: { type: "array", items: { type: "string" }, maxItems: 16 },
    },
  },
} as const;

function buildMetadataPrompt(storyText: string) {
  const maxSection = 8000;
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

function dedupeCaseInsensitive(values: string[], maxItems: number): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(trimmed);
    if (output.length >= maxItems) {
      break;
    }
  }

  return output;
}

function asArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const cleaned = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);

  return dedupeCaseInsensitive(cleaned, limit);
}

function normalizeMetadata(input: unknown): StoryMetadata {
  const value = (input ?? {}) as Record<string, unknown>;

  const title = typeof value.title === "string" && value.title.trim() ? value.title.trim() : "Untitled Story";
  const summaryShortRaw = typeof value.summary_short === "string" ? value.summary_short.trim() : "";
  const summaryLongRaw = typeof value.summary_long === "string" ? value.summary_long.trim() : "";

  return {
    title,
    author: null,
    summary_short: summaryShortRaw.slice(0, 280),
    summary_long: summaryLongRaw || summaryShortRaw,
    genre: "",
    tone: "",
    setting: "",
    themes: asArray(value.themes, 8),
    tags: asArray(value.tags, 16).slice(0, 12),
    content_notes: [],
  };
}

async function callChatCompletion(
  baseUrl: string,
  apiKey: string,
  model: string,
  timeoutMs: number,
  maxRetries: number,
  messages: Array<{ role: "system" | "user"; content: string }>,
): Promise<string> {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  function isRetryable(error: unknown): boolean {
    if (error instanceof LmStudioRequestError) {
      return error.status === 408 || error.status === 429 || error.status >= 500;
    }
    if (!(error instanceof Error)) {
      return false;
    }
    const cause = (error as Error & { cause?: { code?: string } }).cause;
    const code = cause?.code ?? "";
    if (code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
      return true;
    }
    return error.message.toLowerCase().includes("fetch failed");
  }

  async function request(responseFormat: unknown): Promise<string> {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        response_format: responseFormat,
        messages,
      }),
    });

    if (!response.ok) {
      throw new LmStudioRequestError(response.status, await response.text());
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("LM Studio chat response did not include content");
    }
    return content;
  }

  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      return await request({ type: "json_schema", json_schema: STORY_METADATA_JSON_SCHEMA });
    } catch (error) {
      if (error instanceof LmStudioRequestError && error.status === 400) {
        try {
          return await request({ type: "text" });
        } catch (textError) {
          if (attempt >= maxRetries || !isRetryable(textError)) {
            throw textError;
          }
        }
      } else if (attempt >= maxRetries || !isRetryable(error)) {
        throw error;
      }

      const backoffMs = Math.min(750 * 2 ** attempt, 5000);
      await sleep(backoffMs);
      attempt += 1;
    }
  }

  throw new Error("LM Studio chat request retries exhausted");
}

async function parseMetadataWithRepair(config: IndexerConfig, raw: string): Promise<StoryMetadata> {
  try {
    return normalizeMetadata(JSON.parse(extractJson(raw)));
  } catch {
    const repairPrompt = `Fix this so it is valid JSON for the required schema and return JSON only:\n\n${raw}`;
    const repaired = await callChatCompletion(
      config.lmStudioBaseUrl,
      config.lmStudioApiKey,
      config.lmStudioMetadataModel,
      config.lmStudioTimeoutMs,
      config.lmStudioMaxRetries,
      [
        { role: "system", content: "Return valid JSON only. No prose." },
        { role: "user", content: repairPrompt },
      ],
    );

    return normalizeMetadata(JSON.parse(extractJson(repaired)));
  }
}

export async function extractStoryMetadata(
  config: IndexerConfig,
  storyText: string,
  sourcePath: string,
): Promise<StoryMetadata> {
  const textForModel = buildMetadataPrompt(storyText);

  const userPrompt = `Source path: ${sourcePath}
Return STRICT JSON only with this schema:
{
  "title": "string",
  "summary_short": "<=280 chars",
  "summary_long": "3-6 sentences",
  "themes": ["up to 8 strings"],
  "tags": ["up to 12 strings"]
}
Use only what you see in the story text. Do not infer from external sources.
Do not include markdown or extra keys.

Analyze the story text below and return only JSON.

${textForModel}`;

  const raw = await callChatCompletion(
    config.lmStudioBaseUrl,
    config.lmStudioApiKey,
    config.lmStudioMetadataModel,
    config.lmStudioTimeoutMs,
    config.lmStudioMaxRetries,
    [
      { role: "user", content: userPrompt },
    ],
  );

  return parseMetadataWithRepair(config, raw);
}
