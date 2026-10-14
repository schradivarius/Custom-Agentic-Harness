import type { TargetOption } from "../types.ts";

/**
 * Chooses the agent or model deployment a turn is addressed to.
 *
 * A native select keeps the keyboard and screen-reader behaviour for free, and
 * the optgroups carry the distinction that matters: an agent brings its own
 * tools and instructions, a bare model gets the harness's.
 */
export function TargetPicker({
  targets,
  value,
  onChange,
  disabled,
}: {
  targets: TargetOption[];
  value: string | null;
  onChange: (id: string) => void;
  disabled: boolean;
}): JSX.Element | null {
  if (targets.length === 0) return null;

  const agents = targets.filter((t) => t.kind === "agent");
  const models = targets.filter((t) => t.kind === "model");
  const selected = targets.find((t) => t.id === value) ?? targets[0];

  return (
    <div className="picker">
      <label className="picker__label sr-only" htmlFor="target-select">
        Model
      </label>
      <select
        id="target-select"
        className="picker__select"
        value={selected?.id ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {agents.length > 0 && (
          <optgroup label="Agents">
            {agents.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
                {t.detail ? ` — ${t.detail}` : ""}
                {t.isDefault ? " (default)" : ""}
              </option>
            ))}
          </optgroup>
        )}
        {models.length > 0 && (
          <optgroup label="Model deployments">
            {models.map((t) => (
              <option key={t.id} value={t.id}>
                {t.detail ?? t.label}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {selected && (
        <span
          className="picker__hint"
          title={
            selected.toolSource === "agent"
              ? "Tools come from the agent version in Foundry."
              : "No agent involved — this harness sends its own instructions and tools with every call."
          }
        >
          {selected.toolSource === "agent" ? "agent tools" : "harness tools"}
        </span>
      )}
    </div>
  );
}
