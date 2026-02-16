import { promises as fs } from "node:fs";
import path from "node:path";
import type { RunSummary, StoryRunResult } from "./types.js";

function csvEscape(value: string | number): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}

export async function writeTaggerReports(
  reportDir: string,
  summary: RunSummary,
  storyResults: StoryRunResult[],
): Promise<{ summaryPath: string; sampleCsvPath: string }> {
  await fs.mkdir(reportDir, { recursive: true });

  const summaryPath = path.join(reportDir, "tagger_summary.json");
  const sampleCsvPath = path.join(reportDir, "tagged_stories_sample.csv");

  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");

  const rows = ["story_id,tags_added,total_tags"];
  for (const result of storyResults.slice(0, 1000)) {
    if (!result.updated) {
      continue;
    }
    rows.push(
      [
        csvEscape(result.storyId),
        csvEscape(result.tagsAdded.join(" | ")),
        csvEscape(result.totalTags),
      ].join(","),
    );
  }

  await fs.writeFile(sampleCsvPath, `${rows.join("\n")}\n`, "utf8");

  return {
    summaryPath,
    sampleCsvPath,
  };
}
