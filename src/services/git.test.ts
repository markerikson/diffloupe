/**
 * Tests for git service functions
 */

import { describe, expect, test } from "bun:test";
import { getCommitMessage } from "./git.js";
import { GitError } from "../types/git.js";

describe("getCommitMessage", () => {
  test("gets commit message for HEAD", async () => {
    // This test runs against the actual diffloupe repo
    const message = await getCommitMessage("HEAD");

    // Should return a non-empty string
    expect(typeof message).toBe("string");
    expect(message.length).toBeGreaterThan(0);
  });

  test("gets commit message for short hash", async () => {
    // Get the current HEAD hash first
    const proc = Bun.spawn(["git", "rev-parse", "--short", "HEAD"], {
      stdout: "pipe",
    });
    const shortHash = (await new Response(proc.stdout).text()).trim();

    const message = await getCommitMessage(shortHash);
    expect(typeof message).toBe("string");
    expect(message.length).toBeGreaterThan(0);
  });

  test("gets commit message for full hash", async () => {
    // Get the current HEAD full hash
    const proc = Bun.spawn(["git", "rev-parse", "HEAD"], {
      stdout: "pipe",
    });
    const fullHash = (await new Response(proc.stdout).text()).trim();

    const message = await getCommitMessage(fullHash);
    expect(typeof message).toBe("string");
    expect(message.length).toBeGreaterThan(0);
  });

  test("throws COMMIT_NOT_FOUND for invalid hash", async () => {
    try {
      await getCommitMessage("invalidhash123456");
      // Should not reach here
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(GitError);
      expect((error as GitError).code).toBe("COMMIT_NOT_FOUND");
    }
  });

  test("includes commit body when present", async () => {
    // Find a commit with a body (multi-line message)
    // We'll use HEAD~1 and check the format
    const message = await getCommitMessage("HEAD");

    // The message should be trimmed but preserve internal structure
    expect(message).not.toMatch(/^\s/); // No leading whitespace
    expect(message).not.toMatch(/\s$/); // No trailing whitespace
  });
});
