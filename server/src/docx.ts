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
import { MAX_LISTS, parseMarkdown, type Block, type Inline } from "./markdown.js";
import { AURORA, type DocOptions } from "./housestyle.js";

/**
 * Render a parsed Markdown document as an Aurora-styled Word file.
 *
 * The agent writes Markdown, which it is good at, and the house style is
 * applied here, where it is one implementation rather than an instruction the
 * model has to remember and get right every time.
 */

const { RED, INK, MUTED, RULE, CODE_BG, CODE_FG, SANS, MONO } = AURORA;

/* ──────────────────────────── inline runs ──────────────────────────── */

function runs(spans: Inline[]): (TextRun | ExternalHyperlink)[] {
  const out: (TextRun | ExternalHyperlink)[] = [];
  for (const s of spans) {
    if (s.t === "link") {
      out.push(
        new ExternalHyperlink({
          link: s.href,
          children: [
            new TextRun({ text: s.text, font: SANS, color: "0A58CA", underline: {} }),
          ],
        }),
      );
      continue;
    }
    out.push(
      new TextRun({
        text: s.text,
        font: s.code ? MONO : SANS,
        ...(s.bold ? { bold: true } : {}),
        ...(s.italic ? { italics: true } : {}),
        ...(s.code
          ? { size: 20, shading: { type: ShadingType.CLEAR, fill: CODE_BG }, color: CODE_FG }
          : {}),
      }),
    );
  }
  return out.length ? out : [new TextRun({ text: "", font: SANS })];
}

/* ──────────────────────────── blocks ──────────────────────────── */

const HEADING = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

function cell(spans: Inline[], head: boolean): TableCell {
  return new TableCell({
    children: [
      new Paragraph({
        spacing: { before: 60, after: 60 },
        children: runs(
          head ? spans.map((s) => (s.t === "text" ? { ...s, bold: true } : s)) : spans,
        ),
      }),
    ],
    ...(head ? { shading: { type: ShadingType.CLEAR, fill: "F7F7F8" } } : {}),
    margins: { top: 60, bottom: 60, left: 120, right: 120 },
  });
}

function table(rows: Inline[][][]): Table {
  const edge = { style: BorderStyle.SINGLE, size: 2, color: RULE };
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: edge,
      bottom: edge,
      left: edge,
      right: edge,
      insideHorizontal: edge,
      insideVertical: edge,
    },
    rows: rows.map(
      (cells, r) =>
        new TableRow({ tableHeader: r === 0, children: cells.map((c) => cell(c, r === 0)) }),
    ),
  });
}

function toDocx(blocks: Block[]): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];

  for (const [n, b] of blocks.entries()) {
    switch (b.t) {
      case "heading":
        out.push(
          new Paragraph({
            heading: HEADING[b.depth - 1],
            spacing: { before: b.depth === 1 ? 0 : 280, after: 120 },
            children: runs(b.children),
          }),
        );
        break;

      case "para":
        out.push(new Paragraph({ spacing: { after: 160 }, children: runs(b.children) }));
        break;

      case "bullet":
        out.push(
          new Paragraph({
            bullet: { level: b.level },
            spacing: { before: 40, after: 40 },
            children: runs(b.children),
          }),
        );
        break;

      case "ordered":
        out.push(
          new Paragraph({
            numbering: { reference: `ol-${b.listId % MAX_LISTS}`, level: b.level },
            spacing: { before: 40, after: 40 },
            children: runs(b.children),
          }),
        );
        break;

      case "quote":
        out.push(
          new Paragraph({
            indent: { left: 360 },
            spacing: { before: 120, after: 120 },
            border: { left: { style: BorderStyle.SINGLE, size: 12, color: RED, space: 12 } },
            children: runs(b.children.map((s) => (s.t === "text" ? { ...s, italic: true } : s))),
          }),
        );
        break;

      case "code":
        for (const [k, text] of b.lines.entries()) {
          out.push(
            new Paragraph({
              shading: { type: ShadingType.CLEAR, fill: CODE_BG },
              spacing: { before: k === 0 ? 120 : 0, after: k === b.lines.length - 1 ? 120 : 0 },
              indent: { left: 240, right: 240 },
              children: [new TextRun({ text: text || " ", font: MONO, size: 19 })],
            }),
          );
        }
        break;

      case "table":
        out.push(table(b.rows));
        // A table butted against the next paragraph reads as one block in Word.
        if (blocks[n + 1]) out.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
        break;

      case "rule":
        out.push(
          new Paragraph({
            spacing: { before: 160, after: 160 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 1 } },
            children: [],
          }),
        );
        break;
    }
  }

  return out;
}

/* ──────────────────────────── document ──────────────────────────── */

/**
 * Build the .docx and return its bytes.
 *
 * Styling lives in the document's style definitions rather than on each
 * paragraph, so the result is a Word document someone can restyle through the
 * Styles pane like any other, instead of a wall of direct formatting.
 */
export async function markdownToDocx(opts: DocOptions): Promise<Buffer> {
  const headingStyle = (
    id: string,
    size: number,
    color: string,
    before: number,
  ): Record<string, unknown> => ({
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
      default: { document: { run: { font: SANS, size: 22, color: INK } } },
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
      ] as never,
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
        properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
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
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    font: SANS,
                    size: 16,
                    color: MUTED,
                  }),
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
          ...toDocx(parseMarkdown(opts.markdown)),
        ],
      },
    ],
  });

  return Packer.toBuffer(doc) as unknown as Promise<Buffer>;
}
