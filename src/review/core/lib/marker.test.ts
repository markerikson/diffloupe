
import { findMarker, fingerprint, isOwnComment, marker, readMarker, readMarkers, readResponses, stripMarkers } from "./marker.ts";

describe("fingerprint", () => {
  // The model rewrites a title slightly on every run — capitalization, an added
  // article, a moved backtick. Keying on the exact string would refire the
  // finding on the next push, which is the failure this whole scheme exists to
  // prevent.
  it("ignores the wording changes a rerun produces", () => {
    const base = fingerprint("a.ts", "Handle the null case");
    expect(fingerprint("a.ts", "handle the null case")).toBe(base);
    expect(fingerprint("a.ts", "  Handle   the null case  ")).toBe(base);
    expect(fingerprint("a.ts", "Handle the `null` case.")).toBe(base);
  });

  it("separates different claims and different files", () => {
    expect(fingerprint("a.ts", "one")).not.toBe(fingerprint("a.ts", "two"));
    expect(fingerprint("a.ts", "one")).not.toBe(fingerprint("b.ts", "one"));
  });

  // Keyed on the claim, not the location: a finding that survives a rebase with
  // its line number shifted is still the same thing already said.
  it("does not depend on a line number", () => {
    expect(fingerprint("a.ts", "same claim")).toBe(fingerprint("a.ts", "same claim"));
  });

  it("does not let the file and title run together", () => {
    expect(fingerprint("a", "bc")).not.toBe(fingerprint("ab", "c"));
  });

  it("is short hex", () => {
    expect(fingerprint("a.ts", "x")).toMatch(/^[0-9a-f]{10}$/);
  });
});

// A GitHub Action reads these comments back with its own code. Changing the
// hash or the marker text makes every earlier comment look foreign: the next
// push posts a second summary and re-reports every finding.
describe("pinned formats", () => {
  it("keeps the fingerprint value", () => {
    expect(fingerprint("src/a.ts", "Handle the null case")).toBe("b1353373b9");
  });

  it("keeps the marker text", () => {
    expect(marker("inline", { file: "src/a.ts", line: "12", fp: "abc1234567" })).toBe(
      "<!-- ai-review kind=inline file=src/a.ts line=12 fp=abc1234567 -->",
    );
    expect(marker("summary", { pr: "42", runs: "2", head: "0123456789abcdef0123456789abcdef01234567" })).toBe(
      "<!-- ai-review kind=summary pr=42 runs=2 head=0123456789abcdef0123456789abcdef01234567 -->",
    );
  });
});

describe("marker", () => {
  it("round-trips its fields", () => {
    const m = readMarker(marker("inline", { file: "a.ts", line: "12", fp: "abc123" }));
    expect(m).toEqual({ kind: "inline", fields: { file: "a.ts", line: "12", fp: "abc123" } });
  });

  // An early version stripped every hyphen to keep `-->` unformable, which
  // turned `cost-rollup` into `cost_rollup` and broke the paths in the markers.
  it("keeps hyphens in a path", () => {
    const m = readMarker(marker("inline", { file: "charts/cost-rollup/values-prod.yaml" }));
    expect(m!.fields.file).toBe("charts/cost-rollup/values-prod.yaml");
  });

  it("cannot be made to close itself early", () => {
    const body = marker("summary", { pr: "a-->b--c" });
    expect(body.match(/-->/g)).toHaveLength(1);
    expect(readMarker(body)!.fields.pr).toBe("a-_b-c");
  });

  it("returns nothing for text that carries no marker", () => {
    expect(readMarker("just a comment from a person")).toBeNull();
    expect(readMarkers("just a comment from a person")).toEqual([]);
  });

  it("returns nothing for an unrecognized kind", () => {
    expect(readMarker("<!-- ai-review kind=something-else -->")).toBeNull();
  });
});

// A summary comment carries one marker per off-diff finding plus its own. A
// reader that stops at the first one stops at a summary-item, fails to
// recognize the comment as the bot's own, and posts a second summary on the
// next push instead of editing this one.
describe("reading a body with several markers", () => {
  const summary = [
    "# Review",
    "#### Something outside the diff",
    marker("summary-item", { file: "a.ts", line: "9", fp: "1111111111" }),
    "#### Another",
    marker("summary-item", { file: "b.ts", line: "4", fp: "2222222222" }),
    marker("summary", { pr: "13204", runs: "3" }),
  ].join("\n\n");

  it("finds every marker in order", () => {
    expect(readMarkers(summary).map((m) => m.kind)).toEqual(["summary-item", "summary-item", "summary"]);
  });

  it("strips every marker for a local read", () => {
    expect(stripMarkers(summary)).toBe("# Review\n\n#### Something outside the diff\n\n#### Another");
    expect(stripMarkers(`Fixed. ${marker("reply", { of: "1" })}`)).toBe("Fixed.");
  });

  it("finds a later marker by kind", () => {
    expect(findMarker(summary, "summary")!.fields).toEqual({ pr: "13204", runs: "3" });
  });

  it("still recognizes the comment as the bot's own", () => {
    expect(isOwnComment(summary, "Bot", "summary")).toBe(true);
  });

  it("collects the claims already reported in the summary", () => {
    const claims = readMarkers(summary)
      .filter((m) => m.kind === "summary-item")
      .map((m) => m.fields.fp);
    expect(claims).toEqual(["1111111111", "2222222222"]);
  });
});

