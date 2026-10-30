/**
 * A small Markdown parser producing a renderer-neutral tree.
 *
 * There are two document renderers now — Word and PDF — and they must agree
 * on what the agent wrote. Parsing in each one guarantees they drift: a table
 * that renders in the .docx and silently vanishes from the PDF is exactly the
 * kind of bug nobody notices until a client has the wrong file. So the
 * Markdown is understood once, here, and each renderer only decides how to
 * draw the result.
 *
 * The subset is the one a report actually uses: ATX headings, paragraphs,
 * bullet and ordered lists, GFM tables, fenced code, block quotes, rules, and
 * inline bold/italic/code/links. Anything outside it falls through to plain
 * text rather than throwing — a document with one unstyled line beats no
 * document.
 */

export type Inline =
  | { t: "text"; text: string; bold?: boolean; italic?: boolean; code?: boolean }
  | { t: "link"; text: string; href: string };

export type Block =
  | { t: "heading"; depth: number; children: Inline[] }
  | { t: "para"; children: Inline[] }
  | { t: "bullet"; level: number; children: Inline[] }
  | { t: "ordered"; level: number; listId: number; index: number; children: Inline[] }
  | { t: "quote"; children: Inline[] }
  | { t: "code"; lines: string[] }
  | { t: "table"; rows: Inline[][][] }
  | { t: "rule" };

/* ──────────────────────────── inline ──────────────────────────── */

type Style = { bold?: boolean; italic?: boolean };

/**
 * Split inline Markdown into styled spans.
 *
 * One left-to-right pass with an explicit cursor, not a chain of replaces:
 * the delimiters nest, and a regex that tries to handle that in one shot gets
 * the precedence between `**` and `*` wrong.
 */
export function parseInline(text: string, inherited: Style = {}): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  let i = 0;

  const flush = (): void => {
    if (!buf) return;
    out.push({ t: "text", text: buf, ...inherited });
    buf = "";
  };

  while (i < text.length) {
    const rest = text.slice(i);

    // Code spans win over everything: their contents are literal.
    const code = /^`([^`]+)`/.exec(rest);
    if (code) {
      flush();
      out.push({ t: "text", text: code[1]!, ...inherited, code: true });
      i += code[0].length;
      continue;
    }

    const link = /^\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/.exec(rest);
    if (link) {
      flush();
      out.push({ t: "link", text: link[1] || link[2]!, href: link[2]! });
      i += link[0].length;
      continue;
    }

    const strong = /^\*\*([^*]+)\*\*/.exec(rest) ?? /^__([^_]+)__/.exec(rest);
    if (strong) {
      flush();
      out.push(...parseInline(strong[1]!, { ...inherited, bold: true }));
      i += strong[0].length;
      continue;
    }

    const em = /^\*([^*]+)\*/.exec(rest) ?? /^_([^_]+)_/.exec(rest);
    if (em) {
      flush();
      out.push(...parseInline(em[1]!, { ...inherited, italic: true }));
      i += em[0].length;
      continue;
    }

    buf += text[i];
    i += 1;
  }

  flush();
  return out.length ? out : [{ t: "text", text: "", ...inherited }];
}

/** Flatten spans back to plain text, for widths and measurements. */
export const plain = (spans: Inline[]): string => spans.map((s) => s.text).join("");

/* ──────────────────────────── blocks ──────────────────────────── */

const splitRow = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

const isDivider = (line: string): boolean =>
  /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes("-");

const indentLevel = (ws: string): number => Math.min(2, Math.floor(ws.length / 2));

export function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  // Each run of ordered items gets its own id so a second list restarts at 1.
  let listSeq = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (!line.trim()) {
      i += 1;
      continue;
    }

    // Fenced code: everything to the closing fence is literal, so this is
    // checked before any inline handling.
    const fence = /^\s*```+\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1; // past the closing fence, or off the end if it never came
      blocks.push({ t: "code", lines: body });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({
        t: "heading",
        depth: heading[1]!.length,
        children: parseInline(heading[2]!.trim()),
      });
      i += 1;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      blocks.push({ t: "rule" });
      i += 1;
      continue;
    }

    // GFM table: a header row followed by a divider row.
    if (line.includes("|") && i + 1 < lines.length && isDivider(lines[i + 1]!)) {
      const rows: Inline[][][] = [splitRow(line).map((c) => parseInline(c))];
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) {
        rows.push(splitRow(lines[i]!).map((c) => parseInline(c)));
        i += 1;
      }
      blocks.push({ t: "table", rows });
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      const body: string[] = [quote[1]!];
      i += 1;
      while (i < lines.length) {
        const more = /^\s*>\s?(.*)$/.exec(lines[i]!);
        if (!more) break;
        body.push(more[1]!);
        i += 1;
      }
      blocks.push({ t: "quote", children: parseInline(body.join(" ").trim()) });
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push({
        t: "bullet",
        level: indentLevel(bullet[1]!),
        children: parseInline(bullet[2]!),
      });
      i += 1;
      continue;
    }

    const ordered = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      let n = 0;
      while (i < lines.length) {
        const item = /^(\s*)\d+[.)]\s+(.*)$/.exec(lines[i]!);
        if (!item) break;
        n += 1;
        blocks.push({
          t: "ordered",
          level: indentLevel(item[1]!),
          listId: listSeq,
          index: n,
          children: parseInline(item[2]!),
        });
        i += 1;
      }
      listSeq += 1;
      continue;
    }

    // Plain paragraph: join up to the next blank line, so a soft-wrapped
    // source paragraph does not become one output paragraph per line.
    const body: string[] = [line.trim()];
    i += 1;
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```)/.test(lines[i]!)
    ) {
      body.push(lines[i]!.trim());
      i += 1;
    }
    blocks.push({ t: "para", children: parseInline(body.join(" ")) });
  }

  return blocks;
}

/** How many ordered lists a document may contain before ids repeat. */
export const MAX_LISTS = 64;
