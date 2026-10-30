# Fonts

Drop Neue Kabel here to have generated PDFs set in it:

```
NeueKabel-Regular.ttf
NeueKabel-Bold.ttf
NeueKabel-Italic.ttf
NeueKabel-BoldItalic.ttf
```

`.otf` works too. All four weights or none — a partial set is ignored, because
a document set half in Neue Kabel and half in the fallback looks like a
mistake rather than a choice.

The font is licensed, so the files are not in this repository. Without them
PDFs are set in Helvetica and `create_document` says so in its result.

Word documents do not need this: a `.docx` only names the font, and Word
substitutes on the reader's machine. A PDF has to embed what it draws.
