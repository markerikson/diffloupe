/**
 * Markdown that survives content the model wrote.
 *
 * Every string this pipeline embeds — evidence, suggested code, finding titles
 * — came out of a language model reading source files, so it can contain
 * backticks and pipes. A fixed three-backtick fence around a snippet that
 * itself contains a fenced block ends the fence early and spills the rest of
 * the comment out as prose; one `|` in a title breaks the findings table row.
 */

/**
 * Fences a block, widening the delimiter past the longest backtick run inside
 * it. CommonMark closes a fence only on a run at least as long as the opener,
 * so four backticks safely wrap a snippet containing three.
 */
export function fence(content: string, info = ""): string {
  const runs = content.match(/`+/g) ?? [];
  const width = Math.max(3, ...runs.map((r) => r.length + 1));
  const delimiter = "`".repeat(width);
  // A trailing newline of our own, so content that does not end in one still
  // puts the closing delimiter at the start of a line.
  return `${delimiter}${info}\n${content.replace(/\n$/, "")}\n${delimiter}`;
}

/** Inline code, widened the same way, padded when it starts or ends in a backtick. */
export function code(value: string): string {
  const runs = value.match(/`+/g) ?? [];
  const width = Math.max(1, ...runs.map((r) => r.length + 1));
  const delimiter = "`".repeat(width);
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${delimiter}${pad}${value}${pad}${delimiter}`;
}

/**
 * Flattens a value into one table cell. A newline ends the row in GFM, so it
 * becomes a `<br>`, and an unescaped pipe starts a new column.
 */
export function escapeTableCell(value: string): string {
  return value
    .replace(/\|/g, "\\|")
    .replace(/\r?\n+/g, "<br>")
    .trim();
}
