import { describe, expect, test } from "bun:test";
import { checkReviewFlags } from "./review.ts";

const sha = "0123456789abcdef0123456789abcdef01234567";

describe("checkReviewFlags", () => {
  test("accepts the CI form", () => {
    expect(checkReviewFlags({ target: "#12", github: true, head: sha, headless: true, out: "o", json: true, failOn: "blocker" })).toBeNull();
    expect(checkReviewFlags({ target: "https://github.com/o/r/pull/12", github: true })).toBeNull();
  });

  test("--github and --head need a pull request", () => {
    expect(checkReviewFlags({ target: "HEAD", github: true })).toMatch(/--github needs a pull request/);
    expect(checkReviewFlags({ github: true })).toMatch(/--github needs a pull request/);
    expect(checkReviewFlags({ target: "main..topic", head: sha })).toMatch(/--head needs a pull request/);
  });

  test("--head must be a full SHA", () => {
    expect(checkReviewFlags({ target: "#12", head: "abc1234" })).toMatch(/40-character/);
  });

  test("result flags need --headless", () => {
    expect(checkReviewFlags({ out: "o" })).toMatch(/--out needs --headless/);
    expect(checkReviewFlags({ json: true })).toMatch(/--json needs --headless/);
    expect(checkReviewFlags({ failOn: "blocker" })).toMatch(/--fail-on needs --headless/);
  });
});
