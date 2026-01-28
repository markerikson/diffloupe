/**
 * GitHub Service Tests - Unit tests for github.ts
 *
 * These tests focus on the pure functions that don't require actual gh CLI calls.
 */

import { describe, test, expect } from "bun:test";
import { assemblePrIntent } from "./github.js";
import type { PRMetadata } from "../types/github.js";

describe("assemblePrIntent", () => {
  test("includes PR title, author, and branch info", () => {
    const pr: PRMetadata = {
      title: "Add rate limiting to API",
      body: "",
      author: { login: "testuser", name: "Test User" },
      commits: [{ messageHeadline: "feat: add rate limiting", messageBody: "", oid: "abc123" }],
      baseRefName: "main",
      headRefName: "feature/rate-limit",
      state: "OPEN",
      number: 123,
      url: "https://github.com/test/repo/pull/123",
    };

    const intent = assemblePrIntent(pr);

    expect(intent).toContain("PR Title: Add rate limiting to API");
    expect(intent).toContain("Author: Test User");
    expect(intent).toContain("Branch: feature/rate-limit → main");
  });

  test("uses login when name is not available", () => {
    const pr: PRMetadata = {
      title: "Fix bug",
      body: "",
      author: { login: "ghostuser" },
      commits: [{ messageHeadline: "fix: bug", messageBody: "", oid: "abc123" }],
      baseRefName: "main",
      headRefName: "fix/bug",
      state: "OPEN",
      number: 456,
      url: "https://github.com/test/repo/pull/456",
    };

    const intent = assemblePrIntent(pr);

    expect(intent).toContain("Author: ghostuser");
  });

  test("includes PR body when present", () => {
    const pr: PRMetadata = {
      title: "Add feature",
      body: "## Summary\n\nThis PR adds a new feature.\n\n## Testing\n\nManual testing done.",
      author: { login: "dev" },
      commits: [{ messageHeadline: "feat: add feature", messageBody: "", oid: "abc123" }],
      baseRefName: "main",
      headRefName: "feature/new",
      state: "OPEN",
      number: 789,
      url: "https://github.com/test/repo/pull/789",
    };

    const intent = assemblePrIntent(pr);

    expect(intent).toContain("PR Description:");
    expect(intent).toContain("## Summary");
    expect(intent).toContain("This PR adds a new feature.");
    expect(intent).toContain("## Testing");
  });

  test("excludes PR body section when body is empty", () => {
    const pr: PRMetadata = {
      title: "Small fix",
      body: "",
      author: { login: "dev" },
      commits: [{ messageHeadline: "fix: small", messageBody: "", oid: "abc123" }],
      baseRefName: "main",
      headRefName: "fix/small",
      state: "OPEN",
      number: 100,
      url: "https://github.com/test/repo/pull/100",
    };

    const intent = assemblePrIntent(pr);

    expect(intent).not.toContain("PR Description:");
  });

  test("excludes PR body section when body is whitespace", () => {
    const pr: PRMetadata = {
      title: "Small fix",
      body: "   \n  \n  ",
      author: { login: "dev" },
      commits: [{ messageHeadline: "fix: small", messageBody: "", oid: "abc123" }],
      baseRefName: "main",
      headRefName: "fix/small",
      state: "OPEN",
      number: 100,
      url: "https://github.com/test/repo/pull/100",
    };

    const intent = assemblePrIntent(pr);

    expect(intent).not.toContain("PR Description:");
  });

  test("includes commits section for multi-commit PRs", () => {
    const pr: PRMetadata = {
      title: "Major refactor",
      body: "Refactoring the auth system",
      author: { login: "dev" },
      commits: [
        { messageHeadline: "refactor: extract auth service", messageBody: "", oid: "abc123" },
        { messageHeadline: "refactor: update consumers", messageBody: "", oid: "def456" },
        {
          messageHeadline: "test: add auth service tests",
          messageBody: "Added unit tests for the new auth service.\n\nCovers edge cases.",
          oid: "ghi789",
        },
      ],
      baseRefName: "main",
      headRefName: "refactor/auth",
      state: "OPEN",
      number: 200,
      url: "https://github.com/test/repo/pull/200",
    };

    const intent = assemblePrIntent(pr);

    expect(intent).toContain("Commits (3):");
    expect(intent).toContain("- refactor: extract auth service");
    expect(intent).toContain("- refactor: update consumers");
    expect(intent).toContain("- test: add auth service tests");
    expect(intent).toContain("Added unit tests for the new auth service.");
    expect(intent).toContain("Covers edge cases.");
  });

  test("excludes commits section for single-commit PRs", () => {
    const pr: PRMetadata = {
      title: "Quick fix",
      body: "Fixes the bug",
      author: { login: "dev" },
      commits: [{ messageHeadline: "fix: the bug", messageBody: "", oid: "abc123" }],
      baseRefName: "main",
      headRefName: "fix/bug",
      state: "OPEN",
      number: 300,
      url: "https://github.com/test/repo/pull/300",
    };

    const intent = assemblePrIntent(pr);

    expect(intent).not.toContain("Commits (");
    expect(intent).not.toContain("- fix: the bug");
  });

  test("handles complex real-world PR metadata", () => {
    const pr: PRMetadata = {
      title: "chore(toolkit): migrate TypeScript setup to bundler",
      body: `## This PR:
- Migrates TS config to bundler resolution
- Updates tsconfig.json with new settings
- Resolves #5197

## Testing
All existing tests pass.`,
      author: { login: "aryaemami59", name: "Arya Emami" },
      commits: [
        {
          messageHeadline: "chore(toolkit): migrate TS setup to bundler",
          messageBody: "",
          oid: "dbf2285",
        },
        {
          messageHeadline: "fix: address review comments",
          messageBody: "- Fixed import paths\n- Updated documentation",
          oid: "abc1234",
        },
      ],
      baseRefName: "master",
      headRefName: "chore/toolkit/migrate-to-bundler",
      state: "OPEN",
      number: 4567,
      url: "https://github.com/reduxjs/redux-toolkit/pull/4567",
    };

    const intent = assemblePrIntent(pr);

    // Should have all the key components
    expect(intent).toContain("PR Title: chore(toolkit): migrate TypeScript setup to bundler");
    expect(intent).toContain("Author: Arya Emami");
    expect(intent).toContain("Branch: chore/toolkit/migrate-to-bundler → master");
    expect(intent).toContain("PR Description:");
    expect(intent).toContain("Migrates TS config to bundler resolution");
    expect(intent).toContain("Resolves #5197");
    expect(intent).toContain("Commits (2):");
    expect(intent).toContain("- chore(toolkit): migrate TS setup to bundler");
    expect(intent).toContain("- fix: address review comments");
    expect(intent).toContain("Fixed import paths");
  });
});
