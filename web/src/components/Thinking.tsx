/**
 * Shown while the agent is working but has produced nothing visible yet.
 *
 * The gap between sending and the first token is not small — a reasoning
 * model can spend several seconds before it emits anything, and a tool round
 * adds another wait after the result comes back. Without this the window just
 * sits there and the only sign anything is happening is the Stop button.
 */
export function Thinking({ label }: { label: string }): JSX.Element {
  return (
    <div className="turn turn--assistant">
      <div className="thinking" role="status" aria-live="polite">
        <span className="thinking__dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="thinking__label">{label}</span>
      </div>
    </div>
  );
}
