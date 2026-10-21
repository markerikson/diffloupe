import { describe, expect, test } from "bun:test";
import { marker } from "./core/lib/marker.ts";
import { checkedEndpoints, linkDetailArtifact, postPayloads, type ApiResult, type Payloads } from "./post.ts";

const SLUG = "acme/app";
const HEAD = "0123456789abcdef0123456789abcdef01234567";

function payloads(over: Partial<Payloads> = {}): Payloads {
  return {
    summary: {
      method: "POST",
      endpoint: `repos/${SLUG}/issues/7/comments`,
      body: { body: `📄 **[Full review detail](https://github.com/acme/app/actions/runs/1)**\n\n${marker("summary", { pr: 7, head: HEAD })}` },
    },
    review: {
      method: "POST",
      endpoint: `repos/${SLUG}/pulls/7/reviews`,
      body: {
        commit_id: HEAD,
        event: "COMMENT",
        comments: [
          { path: "a.ts", line: 3, side: "RIGHT", body: `one\n${marker("inline", { fp: "aaaaaaaaaa" })}` },
          { path: "b.ts", line: 9, side: "RIGHT", body: `two\n${marker("inline", { fp: "bbbbbbbbbb" })}` },
        ],
      },
    },
    replies: [{ method: "POST", endpoint: `repos/${SLUG}/pulls/7/comments/55/replies`, body: { body: "thanks" } }],
    ...over,
  };
}

function fakeGh(lists: Record<string, unknown[]> = {}, fail: Record<string, number> = {}) {
  const sent: { method: string; endpoint: string; body: unknown }[] = [];
  const lines: string[] = [];
  const deps = {
    send: async (method: string, endpoint: string, body?: unknown): Promise<ApiResult> => {
      sent.push({ method, endpoint, body });
      const status = fail[endpoint];
      return status ? { ok: false, status, data: null, stderr: `HTTP ${status}` } : { ok: true, status: 200, data: { id: 1 }, stderr: "" };
    },
    list: async (endpoint: string) => lists[endpoint] ?? [],
    log: (line: string) => lines.push(line),
  };
  return { deps, sent, lines };
}

describe("checkedEndpoints", () => {
  test("accepts endpoints for the trusted pull request", () => {
    const t = checkedEndpoints(payloads(), SLUG, "7");
    expect(t.replies[0]?.endpoint).toBe(`repos/${SLUG}/pulls/7/comments/55/replies`);
  });

  test("refuses a payload aimed at another pull request or host", () => {
    expect(() => checkedEndpoints(payloads(), SLUG, "8")).toThrow("refusing to send");
    const p = payloads({ replies: [{ method: "POST", endpoint: "https://evil.example/x", body: {} }] });
    expect(() => checkedEndpoints(p, SLUG, "7")).toThrow("does not target PR #7");
  });
});

test("linkDetailArtifact swaps the run link for the artifact", () => {
  const body = "📄 **[Full review detail](https://github.com/a/b/actions/runs/1)** — download";
  expect(linkDetailArtifact(body, "https://x/artifacts/9")).toContain("[Full review detail](https://x/artifacts/9)");
  expect(linkDetailArtifact(body, " ")).toBe(body);
});

describe("postPayloads", () => {
  const target = { slug: SLUG, pr: "7", head: HEAD, artifactUrl: "https://x/artifacts/9" };

  test("creates the summary, posts the review as COMMENT, and sends replies", async () => {
    const gh = fakeGh();
    const failures = await postPayloads(payloads(), target, { dryRun: false, deps: gh.deps });
    expect(failures).toBe(0);
    expect(gh.sent.map((s) => `${s.method} ${s.endpoint}`)).toEqual([
      `POST repos/${SLUG}/issues/7/comments`,
      `POST repos/${SLUG}/pulls/7/reviews`,
      `POST repos/${SLUG}/pulls/7/comments/55/replies`,
    ]);
    expect(JSON.stringify(gh.sent[0]?.body)).toContain("https://x/artifacts/9");
    expect(gh.sent[1]?.body).toMatchObject({ commit_id: HEAD, event: "COMMENT" });
  });

  test("updates the bot's own summary and skips findings already posted", async () => {
    const own = { id: 42, body: `old\n${marker("summary", { pr: 7 })}`, user: { type: "Bot" } };
    const quoted = { id: 43, body: `> ${marker("summary", { pr: 7 })}`, user: { type: "User" } };
    const gh = fakeGh({
      [`repos/${SLUG}/issues/7/comments`]: [own, quoted],
      [`repos/${SLUG}/pulls/7/comments`]: [{ id: 5, body: `x\n${marker("inline", { fp: "aaaaaaaaaa" })}`, user: { type: "Bot" } }],
    });
    await postPayloads(payloads(), target, { dryRun: false, deps: gh.deps });
    expect(gh.sent[0]).toMatchObject({ method: "PATCH", endpoint: `repos/${SLUG}/issues/comments/42` });
    const review = gh.sent[1]?.body as { comments: { path: string }[] };
    expect(review.comments.map((c) => c.path)).toEqual(["b.ts"]);
  });

  test("a rejected batch falls back to one comment at a time", async () => {
    const gh = fakeGh({}, { [`repos/${SLUG}/pulls/7/reviews`]: 422 });
    const failures = await postPayloads(payloads({ replies: [] }), target, { dryRun: false, deps: gh.deps });
    expect(failures).toBe(0);
    expect(gh.sent.filter((s) => s.endpoint === `repos/${SLUG}/pulls/7/comments`)).toHaveLength(2);
  });

  test("a dry run reads but sends nothing", async () => {
    const gh = fakeGh();
    const failures = await postPayloads(payloads(), target, { dryRun: true, deps: gh.deps });
    expect(failures).toBe(0);
    expect(gh.sent).toEqual([]);
    expect(gh.lines.some((l) => l.includes("[dry-run] POST"))).toBe(true);
  });

  test("a failed summary lookup skips the summary but still sends the rest", async () => {
    const gh = fakeGh();
    const list = gh.deps.list;
    gh.deps.list = async (endpoint) => {
      if (endpoint.includes("/issues/")) throw new Error("HTTP 502");
      return list(endpoint);
    };
    const failures = await postPayloads(payloads(), target, { dryRun: false, deps: gh.deps });
    expect(failures).toBe(1);
    expect(gh.sent.map((s) => s.endpoint)).not.toContain(`repos/${SLUG}/issues/7/comments`);
    expect(gh.sent).toHaveLength(2);
  });
});
