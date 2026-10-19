// Extracts each target's head tree into <eval dir>/trees/<head12> (git archive, no change
// to the source repo) and caches DiffLoupe outlines with resolved imports.
import fs from "node:fs";
import path from "node:path";
import { OutlineExtractor } from "../../src/review/core/lib/code-outline.ts";
import { detectLanguage } from "../../src/review/core/lib/languages.ts";
import { projectFilesFromDisk, resolveOutlineImports } from "../../src/review/core/lib/module-resolver.ts";
import { EXTRA_EXCLUDES } from "../../src/review/core/config.ts";
import { DATA, TREES, loadTargets, repoFor } from "./env.ts";

const EXCLUDE = ["node_modules/", "/dist/", "/build/", "/.next/", "/__snapshots__/", ".min.js", ".d.ts", ".js.map", "third-party/"];
const excluded = (p: string) => [...EXCLUDE, ...EXTRA_EXCLUDES].some((e) => p.includes(e) || (!e.startsWith("/") && p.startsWith(e)));

const extractor = await OutlineExtractor.create();
await extractor.warmup(["typescript", "tsx", "cpp"]);

const done = new Set<string>();
for (const t of loadTargets()) {
  const key = t.head.slice(0, 12);
  if (done.has(key)) continue;
  done.add(key);
  const tree = path.join(TREES, key);
  const repo = repoFor(t);
  if (!fs.existsSync(`${tree}/.done`)) {
    fs.mkdirSync(tree, { recursive: true });
    const r = Bun.spawnSync(["bash", "-c", `git -C '${repo}' archive ${t.head} | tar -x -C '${tree}'`]);
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    fs.writeFileSync(`${tree}/.done`, "");
  }
  const outFile = path.join(DATA, `outlines-${key}.json`);
  if (fs.existsSync(outFile)) {
    console.log(key, "cached");
    continue;
  }
  const all = Bun.spawnSync(["git", "-C", repo, "ls-tree", "-r", "--name-only", t.head]).stdout.toString().split("\n").filter(Boolean);
  const tracked = all.filter((p) => !excluded(p) && detectLanguage(p) !== null);
  const t0 = Date.now();
  const outlines = [];
  for (const rel of tracked) {
    try {
      const o = await extractor.parseFile(path.join(tree, rel), rel, tree);
      if (o) outlines.push(o);
    } catch {
      // Unparseable files are left out of the map, as in build-map.
    }
  }
  resolveOutlineImports(outlines, projectFilesFromDisk(tree, all));
  fs.writeFileSync(outFile, JSON.stringify({ all, outlines }));
  console.log(key, `${outlines.length} outlines in ${Date.now() - t0} ms`);
}
