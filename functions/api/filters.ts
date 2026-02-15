import { json } from "../_lib/http";
import type { Env, StoryStatus } from "../_lib/types";

interface SingleValueRow {
  value: string;
}

interface TagRow {
  tag: string;
  count: number;
}

interface StatusRow {
  status: StoryStatus;
  count: number;
}

interface CountRow {
  count: number;
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const [genresResult, tonesResult, tagsResult, statusesResult, totalStoriesResult] = await Promise.all([
    env.STORY_DB.prepare(
      "SELECT DISTINCT GENRE AS value FROM STORIES WHERE GENRE IS NOT NULL AND GENRE != '' AND LOWER(TRIM(GENRE)) != 'unknown' ORDER BY value",
    ).all<SingleValueRow>(),
    env.STORY_DB.prepare(
      "SELECT DISTINCT TONE AS value FROM STORIES WHERE TONE IS NOT NULL AND TONE != '' AND LOWER(TRIM(TONE)) != 'unknown' ORDER BY value",
    ).all<SingleValueRow>(),
    env.STORY_DB.prepare(
      `SELECT TAG AS tag, COUNT(DISTINCT STORY_ID) AS count
       FROM (
         SELECT STORY_ID, TAG FROM STORY_TAGS
         UNION
         SELECT STORY_ID, TAG FROM STORY_USER_TAGS
       )
       GROUP BY TAG
       ORDER BY count DESC, tag ASC
       LIMIT 200`,
    ).all<TagRow>(),
    env.STORY_DB.prepare(
      "SELECT STORY_STATUS AS status, COUNT(*) AS count FROM STORIES GROUP BY STORY_STATUS ORDER BY count DESC, status ASC",
    ).all<StatusRow>(),
    env.STORY_DB.prepare("SELECT COUNT(*) AS count FROM STORIES").first<CountRow>(),
  ]);

  return json({
    genres: (genresResult.results ?? []).map((row) => row.value),
    tones: (tonesResult.results ?? []).map((row) => row.value),
    tags: (tagsResult.results ?? []).map((row) => ({ tag: row.tag, count: row.count })),
    statuses: (statusesResult.results ?? []).map((row) => ({ status: row.status, count: row.count })),
    totalStories: totalStoriesResult?.count ?? 0,
  });
};
