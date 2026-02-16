# Story Library (Cloudflare Pages + Access)

Login-only story library with:
- Semantic search (Workers AI query embeddings + Vectorize)
- Metadata browse/filter (D1)
- Reader view from canonical plain text in R2
- Per-story read/unread state
- Custom user tags (add/remove) with tag search/filter
- Local indexer with mixed-format ingest, normalization, dedupe, and cleanup reporting

## Embedding Strategy (Production)

- **Single embedding model for everything**: Cloudflare Workers AI.
- Document/chunk embeddings (indexer) and query embeddings (search API) use the same model.
- Default model constant: `@cf/baai/bge-base-en-v1.5`.
- LM Studio is used **only** for metadata extraction (title/summaries/tags/themes), not embeddings.

## Architecture

- Frontend: React + Vite (`app/`)
- Backend: Cloudflare Pages Functions (`functions/`)
- Cloudflare data:
  - `STORY_DB` (D1): canonical stories + provenance + tags + settings
  - `STORY_BUCKET` (R2): canonical plain text + chunk maps
  - `STORY_VECTORS` (Vectorize): per-chunk embeddings
- Access: Cloudflare Access policy protects the Pages app
- Local indexer: `tools/indexer/` (LM Studio metadata + Workers AI embeddings)

## Supported Source Formats

The local indexer accepts:
- `.txt`
- `.html`, `.htm`
- `.rtf`
- `.doc`
- `.docx`
- `.pdf`

All formats are converted to canonical plain text before hashing, dedupe, tagging, chunking, and embedding.

OCR is deferred. Scanned PDFs are flagged `PDF_SCANNED_IMAGE`.

## Canonical Ingest Pipeline

For each file:
1. Read original bytes
2. Extract raw text by file type (extractor registry)
3. Normalize canonical text (NFKC, LF newlines, control-char cleanup, whitespace cleanup)
4. Compute:
   - `RAW_HASH = sha256(original bytes)`
   - `CANON_HASH = sha256(normalized canonical text)`
5. Dedupe by `CANON_HASH`
6. If new canonical story:
   - metadata via LM Studio (title, summaries, themes, tags from text)
   - chunk + Workers AI embeddings
   - upload canonical text + chunk map to R2
   - upsert metadata/status to D1
   - upsert vectors to Vectorize (batched and byte-limited <100MB)

Reader view always renders canonical text from R2.

## Local Tagger (Rule-Based Tags)

The local tagger applies configurable lexical rules to canonical text files and writes one unified tag list back to `STORIES.TAGS_JSON` in D1.

- Rules file: `rules/tags.json`
- Canonical source dir: `tools/indexer/output_text`
- Command:

```bash
npm run start -w tools/tagger -- apply --rules rules/tags.json --source tools/indexer/output_text
```

Options:
- `--overwrite`
- `--dry-run`
- `--only-story <id>`
- `--ruleset-version <v>`
- `--max-files <n>`
- `--min-wordcount <n>`
- `--report-out <dir>`

Tagger reports:
- `tagger_summary.json`
- `tagged_stories_sample.csv`

Rules format (`rules/tags.json`):

```json
[
  {
    "tag": "Zulu Wars",
    "anyOf": ["zulu", "isandlwana", "rorke's drift"],
    "minCount": 1,
    "caseSensitive": false,
    "matchWholeWord": true
  }
]
```

Rule behavior:
- Each rule applies when total matches across `anyOf` terms reach `minCount`.
- `caseSensitive` defaults to `false`.
- `matchWholeWord` defaults to `true` for single terms and `false` for phrases.

## Story Deletion

- Story list/search cards include a `...` menu with `Delete`.
- Reader view intentionally has no delete controls.
- API endpoint: `DELETE /api/story/:id`
- Deletion removes:
  - D1 story record + related source/tag rows
  - R2 canonical text + chunk map + optional originals under `sources/original/{storyId}/`
  - Vectorize chunk vectors for the story

## D1 Schema

Migrations:
- `db/migrations/0001_init.sql`
- `db/migrations/0002_cleanup_dedupe.sql`
- `db/migrations/0003_settings.sql`
- `db/migrations/0004_add_author.sql`
- `db/migrations/0005_chunk_count_hardening.sql`
- `db/migrations/0006_user_tags_and_read.sql`
- `db/migrations/0007_tagger_audit_columns.sql`

`STORIES` includes:
- `RAW_HASH`
- `CANON_HASH` (unique)
- `CANON_TEXT_SOURCE`
- `EXTRACT_METHOD`
- `STORY_STATUS`
- `STATUS_NOTES`
- `SOURCE_COUNT`
- `CHUNK_COUNT`
- `TAG_SOURCES_JSON` (optional tag audit metadata)
- `TAG_RULESET_VERSION` (optional ruleset label)

