#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import dotenv from "dotenv";
import { D1Client } from "./d1.js";
import { applyCompiledRules, computeWordCount, diffAddedTags, mergeAndNormalizeTags, parseTagArray } from "./matcher.js";
import { writeTaggerReports } from "./report.js";
import { compileRules, deriveRulesetVersion, loadRawRules } from "./rules.js";
import type { CliOptions, RunSummary, StoryRunResult, StoryUpdate } from "./types.js";

function findUp(startDir: string, targetFile: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, targetFile);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function loadEnvFile(): string | null {
  const explicitPath = process.env.DOTENV_CONFIG_PATH;
  if (explicitPath) {
    const resolvedExplicitPath = path.resolve(process.cwd(), explicitPath);
    const result = dotenv.config({ path: resolvedExplicitPath, quiet: true });
    if (result.error) {
      throw new Error(`Could not load env file at ${resolvedExplicitPath}: ${result.error.message}`);
    }
    return resolvedExplicitPath;
  }

  const candidates: string[] = [];
  const fromCwd = findUp(process.cwd(), ".env");
  if (fromCwd) {
    candidates.push(fromCwd);
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const fromScriptDir = findUp(scriptDir, ".env");
  if (fromScriptDir) {
    candidates.push(fromScriptDir);
  }

  for (const candidate of candidates) {
    const result = dotenv.config({ path: candidate, quiet: true });
    if (!result.error) {
      process.env.STORY_TAGGER_ENV_PATH = candidate;
      return candidate;
    }
  }

  dotenv.config({ quiet: true });
  return null;
}

function resolveLocalPath(value: string): string {
  if (path.isAbsolute(value)) {
    return value;
  }

  const envPath = process.env.STORY_TAGGER_ENV_PATH;
  if (envPath) {
    return path.resolve(path.dirname(envPath), value);
  }

  return path.resolve(value);
}

function requireDirectory(folderPath: string, label: string) {
  if (!existsSync(folderPath) || !statSync(folderPath).isDirectory()) {
    throw new Error(`${label} directory not found: ${folderPath}`);
  }
}

async function collectTextFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return collectTextFiles(fullPath);
      }

      if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".txt") {
        return [fullPath];
      }

      return [];
    }),
  );

  return nested.flat().sort();
}

function parsePositiveInt(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function resolveCliOptions(raw: {
  rules: string;
  source: string;
  overwrite?: boolean;
  dryRun?: boolean;
  onlyStory?: string;
  rulesetVersion?: string;
  maxFiles?: string;
  minWordcount?: string;
  reportOut?: string;
}): CliOptions {
  return {
    rulesPath: resolveLocalPath(raw.rules),
    sourceDir: resolveLocalPath(raw.source),
    overwrite: raw.overwrite === true,
    dryRun: raw.dryRun === true,
    onlyStoryId: raw.onlyStory?.trim() || null,
    rulesetVersion: raw.rulesetVersion?.trim() || null,
    maxFiles: raw.maxFiles ? parsePositiveInt(raw.maxFiles, "--max-files") : null,
    minWordCount: raw.minWordcount ? parsePositiveInt(raw.minWordcount, "--min-wordcount") : 0,
    reportOutDir: resolveLocalPath(raw.reportOut ?? "tools/tagger/reports"),
  };
}

function loadD1Env() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CF_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN;
  const databaseId = process.env.D1_DATABASE_ID;

  if (!accountId) {
    throw new Error("Missing required env var: CLOUDFLARE_ACCOUNT_ID (or CF_ACCOUNT_ID)");
  }
  if (!apiToken) {
    throw new Error("Missing required env var: CLOUDFLARE_API_TOKEN (or CF_API_TOKEN)");
  }
  if (!databaseId) {
    throw new Error("Missing required env var: D1_DATABASE_ID");
  }

  return {
    accountId,
    apiToken,
    databaseId,
  };
}

