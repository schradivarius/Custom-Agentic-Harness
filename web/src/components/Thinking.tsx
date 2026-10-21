import { useEffect, useState } from "react";
import { PHRASES } from "../phrases.ts";

/** A random phrase, never the one already showing. */
function pick(avoid?: string): string {
  const pool = avoid && PHRASES.length > 1 ? PHRASES.filter((p) => p !== avoid) : PHRASES;
  return pool[Math.floor(Math.random() * pool.length)] ?? "Working";
}

const reduceMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Shown while the agent is working but has produced nothing visible yet.
 *
 * The gap between sending and the first token is not small — a reasoning
 * model can spend seconds before it emits anything, and a tool round adds
 * another wait after the result comes back. Without this the window just sits
 * there and the only sign of life is the Stop button.
 *
 * The phrase rerolls every few seconds. It is `aria-hidden` and paired with a
 * fixed label for assistive tech: a live region whose text changed every four
 * seconds would announce the whole list, one phrase at a time, which is worse
 * than silence.
 */
export function Thinking(): JSX.Element {
  const [phrase, setPhrase] = useState(() => pick());

  useEffect(() => {
    if (reduceMotion()) return; // one phrase, held still
    const id = setInterval(() => setPhrase((current) => pick(current)), 3800);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="turn turn--assistant">
      <div className="thinking">
        <span className="thinking__dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="thinking__label" aria-hidden="true">
          {phrase}…
        </span>
        <span className="sr-only" role="status" aria-live="polite">
          Working
        </span>
      </div>
    </div>
  );
}
