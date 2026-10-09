import {
  applyGroupNaming,
  crossLinksFor,
  groupFiles,
  isDistinctiveName,
  linkFiles,
  type FileFacts,
} from "./grouping.ts";

function fact(file: string, o: Partial<Omit<FileFacts, "file">> = {}): FileFacts {
  return { file, tokens: 100, imports: [], defined: [], used: [], ...o };
}

function groupOf(files: string[][], f: string): number {
  return files.findIndex((g) => g.includes(f));
}

describe("isDistinctiveName", () => {
  it("accepts coined names and rejects short, generic or plain words", () => {
    expect(isDistinctiveName("getLastCurrentTreePointBeforeOrEquals")).toBe(true);
    expect(isDistinctiveName("MAX_ITEMS")).toBe(true);
    expect(isDistinctiveName("getX")).toBe(false);
    expect(isDistinctiveName("process")).toBe(false);
    expect(isDistinctiveName("toString", new Set(["toString"]))).toBe(false);
  });
});

describe("linkFiles", () => {
  it("links a file using a name to the file that adds it", () => {
    const links = linkFiles([
      fact("a/use.ts", { used: ["computeThingValue"] }),
      fact("b/def.ts", { defined: ["computeThingValue"] }),
    ]);
    expect(links).toEqual([
      expect.objectContaining({ from: "a/use.ts", to: "b/def.ts", kind: "symbol", names: ["computeThingValue"] }),
    ]);
  });

  it("ignores a name defined by three files and a file using its own name", () => {
    const links = linkFiles([
      fact("a.ts", { defined: ["sharedHelperName"], used: ["sharedHelperName"] }),
      fact("x/b.ts", { defined: ["sharedHelperName"] }),
      fact("y/c.ts", { defined: ["sharedHelperName"] }),
      fact("z/d.ts", { used: ["sharedHelperName"] }),
    ]);
    expect(links.filter((l) => l.kind === "symbol")).toEqual([]);
  });

  it("pairs a test with its source and a header with its implementation", () => {
    const links = linkFiles([
      fact("src/foo.ts"),
      fact("src/foo.test.ts"),
      fact("cpp/Bar.h"),
      fact("cpp/Bar.cpp"),
    ]);
    const pairs = links.filter((l) => l.kind === "pair").map((l) => [l.from, l.to].sort());
    expect(pairs).toEqual(
      expect.arrayContaining([
        ["src/foo.test.ts", "src/foo.ts"],
        ["cpp/Bar.cpp", "cpp/Bar.h"],
      ]),
    );
  });
});