describe("isOwnComment", () => {
  const body = marker("inline", { file: "a.ts", line: "1", fp: "abc" });

  // Both signals are required. A marker alone is spoofable by a human quoting
  // the bot; an author alone cannot tell a summary comment from an inline one,
  // and only the summary is editable in place.
  it("needs the marker and the author to agree", () => {
    expect(isOwnComment(body, "Bot", "inline")).toBe(true);
    expect(isOwnComment(body, "User", "inline")).toBe(false);
    expect(isOwnComment(body, "Bot", "summary")).toBe(false);
    expect(isOwnComment("no marker here", "Bot", "inline")).toBe(false);
  });

  it("accepts the marker alone when no author is known", () => {
    expect(isOwnComment(body, null, "inline")).toBe(true);
  });

  it("accepts any kind when none is asked for", () => {
    expect(isOwnComment(body, "Bot")).toBe(true);
    expect(isOwnComment(marker("reply", { of: "1", addressed: "1" }), "Bot")).toBe(true);
  });
});

// The close-out flow: the bot replies into its own thread with addressed=1, and
// every later run reads that to know the point is finished rather than
// re-reporting it.
describe("close-out replies", () => {
  it("marks a thread settled without needing GitHub's resolution API", () => {
    const reply = ["✅ Fixed as of `abc1234567`.", marker("reply", { of: "555", addressed: "1" })].join("\n\n");
    const m = findMarker(reply, "reply")!;
    expect(m.fields.of).toBe("555");
    expect(m.fields.addressed).toBe("1");
    expect(isOwnComment(reply, "Bot", "reply")).toBe(true);
  });

  it("tells a corroboration apart from a close-out", () => {
    const corroboration = ["Agreed, and also...", marker("reply", { of: "555", fp: "abc1234567" })].join("\n\n");
    expect(findMarker(corroboration, "reply")!.fields.addressed).toBeUndefined();
  });

  // A corroborating reply carries a fingerprint too, so the suppression map has
  // to read fingerprints across kinds. Restricting it to `inline` would let a
  // corroborated finding be posted again on the next push.
  it("carries a fingerprint on both reply shapes", () => {
    const corroboration = marker("reply", { of: "555", fp: "abc1234567" });
    expect(readMarkers(corroboration).find((m) => m.fields.fp)?.fields.fp).toBe("abc1234567");
  });
});

describe("readResponses", () => {
  it("reads a dispute and uses the rest of the comment as its reason", () => {
    const body = "<!-- ai-review-response fp=ABC123def verdict=disputed -->\nThe lock is held by the caller.";
    expect(readResponses(body)).toEqual([
      { fp: "abc123def", verdict: "disputed", reason: "The lock is held by the caller." },
    ]);
  });

  it("accepts action= in place of verdict=", () => {
    expect(readResponses("Done. <!-- ai-review-response fp=abc123 action=fixed -->")).toEqual([
      { fp: "abc123", verdict: "fixed", reason: "Done." },
    ]);
  });

  it("ignores malformed markers", () => {
    expect(readResponses("<!-- ai-review-response fp=xyz verdict=disputed -->")).toEqual([]);
    expect(readResponses("<!-- ai-review-response fp=abc123 verdict=maybe -->")).toEqual([]);
  });

  // The bot's own markers use a different prefix, so a response is never read
  // as the bot's output, and a bot comment is never read as a response.
  it("does not confuse responses with the bot's markers", () => {
    const response = "<!-- ai-review-response fp=abc123 verdict=disputed -->";
    expect(readMarkers(response)).toEqual([]);
    expect(readResponses(marker("reply", { of: "1", fp: "abc123" }))).toEqual([]);
  });

  it("gives each answer its own paragraph when one comment answers several findings", () => {
    const leading = [
      "<!-- ai-review-response fp=aaa111 verdict=disputed -->",
      "First reason.",
      "<!-- ai-review-response fp=bbb222 verdict=fixed -->",
      "Second reason.",
    ].join("\n");
    expect(readResponses(leading).map((r) => r.reason)).toEqual(["First reason.", "Second reason."]);
    const trailing = [
      "First reason.",
      "<!-- ai-review-response fp=aaa111 verdict=disputed -->",
      "Second reason.",
      "<!-- ai-review-response fp=bbb222 verdict=fixed -->",
    ].join("\n");
    expect(readResponses(trailing).map((r) => r.reason)).toEqual(["First reason.", "Second reason."]);
  });
});
