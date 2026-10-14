import type { ConversationMeta, HealthReport } from "../types.ts";

function when(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(ts).toLocaleDateString();
}

export function Sidebar({
  conversations,
  activeId,
  health,
  onSelect,
  onNew,
  onDelete,
}: {
  conversations: ConversationMeta[];
  activeId: string | null;
  health: HealthReport | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}): JSX.Element {
  return (
    <aside className="sidebar">
      <div className="sidebar__head">
        <span className="logo-plaque">
          <img
            src="/brand/logo-primary.png"
            alt="Aurora Technical Services, LLC — engineering and construction management"
          />
        </span>
        <div className="sidebar__brandrow">
          <span className="sidebar__brand">Aurora</span>
          <button type="button" className="btn btn--new" onClick={onNew}>
            New chat
          </button>
        </div>
      </div>

      <nav className="sidebar__list" aria-label="Conversations">
        {conversations.length === 0 && <p className="sidebar__empty">No conversations yet.</p>}
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
      </nav>

      <footer className="sidebar__foot">
        <div className="status">
          <span
            className={`status__dot ${health?.ok ? "status__dot--ok" : "status__dot--bad"}`}
            aria-hidden="true"
          />
          <span className="status__text">
            {health ? health.agentName : "connecting…"}
          </span>
        </div>
        {health && (
          <dl className="status__detail">
            <div>
              <dt>Tools</dt>
              <dd>{health.localTools.length} local</dd>
            </div>
            <div>
              <dt>Auto-approve</dt>
              <dd>{health.autoApprove.join(", ") || "nothing"}</dd>
            </div>
            <div>
              <dt>Shell</dt>
              <dd>{health.shellEnabled ? "enabled" : "off"}</dd>
            </div>
          </dl>
        )}
        {health && !health.ok && <p className="status__err">{health.detail}</p>}
      </footer>
    </aside>
  );
}
