import fs from "node:fs/promises";
import path from "node:path";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

/**
 * Pull text and HTML out of binary office formats.
 *
 * Used for two different jobs that happen to need the same machinery: letting
 * the agent read a .docx or .pdf someone put in the workspace, and rendering a
 * preview of a .docx the agent just generated, since no browser can display
 * one natively.
 */

/** Sniff by content, not by extension — a name is a claim, not a fact. */
async function sniff(bytes: Buffer): Promise<"docx" | "pdf" | "unknown"> {
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  // Every .docx is a zip; the parse below is what proves it is a Word file.
  if (bytes.subarray(0, 4).toString("hex") === "504b0304") return "docx";
  return "unknown";
}

/** A .docx as HTML, for display. Styling is left to the page that shows it. */
export async function docxToHtml(bytes: Buffer): Promise<string> {
  const { value } = await mammoth.convertToHtml({ buffer: bytes });
  return value;
}

/** A .pdf as plain text, page by page. */
async function pdfToText(bytes: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  try {
    return (await parser.getText()).text;
  } finally {
    // pdf.js holds worker resources open; a server reading many documents
    // leaks them without this.
    await parser.destroy?.();
  }
}

/**
 * Read a document from disk as text.
 *
 * The caller is responsible for having confined the path to the workspace —
 * this does no containment of its own.
 */
export async function readDocument(file: string): Promise<string> {
  const bytes = await fs.readFile(file);
  const kind = await sniff(bytes);

  if (kind === "pdf") {
    const text = (await pdfToText(bytes)).trim();
    return text || "(The PDF parsed, but holds no extractable text. It is probably a scan.)";
  }

  if (kind === "docx") {
    const { value } = await mammoth.extractRawText({ buffer: bytes });
    const text = value.trim();
    return text || "(The document parsed, but holds no text.)";
  }

  const ext = path.extname(file).toLowerCase();
  throw new Error(
    `${path.basename(file)} is not a .docx or .pdf (it does not start with either format's signature${
      ext ? `, despite the ${ext} extension` : ""
    }). Use read_file for text formats.`,
  );
}
