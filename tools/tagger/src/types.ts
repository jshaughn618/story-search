export interface RawTagRule {
  tag: string;
  anyOf: string[];
  minCount?: number;
  caseSensitive?: boolean;
  matchWholeWord?: boolean;
}

export interface CompiledMatcher {
  term: string;
  regex: RegExp;
}

export interface CompiledTagRule {
  tag: string;
  minCount: number;
  caseSensitive: boolean;
  matchWholeWord?: boolean;
  matchers: CompiledMatcher[];
}

export interface CliOptions {
  rulesPath: string;
  sourceDir: string;
  overwrite: boolean;
  dryRun: boolean;
  onlyStoryId: string | null;
  rulesetVersion: string | null;
  maxFiles: number | null;
  minWordCount: number;
  reportOutDir: string;
}

export interface StoryTagRow {
  STORY_ID: string;
  TAGS_JSON: string | null;
  WORD_COUNT: number | null;
  TAG_SOURCES_JSON?: string | null;
  TAG_RULESET_VERSION?: string | null;
}

export interface StoryUpdate {
  storyId: string;
  tags: string[];
  tagSources: Record<string, string>;
  rulesetVersion: string;
}

export interface StoryRunResult {
  storyId: string;
  totalTags: number;
  tagsAdded: string[];
  appliedRuleTags: string[];
  updated: boolean;
  skippedReason?: string;
}

export interface RunSummary {
  generatedAt: string;
  rulesetVersion: string;
  totalStoriesDiscovered: number;
  totalStoriesScanned: number;
  totalStoriesUpdated: number;
  totalStoriesSkipped: number;
  totalTagsApplied: number;
  tagsAppliedByTag: Record<string, number>;
  topTags: Array<{ tag: string; count: number }>;
  dryRun: boolean;
}

export interface D1Capabilities {
  hasTagSourcesJson: boolean;
  hasTagRulesetVersion: boolean;
}
