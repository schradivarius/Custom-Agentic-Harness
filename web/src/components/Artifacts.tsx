import { useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";
import { Markdown } from "./Markdown.tsx";
import type { ArtifactKind, ArtifactView } from "../types.ts";

const KIND_LABEL: Record<ArtifactKind, string> = {
  markdown: "Document",
  code: "Code",
  html: "Page",
  svg: "Diagram",
  document: "Document",
};

/**
 * What to call an artifact in the UI.
 *
 * `document` covers more than one file format, so the kind alone is not enough
 * to label it — calling a PDF a Word document is both wrong and the sort of
 * thing someone forwards to a client before noticing.
 */
function label(a: ArtifactView): string {
  if (a.kind !== "document") return KIND_LABEL[a.kind];
  if (a.mime === "application/pdf") return "PDF";
  if (a.mime.includes("wordprocessingml")) return "Word document";
  return "Document";
}

const ico = {
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  fill: "none",
};

function KindIcon({ kind }: { kind: ArtifactKind }): JSX.Element {
  const paths: Record<ArtifactKind, JSX.Element> = {
    markdown: (
      <>
        <path d="M3.5 2.5h6l3 3v8h-9z" />
        <path d="M5.5 8h5M5.5 10.5h5" />
      </>
    ),
    document: (
      <>
        <path d="M3.5 2.5h6l3 3v8h-9z" />
        <path d="M5.5 8l1.2 3 1.3-3 1.3 3L10.5 8" />
      </>
    ),
    code: <path d="M6 5.5 3.5 8 6 10.5M10 5.5 12.5 8 10 10.5" />,
    html: (
      <>
        <rect x="2.5" y="3" width="11" height="10" rx="1.2" />
        <path d="M2.5 6h11" />
      </>
    ),
    svg: (
      <>
        <circle cx="8" cy="8" r="2.2" />
        <path d="M8 2.5v3.3M8 10.2v3.3M2.5 8h3.3M10.2 8h3.3" />
      </>
    ),
  };
  return (
    <svg viewBox="0 0 16 16" width={15} height={15} aria-hidden="true" focusable="false" {...ico}>
      {paths[kind]}
    </svg>
  );
}

const bytesOf = (a: ArtifactView): number =>
  a.history.find((h) => h.version === a.version)?.bytes ?? 0;

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/* ───────────────────────── inline card ───────────────────────── */

/**
 * The in-transcript handle for an artifact.
 *
 * It deliberately shows no content. The transcript is the conversation; the
 * artifact is the deliverable, and duplicating it inline is what this whole
 * feature exists to stop.
 */
export function ArtifactCard({
  artifact,
  active,
  onOpen,
}: {
  artifact: ArtifactView | undefined;
  active: boolean;
  onOpen: () => void;
}): JSX.Element | null {
  if (!artifact) return null;
  return (
    <div className="turn turn--assistant">
      <button
        type="button"
        className={`acard ${active ? "acard--active" : ""}`}
        onClick={onOpen}
        aria-label={`Open ${artifact.title}`}
      >
        <span className="acard__icon">
          <KindIcon kind={artifact.kind} />
        </span>
        <span className="acard__body">
          <span className="acard__title">{artifact.title}</span>
          <span className="acard__meta">
            {label(artifact)}
            {artifact.version > 1 && ` · v${artifact.version}`}
            {` · ${size(bytesOf(artifact))}`}
          </span>
        </span>
        <span className="acard__open">{active ? "Showing" : "Open"}</span>
      </button>
    </div>
  );
}

/* ───────────────────────── side panel ───────────────────────── */

/**
 * Render agent-authored markup in an iframe that cannot reach anything.
 *
 * `allow-scripts` without `allow-same-origin` is the safe half of that pair:
 * the frame gets a unique opaque origin, so a script in it can animate the
 * page but cannot read our DOM, our cookies or call the API as the viewer.
 * Granting both together would hand it the ability to remove its own sandbox,
 * which is why they are never set at the same time here.
 */
function Sandboxed({ html, title }: { html: string; title: string }): JSX.Element {
  return (
    <iframe
      className="apanel__frame"
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={html}
    />
  );
}

/**
 * Wrap converted Word HTML in a readable page.
 *
 * The frame has an opaque origin, so it inherits nothing from the app — not
 * the stylesheet, not the theme. Everything it needs travels with it. It is
 * deliberately light-on-white whatever the app's theme: this is a preview of
 * a printed document, and a dark one would misrepresent it.
 */
function wrapDocHtml(html: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  :root { color-scheme: light; }
  body {
    margin: 0; padding: 40px 48px 64px; background: #fff; color: #1f1f1f;
    font-family: "Neue Kabel", -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
    font-size: 15px; line-height: 1.62;
  }
  h1, h2 { color: #c90000; font-weight: 600; line-height: 1.25; }
  h1 { font-size: 28px; margin: 0 0 18px; }
  h2 { font-size: 21px; margin: 32px 0 10px; }
  h3, h4, h5, h6 { font-size: 17px; margin: 26px 0 8px; font-weight: 600; }
  p { margin: 0 0 13px; }
  ul, ol { margin: 0 0 13px; padding-left: 26px; }
  li { margin: 4px 0; }
  a { color: #0a58ca; }
  table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 14px; }
  th, td { border: 1px solid #d8d8d8; padding: 7px 10px; text-align: left; vertical-align: top; }
  th { background: #f7f7f8; font-weight: 600; }
  img { max-width: 100%; height: auto; }
</style></head><body>${html}</body></html>`;
}

type Preview =
  | { state: "loading" }
  | { state: "pdf" }
  | { state: "html"; html: string }
  | { state: "none"; reason: string };

/**
 * Show a generated document, which neither artifact kind above can do.
 *
 * A PDF the browser renders itself, so it is framed straight from the inline
 * download. A .docx has no renderer anywhere, so the server converts it and
 * the result is displayed in a frame that can do nothing at all.
 */
function DocumentPreview({
  artifact,
  href,
}: {
  artifact: ArtifactView;
  href: string;
}): JSX.Element {
  const [preview, setPreview] = useState<Preview>({ state: "loading" });

  useEffect(() => {
    let live = true;
    setPreview({ state: "loading" });
    api
      .getPreview(artifact.id)
      .then((r) => {
        if (!live) return;
        setPreview(r.kind === "pdf" ? { state: "pdf" } : { state: "html", html: r.html });
      })
      .catch((err: unknown) => {
        if (!live) return;
        setPreview({
          state: "none",
          reason: err instanceof Error ? err.message : String(err),
        });
      });
    // Cancel on unmount: a slow conversion must not land in a panel the user
    // has since pointed at something else.
    return () => {
      live = false;
    };
  }, [artifact.id]);

  const srcDoc = useMemo(
    () => (preview.state === "html" ? wrapDocHtml(preview.html) : ""),
    [preview],
  );

  if (preview.state === "loading") {
    return <div className="apanel__note"><p>Rendering a preview…</p></div>;
  }

  if (preview.state === "pdf") {
    /*
     * Not sandboxed, deliberately. The bytes are served as application/pdf
     * with nosniff, so the browser hands them to its own PDF viewer rather
     * than parsing them as a page — there is no HTML here to execute. A
     * sandbox flag would instead break that viewer in several browsers.
     */
    const src = `${href}${href.includes("?") ? "&" : "?"}inline=1`;
    return <iframe className="apanel__frame" title={artifact.title} src={src} />;
  }

  if (preview.state === "html") {
    return (
      <iframe
        className="apanel__frame"
        title={artifact.title}
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={srcDoc}
      />
    );
  }

  return (
    <div className="apanel__note">
      <p>
        No preview for this one — {preview.reason}. The file itself is fine; download it to read
        it.
      </p>
      <a className="apanel__dl" href={href} download={artifact.filename}>
        Download {artifact.filename}
      </a>
    </div>
  );
}

export function ArtifactPanel({
  artifact,
  onClose,
  onVersion,
}: {
  artifact: ArtifactView;
  onClose: () => void;
  onVersion: (version: number) => void;
}): JSX.Element {
  const [tab, setTab] = useState<"preview" | "source">("preview");

  // A document has no preview to show, and a new artifact should not inherit
  // the previous one's tab.
  useEffect(() => {
    setTab(artifact.kind === "document" ? "source" : "preview");
  }, [artifact.id, artifact.kind]);

  const previewable = artifact.kind !== "document";
  const href = api.downloadUrl(artifact.id, artifact.version);

  return (
    <aside className="apanel" aria-label="Artifact">
      <header className="apanel__top">
        <div className="apanel__id">
          <span className="apanel__icon">
            <KindIcon kind={artifact.kind} />
          </span>
          <div className="apanel__names">
            <h2 className="apanel__title">{artifact.title}</h2>
            <p className="apanel__sub">
              {label(artifact)} · {artifact.filename} · {size(bytesOf(artifact))}
            </p>
          </div>
        </div>
        <button type="button" className="apanel__x" onClick={onClose} aria-label="Close panel">
          ×
        </button>
      </header>

      <div className="apanel__bar">
        {previewable && (
          <div className="apanel__tabs" role="tablist">
            {(["preview", "source"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                className={`apanel__tab ${tab === t ? "is-on" : ""}`}
                onClick={() => setTab(t)}
              >
                {t === "preview" ? "Preview" : "Source"}
              </button>
            ))}
          </div>
        )}

        <div className="apanel__right">
          {artifact.history.length > 1 && (
            <label className="apanel__ver">
              <span className="sr-only">Version</span>
              <select
                value={artifact.version}
                onChange={(e) => onVersion(Number(e.target.value))}
              >
                {[...artifact.history].reverse().map((h) => (
                  <option key={h.version} value={h.version}>
                    v{h.version}
                    {h.version === artifact.history.length ? " (latest)" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          {/*
            A plain link, not a fetch-and-blob: the browser's own download
            handling honours Content-Disposition and streams to disk, where a
            blob would hold the whole file in memory first.
          */}
          <a className="apanel__dl" href={href} download={artifact.filename}>
            Download
          </a>
        </div>
      </div>

      <div className="apanel__body">
        {artifact.kind === "document" ? (
          <DocumentPreview artifact={artifact} href={href} />
        ) : tab === "preview" ? (
          artifact.kind === "markdown" ? (
            <div className="apanel__doc">
              <Markdown text={artifact.text ?? ""} />
            </div>
          ) : artifact.kind === "html" || artifact.kind === "svg" ? (
            <Sandboxed html={artifact.text ?? ""} title={artifact.title} />
          ) : (
            <pre className="apanel__code">
              <code>{artifact.text ?? ""}</code>
            </pre>
          )
        ) : (
          <pre className="apanel__code">
            <code>{artifact.text ?? ""}</code>
          </pre>
        )}
      </div>
    </aside>
  );
}
