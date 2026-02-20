import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type {
  DuplicateGroupRow,
  ExistingSourceRow,
  ExistingStoryRow,
  IndexedStory,
  IndexerConfig,
  SourcePathRow,
  StorySourceRecord,
  VectorRecord,
} from "./types.js";

interface CloudflareApiEnvelope<T> {
  success: boolean;
  errors?: Array<{ message?: string }>;
  result?: T;
}

interface D1QueryResult<T> {
  results?: T[];
}

interface VectorizeUpsertResult {
  count?: number;
}

interface DuplicateGroupQueryRow {
  STORY_ID: string;
  CANON_HASH: string;
  SOURCE_COUNT: number;
  TITLE: string;
  SAMPLE_SOURCE_PATHS: string;
}

interface StoryTextBackfillQueryRow {
  STORY_ID: string;
  R2_KEY: string;
}

const CF_REQUEST_MAX_RETRIES = 4;
const CF_REQUEST_TIMEOUT_MS = 30_000;

export class CloudflareClient {
  private readonly s3: S3Client;

  constructor(private readonly config: IndexerConfig) {
    this.s3 = new S3Client({
      region: "auto",
      endpoint: config.r2Endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.r2AccessKeyId,
        secretAccessKey: config.r2SecretAccessKey,
      },
    });
  }

  private async cfRequest<T>(path: string, init: RequestInit): Promise<T> {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const isRetryableFetchError = (error: unknown): boolean => {
      if (!(error instanceof Error)) {
        return false;
      }
      const cause = error as Error & { cause?: { code?: string } };
      const code = cause.cause?.code ?? "";
      return (
        code === "ECONNRESET" ||
        code === "UND_ERR_CONNECT_TIMEOUT" ||
        code === "UND_ERR_HEADERS_TIMEOUT" ||
        error.message.toLowerCase().includes("fetch failed")
      );
    };

    let attempt = 0;
    while (attempt <= CF_REQUEST_MAX_RETRIES) {
      try {
        const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
          ...init,
          signal: AbortSignal.timeout(CF_REQUEST_TIMEOUT_MS),
          headers: {
            authorization: `Bearer ${this.config.cloudflareApiToken}`,
            ...(init.body instanceof FormData ? {} : { "content-type": "application/json" }),
            ...(init.headers ?? {}),
          },
        });

        const payload = (await response.json()) as CloudflareApiEnvelope<T>;
        if (!response.ok || !payload.success) {
          const details = payload.errors?.map((error) => error.message).filter(Boolean).join("; ");
          const message = `Cloudflare API error (${response.status}): ${details || "unknown error"}`;
          const retryableStatus =
            response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
          if (retryableStatus && attempt < CF_REQUEST_MAX_RETRIES) {
            const backoffMs = Math.min(500 * 2 ** attempt, 4000);
            await sleep(backoffMs);
            attempt += 1;
            continue;
          }
          throw new Error(message);
        }

        if (payload.result === undefined) {
          throw new Error("Cloudflare API response missing result");
        }

        return payload.result;
      } catch (error) {
        if (attempt >= CF_REQUEST_MAX_RETRIES || !isRetryableFetchError(error)) {
          throw error;
        }
        const backoffMs = Math.min(500 * 2 ** attempt, 4000);
        await sleep(backoffMs);
        attempt += 1;
      }
    }

    throw new Error("Cloudflare API request retries exhausted");
  }

  async d1Query<T>(sql: string, params: Array<string | number | null> = []): Promise<T[]> {
    const path = `/accounts/${this.config.cloudflareAccountId}/d1/database/${this.config.d1DatabaseId}/query`;
    const result = await this.cfRequest<Array<D1QueryResult<T>>>(path, {
      method: "POST",
      body: JSON.stringify({ sql, params }),
    });

    return result[0]?.results ?? [];
  }

  async d1Exec(sql: string, params: Array<string | number | null> = []) {
    await this.d1Query(sql, params);
  }

  async upsertStoryText(storyId: string, textContent: string, updatedAt: string) {
    try {
      await this.d1Exec(
        `
        INSERT INTO STORY_TEXT (STORY_ID, TEXT_CONTENT, UPDATED_AT)
        VALUES (?, ?, ?)
        ON CONFLICT(STORY_ID) DO UPDATE SET
          TEXT_CONTENT = excluded.TEXT_CONTENT,
          UPDATED_AT = excluded.UPDATED_AT
        `,
        [storyId, textContent, updatedAt],
      );
    } catch (error) {
      if (error instanceof Error && error.message.toLowerCase().includes("no such table")) {
        return;
      }
      throw error;
    }
  }

  async getStoryTextBackfillCandidates(
    lastStoryId: string | null,
    limit: number,
    onlyMissing: boolean,
  ): Promise<Array<{ storyId: string; r2Key: string }>> {
    const whereClauses = ["s.STORY_ID > ?"];
    const params: Array<string | number | null> = [lastStoryId ?? ""];

    if (onlyMissing) {
      whereClauses.push("st.STORY_ID IS NULL");
    }

    const rows = await this.d1Query<StoryTextBackfillQueryRow>(
      `
      SELECT s.STORY_ID, s.R2_KEY
      FROM STORIES s
      LEFT JOIN STORY_TEXT st ON st.STORY_ID = s.STORY_ID
      WHERE ${whereClauses.join(" AND ")}
      ORDER BY s.STORY_ID ASC
      LIMIT ?
      `,
      [...params, limit],
    );

    return rows.map((row) => ({
      storyId: row.STORY_ID,
      r2Key: row.R2_KEY,
    }));
  }

  async getSetting(key: string): Promise<string | null> {
    const rows = await this.d1Query<{ VALUE: string }>(
      "SELECT VALUE FROM SETTINGS WHERE KEY = ? LIMIT 1",
      [key],
    );
    return rows[0]?.VALUE ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.d1Exec(
      "INSERT OR REPLACE INTO SETTINGS (KEY, VALUE) VALUES (?, ?)",
      [key, value],
    );
  }

  async getSourceByPath(sourcePath: string): Promise<ExistingSourceRow | null> {
    const rows = await this.d1Query<ExistingSourceRow>(
      "SELECT STORY_ID, SOURCE_PATH, RAW_HASH FROM STORY_SOURCES WHERE SOURCE_PATH = ? LIMIT 1",
      [sourcePath],
    );
    return rows[0] ?? null;
  }

  async getAllSources(): Promise<ExistingSourceRow[]> {
    return this.d1Query<ExistingSourceRow>(
      "SELECT STORY_ID, SOURCE_PATH, RAW_HASH FROM STORY_SOURCES",
    );
  }

  async getSourcePathsForMetadataFallbackStories(): Promise<string[]> {
    const rows = await this.d1Query<SourcePathRow>(
      `
      SELECT ss.SOURCE_PATH
      FROM STORY_SOURCES ss
      INNER JOIN STORIES s ON s.STORY_ID = ss.STORY_ID
      WHERE LOWER(COALESCE(s.STATUS_NOTES, '')) LIKE '%metadata extraction fallback used:%'
      `,
    );
    return rows.map((row) => row.SOURCE_PATH);
  }

  async getStoryByCanonHash(canonHash: string): Promise<ExistingStoryRow | null> {
    const rows = await this.d1Query<ExistingStoryRow>(
      `
      SELECT STORY_ID, SOURCE_PATH, RAW_HASH, CANON_HASH, R2_KEY, CHUNKS_KEY,
             STORY_STATUS, CHUNK_COUNT, SOURCE_COUNT, TITLE, AUTHOR
      FROM STORIES
      WHERE CANON_HASH = ?
      LIMIT 1
      `,
      [canonHash],
    );
    return rows[0] ?? null;
  }

  async getAllStoriesByCanonHash(): Promise<ExistingStoryRow[]> {
    return this.d1Query<ExistingStoryRow>(
      `
      SELECT STORY_ID, SOURCE_PATH, RAW_HASH, CANON_HASH, R2_KEY, CHUNKS_KEY,
             STORY_STATUS, CHUNK_COUNT, SOURCE_COUNT, TITLE, AUTHOR
      FROM STORIES
      WHERE CANON_HASH IS NOT NULL AND CANON_HASH != ''
      `,
    );
  }

  async upsertStory(story: IndexedStory) {
    await this.d1Exec(
      `
      INSERT INTO STORIES (
        STORY_ID, SOURCE_PATH, CONTENT_HASH, RAW_HASH, CANON_HASH, STORY_STATUS,
        SOURCE_COUNT, CANON_TEXT_SOURCE, EXTRACT_METHOD, STATUS_NOTES,
        TITLE, AUTHOR, SUMMARY_SHORT, SUMMARY_LONG,
        GENRE, TONE, SETTING, TAGS_JSON, THEMES_JSON, CONTENT_NOTES_JSON,
        WORD_COUNT, CHUNK_COUNT, R2_KEY, CHUNKS_KEY, UPDATED_AT
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(STORY_ID) DO UPDATE SET
        SOURCE_PATH = excluded.SOURCE_PATH,
        CONTENT_HASH = excluded.CONTENT_HASH,
        RAW_HASH = excluded.RAW_HASH,
        CANON_HASH = excluded.CANON_HASH,
        STORY_STATUS = excluded.STORY_STATUS,
        SOURCE_COUNT = excluded.SOURCE_COUNT,
        CANON_TEXT_SOURCE = excluded.CANON_TEXT_SOURCE,
        EXTRACT_METHOD = excluded.EXTRACT_METHOD,
        STATUS_NOTES = excluded.STATUS_NOTES,
        TITLE = excluded.TITLE,
        AUTHOR = excluded.AUTHOR,
        SUMMARY_SHORT = excluded.SUMMARY_SHORT,
        SUMMARY_LONG = excluded.SUMMARY_LONG,
        GENRE = excluded.GENRE,
        TONE = excluded.TONE,
        SETTING = excluded.SETTING,
        TAGS_JSON = excluded.TAGS_JSON,
        THEMES_JSON = excluded.THEMES_JSON,
        CONTENT_NOTES_JSON = excluded.CONTENT_NOTES_JSON,
        WORD_COUNT = excluded.WORD_COUNT,
        CHUNK_COUNT = excluded.CHUNK_COUNT,
        R2_KEY = excluded.R2_KEY,
        CHUNKS_KEY = excluded.CHUNKS_KEY,
        UPDATED_AT = excluded.UPDATED_AT
      `,
      [
        story.storyId,
        story.sourcePath,
        story.contentHash,
        story.rawHash,
        story.canonHash,
        story.storyStatus,
        story.sourceCount,
        story.canonTextSource,
        story.extractMethod,
        story.statusNotes,
        story.title,
        story.author,
        story.summaryShort,
        story.summaryLong,
        story.genre,
        story.tone,
        story.setting,
        JSON.stringify(story.tags),
        JSON.stringify(story.themes),
        JSON.stringify(story.contentNotes),
        story.wordCount,
        story.chunkCount,
        story.r2Key,
        story.chunksKey,
        story.updatedAt,
      ],
    );
  }

  async replaceStoryTags(storyId: string, tags: string[]) {
    await this.d1Exec("DELETE FROM STORY_TAGS WHERE STORY_ID = ?", [storyId]);

    const uniqueTags = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
    for (const tag of uniqueTags) {
      await this.d1Exec("INSERT OR IGNORE INTO TAGS (TAG) VALUES (?)", [tag]);
      await this.d1Exec("INSERT OR REPLACE INTO STORY_TAGS (STORY_ID, TAG) VALUES (?, ?)", [storyId, tag]);
    }
  }

  async upsertStorySource(source: StorySourceRecord) {
    await this.d1Exec("DELETE FROM STORY_SOURCES WHERE SOURCE_PATH = ? AND STORY_ID != ?", [source.sourcePath, source.storyId]);

    await this.d1Exec(
      `
      INSERT OR REPLACE INTO STORY_SOURCES (
        STORY_ID, SOURCE_PATH, SOURCE_TYPE, EXTRACT_METHOD, RAW_HASH, INGESTED_AT, TITLE_FROM_SOURCE
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        source.storyId,
        source.sourcePath,
        source.sourceType,
        source.extractMethod,
        source.rawHash,
        source.ingestedAt,
        source.titleFromSource,
      ],
    );
  }

  async refreshSourceCount(storyId: string): Promise<number> {
    const rows = await this.d1Query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM STORY_SOURCES WHERE STORY_ID = ?",
      [storyId],
    );
    const count = rows[0]?.count ?? 0;
    await this.d1Exec("UPDATE STORIES SET SOURCE_COUNT = ? WHERE STORY_ID = ?", [count, storyId]);
    return count;
  }

  async deleteStoryIfOrphan(storyId: string) {
    const count = await this.refreshSourceCount(storyId);
    if (count > 0) {
      return;
    }
    await this.d1Exec("DELETE FROM STORIES WHERE STORY_ID = ?", [storyId]);
  }

  async uploadTextObject(key: string, content: string) {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.config.r2BucketName,
        Key: key,
        Body: content,
        ContentType: "text/plain; charset=utf-8",
      }),
    );
  }

  async downloadTextObject(key: string): Promise<string | null> {
    const response = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.config.r2BucketName,
        Key: key,
      }),
    );

    const body = response.Body;
    if (!body) {
      return null;
    }

    if ("transformToString" in body && typeof body.transformToString === "function") {
      return body.transformToString();
    }

    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      if (typeof chunk === "string") {
        chunks.push(Buffer.from(chunk));
      } else {
        chunks.push(Buffer.from(chunk));
      }
    }

    return Buffer.concat(chunks).toString("utf8");
  }

  async uploadRawObject(key: string, content: Buffer, contentType: string) {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.config.r2BucketName,
        Key: key,
        Body: content,
        ContentType: contentType,
      }),
    );
  }

  async uploadJsonObject(key: string, value: unknown) {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.config.r2BucketName,
        Key: key,
        Body: JSON.stringify(value),
        ContentType: "application/json; charset=utf-8",
      }),
    );
  }

  async upsertVectors(vectors: VectorRecord[]) {
    if (vectors.length === 0) {
      return 0;
    }

    const lines = vectors.map((vector) => JSON.stringify(vector)).join("\n");
    const form = new FormData();
    form.set("vectors", new Blob([lines], { type: "application/x-ndjson" }), "vectors.ndjson");

    const path = `/accounts/${this.config.cloudflareAccountId}/vectorize/v2/indexes/${this.config.vectorizeIndexName}/upsert`;
    const result = await this.cfRequest<VectorizeUpsertResult>(path, {
      method: "POST",
      body: form,
    });

    return result.count ?? vectors.length;
  }

  async getDuplicateGroups(limit = 200): Promise<DuplicateGroupRow[]> {
    const rows = await this.d1Query<DuplicateGroupQueryRow>(
      `
      SELECT
        s.STORY_ID,
        COALESCE(s.CANON_HASH, '') AS CANON_HASH,
        s.SOURCE_COUNT,
        s.TITLE,
        COALESCE(GROUP_CONCAT(ss.SOURCE_PATH, ' | '), '') AS SAMPLE_SOURCE_PATHS
      FROM STORIES s
      LEFT JOIN STORY_SOURCES ss ON ss.STORY_ID = s.STORY_ID
      WHERE s.SOURCE_COUNT > 1
      GROUP BY s.STORY_ID, s.CANON_HASH, s.SOURCE_COUNT, s.TITLE
      ORDER BY s.SOURCE_COUNT DESC, s.TITLE ASC
      LIMIT ?
      `,
      [limit],
    );

    return rows.map((row) => ({
      storyId: row.STORY_ID,
      canonHash: row.CANON_HASH,
      sourceCount: row.SOURCE_COUNT,
      title: row.TITLE,
      sampleSourcePaths: row.SAMPLE_SOURCE_PATHS
        ? row.SAMPLE_SOURCE_PATHS.split(" | ").slice(0, 5)
        : [],
    }));
  }

  async status() {
    const rows = await this.d1Query<{
      story_count: number;
      total_words: number;
      latest_update: string;
      flagged_count: number;
    }>(
      `
      SELECT
        COUNT(*) AS story_count,
        COALESCE(SUM(WORD_COUNT), 0) AS total_words,
        COALESCE(MAX(UPDATED_AT), '') AS latest_update,
        SUM(CASE WHEN STORY_STATUS = 'OK' THEN 0 ELSE 1 END) AS flagged_count
      FROM STORIES
      `,
    );

    const tags = await this.d1Query<{ tag_count: number }>("SELECT COUNT(*) AS tag_count FROM TAGS");

    return {
      storyCount: rows[0]?.story_count ?? 0,
      totalWords: rows[0]?.total_words ?? 0,
      latestUpdate: rows[0]?.latest_update ?? "",
      flaggedCount: rows[0]?.flagged_count ?? 0,
      tagCount: tags[0]?.tag_count ?? 0,
    };
  }
}
