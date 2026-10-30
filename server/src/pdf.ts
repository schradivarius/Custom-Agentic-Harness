import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import { parseMarkdown, plain, type Block, type Inline } from "./markdown.js";
import { AURORA, hex, type DocOptions } from "./housestyle.js";

/**
 * Render a parsed Markdown document as an Aurora-styled PDF.
 *
 * Shares its parse with the Word renderer, so the two formats cannot disagree
 * about what the agent wrote. What differs is everything about drawing: Word
 * is a flow format that reflows on the reader's machine, a PDF is fixed, so
 * this has to do its own pagination, measure its own tables and place its own
 * running header.
 */

/* ──────────────────────────── fonts ──────────────────────────── */

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const fontDir = path.resolve(moduleDir, "..", "..", "assets", "fonts");

/**
 * Pick the typeface to embed.
 *
 * A PDF carries its fonts; there is no substitution at the reader's end the
 * way Word does it. Neue Kabel is licensed and is not in this repository, so
 * unless someone drops the files into `assets/fonts` the output is set in
 * Helvetica — close in feel, and legible everywhere, which is the thing a PDF
 * has to be. The fallback is reported rather than silent: `usedFont` comes
 * back with the bytes so the caller can say which one it got.
 */
function resolveFonts(doc: PDFKit.PDFDocument): {
  regular: string;
  bold: string;
  italic: string;
  boldItalic: string;
  mono: string;
  name: string;
} {
  const want = {
    regular: "NeueKabel-Regular",
    bold: "NeueKabel-Bold",
    italic: "NeueKabel-Italic",
    boldItalic: "NeueKabel-BoldItalic",
  };

  const found: Partial<Record<keyof typeof want, string>> = {};
  for (const [slot, stem] of Object.entries(want) as [keyof typeof want, string][]) {
    for (const ext of [".ttf", ".otf"]) {
      const file = path.join(fontDir, stem + ext);
      if (fs.existsSync(file)) {
        found[slot] = file;
        break;
      }
    }
  }

  // All four or none: a document set half in Neue Kabel and half in Helvetica
  // looks like a mistake, which is worse than consistently using the fallback.
  if (found.regular && found.bold && found.italic && found.boldItalic) {
    doc.registerFont("sans", found.regular);
    doc.registerFont("sans-b", found.bold);
    doc.registerFont("sans-i", found.italic);
    doc.registerFont("sans-bi", found.boldItalic);
    return {
      regular: "sans",
      bold: "sans-b",
      italic: "sans-i",
      boldItalic: "sans-bi",
      mono: "Courier",
      name: "Neue Kabel",
    };
  }

  return {
    regular: "Helvetica",
    bold: "Helvetica-Bold",
    italic: "Helvetica-Oblique",
    boldItalic: "Helvetica-BoldOblique",
    mono: "Courier",
    name: "Helvetica",
  };
}

/* ──────────────────────────── layout ──────────────────────────── */

const MARGIN = 72; // 1 inch
const BODY = 10.5;
const LINE_GAP = 3;

/** Point size and colour for each heading depth. */
const HEAD = [
  { size: 20, color: AURORA.RED, before: 0, after: 8 },
  { size: 15, color: AURORA.RED, before: 16, after: 6 },
  { size: 12.5, color: AURORA.INK, before: 14, after: 5 },
  { size: 11.5, color: AURORA.INK, before: 12, after: 4 },
  { size: 11, color: AURORA.MUTED, before: 12, after: 4 },
  { size: 10.5, color: AURORA.MUTED, before: 12, after: 4 },
];

export interface PdfResult {
  bytes: Buffer;
  /** The typeface actually embedded, so the caller can report a fallback. */
  font: string;
}

