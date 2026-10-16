import { useState, type ReactNode } from "react";
import type { ConversationMeta, HealthReport, TargetOption, ToolInfo } from "../types.ts";

/* ── icons ─────────────────────────────────────────────────────────
   Drawn inline at 14px on a 16px grid so they sit on the monospace
   baseline without a font dependency. */

const ico = {
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  fill: "none",
};

function Svg({ children }: { children: ReactNode }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" {...ico}>
      {children}
    </svg>
  );
}

const PlusIcon = (): JSX.Element => (
  <Svg>
    <path d="M8 3.5v9M3.5 8h9" />
  </Svg>
);
const ChatIcon = (): JSX.Element => (
  <Svg>
    <path d="M13.5 9.5a1.5 1.5 0 0 1-1.5 1.5H6l-3 2.5V4a1.5 1.5 0 0 1 1.5-1.5h7.5A1.5 1.5 0 0 1 13.5 4z" />
  </Svg>
);
const ModelIcon = (): JSX.Element => (
  <Svg>
    <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" />
    <path d="M6.5 2.5v2M9.5 2.5v2M6.5 11.5v2M9.5 11.5v2M2.5 6.5h2M2.5 9.5h2M11.5 6.5h2M11.5 9.5h2" />
  </Svg>
);
const ToolIcon = (): JSX.Element => (
  <Svg>
    <path d="M10.2 2.6a3.2 3.2 0 0 0-3.9 4.1l-3.6 3.6a1.3 1.3 0 0 0 1.9 1.9l3.6-3.6a3.2 3.2 0 0 0 4.1-3.9L10.8 6.3 9 5.9l-.4-1.8z" />
  </Svg>
);
const Chevron = ({ open }: { open: boolean }): JSX.Element => (
  <svg
    viewBox="0 0 16 16"
    width="11"
    height="11"
    aria-hidden="true"
    focusable="false"
    className={`rail__chev ${open ? "rail__chev--open" : ""}`}
    {...ico}
  >
    <path d="m6 4 4 4-4 4" />
  </svg>
);

/* ── a collapsible rail section ────────────────────────────────── */

function Section({
  icon,
  label,
  badge,
  defaultOpen = false,
  children,
}: {
  icon: ReactNode;
  label: string;
  badge?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rail__section">
      <button
        type="button"
        className="rail__item"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="rail__ico">{icon}</span>
        <span className="rail__label">{label}</span>
        {badge && <span className="rail__badge">{badge}</span>}
        <Chevron open={open} />
      </button>
      {open && <div className="rail__body">{children}</div>}
    </div>
  );
}

function when(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return new Date(ts).toLocaleDateString();
}

const RISK_MARK: Record<ToolInfo["risk"], string> = {
  safe: "auto",
  caution: "ask",
  dangerous: "ask!",
};

export function Sidebar({
  conversations,
  activeId,
  health,
  targets,
  tools,
  onSelect,
  onNew,
  onDelete,
}: {
  conversations: ConversationMeta[];
  activeId: string | null;
  health: HealthReport | null;
  targets: TargetOption[];
  tools: ToolInfo[];
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}): JSX.Element {
  return (
    <aside className="rail">
      <div className="rail__head">
        <picture>
          {/* The artwork comes as a pair: the "A" is white for dark
              backgrounds and Aurora's logo gray for light ones. */}
          <source srcSet="/brand/aurora-mark-dark.png" media="(prefers-color-scheme: dark)" />
          {/* The mark now stands alone, so it carries the name for anyone
              who cannot see it — it is no longer decorative. */}
          <img className="brandmark" src="/brand/aurora-mark-light.png" alt="Aurora" />
        </picture>
      </div>

      <nav className="rail__nav" aria-label="Sections">
        <button type="button" className="rail__item rail__item--action" onClick={onNew}>
          <span className="rail__ico">
            <PlusIcon />
          </span>
          <span className="rail__label">New chat</span>
        </button>

        <Section
          icon={<ChatIcon />}
          label="Chats"
          badge={conversations.length ? String(conversations.length) : undefined}
          defaultOpen
        >
          {conversations.length === 0 && <p className="rail__empty">No conversations yet.</p>}
          {conversations.map((c) => (
            <div key={c.id} className={`conv ${c.id === activeId ? "conv--active" : ""}`}>
              <button type="button" className="conv__main" onClick={() => onSelect(c.id)}>
                <span className="conv__title">{c.title}</span>
                <span className="conv__meta">{when(c.updatedAt)}</span>
              </button>
              <button
                type="button"
                className="conv__del"
                aria-label={`Delete ${c.title}`}
                onClick={() => onDelete(c.id)}
              >
                ×
              </button>
            </div>
          ))}
        </Section>

        <Section
          icon={<ModelIcon />}
          label="Models"
          badge={targets.length ? String(targets.length) : undefined}
        >
          {targets.length === 0 && <p className="rail__empty">None discovered.</p>}
          {targets.map((t) => (
            <div key={t.id} className="rowitem" title={t.detail ?? t.label}>
              <span className="rowitem__name">{t.label}</span>
              <span className={`rowitem__tag rowitem__tag--${t.kind}`}>
                {t.kind === "agent" ? "agent" : "model"}
              </span>
            </div>
          ))}
        </Section>

        <Section
          icon={<ToolIcon />}
          label="Tools"
          badge={tools.length ? String(tools.length) : undefined}
        >
          {tools.length === 0 && <p className="rail__empty">No local tools.</p>}
          {tools.map((t) => (
            <div key={t.name} className="rowitem" title={t.description}>
              <span className="rowitem__name">{t.name}</span>
              <span className={`rowitem__tag rowitem__tag--${t.risk}`}>{RISK_MARK[t.risk]}</span>
            </div>
          ))}
        </Section>
      </nav>

      <footer className="rail__foot">
        <div className="status">
          <span
            className={`status__dot ${health?.ok ? "status__dot--ok" : "status__dot--bad"}`}
            aria-hidden="true"
          />
          <span className="status__text">{health ? health.agentName : "connecting…"}</span>
        </div>
        {health && (
          <p className="status__line">
            {health.shellEnabled ? "shell on" : "shell off"} · auto:{" "}
            {health.autoApprove.join(",") || "none"}
          </p>
        )}
        {health && !health.ok && <p className="status__err">{health.detail}</p>}
      </footer>
    </aside>
  );
}
