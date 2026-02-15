import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { deleteStory, fetchFilters, searchStories } from "../lib/api";
import type { FiltersResponse, SearchResponse, StoryResult, StoryStatus } from "../types";

const PAGE_SIZE = 20;
const DELETE_CONFIRM_TOKEN = "DELETE";

type StatusFilterValue = StoryStatus | "ALL";

const emptyFilters: FiltersResponse = {
  genres: [],
  tones: [],
  tags: [],
  statuses: [],
};

const statusLabel: Record<StatusFilterValue, string> = {
  ALL: "All statuses",
  OK: "OK only",
  TOO_SHORT: "Too short",
  BINARY_GARBAGE: "Binary garbage",
  NEEDS_REVIEW: "Needs review",
  PDF_SCANNED_IMAGE: "PDF scanned image",
  EXTRACTION_FAILED: "Extraction failed",
};

export function LibraryPage() {
  const location = useLocation();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [filters, setFilters] = useState<FiltersResponse>(emptyFilters);
  const [query, setQuery] = useState("");
  const [genre, setGenre] = useState<string>("");
  const [tone, setTone] = useState<string>("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>("OK");
  const [results, setResults] = useState<StoryResult[]>([]);
  const [mode, setMode] = useState<SearchResponse["mode"]>("browse");
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [totalCandidates, setTotalCandidates] = useState<number | undefined>(undefined);
  const [debugScores, setDebugScores] = useState(false);
  const [openMenuStoryId, setOpenMenuStoryId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<StoryResult | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deletingStoryId, setDeletingStoryId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeFilters = useMemo(() => {
    const statusActive = statusFilter === "ALL" ? 0 : 1;
    return [genre, tone, ...selectedTags].filter(Boolean).length + statusActive;
  }, [genre, tone, selectedTags, statusFilter]);

  const runSearch = async (next = 0) => {
    setLoading(true);
    setError(null);

    try {
      const response = await searchStories({
        q: query,
        filters: {
          genre: genre || null,
          tone: tone || null,
          tags: selectedTags,
          statuses: statusFilter === "ALL" ? [] : [statusFilter],
        },
        limit: PAGE_SIZE,
        offset: next,
      });

      setResults(response.items);
      setMode(response.mode);
      setOffset(next);
      setNextOffset(response.nextOffset);
      setTotalCandidates(response.totalCandidates);
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : "Search failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const init = async () => {
      try {
        const response = await fetchFilters();
        setFilters(response);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Failed to load filters");
      }
      await runSearch(0);
    };

    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void runSearch(0);
  };

  const toggleTag = (tag: string) => {
    setSelectedTags((current) =>
      current.includes(tag) ? current.filter((value) => value !== tag) : [...current, tag],
    );
  };

  const clearFilters = () => {
    setGenre("");
    setTone("");
    setSelectedTags([]);
    setStatusFilter("OK");
  };

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timeout = window.setTimeout(() => {
      setToast(null);
    }, 3200);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [toast]);

  useEffect(() => {
    if (!openMenuStoryId) {
      return;
    }

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current && !menuRef.current.contains(target)) {
        setOpenMenuStoryId(null);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenMenuStoryId(null);
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenuStoryId]);

  useEffect(() => {
    if (!deleteTarget) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeDeleteDialog();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [deleteTarget, deletingStoryId]);

  const openDeleteDialog = (story: StoryResult) => {
    setDeleteTarget(story);
    setDeleteConfirmText("");
    setOpenMenuStoryId(null);
  };

  const closeDeleteDialog = () => {
    if (deletingStoryId) {
      return;
    }
    setDeleteTarget(null);
    setDeleteConfirmText("");
  };

  const confirmDelete = async () => {
    if (!deleteTarget || deletingStoryId) {
      return;
    }

    const storyId = deleteTarget.storyId;
    const previousResults = results;
    const previousTotalCandidates = totalCandidates;

    setDeletingStoryId(storyId);
    setResults((current) => current.filter((item) => item.storyId !== storyId));
    setTotalCandidates((current) =>
      typeof current === "number" ? Math.max(0, current - 1) : current,
    );

    try {
      await deleteStory(storyId);
      setToast("Story deleted.");
      setDeleteTarget(null);
      setDeleteConfirmText("");
    } catch (deleteError) {
      setResults(previousResults);
      setTotalCandidates(previousTotalCandidates);
      const message = deleteError instanceof Error ? deleteError.message : "Failed to delete story";
      setToast(`Delete failed: ${message}`);
    } finally {
      setDeletingStoryId(null);
    }
  };

  return (
    <main className="library-page">
      <section className="hero">
        <h1>Story Library</h1>
        <p>Semantic search + metadata browse for your indexed corpus.</p>
      </section>

      <section className="search-panel">
        <form onSubmit={onSubmit} className="search-form">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Ask for what you want to read..."
            aria-label="Search stories"
          />
          <button type="submit" disabled={loading}>
            {loading ? "Searching..." : "Search"}
          </button>
        </form>

        <div className="filter-row">
          <label>
            Genre
            <select value={genre} onChange={(event) => setGenre(event.target.value)}>
              <option value="">All</option>
              {filters.genres.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>

          <label>
            Tone
            <select value={tone} onChange={(event) => setTone(event.target.value)}>
              <option value="">All</option>
              {filters.tones.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>

          <label>
            Status
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as StatusFilterValue)}
            >
              <option value="OK">OK only</option>
              <option value="ALL">All statuses</option>
              {filters.statuses
                .map((item) => item.status)
                .filter((status) => status !== "OK")
                .map((status) => (
                  <option key={status} value={status}>
                    {statusLabel[status]}
                  </option>
                ))}
            </select>
          </label>

          <button type="button" onClick={clearFilters} className="ghost">
            Clear Filters
          </button>

          <label className="checkbox-inline">
            <input
              type="checkbox"
              checked={debugScores}
              onChange={(event) => setDebugScores(event.target.checked)}
            />
            Show debug
          </label>
        </div>

        <div className="tag-cloud">
          {filters.tags.slice(0, 30).map((tagInfo) => {
            const selected = selectedTags.includes(tagInfo.tag);
            return (
              <button
                key={tagInfo.tag}
                className={selected ? "tag-chip selected" : "tag-chip"}
                onClick={() => toggleTag(tagInfo.tag)}
                type="button"
              >
                {tagInfo.tag} <span>{tagInfo.count}</span>
              </button>
            );
          })}
        </div>

        <div className="results-meta">
          <span>
            {mode === "semantic" ? "Semantic results" : "Metadata browse"} • page offset {offset}
          </span>
          <span>
            {results.length} results {totalCandidates ? `(from ${totalCandidates} ranked matches)` : ""}
            {activeFilters > 0 ? ` • ${activeFilters} filters` : ""}
          </span>
        </div>
      </section>

      {error ? <p className="error-banner">{error}</p> : null}

      <section className="results-list">
        {results.length === 0 && !loading ? <p>No stories matched this query.</p> : null}

        {results.map((story) => {
          const chunkQuery = story.bestChunk ? `?chunk=${story.bestChunk.chunkIndex}` : "";
          const menuOpen = openMenuStoryId === story.storyId;
          const deleting = deletingStoryId === story.storyId;
          return (
            <article key={story.storyId} className="story-card">
              <header className="story-head">
                <div className="story-head-main">
                  <h2>
                    <Link
                      to={`/story/${story.storyId}${chunkQuery}`}
                      state={{ from: `${location.pathname}${location.search}` }}
                    >
                      {story.title}
                    </Link>
                  </h2>
                  <p className="story-meta">
                    {story.genre || "Unknown genre"} • {story.tone || "Unknown tone"} • {story.wordCount} words • {story.storyStatus}
                  </p>
                </div>

                <div className="story-menu-wrap" ref={menuOpen ? menuRef : null}>
                  <button
                    type="button"
                    className="kebab-button"
                    aria-label={`Open story actions for ${story.title}`}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    disabled={deleting}
                    onClick={() =>
                      setOpenMenuStoryId((current) => (current === story.storyId ? null : story.storyId))
                    }
                  >
                    ⋯
                  </button>

                  {menuOpen ? (
                    <div className="story-menu" role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        className="story-menu-item danger"
                        onClick={() => openDeleteDialog(story)}
                      >
                        Delete
                      </button>
                    </div>
                  ) : null}
                </div>
              </header>

              {story.summaryShort ? <p>{story.summaryShort}</p> : null}
              {story.bestChunk?.excerpt ? <blockquote>{story.bestChunk.excerpt}</blockquote> : null}

              <div className="tags-row">
                {story.tags.slice(0, 8).map((tag) => (
                  <span key={tag} className="tag-pill">
                    {tag}
                  </span>
                ))}
              </div>

              {debugScores ? (
                <div className="debug-panel">
                  {story.bestChunk ? (
                    <p className="debug-line">
                      Best chunk #{story.bestChunk.chunkIndex} • score {story.bestChunk.score}
                    </p>
                  ) : null}
                  {story.sourceCount > 1 ? (
                    <p className="debug-line">Duplicates: {story.sourceCount - 1}</p>
                  ) : null}
                  {story.statusNotes ? <p className="debug-line">Status notes: {story.statusNotes}</p> : null}
                </div>
              ) : null}
            </article>
          );
        })}
      </section>

      {deleteTarget ? (
        <div className="confirm-backdrop" role="presentation" onClick={closeDeleteDialog}>
          <div
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="delete-dialog-title">Delete story?</h3>
            <p>This will permanently delete the story and its index. This can&apos;t be undone.</p>
            <label>
              Type {DELETE_CONFIRM_TOKEN} to confirm
              <input
                type="text"
                value={deleteConfirmText}
                onChange={(event) => setDeleteConfirmText(event.target.value)}
                autoComplete="off"
                autoFocus
              />
            </label>
            <div className="confirm-actions">
              <button type="button" className="ghost" onClick={closeDeleteDialog} disabled={Boolean(deletingStoryId)}>
                Cancel
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={deleteConfirmText !== DELETE_CONFIRM_TOKEN || Boolean(deletingStoryId)}
                onClick={() => void confirmDelete()}
              >
                {deletingStoryId ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {toast ? <div className="toast">{toast}</div> : null}

      <nav className="pagination-row">
        <button
          type="button"
          disabled={offset === 0 || loading}
          onClick={() => void runSearch(Math.max(0, offset - PAGE_SIZE))}
        >
          Previous
        </button>
        <button
          type="button"
          disabled={nextOffset === null || loading}
          onClick={() => void runSearch(nextOffset ?? offset)}
        >
          Next
        </button>
      </nav>
    </main>
  );
}
