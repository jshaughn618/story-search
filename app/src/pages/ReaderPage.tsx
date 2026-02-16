import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ApiError, fetchStory, updateStory } from "../lib/api";
import { loadStoryBookmarks, saveStoryBookmarks } from "../lib/bookmarks";
import {
  defaultReaderPreferences,
  loadReaderPreferences,
  saveReaderPreferences,
} from "../lib/readerPrefs";
import type { ReaderLineHeight, ReaderPreferences, ReaderTheme, ReaderWidth, StoryDetailResponse } from "../types";
import type { StoryBookmark } from "../lib/bookmarks";

interface ParagraphBlock {
  text: string;
  startChar: number;
  endChar: number;
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

export function ReaderPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();

  const chunkParam = searchParams.get("chunk");
  const chunkIndex = chunkParam ? Number.parseInt(chunkParam, 10) : Number.NaN;

  const [data, setData] = useState<StoryDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [highlightedParagraph, setHighlightedParagraph] = useState<number | null>(null);
  const [updatingRead, setUpdatingRead] = useState(false);
  const [updatingTags, setUpdatingTags] = useState(false);
  const [bookmarks, setBookmarks] = useState<StoryBookmark[]>([]);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [currentParagraphIndex, setCurrentParagraphIndex] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<ReaderPreferences>(() => {
    if (typeof window === "undefined") {
      return defaultReaderPreferences;
    }
    return loadReaderPreferences();
  });

  const paragraphRefs = useRef<Map<number, HTMLParagraphElement>>(new Map());

  useEffect(() => {
    if (!id) {
      setError("Missing story id");
      setLoading(false);
      return;
    }

    const run = async () => {
      setLoading(true);
      setError(null);
      setNotFound(false);

      try {
        const response = await fetchStory(id, Number.isNaN(chunkIndex) ? null : chunkIndex);
        setData(response);
      } catch (fetchError) {
        if (fetchError instanceof ApiError && fetchError.status === 404) {
          setNotFound(true);
          setData(null);
        } else {
          setError(fetchError instanceof Error ? fetchError.message : "Failed to load story");
        }
      } finally {
        setLoading(false);
      }
    };

    void run();
  }, [id, chunkIndex]);

  useEffect(() => {
    saveReaderPreferences(preferences);
  }, [preferences]);

