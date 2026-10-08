import type { FileFacts, Link } from "./grouping.ts";
import {
  crossGroupLinkLines,
  groupLinkLines,
  hunkContextName,
  selectWalkFiles,
  sketchFiles,
  sketchLine,
} from "./walk-input.ts";

function fact(file: string, defined: string[] = []): FileFacts {
  return { file, tokens: 0, imports: [], defined, used: [] };
}

describe("hunkContextName", () => {
  it("names TypeScript, C++ and arrow-function contexts", () => {
    expect(hunkContextName("export async function processFiber(cx: Context) {")).toBe("processFiber");
    expect(hunkContextName("void Instrumentation::OnStackFunctionIDs(const Value& v) {")).toBe(
      "Instrumentation::OnStackFunctionIDs",
    );
    expect(hunkContextName("const handler = async (event) => {")).toBe("handler");
    expect(hunkContextName("export class BranchCache {")).toBe("BranchCache");
  });

  it("skips control keywords and returns nothing for plain text", () => {
    expect(hunkContextName("  if (ready) {")).toBeUndefined();
    expect(hunkContextName("")).toBeUndefined();
  });
});

describe("sketchFiles", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,2 +10,3 @@ export function oldThing() {",
    "-  a();",
    "-  b();",
    "+  a2();",
    "+  b2();",
    "+  c2();",
    "@@ -40,0 +41,2 @@ export class Holder {",
    "+export function newThing() {",
    "+}",
    "",
  ].join("\n");

  it("counts lines, names edited functions with their first line, and drops ones the diff defines", () => {
    const s = sketchFiles(diff, [fact("src/a.ts", ["newThing", "Holder"])]).get("src/a.ts")!;
    expect(s).toMatchObject({ added: 5, removed: 2, defines: ["newThing", "Holder"] });
    expect(s.touches).toEqual([{ name: "oldThing", line: 10 }]);
    expect(sketchLine(s)).toBe("- `src/a.ts` (+5 −2): adds `newThing`, `Holder`; edits in `oldThing@10`");
  });

  it("caps the names it lists", () => {
    const s = { file: "x.ts", added: 1, removed: 0, defines: ["a", "b", "c"], touches: [] };
    expect(sketchLine(s, 2)).toBe("- `x.ts` (+1 −0): adds `a`, `b`, +1 more");
  });
});

describe("selectWalkFiles", () => {
  const tokens = new Map([
    ["g1/big.ts", 500],
    ["g1/small.ts", 50],
    ["g2/main.ts", 300],
    ["g2/side.ts", 40],
    ["g3/huge.ts", 5000],
    ["g3/tiny.ts", 10],
  ]);
  const groups = [
    { files: ["g1/big.ts", "g1/small.ts"] },
    { files: ["g2/main.ts", "g2/side.ts"] },
    { files: ["g3/huge.ts", "g3/tiny.ts"] },
  ];

  it("shows everything when it fits", () => {
    const r = selectWalkFiles(groups.slice(0, 2), tokens, 10_000);
    expect(r.sketched).toEqual([]);
  });

  it("gives every group a share before any group gets more, and never shows an oversized file", () => {
    const r = selectWalkFiles(groups, tokens, 900, 400);
    // Share is 300 a group: g2's main file fills its share, g1's big file is over the file cap.
    expect(r.shown).toContain("g2/main.ts");
    expect(r.shown).toContain("g3/tiny.ts");
    expect(r.sketched).toContain("g3/huge.ts");
    // What is left after the shares goes to the smallest files first.
    expect(r.shown).toContain("g1/small.ts");
    expect(r.shown).toContain("g2/side.ts");
    expect(r.sketched).toContain("g1/big.ts");
    expect([...r.shown, ...r.sketched].sort()).toEqual([...tokens.keys()].sort());
  });
});

describe("link lines", () => {
  const links: Link[] = [
    { from: "a/x.ts", to: "b/y.ts", kind: "symbol", weight: 4, names: ["makeThing"] },
    { from: "a/x.ts", to: "a/z.ts", kind: "import", weight: 2 },
    { from: "a/x.ts", to: "a/w.ts", kind: "dir", weight: 0.25 },
  ];
  const groups = [
    { id: "alpha", files: ["a/x.ts", "a/z.ts", "a/w.ts"] },
    { id: "beta", files: ["b/y.ts"] },
  ];

  it("lists a group's own links without directory links", () => {
    expect(groupLinkLines(groups[0].files, links)).toEqual(["`a/x.ts` imports `a/z.ts`"]);
  });

  it("lists links between groups with both group ids", () => {
    expect(crossGroupLinkLines(groups, links)).toEqual([
      "`a/x.ts` uses `makeThing`, added in `b/y.ts` (alpha → beta)",
    ]);
  });
});
