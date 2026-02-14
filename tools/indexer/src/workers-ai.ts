import type { IndexerConfig } from "./types.js";

interface WorkersAiResult {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  result?: unknown;
}

function parseEmbeddings(result: unknown): number[][] {
  const candidate = result as { data?: unknown; embedding?: unknown };

  if (Array.isArray(candidate.data)) {
    if (candidate.data.length === 0) {
      return [];
    }

    if (Array.isArray(candidate.data[0])) {
      return (candidate.data as unknown[][]).map((row) => row.map((value) => Number(value)));
    }

    if (
      typeof candidate.data[0] === "object" &&
      candidate.data[0] !== null &&
      Array.isArray((candidate.data[0] as { embedding?: unknown }).embedding)
    ) {
      return (candidate.data as Array<{ embedding: number[] }>).map((item) => item.embedding.map((value) => Number(value)));
    }

    if (candidate.data.every((value) => typeof value === "number")) {
      return [candidate.data as number[]];
    }
  }

  if (Array.isArray(candidate.embedding)) {
    return [(candidate.embedding as unknown[]).map((value) => Number(value))];
  }

  throw new Error("Workers AI embedding response format was not recognized");
}

export async function createWorkersAiEmbeddings(config: IndexerConfig, inputs: string[]): Promise<number[][]> {
  if (inputs.length === 0) {
    return [];
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${config.cloudflareAccountId}/ai/run/${config.cfAiEmbedModel}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.cloudflareApiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: inputs }),
    },
  );

  const payload = (await response.json()) as WorkersAiResult;
  if (!response.ok || payload.success === false) {
    const details = payload.errors?.map((entry) => entry.message).filter(Boolean).join("; ");
    throw new Error(`Workers AI embedding request failed (${response.status}): ${details || "unknown"}`);
  }

  const vectors = parseEmbeddings(payload.result);
  if (vectors.length !== inputs.length && !(vectors.length === 1 && inputs.length === 1)) {
    throw new Error(`Workers AI returned ${vectors.length} embeddings for ${inputs.length} inputs`);
  }

  return vectors;
}