  useEffect(() => {
    if (!id) {
      setBookmarks([]);
      return;
    }
    setBookmarks(loadStoryBookmarks(id));
  }, [id]);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timeout = window.setTimeout(() => {
      setToast(null);
    }, 2400);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [toast]);

  const paragraphs = useMemo<ParagraphBlock[]>(() => {
    if (!data?.text) {
      return [];
    }

    const blocks = data.text
      .split(/\n{2,}/)
      .map((text) => text.trim())
      .filter(Boolean);

    let cursor = 0;
    return blocks.map((text) => {
      const startChar = data.text.indexOf(text, cursor);
      const endChar = startChar + text.length;
      cursor = endChar;
      return { text, startChar, endChar };
    });
  }, [data]);

  const anchorParagraph = useMemo(() => {
    const anchorStart = data?.anchor?.startChar;
    if (anchorStart === undefined || anchorStart === null) {
      return null;
    }

    const index = paragraphs.findIndex(
      (paragraph) => anchorStart >= paragraph.startChar && anchorStart <= paragraph.endChar,
    );
    return index >= 0 ? index : null;
  }, [data, paragraphs]);

  useEffect(() => {
    if (anchorParagraph === null) {
      return;
    }

    const target = paragraphRefs.current.get(anchorParagraph);
    if (!target) {
      return;
    }

    target.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightedParagraph(anchorParagraph);

    const timeout = window.setTimeout(() => {
      setHighlightedParagraph(null);
    }, 1800);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [anchorParagraph, paragraphs]);

  useEffect(() => {
    if (paragraphs.length === 0) {
      setCurrentParagraphIndex(null);
      setScrollProgress(0);
      return;
    }

    let frame = 0;

    const syncFromScroll = () => {
      const doc = document.documentElement;
      const scrollable = doc.scrollHeight - window.innerHeight;
      const ratio = scrollable > 0 ? clamp01(window.scrollY / scrollable) : 0;
      setScrollProgress(ratio);

      const viewportCenter = window.scrollY + window.innerHeight * 0.5;
      let nearestIndex = 0;
      let nearestDistance = Number.POSITIVE_INFINITY;

      paragraphs.forEach((_, index) => {
        const node = paragraphRefs.current.get(index);
        if (!node) {
          return;
        }
        const midpoint = node.offsetTop + node.offsetHeight * 0.5;
        const distance = Math.abs(midpoint - viewportCenter);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestIndex = index;
        }
      });

      setCurrentParagraphIndex(nearestIndex);
    };

    const queueSync = () => {
      if (frame) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        syncFromScroll();
      });
    };

    queueSync();
    window.addEventListener("scroll", queueSync, { passive: true });
    window.addEventListener("resize", queueSync);

    return () => {
      window.removeEventListener("scroll", queueSync);
      window.removeEventListener("resize", queueSync);
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [paragraphs]);

  const updateTheme = (theme: ReaderTheme) => setPreferences((current) => ({ ...current, theme }));
  const updateWidth = (width: ReaderWidth) => setPreferences((current) => ({ ...current, width }));
  const updateLineHeight = (lineHeight: ReaderLineHeight) =>
    setPreferences((current) => ({ ...current, lineHeight }));

  const toggleRead = async () => {
    if (!id || !data || updatingRead) {
      return;
    }

    const previous = data.story.isRead;
    setData((current) =>
      current
        ? {
            ...current,
            story: {
              ...current.story,
              isRead: !previous,
            },
          }
        : current,
    );
    setUpdatingRead(true);

    try {
      const response = await updateStory(id, { isRead: !previous });
      setData((current) =>
        current
          ? {
              ...current,
              story: {
                ...current.story,
                isRead: response.story.isRead,
              },
            }
          : current,
      );
      setToast(response.story.isRead ? "Marked as read." : "Marked as unread.");
    } catch (updateError) {
      setData((current) =>
        current
          ? {
              ...current,
              story: {
                ...current.story,
                isRead: previous,
              },
            }
          : current,
      );
      const message = updateError instanceof Error ? updateError.message : "Failed to update read state";
      setToast(`Update failed: ${message}`);
    } finally {
      setUpdatingRead(false);
    }
  };

  const addUserTag = async () => {
    if (!id || !data || updatingTags) {
      return;
    }
    const input = window.prompt(`Add a custom tag for "${data.story.title}"`);
    if (!input) {
      return;
    }
    const newTag = input.trim();
    if (!newTag) {
      return;
    }

    setUpdatingTags(true);
    try {
      const response = await updateStory(id, { addUserTag: newTag });
      setData((current) =>
        current
          ? {
              ...current,
              story: {
                ...current.story,
                tags: response.story.tags,
                userTags: response.story.userTags,
              },
            }
          : current,
      );
      setToast("Tag added.");
    } catch (updateError) {
      const message = updateError instanceof Error ? updateError.message : "Failed to add tag";
      setToast(`Tag update failed: ${message}`);
    } finally {
      setUpdatingTags(false);
    }
  };

  const removeUserTag = async (tag: string) => {
    if (!id || !data || updatingTags) {
      return;
    }

    setUpdatingTags(true);
    try {
      const response = await updateStory(id, { removeUserTag: tag });
      setData((current) =>
        current
          ? {
              ...current,
              story: {
                ...current.story,
                tags: response.story.tags,
                userTags: response.story.userTags,
              },
            }
          : current,
      );
      setToast("Tag removed.");
    } catch (updateError) {
      const message = updateError instanceof Error ? updateError.message : "Failed to remove tag";
      setToast(`Tag update failed: ${message}`);
    } finally {
      setUpdatingTags(false);
    }
  };

  const addBookmarkAtScroll = async () => {
    if (!id || !data || paragraphs.length === 0) {
      return;
    }

    const paragraphIndex = currentParagraphIndex ?? 0;
    const paragraph = paragraphs[paragraphIndex];
    if (!paragraph) {
      return;
    }

    if (bookmarks.some((bookmark) => bookmark.startChar === paragraph.startChar)) {
      setToast("Bookmark already exists here.");
      return;
    }

    const newBookmark: StoryBookmark = {
      id: `bm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      startChar: paragraph.startChar,
      excerpt: paragraph.text.replace(/\s+/g, " ").trim().slice(0, 120),
      createdAt: new Date().toISOString(),
    };

    const nextBookmarks = [...bookmarks, newBookmark].sort((a, b) => a.startChar - b.startChar);
    setBookmarks(nextBookmarks);
    saveStoryBookmarks(id, nextBookmarks);
    try {
      const response = await updateStory(id, { addUserTag: "Bookmarked" });
      setData((current) =>
        current
          ? {
              ...current,
              story: {
                ...current.story,
                tags: response.story.tags,
                userTags: response.story.userTags,
              },
            }
          : current,
      );
      setToast("Bookmark added.");
    } catch (updateError) {
      const message = updateError instanceof Error ? updateError.message : "Failed to tag story";
      setToast(`Bookmark added, but tag update failed: ${message}`);
    }
  };

  const scrollToBookmark = (bookmark: StoryBookmark) => {
    const paragraphIndex = paragraphs.findIndex(
      (paragraph) => bookmark.startChar >= paragraph.startChar && bookmark.startChar <= paragraph.endChar,
    );

    if (paragraphIndex >= 0) {
      const node = paragraphRefs.current.get(paragraphIndex);
      if (node) {
        node.scrollIntoView({ behavior: "smooth", block: "center" });
        setHighlightedParagraph(paragraphIndex);
        window.setTimeout(() => setHighlightedParagraph(null), 1600);
        return;
      }
    }

    const textLength = data?.text.length ?? 0;
    const ratio = textLength > 0 ? clamp01(bookmark.startChar / textLength) : 0;
    const scrollable = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo({
      top: Math.max(0, scrollable * ratio),
      behavior: "smooth",
    });
  };

  const bookmarkMarkers = useMemo(() => {
    if (!data?.text) {
      return [];
    }
    const textLength = Math.max(1, data.text.length);
    return bookmarks.map((bookmark) => ({
      ...bookmark,
      ratio: clamp01(bookmark.startChar / textLength),
    }));
  }, [bookmarks, data?.text]);

  const style = {
    "--reader-font-size": `${preferences.fontSize}px`,
  } as CSSProperties;

  const backTo = (location.state as { from?: string } | null)?.from;
  const readerMetaParts = [
    data?.story.genre && data.story.genre.trim().toLowerCase() !== "unknown" ? data.story.genre : null,
    data?.story.tone && data.story.tone.trim().toLowerCase() !== "unknown" ? data.story.tone : null,
    data ? `${data.story.wordCount} words` : null,
  ].filter((value): value is string => Boolean(value));

  if (loading) {
    return <main className="reader-page">Loading story...</main>;
  }

  if (notFound) {
    return (
      <main className="reader-page">
        <section className="reader-not-found">
          <h1>Story not found</h1>
          <p>This story may have been deleted or is no longer available.</p>
          <button type="button" onClick={() => navigate("/")}>
            Back to library
          </button>
        </section>
      </main>
    );
  }

  if (error || !data) {
    return <main className="reader-page error-banner">{error || "Story not found"}</main>;
  }

  return (
    <main className={`reader-page theme-${preferences.theme}`} style={style}>
      <header className="reader-toolbar">
        <div className="reader-toolbar-actions">
          <button type="button" onClick={() => (backTo ? navigate(backTo) : navigate(-1))}>
            Back to results
          </button>
          <button type="button" onClick={toggleRead} disabled={updatingRead}>
            {updatingRead ? "Updating..." : data.story.isRead ? "Mark unread" : "Mark read"}
          </button>
          <button type="button" onClick={addUserTag} disabled={updatingTags}>
            {updatingTags ? "Updating..." : "Add tag"}
          </button>
        </div>

        <div className="reader-controls">
          <label>
            Font
            <input
              type="range"
              min={14}
              max={34}
              step={1}
              value={preferences.fontSize}
              onChange={(event) =>
                setPreferences((current) => ({ ...current, fontSize: Number(event.target.value) }))
              }
            />
          </label>

          <label>
            Line Height
            <select
              value={preferences.lineHeight}
              onChange={(event) => updateLineHeight(event.target.value as ReaderLineHeight)}
            >
              <option value="compact">Compact</option>
              <option value="normal">Normal</option>
              <option value="relaxed">Relaxed</option>
            </select>
          </label>

          <label>
            Width
            <select value={preferences.width} onChange={(event) => updateWidth(event.target.value as ReaderWidth)}>
              <option value="narrow">Narrow</option>
              <option value="medium">Medium</option>
              <option value="wide">Wide</option>
            </select>
          </label>

          <label>
            Theme
            <select value={preferences.theme} onChange={(event) => updateTheme(event.target.value as ReaderTheme)}>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
              <option value="sepia">Sepia</option>
            </select>
          </label>
        </div>
      </header>

      <section className="reader-meta">
        <h1>
          {data.story.title}
          <span className={`reader-status-badge ${data.story.isRead ? "is-read" : "is-unread"}`}>
            {data.story.isRead ? "Read" : "Unread"}
          </span>
        </h1>
        <p>{readerMetaParts.join(" • ")}</p>
        <div className="reader-tags">
          {data.story.tags.slice(0, 8).map((tag) => (
            <span key={tag} className="tag-pill">
              {tag}
            </span>
          ))}
          {data.story.userTags.map((tag) => (
            <button
              key={`reader-user-${data.story.storyId}-${tag}`}
              type="button"
              className="tag-pill"
              onClick={() => void removeUserTag(tag)}
              title="Remove custom tag"
              disabled={updatingTags}
            >
              {tag} ×
            </button>
          ))}
        </div>
      </section>

      <article className={`reader-body width-${preferences.width} line-${preferences.lineHeight}`}>
        {paragraphs.map((paragraph, index) => {
          const highlighted = highlightedParagraph === index;
          return (
            <p
              key={`${paragraph.startChar}-${paragraph.endChar}`}
              ref={(node) => {
                if (node) {
                  paragraphRefs.current.set(index, node);
                } else {
                  paragraphRefs.current.delete(index);
                }
              }}
              className={highlighted ? "highlight" : ""}
            >
              {paragraph.text}
            </p>
          );
        })}
      </article>

      <aside className="reader-scroll-rail" aria-label="Story bookmarks">
        <button
          type="button"
          className="reader-bookmark-arrow"
          title="Add bookmark near current scroll position"
          onClick={() => void addBookmarkAtScroll()}
          style={{ top: `calc(${scrollProgress * 100}% - 14px)` }}
        >
          &gt;
        </button>
        {bookmarkMarkers.map((bookmark) => (
          <button
            key={bookmark.id}
            type="button"
            className="reader-bookmark-marker"
            style={{ top: `calc(${bookmark.ratio * 100}% - 4px)` }}
            title={bookmark.excerpt ? `Bookmark: ${bookmark.excerpt}` : "Bookmark"}
            onClick={() => scrollToBookmark(bookmark)}
          />
        ))}
      </aside>

      {toast ? <div className="toast">{toast}</div> : null}
    </main>
  );
}
