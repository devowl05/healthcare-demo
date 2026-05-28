// Renders the message timeline + an IntersectionObserver sentinel at the top
// that triggers `loadOlder()` when scrolled into view.

import { useEffect, useRef } from "react";
import type { Message } from "../protocol/frames";
import { MessageView } from "./MessageView";

type Props = {
  messages: Message[];
  streaming: boolean;
  hasMoreOlder: boolean;
  isLoadingOlder: boolean;
  voiceOn: boolean;
  onLoadOlder: () => void;
  onDelete?: (id: string) => void;
};

export function MessageList({
  messages,
  streaming,
  hasMoreOlder,
  isLoadingOlder,
  voiceOn,
  onLoadOlder,
  onDelete,
}: Props) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // Keep the latest callback so the observer effect doesn't re-bind on every
  // render of the parent.
  const onLoadOlderRef = useRef(onLoadOlder);
  onLoadOlderRef.current = onLoadOlder;
  const hasMoreRef = useRef(hasMoreOlder);
  hasMoreRef.current = hasMoreOlder;
  const loadingRef = useRef(isLoadingOlder);
  loadingRef.current = isLoadingOlder;

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (
            entry.isIntersecting &&
            hasMoreRef.current &&
            !loadingRef.current
          ) {
            onLoadOlderRef.current();
          }
        }
      },
      { rootMargin: "200px 0px 0px 0px", threshold: 0 },
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, []);

  // Find the latest assistant message id so MessageView can flag typing dots.
  let latestAssistantId: string | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant") {
      latestAssistantId = m.id;
      break;
    }
  }

  return (
    <div className="message-list">
      <div ref={sentinelRef} className="message-list__sentinel" aria-hidden />
      {hasMoreOlder && isLoadingOlder && (
        <div className="list-loader" role="status">
          Loading older messages…
        </div>
      )}
      {messages.map((m) => (
        <MessageView
          key={m.id}
          message={m}
          isLatestAssistant={m.id === latestAssistantId}
          streaming={streaming}
          voiceOn={voiceOn}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}
