import type { D1Capabilities, StoryTagRow, StoryUpdate } from "./types.js";

interface CloudflareEnvelope<T> {
  success: boolean;
  errors?: Array<{ message?: string }>;
  result?: T;
}

interface D1QueryResult<T> {
  results?: T[];
}

interface ColumnInfoRow {
  name: string;
}

export interface D1ClientConfig {
  accountId: string;
  apiToken: string;
  databaseId: string;
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

export class D1Client {
  constructor(private readonly config: D1ClientConfig) {}

  private async cfRequest<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.config.apiToken}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    const payload = (await response.json()) as CloudflareEnvelope<T>;
    if (!response.ok || !payload.success) {
      const detail = payload.errors?.map((item) => item.message).filter(Boolean).join("; ");
      throw new Error(`Cloudflare API error (${response.status}): ${detail || "unknown error"}`);
    }

    if (payload.result === undefined) {
      throw new Error("Cloudflare API response missing result");
    }

    return payload.result;
  }

  async query<T>(sql: string, params: Array<string | number | null> = []): Promise<T[]> {
    const path = `/accounts/${this.config.accountId}/d1/database/${this.config.databaseId}/query`;
    const result = await this.cfRequest<Array<D1QueryResult<T>>>(path, {
      method: "POST",
      body: JSON.stringify({ sql, params }),
    });

    return result[0]?.results ?? [];
  }

  async capabilities(): Promise<D1Capabilities> {
    const rows = await this.query<ColumnInfoRow>("PRAGMA table_info(STORIES)");
    const set = new Set(rows.map((row) => row.name.toUpperCase()));
    return {
      hasTagSourcesJson: set.has("TAG_SOURCES_JSON"),
      hasTagRulesetVersion: set.has("TAG_RULESET_VERSION"),
    };
  }

  async getStoriesByIds(
    storyIds: string[],
    capabilities: D1Capabilities,
  ): Promise<Map<string, StoryTagRow>> {
    const byId = new Map<string, StoryTagRow>();
    if (storyIds.length === 0) {
      return byId;
    }

    const chunks = chunkArray([...new Set(storyIds)], 300);
    for (const ids of chunks) {
      const placeholders = ids.map(() => "?").join(",");
      const optionalColumns = [
        capabilities.hasTagSourcesJson ? "TAG_SOURCES_JSON" : null,
        capabilities.hasTagRulesetVersion ? "TAG_RULESET_VERSION" : null,
      ]
        .filter(Boolean)
        .join(", ");
      const selectColumns = optionalColumns
        ? `STORY_ID, TAGS_JSON, WORD_COUNT, ${optionalColumns}`
        : "STORY_ID, TAGS_JSON, WORD_COUNT";
      const rows = await this.query<StoryTagRow>(
        `
        SELECT ${selectColumns}
        FROM STORIES
        WHERE STORY_ID IN (${placeholders})
        `,
        ids,
      );

      for (const row of rows) {
        byId.set(row.STORY_ID, row);
      }
    }

    return byId;
  }

  async updateStoryTagsBatch(
    updates: StoryUpdate[],
    capabilities: D1Capabilities,
  ): Promise<void> {
    if (updates.length === 0) {
      return;
    }

    const chunks = chunkArray(updates, 120);

    for (const chunk of chunks) {
      const tagsCase = chunk.map(() => "WHEN ? THEN ?").join(" ");
      const whereIds = chunk.map(() => "?").join(",");

      const params: Array<string | number | null> = [];
      for (const row of chunk) {
        params.push(row.storyId, JSON.stringify(row.tags));
      }

      let sql = `UPDATE STORIES SET TAGS_JSON = CASE STORY_ID ${tagsCase} ELSE TAGS_JSON END`;

      if (capabilities.hasTagSourcesJson) {
        const sourceCase = chunk.map(() => "WHEN ? THEN ?").join(" ");
        sql += `, TAG_SOURCES_JSON = CASE STORY_ID ${sourceCase} ELSE TAG_SOURCES_JSON END`;
        for (const row of chunk) {
          params.push(row.storyId, JSON.stringify(row.tagSources));
        }
      }

      if (capabilities.hasTagRulesetVersion) {
        const versionCase = chunk.map(() => "WHEN ? THEN ?").join(" ");
        sql += `, TAG_RULESET_VERSION = CASE STORY_ID ${versionCase} ELSE TAG_RULESET_VERSION END`;
        for (const row of chunk) {
          params.push(row.storyId, row.rulesetVersion);
        }
      }

      sql += ` WHERE STORY_ID IN (${whereIds})`;
      for (const row of chunk) {
        params.push(row.storyId);
      }

      await this.query(sql, params);
    }
  }
}
