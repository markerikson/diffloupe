/** Filesystem helpers. Writes create their parent directory. */
import { promises as fs } from "node:fs";
import path from "node:path";

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export function readText(p: string): Promise<string> {
  return fs.readFile(p, "utf8");
}

export async function readJson<T = unknown>(p: string): Promise<T> {
  return JSON.parse(await readText(p)) as T;
}

export async function writeText(p: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, contents, "utf8");
}

export async function writeJson(p: string, value: unknown): Promise<void> {
  await writeText(p, JSON.stringify(value, null, 2));
}

export async function removeIfPresent(p: string): Promise<void> {
  await fs.rm(p, { force: true });
}

export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

/**
 * Line count of a file, or null when it does not exist.
 *
 * The trailing newline is dropped before splitting. Keeping it counts a final
 * empty element, and the caller uses this to reject findings cited past the end
 * of a file — with an inflated count, a citation one line past EOF survives.
 */
export async function countLines(p: string): Promise<number | null> {
  try {
    const text = await readText(p);
    if (text === "") return 0;
    return text.replace(/\n$/, "").split("\n").length;
  } catch {
    return null;
  }
}
