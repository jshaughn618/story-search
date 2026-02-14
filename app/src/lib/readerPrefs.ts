import type { ReaderPreferences } from "../types";

const STORAGE_KEY = "story-library-reader-prefs";

export const defaultReaderPreferences: ReaderPreferences = {
  theme: "light",
  width: "medium",
  lineHeight: "normal",
  fontSize: 19,
};

export function loadReaderPreferences(): ReaderPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return defaultReaderPreferences;
    }
    const parsed = JSON.parse(raw) as Partial<ReaderPreferences>;
    return {
      theme: parsed.theme ?? defaultReaderPreferences.theme,
      width: parsed.width ?? defaultReaderPreferences.width,
      lineHeight: parsed.lineHeight ?? defaultReaderPreferences.lineHeight,
      fontSize:
        typeof parsed.fontSize === "number" && parsed.fontSize >= 14 && parsed.fontSize <= 34
          ? parsed.fontSize
          : defaultReaderPreferences.fontSize,
    };
  } catch {
    return defaultReaderPreferences;
  }
}

export function saveReaderPreferences(preferences: ReaderPreferences) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}
