// One-time dismissible privacy banner. Dismissal state persists in
// localStorage under `hc_privacy_seen=1`.

import { useEffect, useState } from "react";

const STORAGE_KEY = "hc_privacy_seen";

function initiallyDismissed(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function PrivacyBanner() {
  const [dismissed, setDismissed] = useState(initiallyDismissed);

  useEffect(() => {
    if (dismissed && typeof window !== "undefined") {
      try {
        window.localStorage.setItem(STORAGE_KEY, "1");
      } catch {
        // Storage may be disabled; non-fatal.
      }
    }
  }, [dismissed]);

  if (dismissed) return null;

  return (
    <div className="privacy-banner" role="region" aria-label="Privacy notice">
      <span className="privacy-banner__text">
        Your messages are processed by OpenAI to generate replies. We store
        conversation history to provide the service.
      </span>
      <button
        type="button"
        className="privacy-banner__dismiss"
        onClick={() => setDismissed(true)}
      >
        Got it
      </button>
    </div>
  );
}
