import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });

/**
 * Agent output is untrusted text — it can carry anything a tool result or a
 * remote page put in front of the model — so it is sanitized before it reaches
 * the DOM rather than trusted because it came from our own backend.
 */
export function Markdown({ text }: { text: string }): JSX.Element {
  const html = useMemo(() => {
    const parsed = marked.parse(text ?? "", { async: false }) as string;
    return DOMPurify.sanitize(parsed, {
      ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
      FORBID_TAGS: ["style", "form", "input", "button"],
      FORBID_ATTR: ["style", "srcset"],
    });
  }, [text]);

  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
