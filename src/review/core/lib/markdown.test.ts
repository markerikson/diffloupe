
import { code, escapeTableCell, fence } from "./markdown.ts";

// Evidence and suggested code come from the model and regularly contain fenced
// blocks of their own. A fixed three-backtick fence lets that content break out
// and mangles the rest of the comment.
describe("fence", () => {
  it("uses three backticks for ordinary content", () => {
    expect(fence("const x = 1;", "ts")).toBe("```ts\nconst x = 1;\n```");
  });

  it("widens past any run of backticks in the content", () => {
    const body = fence("before\n```js\nnested\n```\nafter", "");
    expect(body.startsWith("````\n")).toBe(true);
    expect(body.endsWith("\n````")).toBe(true);
    expect(body).toContain("```js");
  });

  it("widens past a longer run than its own", () => {
    expect(fence("a ````` b", "").startsWith("``````\n")).toBe(true);
  });

  it("does not leave a blank line before the closing fence", () => {
    expect(fence("x\n", "")).toBe("```\nx\n```");
  });
});

describe("code", () => {
  it("wraps a plain value in single backticks", () => {
    expect(code("foo")).toBe("`foo`");
  });

  it("stays readable when the value itself has backticks", () => {
    const wrapped = code("a `b` c");
    expect(wrapped.startsWith("``")).toBe(true);
    expect(wrapped).toContain("a `b` c");
  });

  it("pads when the value starts or ends with a backtick", () => {
    expect(code("`x")).toContain(" `x");
    expect(code("x`")).toContain("x` ");
  });
});

// The drop list in the summary comment is a table built from model prose. One
// unescaped pipe breaks the row.
describe("escapeTableCell", () => {
  it("escapes a pipe", () => {
    expect(escapeTableCell("a | b")).toBe("a \\| b");
  });

  it("folds newlines so the row survives", () => {
    expect(escapeTableCell("one\ntwo")).toBe("one<br>two");
    expect(escapeTableCell("one\n\ntwo")).toBe("one<br>two");
  });

  // Bodies read back from the API carry CRLF. A blank line there folds to two
  // breaks rather than one, which is cosmetic — what matters is that no raw
  // newline reaches the table.
  it("leaves no raw newline in the cell", () => {
    expect(escapeTableCell("one\r\n\r\ntwo")).not.toMatch(/[\r\n]/);
  });

  it("trims", () => {
    expect(escapeTableCell("  x  ")).toBe("x");
  });
});
