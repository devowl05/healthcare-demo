// Collapsible reasoning panel. Auto-opens while streaming; switches to a
// dashed border when frozen.

import { useEffect, useState } from "react";
import type { ReasoningPart } from "../protocol/frames";
import { BrainIcon, ChevronIcon } from "./icons";

type Props = {
  part: ReasoningPart;
  streaming: boolean;
};

export function ReasoningPanel({ part, streaming }: Props) {
  const [open, setOpen] = useState(streaming);

  // When streaming flips on, force-open. When it flips off, leave whatever
  // the user has set (don't close on them mid-read).
  useEffect(() => {
    if (streaming) setOpen(true);
  }, [streaming]);

  const cls = streaming ? "reasoning reasoning--streaming" : "reasoning";

  return (
    <div className={cls} data-open={open ? "true" : "false"}>
      <button
        type="button"
        className="reasoning__head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="reasoning__icon" aria-hidden>
          <BrainIcon size={14} />
        </span>
        <span className="reasoning__title">Reasoning</span>
        <span className="reasoning__chevron" data-open={open ? "true" : "false"} aria-hidden>
          <ChevronIcon size={14} />
        </span>
      </button>
      {open && <div className="reasoning__body">{part.text}</div>}
    </div>
  );
}
