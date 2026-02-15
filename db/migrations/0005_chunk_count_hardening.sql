PRAGMA foreign_keys = ON;

-- CHUNK_COUNT is used for deterministic Vectorize deletion.
-- This migration hardens existing data by backfilling null values and adding an index.
UPDATE STORIES
SET CHUNK_COUNT = 0
WHERE CHUNK_COUNT IS NULL;

CREATE INDEX IF NOT EXISTS IDX_STORIES_CHUNK_COUNT ON STORIES (CHUNK_COUNT);
