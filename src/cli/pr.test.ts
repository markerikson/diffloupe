/**
 * PR Command Tests - Unit tests for pr.ts parsing functions
 */

import { describe, test, expect } from "bun:test";
import { parseGitHubPRUrl, parsePRIdentifier } from "./pr.js";

describe("parseGitHubPRUrl", () => {
  test("parses standard https URL", () => {
    const result = parseGitHubPRUrl("https://github.com/reduxjs/redux-toolkit/pull/4812");
    expect(result).toEqual({
      owner: "reduxjs",
      repo: "redux-toolkit",
      prNumber: 4812,
    });
  });

  test("parses URL with /files suffix", () => {
    const result = parseGitHubPRUrl("https://github.com/reduxjs/redux-toolkit/pull/4812/files");
    expect(result).toEqual({
      owner: "reduxjs",
      repo: "redux-toolkit",
      prNumber: 4812,
    });
  });

  test("parses URL with /commits suffix", () => {
    const result = parseGitHubPRUrl("https://github.com/facebook/react/pull/12345/commits");
    expect(result).toEqual({
      owner: "facebook",
      repo: "react",
      prNumber: 12345,
    });
  });

  test("parses http URL", () => {
    const result = parseGitHubPRUrl("http://github.com/owner/repo/pull/123");
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      prNumber: 123,
    });
  });

  test("parses URL without protocol", () => {
    const result = parseGitHubPRUrl("github.com/owner/repo/pull/456");
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      prNumber: 456,
    });
  });

  test("returns null for non-github URLs", () => {
    expect(parseGitHubPRUrl("https://gitlab.com/owner/repo/pull/123")).toBeNull();
  });

  test("returns null for github URLs that are not PRs", () => {
    expect(parseGitHubPRUrl("https://github.com/reduxjs/redux-toolkit")).toBeNull();
    expect(parseGitHubPRUrl("https://github.com/reduxjs/redux-toolkit/issues/123")).toBeNull();
    expect(parseGitHubPRUrl("https://github.com/reduxjs/redux-toolkit/blob/main/README.md")).toBeNull();
  });

  test("returns null for invalid URLs", () => {
    expect(parseGitHubPRUrl("not-a-url")).toBeNull();
    expect(parseGitHubPRUrl("https://github.com")).toBeNull();
    expect(parseGitHubPRUrl("https://github.com/owner")).toBeNull();
    expect(parseGitHubPRUrl("https://github.com/owner/repo/pull")).toBeNull();
    expect(parseGitHubPRUrl("https://github.com/owner/repo/pull/abc")).toBeNull();
  });

  test("handles URLs with query params and fragments", () => {
    // URL parser strips query/fragment from pathname naturally
    const result = parseGitHubPRUrl("https://github.com/owner/repo/pull/789?diff=split#diff-123");
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      prNumber: 789,
    });
  });
});

describe("parsePRIdentifier", () => {
  describe("plain number", () => {
    test("parses simple PR number", () => {
      const result = parsePRIdentifier("123", undefined);
      expect(result).toEqual({ prNumber: 123, repo: undefined });
    });

    test("passes through repo option with number", () => {
      const result = parsePRIdentifier("456", "owner/repo");
      expect(result).toEqual({ prNumber: 456, repo: "owner/repo" });
    });
  });

  describe("owner/repo#number format", () => {
    test("parses cross-repo format", () => {
      const result = parsePRIdentifier("reduxjs/redux-toolkit#4812", undefined);
      expect(result).toEqual({
        prNumber: 4812,
        repo: "reduxjs/redux-toolkit",
      });
    });

    test("cross-repo format overrides -R option", () => {
      const result = parsePRIdentifier("owner/repo#999", "other/repo");
      expect(result).toEqual({
        prNumber: 999,
        repo: "owner/repo",
      });
    });
  });

  describe("GitHub URL format", () => {
    test("parses full GitHub URL", () => {
      const result = parsePRIdentifier(
        "https://github.com/reduxjs/redux-toolkit/pull/4812",
        undefined
      );
      expect(result).toEqual({
        prNumber: 4812,
        repo: "reduxjs/redux-toolkit",
      });
    });

    test("parses URL with trailing path", () => {
      const result = parsePRIdentifier(
        "https://github.com/facebook/react/pull/12345/files",
        undefined
      );
      expect(result).toEqual({
        prNumber: 12345,
        repo: "facebook/react",
      });
    });

    test("parses URL without protocol", () => {
      const result = parsePRIdentifier("github.com/owner/repo/pull/789", undefined);
      expect(result).toEqual({
        prNumber: 789,
        repo: "owner/repo",
      });
    });

    test("URL format overrides -R option", () => {
      const result = parsePRIdentifier(
        "https://github.com/actual/repo/pull/100",
        "ignored/repo"
      );
      expect(result).toEqual({
        prNumber: 100,
        repo: "actual/repo",
      });
    });
  });

  describe("error cases", () => {
    test("throws for invalid identifier", () => {
      expect(() => parsePRIdentifier("not-valid", undefined)).toThrow(
        /Invalid PR identifier/
      );
    });

    test("throws for non-github URL", () => {
      expect(() => parsePRIdentifier("https://gitlab.com/owner/repo/pull/123", undefined)).toThrow(
        /Invalid PR identifier/
      );
    });

    test("error message mentions all valid formats", () => {
      expect(() => parsePRIdentifier("invalid", undefined)).toThrow(
        /number, owner\/repo#number, or GitHub URL/
      );
    });
  });
});
