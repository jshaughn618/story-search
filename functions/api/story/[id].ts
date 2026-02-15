import { errorResponse, json } from "../../_lib/http";
import { mapStory } from "../../_lib/story";
import type { ChunkMapItem, Env, StoryRow } from "../../_lib/types";

interface StoryDeleteRow {
  STORY_ID: string;
  R2_KEY: string;
  CHUNKS_KEY: string | null;
  CHUNK_COUNT: number | null;
}

interface VectorMatchId {
  id: string;
}

const VECTOR_DELETE_BATCH_SIZE = 500;
const VECTOR_QUERY_TOP_K = 50;
const VECTOR_CLEANUP_MAX_PASSES = 200;

async function runDeleteIfTableExists(env: Env, sql: string, storyId: string): Promise<void> {
  try {
    await env.STORY_DB.prepare(sql).bind(storyId).run();
  } catch (error) {
    if (error instanceof Error && error.message.toLowerCase().includes("no such table")) {
      return;
    }
    throw error;
  }
}

async function resolveVectorDimensions(env: Env): Promise<number | null> {
  try {
    const indexInfo = (await env.STORY_VECTORS.describe()) as {
      dimensions?: number;
      config?: { dimensions?: number };
    };

    if (typeof indexInfo.dimensions === "number" && indexInfo.dimensions > 0) {
      return indexInfo.dimensions;
    }

    if (typeof indexInfo.config?.dimensions === "number" && indexInfo.config.dimensions > 0) {
      return indexInfo.config.dimensions;
    }

    return null;
  } catch (error) {
    console.warn("Could not determine Vectorize dimensions", error);
    return null;
  }
}

async function deleteKnownChunkVectors(env: Env, storyId: string, chunkCount: number): Promise<number> {
  if (chunkCount <= 0) {
    return 0;
  }

  let deleted = 0;
  for (let start = 0; start < chunkCount; start += VECTOR_DELETE_BATCH_SIZE) {
    const end = Math.min(start + VECTOR_DELETE_BATCH_SIZE, chunkCount);
    const ids: string[] = [];

    for (let index = start; index < end; index += 1) {
      ids.push(`${storyId}:${String(index).padStart(5, "0")}`);
    }

    await env.STORY_VECTORS.deleteByIds(ids);
    deleted += ids.length;
  }

  return deleted;
}

async function cleanupRemainingStoryVectors(env: Env, storyId: string): Promise<number> {
  const dimensions = await resolveVectorDimensions(env);
  if (!dimensions || dimensions <= 0) {
    return 0;
  }

  const probeVector = new Array<number>(dimensions).fill(0);
  let deleted = 0;

  for (let pass = 0; pass < VECTOR_CLEANUP_MAX_PASSES; pass += 1) {
    const result = await env.STORY_VECTORS.query(probeVector, {
      topK: VECTOR_QUERY_TOP_K,
      returnValues: false,
      returnMetadata: "indexed",
      filter: { storyId },
    });

    const ids = [...new Set(((result.matches ?? []) as VectorMatchId[]).map((match) => match.id).filter(Boolean))];
    if (ids.length === 0) {
      break;
    }

    await env.STORY_VECTORS.deleteByIds(ids);
    deleted += ids.length;
  }

  return deleted;
}

