export interface StoryBookmark {
  id: string;
  startChar: number;
  excerpt: string;
  createdAt: string;
}

const STORAGE_KEY = "story-library-reader-bookmarks";
const MAX_BOOKMARKS_PER_STORY = 200;
const MAX_EXCERPT_LENGTH = 140;

function parseStore(): Record<string, StoryBookmark[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    const output: Record<string, StoryBookmark[]> = {};
    for (const [storyId, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) {
        continue;
      }

      const bookmarks: StoryBookmark[] = [];
      for (const item of value) {
        if (!item || typeof item !== "object") {
          continue;
        }
        const candidate = item as Partial<StoryBookmark>;
        if (typeof candidate.id !== "string" || !candidate.id) {
          continue;
        }
        if (typeof candidate.startChar !== "number" || !Number.isFinite(candidate.startChar)) {
          continue;
        }
        if (typeof candidate.createdAt !== "string" || !candidate.createdAt) {
          continue;
        }

        const excerpt =
          typeof candidate.excerpt === "string"
            ? candidate.excerpt.replace(/\s+/g, " ").trim().slice(0, MAX_EXCERPT_LENGTH)
            : "";

        bookmarks.push({
          id: candidate.id,
          startChar: Math.max(0, Math.floor(candidate.startChar)),
          excerpt,
          createdAt: candidate.createdAt,
        });
      }

      if (bookmarks.length > 0) {
        output[storyId] = bookmarks.sort((a, b) => a.startChar - b.startChar).slice(0, MAX_BOOKMARKS_PER_STORY);
      }
    }

    return output;
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, StoryBookmark[]>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

export function loadStoryBookmarks(storyId: string): StoryBookmark[] {
  const store = parseStore();
  return store[storyId] ?? [];
}

export function saveStoryBookmarks(storyId: string, bookmarks: StoryBookmark[]) {
  const store = parseStore();
  store[storyId] = bookmarks
    .filter((bookmark) => bookmark.id && Number.isFinite(bookmark.startChar))
    .sort((a, b) => a.startChar - b.startChar)
    .slice(0, MAX_BOOKMARKS_PER_STORY);
  writeStore(store);
}
