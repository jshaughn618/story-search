import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ApiError, fetchStory, updateStory } from "../lib/api";
import {
  defaultReaderPreferences,
  loadReaderPreferences,
  saveReaderPreferences,
} from "../lib/readerPrefs";
import type { ReaderLineHeight, ReaderPreferences, ReaderTheme, ReaderWidth, StoryDetailResponse } from "../types";

interface ParagraphBlock {
  text: string;
  startChar: number;
  endChar: number;
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

      {toast ? <div className="toast">{toast}</div> : null}
    </main>
  );
}
