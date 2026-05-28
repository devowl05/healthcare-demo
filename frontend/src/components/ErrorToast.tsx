// Floating, dismissible error toast (bottom-right). Auto-fades after 8s.

import { useEffect, useState } from "react";
import type { ChatError } from "../types";
import { AlertIcon, CopyIcon } from "./icons";

type Props = {
  error: ChatError;
  onDismiss: () => void;
};

export function ErrorToast({ error, onDismiss }: Props) {
  const [copied, setCopied] = useState(false);

  // Auto-dismiss after 8s.
  useEffect(() => {
    const t = setTimeout(onDismiss, 8000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  const copy = async () => {
    const id = error.requestId ?? "";
    if (!id) return;
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard might be unavailable (insecure context); ignore.
    }
  };

  return (
    <div className="toast" role="alert" aria-live="assertive">
      <div className="toast__head">
        <span className="toast__icon" aria-hidden>
          <AlertIcon size={16} />
        </span>
        <span className="toast__code">{error.code}</span>
        <button
          type="button"
          className="toast__close"
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          ×
        </button>
      </div>
      <div className="toast__body">{error.message}</div>
      {error.requestId && (
        <button type="button" className="toast__copy" onClick={copy}>
          <CopyIcon size={12} />
          {copied ? "Copied" : "Copy support ID"}
        </button>
      )}
    </div>
  );
}
