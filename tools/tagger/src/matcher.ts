import type { CompiledTagRule } from "./types.js";

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function countMatches(text: string, regex: RegExp): number {
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

function isRuleStyled(tag: string): boolean {
  return tag !== tag.toLowerCase();
}

function titleCaseTag(value: string): string {
  return value
    .split(" ")
    .map((word) => {
      if (!word) {
        return word;
      }
      return word[0].toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

function normalizeTagForm(tag: string, source: string): string {
  const normalized = tag.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }

  if (source.startsWith("ruleset:")) {
    return normalized;
  }

  if (normalized.includes(" ") && !isRuleStyled(normalized)) {
    return titleCaseTag(normalized);
  }

  return normalized;
}

export function applyCompiledRules(text: string, rules: CompiledTagRule[]): string[] {
  const applied: string[] = [];

  for (const rule of rules) {
    let total = 0;
    for (const matcher of rule.matchers) {
      total += countMatches(text, matcher.regex);
      if (total >= rule.minCount) {
        applied.push(rule.tag);
        break;
      }
    }
  }

  return applied;
}

export function mergeAndNormalizeTags(params: {
  existingTags: string[];
  ruleTags: string[];
  overwrite: boolean;
  rulesetVersion: string;
}) {
  const candidates: Array<{ tag: string; source: string }> = [];

  if (!params.overwrite) {
    for (const tag of params.existingTags) {
      candidates.push({ tag, source: "existing" });
    }
  }

  const ruleSource = `ruleset:${params.rulesetVersion}`;
  for (const tag of params.ruleTags) {
    candidates.push({ tag, source: ruleSource });
  }

  const byKey = new Map<string, { tag: string; source: string }>();

  for (const candidate of candidates) {
    const normalized = normalizeTagForm(candidate.tag, candidate.source);
    if (!normalized) {
      continue;
    }

    const key = normalized.toLowerCase();
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { tag: normalized, source: candidate.source });
      continue;
    }

    const shouldPreferCandidate =
      candidate.source.startsWith("ruleset:") && !existing.source.startsWith("ruleset:");

    if (shouldPreferCandidate) {
      byKey.set(key, { tag: normalized, source: candidate.source });
    }
  }

  const sorted = [...byKey.values()].sort((a, b) =>
    a.tag.localeCompare(b.tag, undefined, { sensitivity: "base" }),
  );

  return {
    tags: sorted.map((item) => item.tag),
    sources: Object.fromEntries(sorted.map((item) => [item.tag, item.source])),
  };
}

export function parseTagArray(raw: string | null | undefined): string[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function diffAddedTags(existingTags: string[], finalTags: string[]): string[] {
  const existing = new Set(existingTags.map((tag) => tag.toLowerCase()));
  return finalTags.filter((tag) => !existing.has(tag.toLowerCase()));
}

export function computeWordCount(text: string): number {
  return countWords(text);
}
