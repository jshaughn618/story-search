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

interface StoryPatchBody {
  isRead?: boolean;
  addUserTag?: string;
  removeUserTag?: string;
  title?: string;
  author?: string | null;
}

interface UserTagRow {
  TAG: string;
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
             TAGS_JSON, USER_TAGS_JSON, THEMES_JSON, WORD_COUNT, R2_KEY, CHUNKS_KEY, UPDATED_AT,
             STORY_STATUS, SOURCE_COUNT, STATUS_NOTES, IS_READ
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

function normalizeUserTag(input: unknown): string | null {
  if (typeof input !== "string") {
    return null;
  }
  const normalized = input.trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized.length > 64) {
    return null;
  }
  return normalized;
}

function normalizeStoryTitle(input: unknown): string | null {
  if (typeof input !== "string") {
    return null;
  }
  const normalized = input.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 220) {
    return null;
  }
  return normalized;
}

function normalizeAuthor(input: unknown): string | null {
  if (input === null || input === undefined) {
    return null;
  }
  if (typeof input !== "string") {
    return null;
  }
  const normalized = input.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return null;
  }
  if (normalized.length > 160) {
    return null;
  }
  return normalized;
}

async function refreshStoryUserTags(env: Env, storyId: string): Promise<string[]> {
  const tagsResult = await env.STORY_DB.prepare(
    "SELECT TAG FROM STORY_USER_TAGS WHERE STORY_ID = ? ORDER BY TAG ASC",
  )
    .bind(storyId)
    .all<UserTagRow>();

  const tags = (tagsResult.results ?? []).map((row) => row.TAG);
  await env.STORY_DB.prepare("UPDATE STORIES SET USER_TAGS_JSON = ? WHERE STORY_ID = ?")
    .bind(JSON.stringify(tags), storyId)
    .run();

  return tags;
}

export const onRequestPatch: PagesFunction<Env> = async ({ env, params, request }) => {
  try {
    const storyParam = params.id;
    const storyId = typeof storyParam === "string" ? storyParam.trim() : "";
    if (!storyId) {
      return errorResponse("Missing story id", 400);
    }

    const existing = await env.STORY_DB.prepare("SELECT STORY_ID FROM STORIES WHERE STORY_ID = ?")
      .bind(storyId)
      .first<{ STORY_ID: string }>();
    if (!existing) {
      return errorResponse("Story not found", 404);
    }

    let body: StoryPatchBody = {};
    try {
      body = (await request.json()) as StoryPatchBody;
    } catch {
      return errorResponse("Invalid JSON body", 400);
    }

    const hasReadUpdate = typeof body.isRead === "boolean";
    const hasTitleUpdate = Object.prototype.hasOwnProperty.call(body, "title");
    const hasAuthorUpdate = Object.prototype.hasOwnProperty.call(body, "author");
    const addTag = normalizeUserTag(body.addUserTag);
    const removeTag = normalizeUserTag(body.removeUserTag);
    if (!hasReadUpdate && !addTag && !removeTag && !hasTitleUpdate && !hasAuthorUpdate) {
      return errorResponse("No valid changes in payload", 400);
    }

    let normalizedTitle: string | null = null;
    if (hasTitleUpdate) {
      normalizedTitle = normalizeStoryTitle(body.title);
      if (!normalizedTitle) {
        return errorResponse("Title must be 1-220 characters", 400);
      }
    }

    let normalizedAuthor: string | null = null;
    if (hasAuthorUpdate) {
      if (body.author !== null && body.author !== undefined && typeof body.author !== "string") {
        return errorResponse("Author must be a string or null", 400);
      }

      normalizedAuthor = normalizeAuthor(body.author);
      if (typeof body.author === "string" && body.author.trim() && !normalizedAuthor) {
        return errorResponse("Author must be 160 characters or fewer", 400);
      }
    }

    if (hasReadUpdate) {
      await env.STORY_DB.prepare("UPDATE STORIES SET IS_READ = ? WHERE STORY_ID = ?")
        .bind(body.isRead ? 1 : 0, storyId)
        .run();
    }

    if (hasTitleUpdate && hasAuthorUpdate) {
      await env.STORY_DB.prepare("UPDATE STORIES SET TITLE = ?, AUTHOR = ? WHERE STORY_ID = ?")
        .bind(normalizedTitle, normalizedAuthor, storyId)
        .run();
    } else if (hasTitleUpdate) {
      await env.STORY_DB.prepare("UPDATE STORIES SET TITLE = ? WHERE STORY_ID = ?")
        .bind(normalizedTitle, storyId)
        .run();
    } else if (hasAuthorUpdate) {
      await env.STORY_DB.prepare("UPDATE STORIES SET AUTHOR = ? WHERE STORY_ID = ?")
        .bind(normalizedAuthor, storyId)
        .run();
    }

    if (addTag) {
      await env.STORY_DB.prepare("INSERT OR IGNORE INTO USER_TAGS (TAG) VALUES (?)").bind(addTag).run();
      await env.STORY_DB.prepare("INSERT OR IGNORE INTO STORY_USER_TAGS (STORY_ID, TAG) VALUES (?, ?)")
        .bind(storyId, addTag)
        .run();
    }

    if (removeTag) {
      await env.STORY_DB.prepare("DELETE FROM STORY_USER_TAGS WHERE STORY_ID = ? AND TAG = ?")
        .bind(storyId, removeTag)
        .run();
    }

    if (addTag || removeTag) {
      await refreshStoryUserTags(env, storyId);
      await env.STORY_DB.prepare("DELETE FROM USER_TAGS WHERE TAG NOT IN (SELECT DISTINCT TAG FROM STORY_USER_TAGS)").run();
    }

    const updated = await env.STORY_DB.prepare(
      `
      SELECT STORY_ID, TITLE, AUTHOR, SUMMARY_SHORT, SUMMARY_LONG, GENRE, TONE, SETTING,
             TAGS_JSON, USER_TAGS_JSON, THEMES_JSON, WORD_COUNT, R2_KEY, CHUNKS_KEY, UPDATED_AT,
             STORY_STATUS, SOURCE_COUNT, STATUS_NOTES, IS_READ
      FROM STORIES
      WHERE STORY_ID = ?
    `,
    )
      .bind(storyId)
      .first<StoryRow>();

    if (!updated) {
      return errorResponse("Story not found", 404);
    }

    return json({
      ok: true,
      story: mapStory(updated),
    });
  } catch (error) {
    console.error("/api/story/:id patch error", error);
    const message = error instanceof Error ? error.message : "Failed to update story";
    return errorResponse(message, 500);
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
    await runDeleteIfTableExists(env, "DELETE FROM STORY_USER_TAGS WHERE STORY_ID = ?", storyId);
    await runDeleteIfTableExists(env, "DELETE FROM STORY_TEXT WHERE STORY_ID = ?", storyId);
    await env.STORY_DB.prepare("DELETE FROM STORIES WHERE STORY_ID = ?").bind(storyId).run();
    await env.STORY_DB.prepare("DELETE FROM TAGS WHERE TAG NOT IN (SELECT DISTINCT TAG FROM STORY_TAGS)").run();
    try {
      await env.STORY_DB.prepare(
        "DELETE FROM USER_TAGS WHERE TAG NOT IN (SELECT DISTINCT TAG FROM STORY_USER_TAGS)",
      ).run();
    } catch (error) {
      if (!(error instanceof Error) || !error.message.toLowerCase().includes("no such table")) {
        throw error;
      }
    }

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
