import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { Markdown } from "./Markdown.tsx";
import type { ArtifactKind, ArtifactView } from "../types.ts";

const KIND_LABEL: Record<ArtifactKind, string> = {
  markdown: "Document",
  code: "Code",
  html: "Page",
  svg: "Diagram",
  document: "Word document",
};

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
            {KIND_LABEL[artifact.kind]}
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
              {KIND_LABEL[artifact.kind]} · {artifact.filename} · {size(bytesOf(artifact))}
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
          <div className="apanel__note">
            <p>
              This is a Word file in Aurora house style. There is no in-browser preview — open it
              in Word to read or edit it.
            </p>
            <a className="apanel__dl" href={href} download={artifact.filename}>
              Download {artifact.filename}
            </a>
          </div>
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
