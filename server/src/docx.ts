import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

/**
 * Render a Markdown document as an Aurora-styled Word file.
 *
 * The agent writes Markdown, which it is good at, and the house style is
 * applied here, where it is one implementation rather than a instruction the
 * model has to remember and get right every time.
 *
 * The Markdown subset covered is the one that actually shows up in a report:
 * ATX headings, paragraphs, bullet and numbered lists, GFM tables, fenced code,
 * block quotes, rules, and inline bold/italic/code/links. Anything outside it
 * degrades to plain text rather than failing — a document with an unstyled line
 * in it beats no document.
 */

/** Aurora brand red, as used on the dashboard. */
const RED = "C90000";
const INK = "1F1F1F";
const MUTED = "6B6B6B";
const RULE = "D8D8D8";
const CODE_BG = "F4F4F5";

/**
 * Neue Kabel is Aurora's typeface. Word substitutes silently when a font is
 * missing, so a reader without it sees a fallback rather than an error — the
 * document is still correct, just not on-brand.
 */
const SANS = "Neue Kabel";
const MONO = "Consolas";

/* ──────────────────────────── inline runs ──────────────────────────── */

type Style = { bold?: boolean; italics?: boolean; code?: boolean };

function run(text: string, style: Style): TextRun {
  return new TextRun({
    text,
    font: style.code ? MONO : SANS,
    ...(style.bold ? { bold: true } : {}),
    ...(style.italics ? { italics: true } : {}),
    ...(style.code
      ? { size: 20, shading: { type: ShadingType.CLEAR, fill: CODE_BG }, color: "B00020" }
      : {}),
  });
}

/**
 * Split inline Markdown into styled runs.
 *
 * One left-to-right pass with an explicit cursor rather than nested replaces:
 * the delimiters can contain each other, and a regex that tries to handle that
 * in one shot gets the precedence between `**` and `*` wrong.
 */
function inline(text: string, inherited: Style = {}): (TextRun | ExternalHyperlink)[] {
  const out: (TextRun | ExternalHyperlink)[] = [];
  let buf = "";
  let i = 0;

  const flush = (): void => {
    if (buf) out.push(run(buf, inherited));
    buf = "";
  };

  while (i < text.length) {
    const rest = text.slice(i);

    // Code spans win over everything: their contents are literal.
    const code = /^`([^`]+)`/.exec(rest);
    if (code) {
      flush();
      out.push(run(code[1]!, { ...inherited, code: true }));
      i += code[0].length;
      continue;
    }

    const link = /^\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/.exec(rest);
    if (link) {
      flush();
      out.push(
        new ExternalHyperlink({
          link: link[2]!,
          children: [
            new TextRun({
              text: link[1] || link[2]!,
              font: SANS,
              color: "0A58CA",
              underline: {},
            }),
          ],
        }),
      );
      i += link[0].length;
      continue;
    }

    const strong = /^\*\*([^*]+)\*\*/.exec(rest) ?? /^__([^_]+)__/.exec(rest);
    if (strong) {
      flush();
      out.push(...inline(strong[1]!, { ...inherited, bold: true }));
      i += strong[0].length;
      continue;
    }

    const em = /^\*([^*]+)\*/.exec(rest) ?? /^_([^_]+)_/.exec(rest);
    if (em) {
      flush();
      out.push(...inline(em[1]!, { ...inherited, italics: true }));
      i += em[0].length;
      continue;
    }

    buf += text[i];
    i += 1;
  }

  flush();
  return out.length ? out : [run("", inherited)];
}

/* ──────────────────────────── block parsing ──────────────────────────── */

const HEADING = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

const isDivider = (line: string): boolean => /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes("-");

function cell(text: string, head: boolean): TableCell {
  return new TableCell({
    children: [
      new Paragraph({
        spacing: { before: 60, after: 60 },
        children: inline(text, head ? { bold: true } : {}),
      }),
    ],
    ...(head ? { shading: { type: ShadingType.CLEAR, fill: "F7F7F8" } } : {}),
    margins: { top: 60, bottom: 60, left: 120, right: 120 },
  });
}

function table(rows: string[][]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 2, color: RULE },
      bottom: { style: BorderStyle.SINGLE, size: 2, color: RULE },
      left: { style: BorderStyle.SINGLE, size: 2, color: RULE },
      right: { style: BorderStyle.SINGLE, size: 2, color: RULE },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: RULE },
      insideVertical: { style: BorderStyle.SINGLE, size: 2, color: RULE },
    },
    rows: rows.map(
      (cells, r) =>
        new TableRow({
          tableHeader: r === 0,
          children: cells.map((c) => cell(c, r === 0)),
        }),
    ),
  });
}

function parse(markdown: string): (Paragraph | Table)[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: (Paragraph | Table)[] = [];
  let i = 0;
  // Ordered lists need a fresh numbering instance each time, or a second list
  // in the same document continues the first one's count.
  let listSeq = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (!line.trim()) {
      i += 1;
      continue;
    }

    // Fenced code. Everything up to the closing fence is literal, so this is
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
      for (const [n, text] of body.entries()) {
        blocks.push(
          new Paragraph({
            shading: { type: ShadingType.CLEAR, fill: CODE_BG },
            spacing: { before: n === 0 ? 120 : 0, after: n === body.length - 1 ? 120 : 0 },
            indent: { left: 240, right: 240 },
            children: [new TextRun({ text: text || " ", font: MONO, size: 19 })],
          }),
        );
      }
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const depth = heading[1]!.length;
      blocks.push(
        new Paragraph({
          heading: HEADING[depth - 1],
          spacing: { before: depth === 1 ? 0 : 280, after: 120 },
          children: inline(heading[2]!.trim()),
        }),
      );
      i += 1;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      blocks.push(
        new Paragraph({
          spacing: { before: 160, after: 160 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 1 } },
          children: [],
        }),
      );
      i += 1;
      continue;
    }

    // GFM table: a header row followed by a divider row.
    if (line.includes("|") && i + 1 < lines.length && isDivider(lines[i + 1]!)) {
      const rows = [splitRow(line)];
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) {
        rows.push(splitRow(lines[i]!));
        i += 1;
      }
      blocks.push(table(rows));
      // A table butted against the next paragraph reads as one block in Word.
      blocks.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
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
      blocks.push(
        new Paragraph({
          indent: { left: 360 },
          spacing: { before: 120, after: 120 },
          border: { left: { style: BorderStyle.SINGLE, size: 12, color: RED, space: 12 } },
          children: inline(body.join(" ").trim(), { italics: true }),
        }),
      );
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push(
        new Paragraph({
          bullet: { level: Math.min(2, Math.floor(bullet[1]!.length / 2)) },
          spacing: { before: 40, after: 40 },
          children: inline(bullet[2]!),
        }),
      );
      i += 1;
      continue;
    }

    const ordered = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      // One numbering reference per run of items, so each list restarts at 1.
      const ref = `ol-${listSeq}`;
      let j = i;
      while (j < lines.length) {
        const item = /^(\s*)\d+[.)]\s+(.*)$/.exec(lines[j]!);
        if (!item) break;
        blocks.push(
          new Paragraph({
            numbering: { reference: ref, level: Math.min(2, Math.floor(item[1]!.length / 2)) },
            spacing: { before: 40, after: 40 },
            children: inline(item[2]!),
          }),
        );
        j += 1;
      }
      i = j;
      listSeq += 1;
      continue;
    }

    // Plain paragraph: join the lines up to the next blank one, so a soft-
    // wrapped source paragraph does not become one Word paragraph per line.
    const body: string[] = [line.trim()];
    i += 1;
    while (i < lines.length && lines[i]!.trim() && !/^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```)/.test(lines[i]!)) {
      body.push(lines[i]!.trim());
      i += 1;
    }
    blocks.push(
      new Paragraph({ spacing: { after: 160 }, children: inline(body.join(" ")) }),
    );
  }

  return blocks;
}