export async function markdownToPdf(opts: DocOptions): Promise<PdfResult> {
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    // Pages are revisited at the end to write "Page X of Y", which cannot be
    // known until the last one exists.
    bufferPages: true,
    info: {
      Title: opts.title,
      Author: "Aurora Technical Services",
      ...(opts.subtitle ? { Subject: opts.subtitle } : {}),
    },
  });

  const F = resolveFonts(doc);
  const left = MARGIN;
  const width = doc.page.width - MARGIN * 2;
  const bottom = doc.page.height - MARGIN;

  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });

  /** Start a new page when the next block would not fit on this one. */
  const room = (needed: number): void => {
    if (doc.y + needed > bottom) doc.addPage();
  };

  const fontFor = (s: Inline): string => {
    if (s.t === "link") return F.regular;
    if (s.code) return F.mono;
    if (s.bold && s.italic) return F.boldItalic;
    if (s.bold) return F.bold;
    if (s.italic) return F.italic;
    return F.regular;
  };

  /**
   * Draw a run of inline spans as one wrapped paragraph.
   *
   * pdfkit chains spans with `continued: true` and only lays the line out when
   * a span arrives without it, so the final span must always clear the flag —
   * otherwise the paragraph is buffered and the next one runs into it.
   */
  const inline = (
    spans: Inline[],
    o: { size?: number; color?: string; indent?: number; width?: number; align?: string } = {},
  ): void => {
    const size = o.size ?? BODY;
    const w = o.width ?? width - (o.indent ?? 0);
    const x = left + (o.indent ?? 0);
    const base = o.color ?? AURORA.INK;

    room(size * 2);
    const startY = doc.y;

    spans.forEach((s, i) => {
      const last = i === spans.length - 1;
      const isCode = s.t === "text" && s.code === true;
      doc
        .font(fontFor(s))
        .fontSize(isCode ? size - 0.5 : size)
        .fillColor(hex(s.t === "link" ? AURORA.LINK : isCode ? AURORA.CODE_FG : base));

      /*
       * Only the first span is positioned. pdfkit reads `text(str, x, y, opts)`
       * positionally, so handing it an explicit `undefined` x is not the same
       * as omitting it — it resets to the left margin and starts a new line,
       * which puts every run after a bold word on its own line.
       */
      const opts = {
        continued: !last,
        width: w,
        lineGap: LINE_GAP,
        ...(o.align ? { align: o.align as "left" } : {}),
        ...(s.t === "link" ? { link: s.href, underline: true } : { link: null, underline: false }),
      };
      if (i === 0) doc.text(s.text, x, startY, opts);
      else doc.text(s.text, opts);
    });
  };

  /* ── tables ───────────────────────────────────────────────────── */

  const drawTable = (rows: Inline[][][]): void => {
    const cols = Math.max(...rows.map((r) => r.length));
    if (!cols) return;

    // Width by the longest cell in each column, so a narrow "Value" column
    // does not get the same space as a prose column, then normalised.
    const weights = Array.from({ length: cols }, (_, c) =>
      Math.max(6, ...rows.map((r) => plain(r[c] ?? []).length)),
    );
    const total = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => Math.max(46, (w / total) * width));
    const scale = width / widths.reduce((a, b) => a + b, 0);
    const colW = widths.map((w) => w * scale);

    const PAD = 6;
    doc.y += 4;

    rows.forEach((row, r) => {
      const head = r === 0;
      // Measure first: a row has to be placed whole or moved to the next page.
      const heights = row.map((cellSpans, c) => {
        doc.font(head ? F.bold : F.regular).fontSize(BODY - 0.5);
        return doc.heightOfString(plain(cellSpans), {
          width: (colW[c] ?? 60) - PAD * 2,
          lineGap: 1,
        });
      });
      const rowH = Math.max(18, ...heights) + PAD * 2;

      if (doc.y + rowH > bottom) doc.addPage();
      const top = doc.y;

      if (head) {
        doc.rect(left, top, width, rowH).fill(hex(AURORA.TABLE_HEAD));
      }

      let x = left;
      row.forEach((cellSpans, c) => {
        const w = colW[c] ?? 60;
        doc
          .font(head ? F.bold : F.regular)
          .fontSize(BODY - 0.5)
          .fillColor(hex(AURORA.INK))
          .text(plain(cellSpans), x + PAD, top + PAD, {
            width: w - PAD * 2,
            lineGap: 1,
            link: null,
            underline: false,
          });
        x += w;
      });

      // Rules drawn after the text so a shaded header does not cover them.
      doc.lineWidth(0.5).strokeColor(hex(AURORA.RULE));
      doc.moveTo(left, top).lineTo(left + width, top).stroke();
      doc.moveTo(left, top + rowH).lineTo(left + width, top + rowH).stroke();
      let vx = left;
      for (let c = 0; c <= cols; c++) {
        doc.moveTo(vx, top).lineTo(vx, top + rowH).stroke();
        vx += colW[c] ?? 0;
      }

      doc.y = top + rowH;
    });

    doc.y += 10;
  };

  /* ── the document ─────────────────────────────────────────────── */

  doc.font(F.bold).fontSize(22).fillColor(hex(AURORA.RED)).text(opts.title, left, MARGIN, {
    width,
    lineGap: 2,
  });
  if (opts.subtitle) {
    doc.moveDown(0.25);
    doc.font(F.regular).fontSize(9.5).fillColor(hex(AURORA.MUTED)).text(opts.subtitle, { width });
  }
  doc.moveDown(0.9);

  for (const b of parseMarkdown(opts.markdown)) {
    switch (b.t) {
      case "heading": {
        const h = HEAD[b.depth - 1] ?? HEAD[5]!;
        doc.y += h.before;
        room(h.size * 2.4);
        inline(b.children, { size: h.size, color: h.color });
        doc.y += h.after;
        break;
      }

      case "para":
        inline(b.children);
        doc.y += 7;
        break;

      case "bullet": {
        const ind = 14 + b.level * 14;
        const y = doc.y;
        room(BODY * 2);
        doc
          .font(F.regular)
          .fontSize(BODY)
          .fillColor(hex(AURORA.MUTED))
          .text("•", left + ind - 10, doc.y, { width: 10, link: null, underline: false });
        doc.y = y;
        inline(b.children, { indent: ind });
        doc.y += 3;
        break;
      }

      case "ordered": {
        const ind = 20 + b.level * 14;
        const y = doc.y;
        room(BODY * 2);
        doc
          .font(F.regular)
          .fontSize(BODY)
          .fillColor(hex(AURORA.MUTED))
          .text(`${b.index}.`, left + ind - 18, doc.y, { width: 16, link: null, underline: false });
        doc.y = y;
        inline(b.children, { indent: ind });
        doc.y += 3;
        break;
      }

      case "quote": {
        const y0 = doc.y;
        inline(
          b.children.map((s) => (s.t === "text" ? { ...s, italic: true } : s)),
          { indent: 18, color: AURORA.MUTED },
        );
        // The rule is drawn after the text, which is what determines its height.
        doc
          .lineWidth(2.5)
          .strokeColor(hex(AURORA.RED))
          .moveTo(left + 3, y0)
          .lineTo(left + 3, doc.y)
          .stroke();
        doc.y += 8;
        break;
      }

      case "code": {
        const lines = b.lines.length ? b.lines : [""];
        const lh = 12.5;
        const boxH = lines.length * lh + 12;
        room(Math.min(boxH, 120));
        const top = doc.y;
        doc.rect(left, top, width, boxH).fill(hex(AURORA.CODE_BG));
        doc.font(F.mono).fontSize(8.8).fillColor(hex(AURORA.INK));
        lines.forEach((l, i) => {
          doc.text(l || " ", left + 10, top + 6 + i * lh, {
            width: width - 20,
            lineBreak: false,
            link: null,
            underline: false,
          });
        });
        doc.y = top + boxH + 8;
        break;
      }

      case "table":
        drawTable(b.rows);
        break;

      case "rule":
        doc.y += 6;
        room(14);
        doc
          .lineWidth(0.75)
          .strokeColor(hex(AURORA.RULE))
          .moveTo(left, doc.y)
          .lineTo(left + width, doc.y)
          .stroke();
        doc.y += 12;
        break;
    }
  }

  /* ── running header and page numbers ──────────────────────────── */

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    /*
     * The footer sits below the bottom margin, and writing past that margin is
     * exactly what pdfkit treats as an overflow — it helpfully appends a page,
     * which then gets a footer of its own, and the document grows a blank page
     * per page it already had. Dropping the margin for the duration of the
     * write is the documented way to place furniture in the margin.
     */
    const keep = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .font(F.regular)
      .fontSize(8)
      .fillColor(hex(AURORA.MUTED))
      .text("Aurora Technical Services", left, MARGIN - 26, {
        width,
        align: "right",
        link: null,
        underline: false,
      })
      .text(`Page ${i + 1} of ${range.count}`, left, doc.page.height - MARGIN + 14, {
        width,
        align: "center",
        link: null,
        underline: false,
      });
    doc.page.margins.bottom = keep;
  }

  doc.end();
  return { bytes: await done, font: F.name };
}