async function deleteStoryR2Objects(env: Env, story: StoryDeleteRow): Promise<number> {
  let deleted = 0;

  const keys = [story.R2_KEY, story.CHUNKS_KEY].filter((value): value is string => Boolean(value));
  if (keys.length > 0) {
    await env.STORY_BUCKET.delete(keys);
    deleted += keys.length;
  }

  const originalPrefix = `sources/original/${story.STORY_ID}/`;
  let cursor: string | undefined;

  do {
    const listed = await env.STORY_BUCKET.list({ prefix: originalPrefix, cursor });
    const originalKeys = listed.objects.map((object) => object.key);
    if (originalKeys.length > 0) {
      await env.STORY_BUCKET.delete(originalKeys);
      deleted += originalKeys.length;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return deleted;
}

export const onRequestGet: PagesFunction<Env> = async ({ env, params, request }) => {
  try {
    const storyParam = params.id;
    const storyId = typeof storyParam === "string" ? storyParam.trim() : "";
    if (!storyId) {
      return errorResponse("Missing story id", 400);
    }

    const dbResult = await env.STORY_DB.prepare(
      `
      SELECT STORY_ID, TITLE, AUTHOR, SUMMARY_SHORT, SUMMARY_LONG, GENRE, TONE, SETTING,
             TAGS_JSON, THEMES_JSON, WORD_COUNT, R2_KEY, CHUNKS_KEY, UPDATED_AT,
             STORY_STATUS, SOURCE_COUNT, STATUS_NOTES
      FROM STORIES
      WHERE STORY_ID = ?
    `,
    )
      .bind(storyId)
      .first<StoryRow>();

    if (!dbResult) {
      return errorResponse("Story not found", 404);
    }

    const storyObject = await env.STORY_BUCKET.get(dbResult.R2_KEY);
    if (!storyObject) {
      return errorResponse("Story text missing in R2", 404);
    }

    const text = await storyObject.text();

    let chunks: ChunkMapItem[] = [];
    if (dbResult.CHUNKS_KEY) {
      const chunksObject = await env.STORY_BUCKET.get(dbResult.CHUNKS_KEY);
      if (chunksObject) {
        try {
          const parsed = await chunksObject.json<ChunkMapItem[]>();
          if (Array.isArray(parsed)) {
            chunks = parsed;
          }
        } catch {
          chunks = [];
        }
      }
    }

    const url = new URL(request.url);
    const chunkParam = url.searchParams.get("chunk");
    const chunkIndex = chunkParam ? Number.parseInt(chunkParam, 10) : Number.NaN;
    const anchor = Number.isNaN(chunkIndex)
      ? null
      : chunks.find((chunk) => chunk.chunkIndex === chunkIndex) ?? null;

    return json({
      story: mapStory(dbResult),
      text,
      chunks,
      anchor,
    });
  } catch (error) {
    console.error("/api/story/:id error", error);
    return errorResponse("Failed to load story", 500);
  }
};

export const onRequestDelete: PagesFunction<Env> = async ({ env, params }) => {
  try {
    const storyParam = params.id;
    const storyId = typeof storyParam === "string" ? storyParam.trim() : "";
    if (!storyId) {
      return errorResponse("Missing story id", 400);
    }

    const story = await env.STORY_DB.prepare(
      `
      SELECT STORY_ID, R2_KEY, CHUNKS_KEY, CHUNK_COUNT
      FROM STORIES
      WHERE STORY_ID = ?
    `,
    )
      .bind(storyId)
      .first<StoryDeleteRow>();

    if (!story) {
      return errorResponse("Story not found", 404);
    }

    const chunkCount = Math.max(0, story.CHUNK_COUNT ?? 0);
    await deleteKnownChunkVectors(env, storyId, chunkCount);
    await cleanupRemainingStoryVectors(env, storyId);
    await deleteStoryR2Objects(env, story);

    await runDeleteIfTableExists(env, "DELETE FROM STORY_SOURCES WHERE STORY_ID = ?", storyId);
    await runDeleteIfTableExists(env, "DELETE FROM STORY_TAGS WHERE STORY_ID = ?", storyId);
    await env.STORY_DB.prepare("DELETE FROM STORIES WHERE STORY_ID = ?").bind(storyId).run();
    await env.STORY_DB.prepare("DELETE FROM TAGS WHERE TAG NOT IN (SELECT DISTINCT TAG FROM STORY_TAGS)").run();

    return json({
      ok: true,
      storyId,
    });
  } catch (error) {
    console.error("/api/story/:id delete error", error);
    const message = error instanceof Error ? error.message : "Failed to delete story";
    return errorResponse(message, 500);
  }
};