/* ──────────────────────────── document ──────────────────────────── */

/** How many ordered-list numbering instances to declare up front. */
const MAX_LISTS = 32;

export interface DocxOptions {
  title: string;
  markdown: string;
  /** Printed under the title on page one. */
  subtitle?: string;
}

/**
 * Build the .docx and return its bytes.
 *
 * Styling lives in the document's style definitions rather than on each
 * paragraph, so the result is a Word document someone can restyle through the
 * Styles pane like any other, instead of a wall of direct formatting.
 */
export async function markdownToDocx(opts: DocxOptions): Promise<Buffer> {
  const headingStyle = (id: string, size: number, color: string, before: number) => ({
    id,
    name: id,
    basedOn: "Normal",
    next: "Normal",
    quickFormat: true,
    run: { font: SANS, size, bold: true, color },
    paragraph: { spacing: { before, after: 120 }, keepNext: true },
  });

  const doc = new Document({
    title: opts.title,
    creator: "Aurora Technical Services",
    description: opts.subtitle ?? "",
    styles: {
      default: {
        document: { run: { font: SANS, size: 22, color: INK } },
      },
      paragraphStyles: [
        {
          id: "Normal",
          name: "Normal",
          run: { font: SANS, size: 22, color: INK },
          paragraph: { spacing: { line: 300, after: 160 } },
        },
        headingStyle("Heading1", 40, RED, 0),
        headingStyle("Heading2", 30, RED, 280),
        headingStyle("Heading3", 25, INK, 240),
        headingStyle("Heading4", 23, INK, 200),
        headingStyle("Heading5", 22, MUTED, 200),
        headingStyle("Heading6", 21, MUTED, 200),
      ],
    },
    numbering: {
      config: Array.from({ length: MAX_LISTS }, (_, n) => ({
        reference: `ol-${n}`,
        levels: [0, 1, 2].map((level) => ({
          level,
          format: LevelFormat.DECIMAL,
          text: `%${level + 1}.`,
          alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 260 } } },
        })),
      })),
    },
    sections: [
      {
        properties: {
          page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                spacing: { after: 0 },
                children: [
                  new TextRun({
                    text: "Aurora Technical Services",
                    font: SANS,
                    size: 16,
                    color: MUTED,
                  }),
                ],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { before: 0 },
                children: [
                  new TextRun({ text: "Page ", font: SANS, size: 16, color: MUTED }),
                  new TextRun({ children: [PageNumber.CURRENT], font: SANS, size: 16, color: MUTED }),
                  new TextRun({ text: " of ", font: SANS, size: 16, color: MUTED }),
                  new TextRun({
                    children: [PageNumber.TOTAL_PAGES],
                    font: SANS,
                    size: 16,
                    color: MUTED,
                  }),
                ],
              }),
            ],
          }),
        },
        children: [
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            spacing: { after: opts.subtitle ? 40 : 240 },
            children: [new TextRun({ text: opts.title, font: SANS, bold: true })],
          }),
          ...(opts.subtitle
            ? [
                new Paragraph({
                  spacing: { after: 240 },
                  children: [
                    new TextRun({ text: opts.subtitle, font: SANS, size: 20, color: MUTED }),
                  ],
                }),
              ]
            : []),
          ...parse(opts.markdown),
        ],
      },
    ],
  });

  return Packer.toBuffer(doc) as unknown as Promise<Buffer>;
}
