import { writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Writes a stand-in for `name` into `bin` from a POSIX shell script and returns
 * the path a PATH lookup finds. Windows cannot run a script through its shebang,
 * so there the script gets a `name.cmd` launcher that runs it with Git for
 * Windows' `sh`.
 */
export async function writeFakeCommand(bin: string, name: string, script: string): Promise<string> {
  if (process.platform !== "win32") {
    const file = path.join(bin, name);
    await writeFile(file, script, { mode: 0o755 });
    return file;
  }
  const sh = Bun.which("sh");
  if (!sh) throw new Error("Fake commands need Git for Windows' sh on PATH: run the tests from Git Bash.");
  await writeFile(path.join(bin, `${name}.sh`), script);
  const file = path.join(bin, `${name}.cmd`);
  await writeFile(file, `@"${sh}" "%~dp0${name}.sh" %*\r\n`);
  return file;
}

/** `bin` ahead of the current PATH. */
export function pathWith(bin: string): string {
  return `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
}
