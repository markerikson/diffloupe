import { describe, expect, test } from "bun:test";
import { keyAction } from "./useKeyboardNav.ts";

const press = (key: string, extra: Partial<Parameters<typeof keyAction>[0]> = {}) =>
  keyAction({ key, ctrlKey: false, metaKey: false, altKey: false, target: null, ...extra });

describe("keyAction", () => {
  test("maps the documented keys", () => {
    expect(press("j")).toBe("nextFile");
    expect(press("k")).toBe("prevFile");
    expect(press("n")).toBe("nextFinding");
    expect(press("p")).toBe("prevFinding");
    expect(press("]")).toBe("nextStop");
    expect(press("[")).toBe("prevStop");
    expect(press("x")).toBe("toggleFile");
    expect(press("?")).toBe("help");
    expect(press("q")).toBeNull();
  });

  test("ignores modified keys", () => {
    expect(press("j", { ctrlKey: true })).toBeNull();
    expect(press("j", { metaKey: true })).toBeNull();
    expect(press("j", { altKey: true })).toBeNull();
  });

  test("ignores keys typed into editable elements", () => {
    expect(press("j", { target: { tagName: "INPUT" } as unknown as EventTarget })).toBeNull();
    expect(press("j", { target: { tagName: "TEXTAREA" } as unknown as EventTarget })).toBeNull();
    expect(press("j", { target: { tagName: "DIV", isContentEditable: true } as unknown as EventTarget })).toBeNull();
    expect(press("j", { target: { tagName: "BUTTON" } as unknown as EventTarget })).toBe("nextFile");
  });
});
