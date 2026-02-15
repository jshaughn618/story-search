import { errorResponse, json, readJson } from "../_lib/http";
import { mapStory, parseStringArray } from "../_lib/story";
import { DEFAULT_CF_AI_EMBED_MODEL } from "@story-search/shared";
import type {
  Env,
  SearchFilters,
  SearchRequestBody,
  StoryRow,
  StoryStatus,
  VectorMetadata,
} from "../_lib/types";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const DEFAULT_STATUSES: StoryStatus[] = [];
const VECTOR_MAX_TOPK_WITH_ALL_METADATA = 50;
const VECTOR_MAX_TOPK_WITH_INDEXED_METADATA = 100;
const EXACT_SCAN_BATCH_SIZE = 40;
const EXACT_SCAN_MAX_CANDIDATES = 60;

interface VectorMatch {
  id: string;
  score: number;
  metadata?: VectorMetadata;
}

interface AggregatedResult {
  storyId: string;
  chunkIndex: number;
  score: number;
  excerpt: string;
}


function collectVectorMatches(bestByStory: Map<string, AggregatedResult>, matches: VectorMatch[]) {
  for (const match of matches) {
    const metadata = match.metadata;
    const storyId = metadata?.storyId ?? match.id.split(":")[0];
    if (!storyId) {
      continue;
    }

    const existing = bestByStory.get(storyId);
    if (!existing || match.score > existing.score) {
      bestByStory.set(storyId, {
        storyId,
        chunkIndex:
          metadata?.chunkIndex ??
          (Number.parseInt(match.id.split(":")[1] ?? "0", 10) || 0),
        score: match.score,
        excerpt: metadata?.excerpt ?? existing?.excerpt ?? "",
      });
    }
  }
}

function normalizeStatuses(statuses?: StoryStatus[]): StoryStatus[] {
  if (statuses === undefined) {
    return DEFAULT_STATUSES;
  }
  if (Array.isArray(statuses) && statuses.length === 0) {
    return [];
  }
  if (!Array.isArray(statuses)) {
    return DEFAULT_STATUSES;
  }

  const valid = new Set<StoryStatus>([
    "OK",
    "TOO_SHORT",
    "BINARY_GARBAGE",
    "NEEDS_REVIEW",
    "PDF_SCANNED_IMAGE",
    "EXTRACTION_FAILED",
  ]);
  const parsed = statuses.map((status) => String(status).trim().toUpperCase() as StoryStatus).filter((status) => valid.has(status));
  return parsed.length > 0 ? [...new Set(parsed)] : DEFAULT_STATUSES;
}

function normalizeFilters(filters?: SearchFilters): Required<SearchFilters> {
  const genre = filters?.genre?.trim() || null;
  const tone = filters?.tone?.trim() || null;
  const tags = Array.isArray(filters?.tags)
    ? filters.tags.map((tag) => tag.trim()).filter(Boolean)
    : [];
  const statuses = normalizeStatuses(filters?.statuses);
  const hideRead = filters?.hideRead === true;

  return { genre, tone, tags, statuses, hideRead };
}

function clampLimit(limit?: number): number {
  if (!limit || Number.isNaN(limit)) {
    return DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit)));
}

interface ExactQuery {
  exactTerm: string;
  extraTerms: string[];
}

function parseExactQuery(q: string): ExactQuery | null {
  const trimmed = q.trim();
  if (trimmed.length < 2) {
    return null;
  }

  const quotePairs: Array<[string, string]> = [
    ["\"", "\""],
    ["“", "”"],
  ];

  for (const [open, close] of quotePairs) {
    if (trimmed.startsWith(open) && trimmed.endsWith(close)) {
      const inner = trimmed.slice(open.length, trimmed.length - close.length);
      return inner.length > 0 ? { exactTerm: inner, extraTerms: [] } : null;
    }

    if (trimmed.startsWith(open)) {
      const closeIndex = trimmed.indexOf(close, open.length);
      if (closeIndex > open.length) {
        const exactTerm = trimmed.slice(open.length, closeIndex).trim();
        const tail = trimmed.slice(closeIndex + close.length).trim();
        const extraTerms = tail.length > 0 ? tail.split(/\s+/).filter(Boolean) : [];
        return exactTerm ? { exactTerm, extraTerms } : null;
      }
    }
  }

  return null;
}

