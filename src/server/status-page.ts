/**
 * The page served when no web UI is built: the run list and the live event
 * log of the selected (or active) run. `/runs/<id>` selects a run.
 */
export const STATUS_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>DiffLoupe</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; margin: 0; display: flex; height: 100vh; color: #ddd; background: #1b1d21; }
  nav { width: 22rem; overflow: auto; border-right: 1px solid #333; padding: .5rem; }
  main { flex: 1; overflow: auto; padding: .5rem 1rem; }
  a { color: #8cb4ff; text-decoration: none; display: block; padding: .25rem; border-radius: 4px; }
  a.sel { background: #2c3340; }
  .st { font-size: 12px; color: #999; }
  .running { color: #e5c07b; } .complete { color: #98c379; } .failed { color: #e06c75; } .cancelled { color: #999; }
  pre { margin: 0; white-space: pre-wrap; font: 12px/1.5 ui-monospace, monospace; }
  button { margin: .5rem 0; }
</style>
</head>
<body>
<nav><h3>Runs</h3><div id="runs"></div></nav>
<main><h3 id="title">No run selected</h3><button id="cancel" hidden>Cancel run</button><pre id="log"></pre></main>
<script>
let selected = location.pathname.match(/^\\/runs\\/([^/]+)/)?.[1] ?? null;
let source = null;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
function line(e) {
  if (e.type === "stage") return "» " + e.stage.replaceAll("_", " ");
  if (e.type === "log") return e.message;
  if (e.type === "slice") return "  [" + (e.index + 1) + "/" + e.total + "] " + e.status + " " + e.title + (e.costUsd != null ? " $" + e.costUsd.toFixed(2) : "");
  if (e.type === "budget") return "  cost limit reached at $" + e.totalUsd.toFixed(2) + "; " + e.skippedSlices + " slice(s) not started";
  if (e.type === "done" && e.roundLimit) return "Not reviewed: this change already had " + e.roundLimit + " round(s) of review (--max-rounds).";
  if (e.type === "done" && e.noChanges) return "No code changes to review.";
  if (e.type === "done") return (e.carriedOver ? (e.findings - e.carriedOver) + " new finding(s), " + e.carriedOver + " carried over" : e.findings + " finding(s)") + " · $" + e.costUsd.toFixed(2) + " · " + Math.round(e.wallMs / 1000) + "s";
  if (e.type === "cancelled") return "Cancelled.";
  if (e.type === "error") return "Failed: " + e.message;
  return null;
}
async function loadRuns() {
  const [runs, health] = await Promise.all([fetch("/api/runs").then((r) => r.json()), fetch("/api/health").then((r) => r.json())]);
  if (!selected) selected = health.activeRunId ?? runs[0]?.id ?? null;
  $("runs").innerHTML = runs.map((r) => '<a href="/runs/' + esc(r.id) + '" class="' + (r.id === selected ? "sel" : "") + '">' + esc(r.id) +
    '<div class="st"><span class="' + esc(r.status) + '">' + esc(r.status) + "</span> · " + esc(Object.values(r.findingCounts ?? {}).reduce((a, b) => a + b, 0)) + " finding(s) · $" + (r.costUsd ?? 0).toFixed(2) + "</div></a>").join("");
  $("cancel").hidden = !selected || health.activeRunId !== selected;
  return health;
}
function follow(id) {
  if (source) source.close();
  $("log").textContent = "";
  $("title").textContent = id;
  source = new EventSource("/api/runs/" + encodeURIComponent(id) + "/events");
  source.onmessage = () => {};
  for (const type of ["stage", "log", "slice", "budget", "done", "cancelled", "error"]) {
    source.addEventListener(type, (m) => {
      const text = line(JSON.parse(m.data));
      if (text != null) $("log").textContent += text + "\\n";
      if (type === "done" || type === "cancelled" || type === "error") loadRuns();
    });
  }
  source.addEventListener("end", () => source.close());
}
$("cancel").onclick = () => fetch("/api/runs/" + encodeURIComponent(selected) + "/cancel", { method: "POST" });
loadRuns().then(() => { if (selected) follow(selected); });
setInterval(loadRuns, 5000);
</script>
</body>
</html>
`;
