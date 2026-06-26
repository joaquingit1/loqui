/**
 * Markdown — a tiny, dependency-free, XSS-safe markdown renderer.
 *
 * It builds React elements directly (NEVER dangerouslySetInnerHTML), so model
 * output can never inject HTML. It supports exactly the subset the AI summary
 * overview uses: `##`/`###` headers, `-`/`*` bullet lists, `**bold**` inline,
 * and blank-line-separated paragraphs. Anything else renders as plain text.
 *
 * This is intentionally NOT a full CommonMark implementation — it covers the
 * notetaker prompt's output shape (themed `## sections` of `- ` bullets) and
 * degrades gracefully (an unrecognized line is just a paragraph).
 */
import { type JSX, type ReactNode } from "react";

/** Split a line into runs, turning `**bold**` into <strong>. */
function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Split on **…** while keeping the delimiters' content; odd indices are bold.
  const parts = text.split(/\*\*([^*]+)\*\*/g);
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (seg === "") continue;
    if (i % 2 === 1) {
      out.push(<strong key={i}>{seg}</strong>);
    } else {
      out.push(seg);
    }
  }
  return out;
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "para"; text: string };

/** Parse markdown source into a flat list of blocks. */
function parseBlocks(src: string): Block[] {
  const blocks: Block[] = [];
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];
  let list: string[] | null = null;

  const flushPara = (): void => {
    if (para.length > 0) {
      blocks.push({ kind: "para", text: para.join(" ").trim() });
      para = [];
    }
  };
  const flushList = (): void => {
    if (list && list.length > 0) blocks.push({ kind: "list", items: list });
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{1,6})\s+(.*\S)\s*$/.exec(line.trim());
    const bullet = /^[-*]\s+(.*\S)\s*$/.exec(line.trim());
    if (line.trim() === "") {
      flushPara();
      flushList();
    } else if (heading) {
      flushPara();
      flushList();
      blocks.push({ kind: "heading", level: (heading[1] ?? "").length, text: heading[2] ?? "" });
    } else if (bullet) {
      flushPara();
      if (!list) list = [];
      list.push(bullet[1] ?? "");
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return blocks;
}

export interface MarkdownProps {
  /** The markdown source to render. */
  children: string;
  /** Optional className on the wrapper. */
  className?: string;
}

export function Markdown({ children, className }: MarkdownProps): JSX.Element {
  const blocks = parseBlocks(children ?? "");
  return (
    <div className={className} data-testid="markdown">
      {blocks.map((block, i) => {
        if (block.kind === "heading") {
          // Clamp to h3..h5 so the summary heading hierarchy stays sane.
          const level = Math.min(5, Math.max(3, block.level + 1));
          const Tag = `h${level}` as keyof JSX.IntrinsicElements;
          return (
            <Tag key={i} className="md__h">
              {renderInline(block.text)}
            </Tag>
          );
        }
        if (block.kind === "list") {
          return (
            <ul key={i} className="md__ul">
              {block.items.map((item, j) => (
                <li key={j}>{renderInline(item)}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className="md__p">
            {renderInline(block.text)}
          </p>
        );
      })}
    </div>
  );
}
