#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { loadConfig } from "./config.js";
import { printStatus, runIndexing } from "./indexer.js";

const program = new Command();

program
  .name("story-indexer")
  .description("Local Story Library indexer for LM Studio + Cloudflare")
  .version("0.3.0");

program
  .command("index")
  .argument("<folder>", "Folder containing .txt/.html/.rtf/.doc/.docx/.pdf stories")
  .option("--force-reindex", "Override embedding model/dimension settings mismatch checks", false)
  .description("Index all files in a folder")
  .action(async (folder: string, options: { forceReindex?: boolean }) => {
    const config = loadConfig();
    const summary = await runIndexing(config, folder, {
      changedOnly: false,
      forceReindex: options.forceReindex === true,
    });
    console.log("\nIndex complete");
    console.log(JSON.stringify(summary, null, 2));
  });

program
  .command("reindex")
  .argument("<folder>", "Folder containing .txt/.html/.rtf/.doc/.docx/.pdf stories")
  .option("--changed-only", "Skip files when source path + RAW_HASH are unchanged", true)
  .option("--force-reindex", "Override embedding model/dimension settings mismatch checks", false)
  .description("Re-index files, optimized for changed inputs")
  .action(async (folder: string, options: { changedOnly?: boolean; forceReindex?: boolean }) => {
    const config = loadConfig();
    const summary = await runIndexing(config, folder, {
      changedOnly: options.changedOnly !== false,
      forceReindex: options.forceReindex === true,
    });
    console.log("\nReindex complete");
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
