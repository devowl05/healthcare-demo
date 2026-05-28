// Inline rendering for a single tool call. Four visual states with a stable
// layout (no jumps when output arrives).

import type { ToolCallPart } from "../protocol/frames";
import { AlertIcon, CheckIcon, ToolIcon } from "./icons";

type Props = {
  part: ToolCallPart;
};

const STATE_LABEL: Record<ToolCallPart["state"], string> = {
  pending: "Pending",
  running: "Running",
  complete: "Complete",
  failed: "Failed",
};

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function ToolCard({ part }: Props) {
  const stateClass = `tool-card tool-card--${part.state}`;
  return (
    <div className={stateClass} data-tool-id={part.id}>
      <div className="tool-card__head">
        <span className="tool-card__icon" aria-hidden>
          <ToolIcon size={16} />
        </span>
        <span className="tool-card__name">{part.name}</span>
        <span className="tool-card__badge" data-state={part.state}>
          {part.state === "complete" && (
            <span className="tool-card__badge-icon" aria-hidden>
              <CheckIcon size={12} />
            </span>
          )}
          {part.state === "failed" && (
            <span className="tool-card__badge-icon" aria-hidden>
              <AlertIcon size={12} />
            </span>
          )}
          {part.state === "running" && (
            <span
              className="tool-card__spinner"
              role="status"
              aria-label="Running"
            />
          )}
          {STATE_LABEL[part.state]}
        </span>
      </div>
      <div className="tool-card__io">
        <div className="tool-card__io-label">Input</div>
        <pre className="tool-card__pre">{prettyJson(part.input)}</pre>
        <div className="tool-card__io-label">Output</div>
        <pre
          className="tool-card__pre tool-card__pre--output"
          data-empty={part.output ? "false" : "true"}
        >
          {part.output ?? ""}
        </pre>
      </div>
    </div>
  );
}
