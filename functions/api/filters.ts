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

function parseCsvParam(value: string | null): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseStatuses(value: string | null): StoryStatus[] {
  const valid = new Set<StoryStatus>([
    "OK",
    "TOO_SHORT",
    "BINARY_GARBAGE",
    "NEEDS_REVIEW",
    "PDF_SCANNED_IMAGE",
    "EXTRACTION_FAILED",
  ]);

  return parseCsvParam(value)
    .map((status) => status.toUpperCase() as StoryStatus)
    .filter((status) => valid.has(status));
}

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const requestUrl = new URL(request.url);
  const genre = requestUrl.searchParams.get("genre")?.trim() || null;
  const tone = requestUrl.searchParams.get("tone")?.trim() || null;
  const tagQuery = requestUrl.searchParams.get("tagQuery")?.trim().toLowerCase() || "";
  const selectedTags = parseCsvParam(requestUrl.searchParams.get("tags"));
  const selectedTagSet = new Set(selectedTags.map((tag) => tag.toLowerCase()));
  const excludedTags = parseCsvParam(requestUrl.searchParams.get("excludedTags")).filter(
    (tag) => !selectedTagSet.has(tag.toLowerCase()),
  );
  const statuses = parseStatuses(requestUrl.searchParams.get("statuses"));
  const hideRead = requestUrl.searchParams.get("hideRead") === "1";

  const filterClauses: string[] = [];
  const filterParams: Array<string | number> = [];

  if (genre) {
    filterClauses.push("s.GENRE = ?");
    filterParams.push(genre);
  }

  if (tone) {
    filterClauses.push("s.TONE = ?");
    filterParams.push(tone);
  }

  if (statuses.length > 0) {
    const placeholders = statuses.map(() => "?").join(",");
    filterClauses.push(`s.STORY_STATUS IN (${placeholders})`);
    filterParams.push(...statuses);
  }

  if (hideRead) {
    filterClauses.push("s.IS_READ = 0");
  }

  if (selectedTags.length > 0) {
    const normalized = selectedTags.map((tag) => tag.toLowerCase());
    const placeholders = normalized.map(() => "?").join(",");
    filterClauses.push(`
      s.STORY_ID IN (
        SELECT STORY_ID
        FROM (
          SELECT s2.STORY_ID AS STORY_ID, LOWER(TRIM(j2.value)) AS TAG
          FROM STORIES s2, json_each(COALESCE(s2.TAGS_JSON, '[]')) j2
          WHERE j2.type = 'text' AND TRIM(j2.value) != ''
          UNION
          SELECT STORY_ID, LOWER(TAG) AS TAG FROM STORY_USER_TAGS
        )
        WHERE TAG IN (${placeholders})
        GROUP BY STORY_ID
        HAVING COUNT(DISTINCT TAG) = ?
      )
    `);
    filterParams.push(...normalized, normalized.length);
  }

  if (excludedTags.length > 0) {
    const normalized = excludedTags.map((tag) => tag.toLowerCase());
    const placeholders = normalized.map(() => "?").join(",");
    filterClauses.push(`
      s.STORY_ID NOT IN (
        SELECT STORY_ID
        FROM (
          SELECT s2.STORY_ID AS STORY_ID, LOWER(TRIM(j2.value)) AS TAG
          FROM STORIES s2, json_each(COALESCE(s2.TAGS_JSON, '[]')) j2
          WHERE j2.type = 'text' AND TRIM(j2.value) != ''
          UNION
          SELECT STORY_ID, LOWER(TAG) AS TAG FROM STORY_USER_TAGS
        )
        WHERE TAG IN (${placeholders})
      )
    `);
    filterParams.push(...normalized);
  }

  const filteredWhere = filterClauses.length > 0 ? `WHERE ${filterClauses.join(" AND ")}` : "";
  const tagWhereClause = tagQuery ? "WHERE LOWER(tag) LIKE ?" : "";

  const [genresResult, tonesResult, tagsResult, statusesResult, totalStoriesResult] = await Promise.all([
    env.STORY_DB.prepare(
      "SELECT DISTINCT GENRE AS value FROM STORIES WHERE GENRE IS NOT NULL AND GENRE != '' AND LOWER(TRIM(GENRE)) != 'unknown' ORDER BY value",
    ).all<SingleValueRow>(),
    env.STORY_DB.prepare(
      "SELECT DISTINCT TONE AS value FROM STORIES WHERE TONE IS NOT NULL AND TONE != '' AND LOWER(TRIM(TONE)) != 'unknown' ORDER BY value",
    ).all<SingleValueRow>(),
    env.STORY_DB.prepare(
      `SELECT tag, count
       FROM (
         SELECT TAG AS tag, COUNT(DISTINCT STORY_ID) AS count
         FROM (
           SELECT fs.STORY_ID AS STORY_ID, TRIM(j.value) AS TAG
           FROM (
             SELECT s.STORY_ID
             FROM STORIES s
             ${filteredWhere}
           ) fs
           JOIN STORIES s ON s.STORY_ID = fs.STORY_ID
           , json_each(COALESCE(s.TAGS_JSON, '[]')) j
           WHERE j.type = 'text' AND TRIM(j.value) != ''
           UNION
           SELECT su.STORY_ID, su.TAG
           FROM STORY_USER_TAGS su
           JOIN (
             SELECT s.STORY_ID
             FROM STORIES s
             ${filteredWhere}
           ) fs ON fs.STORY_ID = su.STORY_ID
         )
         GROUP BY TAG
       )
       ${tagWhereClause}
       ORDER BY count DESC, tag ASC
       LIMIT 200`,
    )
      .bind(
        ...filterParams,
        ...filterParams,
        ...(tagQuery ? [`%${tagQuery}%`] : []),
      )
      .all<TagRow>(),
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
