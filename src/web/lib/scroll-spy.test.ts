import { describe, expect, test } from "bun:test";
import { visibleFile, visibleGroups } from "./scroll-spy.ts";

describe("visibleGroups", () => {
  const rects = [
    { id: "a", top: -500, bottom: 40 },
    { id: "b", top: 40, bottom: 900 },
    { id: "c", top: 900, bottom: 1400 },
  ];

  test("a section hidden under the header does not count", () => {
    expect(visibleGroups(rects, 60, 800)).toEqual(["b"]);
  });

  test("a section partly under the header counts", () => {
    expect(visibleGroups(rects, 30, 800)).toEqual(["a", "b"]);
  });

  test("with the header hidden the offset is zero", () => {
    expect(visibleGroups(rects, 0, 1000)).toEqual(["a", "b", "c"]);
  });
});

describe("visibleFile", () => {
  const markers = [
    { path: "one.ts", top: 100 },
    { path: "two.ts", top: 400 },
    { path: "three.ts", top: 700 },
  ];

  test("before the first marker reaches the header, the first file is visible", () => {
    expect(visibleFile(markers, 1200, 60)).toBe("one.ts");
  });

  test("the file whose span holds the header line wins", () => {
    expect(visibleFile(markers, 1200, 450)).toBe("two.ts");
    expect(visibleFile(markers, 1200, 400)).toBe("two.ts");
  });

  test("the last file spans to the section bottom", () => {
    expect(visibleFile(markers, 1200, 1100)).toBe("three.ts");
    expect(visibleFile(markers, 1200, 1200)).toBeNull();
  });

  test("no markers, no file", () => {
    expect(visibleFile([], 1200, 0)).toBeNull();
  });
});
