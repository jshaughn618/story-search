import { errorResponse, json } from "../../_lib/http";
import { mapStory } from "../../_lib/story";
import type { ChunkMapItem, Env, StoryRow } from "../../_lib/types";

export const onRequestGet: PagesFunction<Env> = async ({ env, params, request }) => {
  try {
    const storyParam = params.id;
    const storyId = typeof storyParam === "string" ? storyParam.trim() : "";
    if (!storyId) {
      return errorResponse("Missing story id", 400);
    }

    const dbResult = await env.STORY_DB.prepare(
      `
      SELECT STORY_ID, TITLE, SUMMARY_SHORT, SUMMARY_LONG, GENRE, TONE, SETTING,
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
