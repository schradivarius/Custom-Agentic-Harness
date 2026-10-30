/**
 * Aurora's document palette, shared by every generated format.
 *
 * Word takes bare hex, PDF takes `#rrggbb`, so both spellings live here
 * rather than being converted at each use.
 */
export const AURORA = {
  /** Aurora brand red. */
  RED: "C90000",
  INK: "1F1F1F",
  MUTED: "6B6B6B",
  RULE: "D8D8D8",
  CODE_BG: "F4F4F5",
  CODE_FG: "B00020",
  TABLE_HEAD: "F7F7F8",
  LINK: "0A58CA",

  /**
   * Neue Kabel is Aurora's typeface. Word substitutes silently when a font is
   * missing, so a reader without it sees a fallback rather than an error.
   * PDF cannot do that — see pdf.ts, which has to embed what it draws.
   */
  SANS: "Neue Kabel",
  MONO: "Consolas",
} as const;

/** Hex with the `#` a PDF library wants. */
export const hex = (c: string): string => `#${c}`;

export interface DocOptions {
  title: string;
  markdown: string;
  /** Printed under the title on page one. */
  subtitle?: string;
}
