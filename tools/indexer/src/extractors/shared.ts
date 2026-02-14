import { execFile } from "node:child_process";
import { promisify } from "node:util";
import iconv from "iconv-lite";

const execFileAsync = promisify(execFile);

export interface DecodedText {
  text: string;
  method: "utf8" | "iconv_fallback";
  notes: string[];
}

export function decodeTextBuffer(bytes: Buffer): DecodedText {
  const notes: string[] = [];
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return { text: decoder.decode(bytes), method: "utf8", notes };
  } catch {
    notes.push("UTF-8 decode failed; used iconv windows-1252 fallback");
    return {
      text: iconv.decode(bytes, "windows-1252"),
      method: "iconv_fallback",
      notes,
    };
  }
}

export async function runCommand(command: string, args: string[], maxBuffer = 1024 * 1024 * 50) {
  try {
    const result = await execFileAsync(command, args, { maxBuffer, encoding: "utf8" });
    return {
      ok: true as const,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return {
      ok: false as const,
      stdout: nodeError.stdout ?? "",
      stderr: nodeError.stderr ?? nodeError.message,
      code: nodeError.code,
    };
  }
}
