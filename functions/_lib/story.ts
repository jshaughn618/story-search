import type { StoryRow } from "./types";

export function parseStringArray(jsonString: string | null | undefined): string[] {
  if (!jsonString) {
    return [];
  }

  try {
    const parsed = JSON.parse(jsonString);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function mapStory(row: StoryRow) {
  return {
    storyId: row.STORY_ID,
    title: row.TITLE,
    author: row.AUTHOR,
    summaryShort: row.SUMMARY_SHORT,
    summaryLong: row.SUMMARY_LONG,
    genre: row.GENRE,
    tone: row.TONE,
    setting: row.SETTING,
    tags: parseStringArray(row.TAGS_JSON),
    themes: parseStringArray(row.THEMES_JSON),
    wordCount: row.WORD_COUNT,
    updatedAt: row.UPDATED_AT,
    storyStatus: row.STORY_STATUS,
    sourceCount: row.SOURCE_COUNT,
    statusNotes: row.STATUS_NOTES,
  };
}
