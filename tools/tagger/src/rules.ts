import { promises as fs } from "node:fs";
import type { CompiledTagRule, RawTagRule } from "./types.js";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRawRule(value: unknown, index: number): RawTagRule {
  if (!isPlainObject(value)) {
    throw new Error(`Rule at index ${index} must be an object`);
  }

  const tag = typeof value.tag === "string" ? value.tag.trim() : "";
  if (!tag) {
    throw new Error(`Rule at index ${index} is missing a non-empty 'tag'`);
  }

  const anyOfRaw = value.anyOf;
  if (!Array.isArray(anyOfRaw) || anyOfRaw.length === 0) {
    throw new Error(`Rule '${tag}' must include a non-empty 'anyOf' array`);
  }

  const anyOf = anyOfRaw
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);

  if (anyOf.length === 0) {
    throw new Error(`Rule '${tag}' has no usable terms in 'anyOf'`);
  }

  const minCountRaw = value.minCount;
  const minCount =
    typeof minCountRaw === "number" && Number.isFinite(minCountRaw)
      ? Math.max(1, Math.trunc(minCountRaw))
      : 1;

  const caseSensitive = value.caseSensitive === true;

  const matchWholeWord =
    typeof value.matchWholeWord === "boolean" ? value.matchWholeWord : undefined;

  return {
    tag,
    anyOf,
    minCount,
    caseSensitive,
    matchWholeWord,
  };
}

export async function loadRawRules(rulesPath: string): Promise<RawTagRule[]> {
  const raw = await fs.readFile(rulesPath, "utf8");
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`Could not parse rules JSON at ${rulesPath}: ${message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Rules file must be a JSON array of rule objects");
  }

  return parsed.map((item, index) => asRawRule(item, index));
}

export function compileRules(rawRules: RawTagRule[]): CompiledTagRule[] {
  return rawRules.map((rule) => {
    const caseSensitive = rule.caseSensitive === true;

    const matchers = rule.anyOf.map((term) => {
      const wholeWord =
        typeof rule.matchWholeWord === "boolean"
          ? rule.matchWholeWord
          : !/\s/.test(term);

      const escaped = escapeRegex(term);
      const pattern = wholeWord ? `\\b${escaped}\\b` : escaped;
      const flags = caseSensitive ? "g" : "gi";

      return {
        term,
        regex: new RegExp(pattern, flags),
      };
    });

    return {
      tag: rule.tag.trim(),
      minCount: Math.max(1, rule.minCount ?? 1),
      caseSensitive,
      matchWholeWord: rule.matchWholeWord,
      matchers,
    };
  });
}

export async function deriveRulesetVersion(rulesPath: string, override: string | null): Promise<string> {
  if (override && override.trim()) {
    return override.trim();
  }

  const stats = await fs.stat(rulesPath);
  return `mtime-${stats.mtime.toISOString()}`;
}