function buildSnippet(text: string, startIndex: number, matchLength: number): string {
  const radius = 120;
  const from = Math.max(0, startIndex - radius);
  const to = Math.min(text.length, startIndex + matchLength + radius);
  return text
    .slice(from, to)
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeOffset(offset?: number): number {
  if (!offset || Number.isNaN(offset) || offset < 0) {
    return 0;
  }
  return Math.trunc(offset);
}

function extractEmbedding(result: unknown): number[] {
  const candidate = result as {
    data?: unknown;
    embedding?: unknown;
  };

  if (Array.isArray(candidate.data)) {
    if (Array.isArray(candidate.data[0])) {
      return (candidate.data[0] as unknown[]).map((value) => Number(value));
    }
    if (candidate.data.every((value) => typeof value === "number")) {
      return candidate.data as number[];
    }
  }

  if (Array.isArray(candidate.embedding)) {
    return (candidate.embedding as unknown[]).map((value) => Number(value));
  }

  throw new Error("Workers AI embedding response was not recognized");
}

async function fetchStoriesByIds(env: Env, storyIds: string[]): Promise<Map<string, StoryRow>> {
  if (storyIds.length === 0) {
    return new Map();
  }

  const placeholders = storyIds.map(() => "?").join(",");
  const sql = `
    SELECT STORY_ID, TITLE, AUTHOR, SUMMARY_SHORT, SUMMARY_LONG, GENRE, TONE, SETTING,
           TAGS_JSON, USER_TAGS_JSON, THEMES_JSON, WORD_COUNT, R2_KEY, CHUNKS_KEY, UPDATED_AT,
           STORY_STATUS, SOURCE_COUNT, STATUS_NOTES, IS_READ
    FROM STORIES
    WHERE STORY_ID IN (${placeholders})
  `;

  const statement = env.STORY_DB.prepare(sql).bind(...storyIds);
  const result = await statement.all<StoryRow>();

  const byId = new Map<string, StoryRow>();
  for (const row of result.results ?? []) {
    byId.set(row.STORY_ID, row);
  }

  return byId;
}

function storyHasTags(story: StoryRow, selectedTags: string[]): boolean {
  if (selectedTags.length === 0) {
    return true;
  }
  const tagSet = new Set(
    [...parseStringArray(story.TAGS_JSON), ...parseStringArray(story.USER_TAGS_JSON)].map((tag) =>
      tag.toLowerCase(),
    ),
  );
  return selectedTags.every((tag) => tagSet.has(tag.toLowerCase()));
}

function storyMatchesStatus(story: StoryRow, statuses: StoryStatus[]): boolean {
  if (statuses.length === 0) {
    return true;
  }
  return statuses.includes(story.STORY_STATUS);
}

function storyMatchesReadFilter(story: StoryRow, hideRead: boolean): boolean {
  if (!hideRead) {
    return true;
  }
  return story.IS_READ !== 1;
}

async function runBrowseQuery(env: Env, filters: Required<SearchFilters>, limit: number, offset: number) {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  applyFilterClauses(filters, clauses, params);

  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  const sql = `
    SELECT STORY_ID, TITLE, AUTHOR, SUMMARY_SHORT, SUMMARY_LONG, GENRE, TONE, SETTING,
           TAGS_JSON, USER_TAGS_JSON, THEMES_JSON, WORD_COUNT, R2_KEY, CHUNKS_KEY, UPDATED_AT,
           STORY_STATUS, SOURCE_COUNT, STATUS_NOTES, IS_READ
    FROM STORIES
    ${whereClause}
    ORDER BY UPDATED_AT DESC
    LIMIT ? OFFSET ?
  `;

  const result = await env.STORY_DB.prepare(sql).bind(...params, limit, offset).all<StoryRow>();
  const rows = result.results ?? [];

  return {
    items: rows.map((row) => ({ ...mapStory(row), bestChunk: null })),
    nextOffset: rows.length < limit ? null : offset + limit,
    mode: "browse" as const,
  };
}

function applyFilterClauses(
  filters: Required<SearchFilters>,
  clauses: string[],
  params: (string | number)[],
) {
  if (filters.genre) {
    clauses.push("GENRE = ?");
    params.push(filters.genre);
  }

  if (filters.tone) {
    clauses.push("TONE = ?");
    params.push(filters.tone);
  }

  if (filters.statuses.length > 0) {
    const statusPlaceholders = filters.statuses.map(() => "?").join(",");
    clauses.push(`STORY_STATUS IN (${statusPlaceholders})`);
    params.push(...filters.statuses);
  }

  if (filters.tags.length > 0) {
    const tagPlaceholders = filters.tags.map(() => "?").join(",");
    clauses.push(`
      STORY_ID IN (
        SELECT STORY_ID
        FROM (
          SELECT STORY_ID, TAG FROM STORY_TAGS
          UNION
          SELECT STORY_ID, TAG FROM STORY_USER_TAGS
        )
        WHERE TAG IN (${tagPlaceholders})
        GROUP BY STORY_ID
        HAVING COUNT(DISTINCT TAG) = ?
      )
    `);
    params.push(...filters.tags, filters.tags.length);
  }

  if (filters.hideRead) {
    clauses.push("IS_READ = 0");
  }
}

async function runExactQuery(
  env: Env,
  parsedExact: ExactQuery,
  filters: Required<SearchFilters>,
  limit: number,
  cursor: string | null | undefined,
) {
  const exactTerm = parsedExact.exactTerm;
  const extraTerms = parsedExact.extraTerms.map((term) => term.toLowerCase());
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  applyFilterClauses(filters, clauses, params);

  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `
    SELECT STORY_ID, TITLE, AUTHOR, SUMMARY_SHORT, SUMMARY_LONG, GENRE, TONE, SETTING,
           TAGS_JSON, USER_TAGS_JSON, THEMES_JSON, WORD_COUNT, R2_KEY, CHUNKS_KEY, UPDATED_AT,
           STORY_STATUS, SOURCE_COUNT, STATUS_NOTES, IS_READ
    FROM STORIES
    ${whereClause}
    ORDER BY UPDATED_AT DESC
    LIMIT ? OFFSET ?
  `;

  let dbOffset = Math.max(0, Number.parseInt(cursor ?? "0", 10) || 0);
  const matches: Array<ReturnType<typeof mapStory> & {
    bestChunk: { chunkIndex: number; score: number; excerpt: string } | null;
  }> = [];
  let scanned = 0;
  let hasMoreRows = true;

  while (matches.length < limit && scanned < EXACT_SCAN_MAX_CANDIDATES && hasMoreRows) {
    const batchResult = await env.STORY_DB.prepare(sql)
      .bind(...params, EXACT_SCAN_BATCH_SIZE, dbOffset)
      .all<StoryRow>();
    const rows = batchResult.results ?? [];

    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      dbOffset += 1;
      scanned += 1;
      const textObject = await env.STORY_BUCKET.get(row.R2_KEY);
      if (!textObject) {
        if (scanned >= EXACT_SCAN_MAX_CANDIDATES) {
          break;
        }
        continue;
      }

      const text = await textObject.text();
      const startIndex = text.indexOf(exactTerm);
      if (startIndex < 0) {
        if (scanned >= EXACT_SCAN_MAX_CANDIDATES) {
          break;
        }
        continue;
      }

      if (extraTerms.length > 0) {
        const lowerText = text.toLowerCase();
        const allExtrasPresent = extraTerms.every((term) => lowerText.includes(term));
        if (!allExtrasPresent) {
          if (scanned >= EXACT_SCAN_MAX_CANDIDATES) {
            break;
          }
          continue;
        }
      }

      matches.push({
        ...mapStory(row),
        bestChunk: {
          chunkIndex: 0,
          score: 1,
          excerpt: buildSnippet(text, startIndex, exactTerm.length),
        },
      });

      if (matches.length >= limit || scanned >= EXACT_SCAN_MAX_CANDIDATES) {
        break;
      }
    }

    if (rows.length < EXACT_SCAN_BATCH_SIZE) {
      hasMoreRows = false;
    }
  }

  return {
    mode: "exact" as const,
    items: matches,
    totalCandidates: undefined,
    scannedCandidates: scanned,
    nextOffset: matches.length >= limit ? dbOffset : null,
    nextCursor: hasMoreRows ? String(dbOffset) : null,
  };
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  try {
    const embeddingModel = env.CF_AI_EMBED_MODEL ?? DEFAULT_CF_AI_EMBED_MODEL;
    const body = await readJson<SearchRequestBody>(request);
    const q = body.q?.trim() ?? "";
    const filters = normalizeFilters(body.filters);
    const limit = clampLimit(body.limit);
    const offset = normalizeOffset(body.offset);
    const exactQuery = parseExactQuery(q);

    if (!q) {
      const browseResponse = await runBrowseQuery(env, filters, limit, offset);
      return json(browseResponse);
    }

    if (exactQuery !== null) {
      const exactResponse = await runExactQuery(env, exactQuery, filters, limit, body.cursor);
      return json(exactResponse);
    }

    const aiResponse = await env.AI.run(embeddingModel, { text: [q] });
    const queryVector = extractEmbedding(aiResponse);
    if (queryVector.length === 0) {
      throw new Error("Embedding vector is empty");
    }

    const vectorFilter: Record<string, string> = {};
    if (filters.genre) {
      vectorFilter.genre = filters.genre;
    }
    if (filters.tone) {
      vectorFilter.tone = filters.tone;
    }
    if (filters.statuses.length === 1) {
      vectorFilter.storyStatus = filters.statuses[0];
    }

    const topKWithAllMetadata = Math.min(
      Math.min(Math.max(limit * 5, 40), 120),
      VECTOR_MAX_TOPK_WITH_ALL_METADATA,
    );
    const vectorQuery = await env.STORY_VECTORS.query(queryVector, {
      topK: topKWithAllMetadata,
      returnMetadata: "all",
      filter: Object.keys(vectorFilter).length > 0 ? vectorFilter : undefined,
    });

    const bestByStory = new Map<string, AggregatedResult>();
    collectVectorMatches(bestByStory, (vectorQuery.matches ?? []) as VectorMatch[]);

    const topKWithIndexedMetadata = Math.min(
      Math.max(limit * 8, 80),
      VECTOR_MAX_TOPK_WITH_INDEXED_METADATA,
    );

    if (topKWithIndexedMetadata > topKWithAllMetadata && bestByStory.size < Math.max(limit, 10)) {
      const expandedVectorQuery = await env.STORY_VECTORS.query(queryVector, {
        topK: topKWithIndexedMetadata,
        returnValues: false,
        returnMetadata: "indexed",
        filter: Object.keys(vectorFilter).length > 0 ? vectorFilter : undefined,
      });
      collectVectorMatches(bestByStory, (expandedVectorQuery.matches ?? []) as VectorMatch[]);
    }

    const ranked = [...bestByStory.values()].sort((a, b) => b.score - a.score);
    const storiesById = await fetchStoriesByIds(
      env,
      ranked.map((item) => item.storyId),
    );

    const filtered = ranked
      .map((item) => {
        const story = storiesById.get(item.storyId);
        if (!story) {
          return null;
        }

        if (
          !storyHasTags(story, filters.tags) ||
          !storyMatchesStatus(story, filters.statuses) ||
          !storyMatchesReadFilter(story, filters.hideRead)
        ) {
          return null;
        }

        return {
          ...mapStory(story),
          bestChunk: {
            chunkIndex: item.chunkIndex,
            score: Number(item.score.toFixed(4)),
            excerpt: item.excerpt,
          },
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);

    const paged = filtered.slice(offset, offset + limit);

    return json({
      mode: "semantic",
      items: paged,
      totalCandidates: filtered.length,
      nextOffset: offset + limit >= filtered.length ? null : offset + limit,
    });
  } catch (error) {
    console.error("/api/search error", error);
    const message = error instanceof Error ? error.message : "Search failed";
    return errorResponse(message, 500);
  }
};