async function runApply(options: CliOptions) {
  requireDirectory(options.sourceDir, "Source");
  if (!existsSync(options.rulesPath)) {
    throw new Error(`Rules file not found: ${options.rulesPath}`);
  }

  const rawRules = await loadRawRules(options.rulesPath);
  const compiledRules = compileRules(rawRules);
  const rulesetVersion = await deriveRulesetVersion(options.rulesPath, options.rulesetVersion);

  const allFiles = await collectTextFiles(options.sourceDir);
  const filtered = allFiles.filter((filePath) => {
    const storyId = path.basename(filePath, ".txt");
    return options.onlyStoryId ? storyId === options.onlyStoryId : true;
  });

  const selectedFiles = options.maxFiles ? filtered.slice(0, options.maxFiles) : filtered;
  const storyIds = selectedFiles.map((filePath) => path.basename(filePath, ".txt"));

  const d1Config = loadD1Env();
  const client = new D1Client(d1Config);
  const capabilities = await client.capabilities();
  const stories = await client.getStoriesByIds(storyIds, capabilities);

  const updates: StoryUpdate[] = [];
  const storyResults: StoryRunResult[] = [];
  const tagsAppliedByTag: Record<string, number> = {};

  let scanned = 0;
  let skipped = 0;

  for (let index = 0; index < selectedFiles.length; index += 1) {
    const filePath = selectedFiles[index];
    const storyId = path.basename(filePath, ".txt");
    const storyRow = stories.get(storyId);

    if (!storyRow) {
      skipped += 1;
      storyResults.push({
        storyId,
        totalTags: 0,
        tagsAdded: [],
        appliedRuleTags: [],
        updated: false,
        skippedReason: "Story ID not found in D1",
      });
      continue;
    }

    const text = await fs.readFile(filePath, "utf8");
    const wordCount = storyRow.WORD_COUNT ?? computeWordCount(text);

    if (options.minWordCount > 0 && wordCount < options.minWordCount) {
      skipped += 1;
      storyResults.push({
        storyId,
        totalTags: parseTagArray(storyRow.TAGS_JSON).length,
        tagsAdded: [],
        appliedRuleTags: [],
        updated: false,
        skippedReason: `WORD_COUNT ${wordCount} < ${options.minWordCount}`,
      });
      continue;
    }

    const existingTags = parseTagArray(storyRow.TAGS_JSON);
    const existingNormalized = mergeAndNormalizeTags({
      existingTags,
      ruleTags: [],
      overwrite: false,
      rulesetVersion,
    });

    const ruleTags = applyCompiledRules(text, compiledRules);
    for (const tag of ruleTags) {
      tagsAppliedByTag[tag] = (tagsAppliedByTag[tag] ?? 0) + 1;
    }

    const merged = mergeAndNormalizeTags({
      existingTags,
      ruleTags,
      overwrite: options.overwrite,
      rulesetVersion,
    });

    const tagsAdded = diffAddedTags(existingNormalized.tags, merged.tags);
    const tagsChanged = JSON.stringify(existingNormalized.tags) !== JSON.stringify(merged.tags);

    const updateNeeded =
      tagsChanged ||
      (capabilities.hasTagRulesetVersion && storyRow.TAG_RULESET_VERSION !== rulesetVersion) ||
      (capabilities.hasTagSourcesJson && options.overwrite);

    if (updateNeeded) {
      updates.push({
        storyId,
        tags: merged.tags,
        tagSources: merged.sources,
        rulesetVersion,
      });
    }

    scanned += 1;
    storyResults.push({
      storyId,
      totalTags: merged.tags.length,
      tagsAdded,
      appliedRuleTags: ruleTags,
      updated: updateNeeded,
    });

    if ((index + 1) % 200 === 0 || index + 1 === selectedFiles.length) {
      console.log(`Processed ${index + 1}/${selectedFiles.length} files...`);
    }
  }

  if (!options.dryRun) {
    await client.updateStoryTagsBatch(updates, capabilities);
  }

  const topTags = Object.entries(tagsAppliedByTag)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 50)
    .map(([tag, count]) => ({ tag, count }));

  const summary: RunSummary = {
    generatedAt: new Date().toISOString(),
    rulesetVersion,
    totalStoriesDiscovered: allFiles.length,
    totalStoriesScanned: scanned,
    totalStoriesUpdated: updates.length,
    totalStoriesSkipped: skipped,
    totalTagsApplied: Object.values(tagsAppliedByTag).reduce((sum, value) => sum + value, 0),
    tagsAppliedByTag,
    topTags,
    dryRun: options.dryRun,
  };

  const reportPaths = await writeTaggerReports(options.reportOutDir, summary, storyResults);

  console.log("\nTagger apply complete");
  console.log(JSON.stringify({ summary, reportPaths }, null, 2));
}

loadEnvFile();

const program = new Command();

program.name("tagger").description("Local lexical tagger for Story Library").version("0.1.0");

program
  .command("apply")
  .requiredOption("--rules <path>", "Path to rules JSON file")
  .requiredOption("--source <dir>", "Path to canonical text directory")
  .option("--overwrite", "Replace existing tags with rule-based tags", false)
  .option("--dry-run", "Compute tags but do not write to D1", false)
  .option("--only-story <id>", "Only process one story ID")
  .option("--ruleset-version <version>", "Ruleset version label")
  .option("--max-files <n>", "Limit number of files")
  .option("--min-wordcount <n>", "Skip stories under this word count")
  .option("--report-out <dir>", "Output report directory")
  .action(async (rawOptions) => {
    const options = resolveCliOptions(rawOptions);
    await runApply(options);
  });

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unexpected failure";
  console.error(message);
  process.exitCode = 1;
});
