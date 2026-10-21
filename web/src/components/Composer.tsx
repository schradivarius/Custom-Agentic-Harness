import { useEffect, useRef, useState } from "react";

/** The return/enter arrow, drawn rather than typed — a ↵ glyph renders
    inconsistently across the brand font stack. */
function EnterIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M13.5 3.5v3.5a3 3 0 0 1-3 3H3" />
      <path d="m6 7-3 3 3 3" />
    </svg>
  );
}

function StopIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
    </svg>
  );
}

export function Composer({
  onSend,
  onStop,
  busy,
  disabled,
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  busy: boolean;
  disabled: boolean;
}): JSX.Element {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow with the content, up to a cap, the way a desktop composer does.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  const send = (): void => {
    const text = value.trim();
    if (!text || busy) return;
    setValue("");
    onSend(text);
  };

  return (
    <div className="composer">
      <div className="composer__box">
        <textarea
          ref={ref}
          value={value}
          rows={1}
          disabled={disabled}
          placeholder={disabled ? "Connecting to the agent…" : "Message your agent…"}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="composer__controls">
          {busy ? (
            <button
              type="button"
              className="btn btn--icon btn--stop"
              onClick={onStop}
              aria-label="Stop generating"
              title="Stop generating"
            >
              <StopIcon />
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--icon btn--primary btn--send"
              onClick={send}
              disabled={disabled || !value.trim()}
              aria-label="Send message"
              title="Send message (Enter)"
            >
              <EnterIcon />
            </button>
          )}
        </div>
      </div>
      <p className="composer__hint">
        Enter to send · Shift+Enter for a new line · tool calls pause for your approval
      </p>
    </div>
  );
}
