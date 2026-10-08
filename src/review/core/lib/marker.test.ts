
import { findMarker, fingerprint, isOwnComment, marker, readMarker, readMarkers } from "./marker.ts";

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
