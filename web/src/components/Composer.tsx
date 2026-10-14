import { useEffect, useRef, useState, type ReactNode } from "react";

export function Composer({
  onSend,
  onStop,
  busy,
  disabled,
  picker,
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  busy: boolean;
  disabled: boolean;
  /** Target picker, rendered in the controls row under the input. */
  picker?: ReactNode;
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
          {picker}
          {busy ? (
            <button type="button" className="btn btn--stop" onClick={onStop}>
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary btn--send"
              onClick={send}
              disabled={disabled || !value.trim()}
            >
              Send
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
