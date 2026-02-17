#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Command } from "commander";
import { loadConfig } from "./config.js";
import { printStatus, runIndexing } from "./indexer.js";

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
      process.env.STORY_INDEXER_ENV_PATH = candidate;
      return candidate;
    }
  }

  dotenv.config({ quiet: true });
  return null;
}

function ensureDirectory(folderPath: string): boolean {
  if (!existsSync(folderPath)) {
    return false;
  }
  return statSync(folderPath).isDirectory();
}

function resolveInputFolder(folder: string, envPath: string | null): string {
  const fromCwd = path.resolve(process.cwd(), folder);
  if (ensureDirectory(fromCwd)) {
    return fromCwd;
  }

  if (envPath) {
    const projectRoot = path.dirname(envPath);
    const fromProjectRoot = path.resolve(projectRoot, folder);
    if (ensureDirectory(fromProjectRoot)) {
      return fromProjectRoot;
    }
  }

  throw new Error(`Input folder not found: ${folder}`);
}

const loadedEnvPath = loadEnvFile();

const program = new Command();

program
  .name("story-indexer")
  .description("Local Story Library indexer for LM Studio + Cloudflare")
  .version("0.3.0");

program
  .command("index")
  .argument("<folder>", "Folder containing .txt/.html/.rtf/.doc/.docx/.pdf stories")
  .option("--changed-only", "Skip files when source path + RAW_HASH are unchanged", true)
  .option("--full", "Reprocess existing canonical stories (metadata/chunks/embeddings)", false)
  .option(
    "--metadata-fallback-only",
    "Reprocess only sources whose story STATUS_NOTES indicate metadata fallback was previously used",
    false,
  )
  .option("--force-reindex", "Override embedding model/dimension settings mismatch checks", false)
  .option("--profile", "Print timing profile in the run summary", false)
  .description("Index files in a folder (incremental by default)")
  .action(async (folder: string, options: { changedOnly?: boolean; full?: boolean; metadataFallbackOnly?: boolean; forceReindex?: boolean; profile?: boolean }) => {
    const config = loadConfig();
    const inputFolder = resolveInputFolder(folder, loadedEnvPath);
    const full = options.full === true;
    const metadataFallbackOnly = options.metadataFallbackOnly === true;
    const summary = await runIndexing(config, inputFolder, {
      changedOnly: full || metadataFallbackOnly ? false : options.changedOnly !== false,
      forceReindex: options.forceReindex === true,
      reprocessExisting: full || metadataFallbackOnly,
      metadataFallbackOnly,
      profile: options.profile === true,
    });
    console.log("\nIndex complete");
    console.log(JSON.stringify(summary, null, 2));
  });

program
  .command("status")
  .description("Show D1 corpus status")
  .action(async () => {
    const config = loadConfig();
    await printStatus(config);
  });

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unexpected failure";
  console.error(message);
  process.exitCode = 1;
});
