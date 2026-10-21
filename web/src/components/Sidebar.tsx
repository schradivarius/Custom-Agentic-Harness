import { useState, type ReactNode } from "react";
import type { ConversationMeta, HealthReport, ToolInfo } from "../types.ts";

const ico = {
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  fill: "none",
};

function Svg({ size = 16, children }: { size?: number; children: ReactNode }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false" {...ico}>
      {children}
    </svg>
  );
}

const PencilIcon = (): JSX.Element => (
  <Svg>
    <path d="M11.3 2.7a1.3 1.3 0 0 1 1.9 1.9L5.6 12.2l-2.6.7.7-2.6z" />
  </Svg>
);
const ToolIcon = (): JSX.Element => (
  <Svg size={14}>
    <path d="M10.2 2.6a3.2 3.2 0 0 0-3.9 4.1l-3.6 3.6a1.3 1.3 0 0 0 1.9 1.9l3.6-3.6a3.2 3.2 0 0 0 4.1-3.9L10.8 6.3 9 5.9l-.4-1.8z" />
  </Svg>
);

/**
 * Group conversations the way a chat sidebar is read — by recency, newest
 * first — rather than as one undifferentiated list.
 */
function groupByAge(items: ConversationMeta[]): [string, ConversationMeta[]][] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86_400_000;

  const buckets: Record<string, ConversationMeta[]> = {};
  const order: string[] = [];
  const put = (label: string, c: ConversationMeta): void => {
    if (!buckets[label]) {
      buckets[label] = [];
      order.push(label);
    }
    buckets[label]!.push(c);
  };

  for (const c of [...items].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (c.updatedAt >= startOfToday) put("Today", c);
    else if (c.updatedAt >= startOfToday - day) put("Yesterday", c);
    else if (c.updatedAt >= startOfToday - day * 7) put("Previous 7 days", c);
    else if (c.updatedAt >= startOfToday - day * 30) put("Previous 30 days", c);
    else put("Older", c);
  }
  return order.map((label) => [label, buckets[label]!]);
}

const RISK_MARK: Record<ToolInfo["risk"], string> = {
  safe: "auto",
  caution: "ask",
  dangerous: "ask",
};

export function Sidebar({
  conversations,
  activeId,
  health,
  tools,
  onSelect,
  onNew,
  onDelete,
}: {
  conversations: ConversationMeta[];
  activeId: string | null;
  health: HealthReport | null;
  tools: ToolInfo[];
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}): JSX.Element {
  const [toolsOpen, setToolsOpen] = useState(false);
  const groups = groupByAge(conversations);

  return (
    <aside className="side">
      <div className="side__top">
        <picture>
          {/* The artwork comes as a pair: the "A" is white for dark
              backgrounds and Aurora's logo gray for light ones. */}
          <source srcSet="/brand/aurora-mark-dark.png" media="(prefers-color-scheme: dark)" />
          <img className="brandmark" src="/brand/aurora-mark-light.png" alt="Aurora" />
        </picture>
        <button type="button" className="newchat" onClick={onNew}>
          <PencilIcon />
          <span>New chat</span>
        </button>
      </div>

      <nav className="side__list" aria-label="Conversations">
        {conversations.length === 0 && <p className="side__empty">No conversations yet.</p>}
        {groups.map(([label, items]) => (
          <section key={label} className="side__group">
            <h2 className="side__grouphead">{label}</h2>
            {items.map((c) => (
              <div key={c.id} className={`conv ${c.id === activeId ? "conv--active" : ""}`}>
                <button type="button" className="conv__main" onClick={() => onSelect(c.id)}>
                  {c.title}
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
          </section>
        ))}
      </nav>

      <footer className="side__foot">
        <button
          type="button"
          className="side__tools"
          onClick={() => setToolsOpen((v) => !v)}
          aria-expanded={toolsOpen}
        >
          <ToolIcon />
          <span>Tools</span>
          <span className="side__count">{tools.length}</span>
        </button>
        {toolsOpen && (
          <div className="side__toolbody">
            {tools.length === 0 && <p className="side__empty">No local tools.</p>}
            {tools.map((t) => (
              <div key={t.name} className="rowitem" title={t.description}>
                <span className="rowitem__name">{t.name}</span>
                <span className={`rowitem__tag rowitem__tag--${t.risk}`}>{RISK_MARK[t.risk]}</span>
              </div>
            ))}
          </div>
        )}

        <div className="status">
          <span
            className={`status__dot ${health?.ok ? "status__dot--ok" : "status__dot--bad"}`}
            aria-hidden="true"
          />
          <span className="status__text">{health ? health.agentName : "connecting…"}</span>
        </div>
        {health && !health.ok && <p className="status__err">{health.detail}</p>}
      </footer>
    </aside>
  );
}
