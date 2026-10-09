import { describe, expect, it } from "bun:test";
import { browserCommand } from "./browser.ts";

const url = "http://localhost:4517/runs/x";

describe("browserCommand", () => {
  it("uses start with an empty title argument under WSL", () => {
    expect(browserCommand(url, { wsl: true, platform: "linux" })).toEqual(["cmd.exe", "/c", "start", "", url]);
  });

  it("passes a Windows BROWSER through start under WSL", () => {
    const browser = "/mnt/c/Program Files/Firefox/firefox.exe";
    expect(browserCommand(url, { browser, wsl: true, platform: "linux" })).toEqual([
      "cmd.exe", "/c", "start", "", browser, url,
    ]);
  });

  it("runs a Linux BROWSER directly", () => {
    expect(browserCommand(url, { browser: "firefox", wsl: true, platform: "linux" })).toEqual(["firefox", url]);
    expect(browserCommand(url, { browser: "firefox", wsl: false, platform: "linux" })).toEqual(["firefox", url]);
  });

  it("ignores no-op BROWSER values", () => {
    for (const browser of ["true", "false", "none", ":", "0", "1", "  "]) {
      expect(browserCommand(url, { browser, wsl: false, platform: "linux" })).toEqual(["xdg-open", url]);
    }
  });
});