`STORY_SOURCES` includes:
- `STORY_ID`
- `SOURCE_PATH`
- `SOURCE_TYPE`
- `EXTRACT_METHOD`
- `RAW_HASH`
- `INGESTED_AT`

`STORY_USER_TAGS` includes:
- `STORY_ID`
- `TAG`

`USER_TAGS` includes:
- `TAG`

`SETTINGS` includes:
- `embedding_model_name`
- `embedding_dimension`
- `indexed_at`

Indexer compares runtime model/dimension vs `SETTINGS` and aborts on mismatch unless `--force-reindex` is used.

## Quality Statuses

- `OK`
- `TOO_SHORT`
- `BINARY_GARBAGE`
- `NEEDS_REVIEW`
- `PDF_SCANNED_IMAGE`
- `EXTRACTION_FAILED`

Behavior:
- `EXTRACTION_FAILED`, `PDF_SCANNED_IMAGE`, `BINARY_GARBAGE`: skip embeddings
- `EXTRACTION_FAILED`: no canonical upload/vectorization, captured in failure report
- Processing continues for other files

## Local Artifacts

- Canonical text outputs: `tools/indexer/output_text/{storyId}.txt`
- Reports (written every run to `REPORT_DIR`):
  - `ingest_summary.json`
  - `duplicate_groups.csv`
  - `flagged_files.csv`
  - `extraction_failures.csv`

## Setup

### 1) Cloudflare resources

```bash
wrangler d1 create story-library
wrangler r2 bucket create story-library
wrangler vectorize create story-library-vectors --dimensions=768 --metric=cosine
```

### 2) Apply migrations

```bash
wrangler d1 migrations apply story-library --remote --config wrangler.toml
```

### 3) Configure Access (login-only)

1. Zero Trust -> Access -> Applications
2. Add Self-hosted app for Pages hostname
3. Add allow policy (email/group), no public allow

### 4) Configure environment

```bash
cp .env.example .env
```

Important env vars:
- `CF_ACCOUNT_ID`
- `CF_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID` (alias supported)
- `CLOUDFLARE_API_TOKEN` (alias supported)
- `CF_AI_EMBED_MODEL=@cf/baai/bge-base-en-v1.5`
- `LMSTUDIO_TIMEOUT_MS=120000`
- `LMSTUDIO_MAX_RETRIES=2`
- `LMSTUDIO_SYSTEM_PROMPT_PATH=tools/indexer/prompts/system_prompt.txt`
- `INDEXER_ACCEPT_EXTENSIONS=.txt,.html,.htm,.rtf,.doc,.docx,.pdf`
- `MIN_EXTRACT_CHARS=500`
- `PDF_MIN_TEXT_CHARS=800`
- `OUTPUT_TEXT_DIR=tools/indexer/output_text`
- `REPORT_DIR=tools/indexer/reports`
- `HTML_EXTRACT_MODE=readability_first`
- `STORE_ORIGINAL_BINARY=false`
- `INDEXER_HASH_CONCURRENCY=8`

### 5) Run indexer

```bash
npm run start -w tools/indexer -- index ./sample_stories
npm run start -w tools/indexer -- index ./sample_stories --changed-only
npm run start -w tools/indexer -- index ./sample_stories --changed-only --profile
npm run start -w tools/indexer -- index ./sample_stories --full
npm run start -w tools/indexer -- index ./sample_stories --full --force-reindex
npm run start -w tools/indexer -- status
npm run start -w tools/tagger -- apply --rules rules/tags.json --source tools/indexer/output_text --dry-run
npm run start -w tools/tagger -- apply --rules rules/tags.json --source tools/indexer/output_text
```

Notes:
- The indexer auto-loads the nearest `.env` (including repo root `.env` when run with `-w tools/indexer`).
- Folder paths can be repo-relative (for example `./stories/test`) or package-relative.
- LM Studio system prompt content is loaded from `tools/indexer/prompts/system_prompt.txt` by default.

### 6) Run locally

```bash
npm install
npm run build -w app
wrangler pages dev app/dist --config wrangler.toml
```

### 7) Deploy

```bash
npm run build -w app
wrangler pages deploy app/dist --project-name story-library --config wrangler.toml
```

## Bindings

`wrangler.toml` bindings:
- `STORY_DB`
- `STORY_BUCKET`
- `STORY_VECTORS`
- `AI`

Also set runtime var:
- `CF_AI_EMBED_MODEL`