describe("groupFiles", () => {
  it("keeps a symbol link even when an import of equal weight comes first", () => {
    // The #13157 shape: a small file imports one file and calls a method added
    // in another. The import must not take the room the call needed.
    const facts = [
      fact("caches/react.ts", { tokens: 130, imports: ["tools/exception.ts"], used: ["getLastTreePoint"] }),
      fact("tools/exception.ts", { tokens: 9000 }),
      fact("react/phases.ts", { tokens: 9000, defined: ["getLastTreePoint"] }),
    ];
    const links = linkFiles(facts);
    const { groups } = groupFiles(facts, links, { budget: 12000 });
    const files = groups.map((g) => g.files);
    expect(groupOf(files, "caches/react.ts")).toBe(groupOf(files, "react/phases.ts"));
  });

  it("moves a small file to the group its symbol links point into", () => {
    const facts = [
      fact("a/small.ts", { tokens: 50, imports: ["a/big.ts"], used: ["specialHelperFn"] }),
      fact("a/big.ts", { tokens: 5000, used: ["otherNameHere"] }),
      fact("a/peer.ts", { tokens: 100, defined: ["otherNameHere"] }),
      fact("b/target.ts", { tokens: 5000, defined: ["specialHelperFn"] }),
    ];
    const links = linkFiles(facts);
    const { groups } = groupFiles(facts, links, { budget: 10000, target: 5200 });
    const files = groups.map((g) => g.files);
    expect(groupOf(files, "a/small.ts")).toBe(groupOf(files, "b/target.ts"));
  });

  it("caps the file count so a small pull request does not become one group", () => {
    const facts = Array.from({ length: 12 }, (_, i) =>
      fact(`pkg/f${i}.ts`, { imports: i ? [`pkg/f${i - 1}.ts`] : [] }),
    );
    const { groups } = groupFiles(facts, linkFiles(facts), { budget: 100_000, maxFiles: 5 });
    expect(groups.length).toBeGreaterThan(1);
    expect(Math.max(...groups.map((g) => g.files.length))).toBeLessThanOrEqual(5);
  });

  it("merges the smallest groups when over maxGroups, within the budget", () => {
    const facts = Array.from({ length: 6 }, (_, i) => fact(`d${i}/f.ts`, { tokens: 1000 * (i + 1) }));
    const { groups } = groupFiles(facts, linkFiles(facts), { budget: 8000, maxGroups: 3 });
    expect(groups.length).toBeLessThanOrEqual(4);
    expect(groups.every((g) => g.tokens <= 8000 || g.files.length === 1)).toBe(true);
    expect(groups.flatMap((g) => g.files).sort()).toEqual(facts.map((f) => f.file).sort());
  });

  it("folds a lone small file into a full group when the budget allows", () => {
    // A 10-file unit plus one 3,000-token test file, which got its own reviewer.
    const facts = [
      ...Array.from({ length: 10 }, (_, i) =>
        fact(`src/warm/f${i}.ts`, { tokens: 2900, imports: i ? [`src/warm/f${i - 1}.ts`] : [] }),
      ),
      fact("src/guidance/journey/file-bug.test.ts", { tokens: 3000 }),
    ];
    const opts = { budget: 42_000, maxFiles: 12 };
    expect(groupFiles(facts, linkFiles(facts), opts).groups).toHaveLength(1);
    expect(groupFiles(facts, linkFiles(facts), { ...opts, foldSmall: false }).groups).toHaveLength(2);
  });

  it("does not fold a small file into a group over the budget", () => {
    const facts = [
      fact("src/big/a.ts", { tokens: 40_000 }),
      fact("src/other/c.test.ts", { tokens: 3000 }),
    ];
    const { groups } = groupFiles(facts, linkFiles(facts), { budget: 42_000 });
    expect(groups.map((g) => g.files)).toEqual([["src/big/a.ts"], ["src/other/c.test.ts"]]);
  });

  it("splits a mixed C++ and TypeScript group by language and reports the cut link", () => {
    // The #13193 shape: C++ producers of stats, TypeScript consumers.
    const facts = [
      fact("cpp/Instr.cpp", { tokens: 5000, used: ["SmallHitList"] }),
      fact("cpp/Instr.h", { tokens: 100, defined: ["StackStatsType"] }),
      fact("cpp/Scan.h", { tokens: 300, defined: ["SmallHitList"] }),
      fact("ts/child.ts", { tokens: 400, used: ["StackStatsType", "statsResultField"] }),
      fact("ts/manifests.ts", { tokens: 400, defined: ["statsResultField"] }),
    ];
    const { groups, cut } = groupFiles(facts, linkFiles(facts), { budget: 25_000 });
    expect(groups.map((g) => g.files)).toEqual([
      ["cpp/Instr.cpp", "cpp/Instr.h", "cpp/Scan.h"],
      ["ts/child.ts", "ts/manifests.ts"],
    ]);
    expect(cut).toEqual([expect.objectContaining({ from: "ts/child.ts", to: "cpp/Instr.h" })]);
  });

  it("leaves a lone file in another language with its group", () => {
    const facts = [
      fact("cpp/A.cpp", { used: ["SharedThingOne"] }),
      fact("cpp/B.h", { defined: ["SharedThingOne", "SharedThingTwo"] }),
      fact("cpp/C.cpp", { used: ["SharedThingTwo", "ScriptValueName"] }),
      fact("ts/d.ts", { defined: ["ScriptValueName"] }),
    ];
    const { groups } = groupFiles(facts, linkFiles(facts), { budget: 25_000 });
    expect(groups).toHaveLength(1);
  });

  it("reports links between groups as cuts and never drops a file", () => {
    const facts = [
      fact("x/a.ts", { tokens: 900, used: ["largeThingName"] }),
      fact("y/b.ts", { tokens: 900, defined: ["largeThingName"] }),
    ];
    const { groups, cut } = groupFiles(facts, linkFiles(facts), { budget: 1000 });
    expect(groups).toHaveLength(2);
    expect(cut).toEqual([expect.objectContaining({ kind: "symbol" })]);
  });
});

describe("crossLinksFor", () => {
  it("lists symbol links before imports and leaves out directory links", () => {
    const links = linkFiles([
      fact("a/one.ts", { imports: ["b/two.ts"] }),
      fact("b/two.ts"),
      fact("a/three.ts", { used: ["namedExportX"] }),
      fact("c/four.ts", { defined: ["namedExportX"] }),
    ]);
    const lines = crossLinksFor(["a/one.ts", "a/three.ts"], links);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("namedExportX");
    expect(lines[1]).toContain("imports");
  });
});

describe("applyGroupNaming", () => {
  const groups = [
    { id: "g1", files: ["a.ts", "b.ts"], tokens: 200, links: [] },
    { id: "g2", files: ["c.ts"], tokens: 100, links: [] },
  ];
  const tokens = new Map([["a.ts", 100], ["b.ts", 100], ["c.ts", 100]]);

  it("applies titles, rationale and priority, and keeps ids as titles when unnamed", () => {
    const { units } = applyGroupNaming(
      groups,
      { groups: [{ id: "g1", title: "Auth flow", rationale: "Checks tokens.", priority: 1 }, { id: "nope", title: "x" }] },
      1000,
      tokens,
    );
    expect(units).toEqual([
      { id: "g1", title: "Auth flow", rationale: "Checks tokens.", files: ["a.ts", "b.ts"], priority: 1 },
      { id: "g2", title: "g2", files: ["c.ts"] },
    ]);
  });

  it("applies a valid move and skips moves that are unknown, oversized or empty a group", () => {
    const { units, moves } = applyGroupNaming(
      groups,
      {
        moves: [
          { file: "a.ts", to: "g2", reason: "belongs there" },
          { file: "zzz.ts", to: "g2" },
          { file: "b.ts", to: "missing" },
          { file: "b.ts", to: "g2" },
        ],
      },
      250,
      tokens,
    );
    expect(moves).toEqual([{ file: "a.ts", from: "g1", to: "g2", reason: "belongs there" }]);
    expect(units.map((u) => u.files)).toEqual([["b.ts"], ["a.ts", "c.ts"]]);
  });

  it("survives a malformed answer", () => {
    const { units, moves } = applyGroupNaming(
      groups,
      { groups: [{ id: 3 }], moves: [{ file: 1, to: null }] } as never,
      1000,
      tokens,
    );
    expect(moves).toEqual([]);
    expect(units.map((u) => u.title)).toEqual(["g1", "g2"]);
  });
});
