
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { countLines } from "./io.ts";

// The pipeline rejects a finding that cites a line past the end of the file. An
// off-by-one here let a finding at line N+1 of an N-line file through
// verification and on to GitHub, which then refuses the whole review.
describe("countLines", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "code-review-io-"));
  const write = (name: string, content: string) => {
    const p = path.join(dir, name);
    writeFileSync(p, content);
    return p;
  };

  it("does not count the newline that ends the last line", async () => {
    expect(await countLines(write("a", "one\ntwo\nthree\n"))).toBe(3);
  });

  it("counts a file with no trailing newline", async () => {
    expect(await countLines(write("b", "one\ntwo\nthree"))).toBe(3);
  });

  it("counts one line", async () => {
    expect(await countLines(write("c", "only\n"))).toBe(1);
    expect(await countLines(write("d", "only"))).toBe(1);
  });

  it("counts an empty file as no lines", async () => {
    expect(await countLines(write("e", ""))).toBe(0);
  });

  it("counts a trailing blank line", async () => {
    expect(await countLines(write("f", "one\n\n"))).toBe(2);
  });

  it("returns nothing for a file that is not there", async () => {
    expect(await countLines(path.join(dir, "missing"))).toBeNull();
  });
});
