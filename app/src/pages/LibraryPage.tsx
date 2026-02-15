import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { deleteStory, fetchFilters, searchStories, updateStory } from "../lib/api";
import type { FiltersResponse, SearchResponse, StoryResult, StoryStatus } from "../types";

const PAGE_SIZE = 20;

type StatusFilterValue = StoryStatus | "ALL";

const emptyFilters: FiltersResponse = {
  genres: [],
  tones: [],
  tags: [],
  statuses: [],
  totalStories: 0,
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
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>("ALL");
  const [hideRead, setHideRead] = useState(false);
  const [results, setResults] = useState<StoryResult[]>([]);
  const [mode, setMode] = useState<SearchResponse["mode"]>("browse");
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [totalCandidates, setTotalCandidates] = useState<number | undefined>(undefined);
  const [exactCursor, setExactCursor] = useState<string | null>(null);
  const [exactNextCursor, setExactNextCursor] = useState<string | null>(null);
  const [exactCursorHistory, setExactCursorHistory] = useState<string[]>([]);
  const [debugScores, setDebugScores] = useState(false);
  const [openMenuStoryId, setOpenMenuStoryId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<StoryResult | null>(null);
  const [deletingStoryId, setDeletingStoryId] = useState<string | null>(null);
  const [updatingStoryId, setUpdatingStoryId] = useState<string | null>(null);
  const [tagQuery, setTagQuery] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeFilters = useMemo(() => {
    const statusActive = statusFilter === "ALL" ? 0 : 1;
    const readActive = hideRead ? 1 : 0;
    return [genre, tone, ...selectedTags].filter(Boolean).length + statusActive + readActive;
  }, [genre, tone, selectedTags, statusFilter, hideRead]);

  const filteredTagOptions = useMemo(() => {
    const q = tagQuery.trim().toLowerCase();
    if (!q) {
      return filters.tags.slice(0, 60);
    }
    return filters.tags
      .filter((tagInfo) => tagInfo.tag.toLowerCase().includes(q))
      .slice(0, 60);
  }, [filters.tags, tagQuery]);

  const runSearch = async (
    next = 0,
    cursor: string | null = null,
    overrides?: { tags?: string[]; hideRead?: boolean },
  ) => {
    setLoading(true);
    setError(null);

    try {
      const tagsToUse = overrides?.tags ?? selectedTags;
      const hideReadToUse = overrides?.hideRead ?? hideRead;
      const baseRequest = {
        q: query,
        filters: {
          genre: genre || null,
          tone: tone || null,
          tags: tagsToUse,
          statuses: statusFilter === "ALL" ? [] : [statusFilter],
          hideRead: hideReadToUse,
        },
        limit: PAGE_SIZE,
        offset: next,
      };

      let response = await searchStories({
        ...baseRequest,
        cursor,
      });

      if (response.mode === "exact" && response.items.length < PAGE_SIZE && response.nextCursor) {
        const combinedItems = [...response.items];
        let rollingCursor: string | null = response.nextCursor;
        let requestCount = 0;

        while (rollingCursor && combinedItems.length < PAGE_SIZE && requestCount < 8) {
          const nextResponse = await searchStories({
            ...baseRequest,
            cursor: rollingCursor,
          });

          if (nextResponse.mode !== "exact") {
            break;
          }

          combinedItems.push(...nextResponse.items);
          rollingCursor = nextResponse.nextCursor ?? null;
          requestCount += 1;
        }

        response = {
          ...response,
          items: combinedItems.slice(0, PAGE_SIZE),
          nextCursor: rollingCursor,
          nextOffset: rollingCursor ? next + PAGE_SIZE : null,
        };
      }

      setResults(response.items);
      setMode(response.mode);
      setOffset(next);
      setNextOffset(response.nextOffset);
      setTotalCandidates(response.totalCandidates);
      if (response.mode === "exact") {
        setExactCursor(cursor);
        setExactNextCursor(response.nextCursor ?? null);
      } else {
        setExactCursor(null);
        setExactNextCursor(null);
        setExactCursorHistory([]);
      }
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
    setExactCursor(null);
    setExactNextCursor(null);
    setExactCursorHistory([]);
    void runSearch(0);
  };

  const toggleTag = (tag: string) => {
    setSelectedTags((current) => {
      const next = current.includes(tag)
        ? current.filter((value) => value !== tag)
        : [...current, tag];
      void runSearch(0, null, { tags: next });
      return next;
    });
  };

  const clearFilters = () => {
    setGenre("");
    setTone("");
    setSelectedTags([]);
    setStatusFilter("ALL");
    setHideRead(false);
  };

  const refreshFilters = async () => {
    try {
      const response = await fetchFilters();
      setFilters(response);
    } catch {
      // noop
    }
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
    setOpenMenuStoryId(null);
  };

  const closeDeleteDialog = () => {
    if (deletingStoryId) {
      return;
    }
    setDeleteTarget(null);
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
      setFilters((current) => ({
        ...current,
        totalStories: Math.max(0, current.totalStories - 1),
      }));
    } catch (deleteError) {
      setResults(previousResults);
      setTotalCandidates(previousTotalCandidates);
      const message = deleteError instanceof Error ? deleteError.message : "Failed to delete story";
      setToast(`Delete failed: ${message}`);
    } finally {
      setDeletingStoryId(null);
    }
  };

  const patchStoryInResults = (storyId: string, patch: Partial<StoryResult>) => {
    setResults((current) =>
      current.map((item) => (item.storyId === storyId ? { ...item, ...patch } : item)),
    );
  };

  const toggleRead = async (story: StoryResult) => {
    if (updatingStoryId) {
      return;
    }
    const previous = story.isRead;
    patchStoryInResults(story.storyId, { isRead: !previous });
    setUpdatingStoryId(story.storyId);

    try {
      const response = await updateStory(story.storyId, { isRead: !previous });
      patchStoryInResults(story.storyId, {
        isRead: response.story.isRead,
      });
    } catch (updateError) {
      patchStoryInResults(story.storyId, { isRead: previous });
      const message = updateError instanceof Error ? updateError.message : "Failed to update read status";
      setToast(`Update failed: ${message}`);
    } finally {
      setUpdatingStoryId(null);
    }
  };

  const addUserTag = async (story: StoryResult) => {
    if (updatingStoryId) {
      return;
    }
    const input = window.prompt(`Add a custom tag for "${story.title}"`);
    if (!input) {
      return;
    }
    const newTag = input.trim();
    if (!newTag) {
      return;
    }

    setUpdatingStoryId(story.storyId);
    try {
      const response = await updateStory(story.storyId, { addUserTag: newTag });
      patchStoryInResults(story.storyId, {
        tags: response.story.tags,
        userTags: response.story.userTags,
      });
      await refreshFilters();
      setToast("Tag added.");
    } catch (updateError) {
      const message = updateError instanceof Error ? updateError.message : "Failed to add tag";
      setToast(`Tag update failed: ${message}`);
    } finally {
      setUpdatingStoryId(null);
    }
  };

  const removeUserTag = async (story: StoryResult, tag: string) => {
    if (updatingStoryId) {
      return;
    }
    setUpdatingStoryId(story.storyId);
    try {
      const response = await updateStory(story.storyId, { removeUserTag: tag });
      patchStoryInResults(story.storyId, {
        tags: response.story.tags,
        userTags: response.story.userTags,
      });
      await refreshFilters();
      setToast("Tag removed.");
    } catch (updateError) {
      const message = updateError instanceof Error ? updateError.message : "Failed to remove tag";
      setToast(`Tag update failed: ${message}`);
    } finally {
      setUpdatingStoryId(null);
    }
  };

  return (
    <main className="library-page">
      <section className="hero">
        <h1>Story Library</h1>
        <p>
          Semantic search + metadata browse for your indexed corpus. {filters.totalStories.toLocaleString()} stories in library.
        </p>
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
              <option value="ALL">All statuses</option>
              <option value="OK">OK only</option>
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
          <label className="checkbox-inline">
            <input
              type="checkbox"
              checked={hideRead}
              onChange={(event) => {
                const nextHideRead = event.target.checked;
                setHideRead(nextHideRead);
                void runSearch(0, null, { hideRead: nextHideRead });
              }}
            />
            Hide read
          </label>
        </div>

        <div className="tag-cloud">
          <input
            type="search"
            placeholder="Search tags..."
            value={tagQuery}
            onChange={(event) => setTagQuery(event.target.value)}
            aria-label="Search available tags"
          />
          {filteredTagOptions.map((tagInfo) => {
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
            {mode === "semantic" ? "Semantic results" : mode === "exact" ? "Exact text results" : "Metadata browse"} • page offset {offset}
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
          const metaParts = [
            story.isRead ? "Read" : "Unread",
            story.genre && story.genre.trim().toLowerCase() !== "unknown" ? story.genre : null,
            story.tone && story.tone.trim().toLowerCase() !== "unknown" ? story.tone : null,
            `${story.wordCount} words`,
            story.storyStatus,
          ].filter((value): value is string => Boolean(value));
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
                  <p className="story-meta">{metaParts.join(" • ")}</p>
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
                        className="story-menu-item"
                        onClick={() => void toggleRead(story)}
                      >
                        {story.isRead ? "Mark unread" : "Mark read"}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="story-menu-item"
                        onClick={() => void addUserTag(story)}
                      >
                        Add tag
                      </button>
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
                {story.userTags.map((tag) => (
                  <button
                    key={`user-${story.storyId}-${tag}`}
                    type="button"
                    className="tag-pill"
                    onClick={() => void removeUserTag(story, tag)}
                    title="Remove custom tag"
                  >
                    {tag} ×
                  </button>
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
            <div className="confirm-actions">
              <button type="button" className="ghost" onClick={closeDeleteDialog} disabled={Boolean(deletingStoryId)}>
                Cancel
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={Boolean(deletingStoryId)}
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
          disabled={mode === "exact" ? exactCursorHistory.length === 0 || loading : offset === 0 || loading}
          onClick={() => {
            if (mode === "exact") {
              if (exactCursorHistory.length === 0) {
                return;
              }
              const history = [...exactCursorHistory];
              const previousCursor = history.pop() ?? "";
              setExactCursorHistory(history);
              void runSearch(
                Math.max(0, offset - PAGE_SIZE),
                previousCursor.length > 0 ? previousCursor : null,
              );
              return;
            }
            void runSearch(Math.max(0, offset - PAGE_SIZE));
          }}
        >
          Previous
        </button>
        <button
          type="button"
          disabled={mode === "exact" ? exactNextCursor === null || loading : nextOffset === null || loading}
          onClick={() => {
            if (mode === "exact") {
              if (!exactNextCursor) {
                return;
              }
              setExactCursorHistory((current) => [...current, exactCursor ?? ""]);
              void runSearch(offset + PAGE_SIZE, exactNextCursor);
              return;
            }
            void runSearch(nextOffset ?? offset);
          }}
        >
          Next
        </button>
      </nav>
    </main>
  );
}
