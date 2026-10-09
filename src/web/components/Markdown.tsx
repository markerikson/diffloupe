import type { ReactNode } from "react";
import styles from "./Markdown.module.css";

type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; level: number; text: string }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "code"; text: string };

const LIST_ITEM = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/;

function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];
  const flush = () => {
    if (para.length > 0) blocks.push({ kind: "p", text: para.join(" ") });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (line.trimStart().startsWith("```")) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !lines[i]!.trimStart().startsWith("```")) code.push(lines[i]!);
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "h", level: heading[1]!.length, text: heading[2]! });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flush();
      const kind = item[1] ? "ul" : "ol";
      const last = blocks.at(-1);
      if (last && last.kind === kind) last.items.push(item[3]!);
      else blocks.push({ kind, items: [item[3]!] });
      continue;
    }
    const last = blocks.at(-1);
    if (para.length === 0 && last && (last.kind === "ul" || last.kind === "ol") && /^\s+\S/.test(line)) {
      last.items[last.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|\[([^\]]+)\]\(([^)\s]+)\)/g;

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = m.index;
    if (m[1] !== undefined) out.push(<code key={key}>{m[1]}</code>);
    else if (m[2] !== undefined || m[3] !== undefined) out.push(<strong key={key}>{renderInline(m[2] ?? m[3]!)}</strong>);
    else if (m[4] !== undefined || m[5] !== undefined) out.push(<em key={key}>{renderInline(m[4] ?? m[5]!)}</em>);
    else if (m[6] !== undefined && m[7] !== undefined) {
      const safe = /^(https?:|\/|#)/.test(m[7]);
      out.push(
        safe ? (
          <a key={key} href={m[7]} target="_blank" rel="noreferrer">
            {renderInline(m[6])}
          </a>
        ) : (
          m[6]
        ),
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderBlock(block: Block, i: number): ReactNode {
  switch (block.kind) {
    case "p":
      return <p key={i}>{renderInline(block.text)}</p>;
    case "h":
      return <p key={i} className={styles.heading}>{renderInline(block.text)}</p>;
    case "code":
      return (
        <pre key={i}>
          <code>{block.text}</code>
        </pre>
      );
    case "ul":
    case "ol": {
      const List = block.kind;
      return (
        <List key={i}>
          {block.items.map((item, j) => (
            <li key={j}>{renderInline(item)}</li>
          ))}
        </List>
      );
    }
  }
}

interface MarkdownProps {
  source: string;
  className?: string | undefined;
}

/** Renders the small Markdown subset the review models write: paragraphs, lists, code, emphasis, links. */
export function Markdown({ source, className }: MarkdownProps) {
  return (
    <div className={[styles.markdown, className].filter(Boolean).join(" ")}>{parseBlocks(source).map(renderBlock)}</div>
  );
}
