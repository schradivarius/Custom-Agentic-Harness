import { useEffect, useMemo, useRef } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });

/**
 * Close a fence that has not arrived yet.
 *
 * Markdown is re-parsed on every streamed chunk, so a code block spends the
 * whole time it is being written with no closing fence. Left alone it parses
 * as a paragraph, so code appears as plain prose and then jumps into a box
 * when the final backticks land. Closing it provisionally means it is a code
 * block from the first line.
 */
function closeOpenFence(text: string): string {
  const fences = text.match(/^```/gm);
  if (fences && fences.length % 2 === 1) {
    return `${text}${text.endsWith("\n") ? "" : "\n"}\`\`\``;
  }
  return text;
}

/**
 * Agent output is untrusted — it can carry anything a tool result or a fetched
 * page put in front of the model — so it is sanitized before it reaches the
 * DOM rather than trusted because it came from our own backend.
 */
function render(text: string): string {
  const parsed = marked.parse(closeOpenFence(text ?? ""), { async: false }) as string;
  return DOMPurify.sanitize(parsed, {
    ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
    FORBID_TAGS: ["style", "form", "input", "button"],
    FORBID_ATTR: ["style", "srcset"],
  });
}

export function Markdown({ text }: { text: string }): JSX.Element {
  const html = useMemo(() => render(text), [text]);
  const root = useRef<HTMLDivElement>(null);

  /*
   * The toolbar is built here rather than emitted through the sanitizer,
   * which forbids <button> precisely so model output cannot introduce one.
   * Constructing it after sanitizing keeps that restriction intact and still
   * gives a real button.
   */
  useEffect(() => {
    const el = root.current;
    if (!el) return;

    for (const pre of Array.from(el.querySelectorAll("pre"))) {
      if (pre.parentElement?.classList.contains("codeblock")) continue;

      const code = pre.querySelector("code");
      const lang =
        Array.from(code?.classList ?? [])
          .find((c) => c.startsWith("language-"))
          ?.slice("language-".length) ?? "";

      const box = document.createElement("div");
      box.className = "codeblock";
      const bar = document.createElement("div");
      bar.className = "codeblock__bar";

      const label = document.createElement("span");
      label.className = "codeblock__lang";
      label.textContent = lang || "code";

      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "codeblock__copy";
      copy.textContent = "Copy";
      copy.setAttribute("aria-label", "Copy code to clipboard");
      copy.addEventListener("click", () => {
        const source = pre.querySelector("code")?.textContent ?? pre.textContent ?? "";
        void navigator.clipboard
          .writeText(source)
          .then(() => {
            copy.textContent = "Copied";
            copy.classList.add("is-copied");
            setTimeout(() => {
              copy.textContent = "Copy";
              copy.classList.remove("is-copied");
            }, 1400);
          })
          .catch(() => {
            // Clipboard access can be refused; say so rather than claim success.
            copy.textContent = "Press ⌘C";
            setTimeout(() => (copy.textContent = "Copy"), 1800);
          });
      });

      bar.append(label, copy);
      pre.replaceWith(box);
      box.append(bar, pre);
    }
  }, [html]);

  return <div className="md" ref={root} dangerouslySetInnerHTML={{ __html: html }} />;
}
