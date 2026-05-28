// Renders a single Message: iterates `parts` in array order, dispatching to
// the appropriate sub-component. Below assistant messages, shows the meta pill
// row and (later) audio controls.

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { Message } from "../protocol/frames";
import { AudioControls } from "./AudioControls";
import { TrashIcon } from "./icons";
import { MessageMeta } from "./MessageMeta";
import { ReasoningPanel } from "./ReasoningPanel";
import { ToolCard } from "./ToolCard";

type Props = {
  message: Message;
  isLatestAssistant: boolean;
  streaming: boolean;
  voiceOn: boolean;
  onDelete?: (id: string) => void;
};

export function MessageView({
  message,
  isLatestAssistant,
  streaming,
  voiceOn,
  onDelete,
}: Props) {
  const [hover, setHover] = useState(false);
  const isUser = message.role === "user";
  const bubbleCls = isUser ? "bubble bubble--user" : "bubble bubble--assistant";
  // The latest assistant bubble announces incremental updates politely to
  // screen readers while tokens stream in.
  const isLiveBubble =
    !isUser && isLatestAssistant && streaming;

  // First-token loading indicator: the latest assistant placeholder before
  // any deltas have landed.
  const showTypingDots =
    isLatestAssistant &&
    streaming &&
    message.role === "assistant" &&
    message.parts.length === 0;

  return (
    <div
      className={`message message--${message.role}`}
      data-message-id={message.id}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div
        className={bubbleCls}
        aria-live={isLiveBubble ? "polite" : undefined}
        aria-atomic={isLiveBubble ? false : undefined}
      >
        {showTypingDots && (
          <span className="typing-dots" aria-label="Assistant is typing">
            <span />
            <span />
            <span />
          </span>
        )}
        {message.parts.map((part, idx) => {
          const key = `${message.id}-${idx}`;
          if (part.type === "text") {
            return (
              <div className="md" key={key}>
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeSanitize, rehypeHighlight]}
                >
                  {part.text}
                </ReactMarkdown>
              </div>
            );
          }
          if (part.type === "reasoning") {
            // Only the trailing reasoning part of the latest streaming
            // assistant message is "live".
            const isLive =
              isLatestAssistant &&
              streaming &&
              idx === message.parts.length - 1;
            return (
              <ReasoningPanel key={key} part={part} streaming={isLive} />
            );
          }
          if (part.type === "tool_call") {
            return <ToolCard key={key} part={part} />;
          }
          return null;
        })}
        {onDelete && hover && (
          <button
            type="button"
            className="icon-btn icon-btn--danger message__delete"
            aria-label="Delete message"
            onClick={() => onDelete(message.id)}
          >
            <TrashIcon size={14} />
          </button>
        )}
      </div>
      {!isUser && (
        <>
          <MessageMeta
            metadata={message.metadata}
            createdAt={message.createdAt}
          />
          <AudioControls
            messageId={message.id}
            voiceEnabled={voiceOn}
            isLatest={isLatestAssistant}
            isStreaming={isLatestAssistant && streaming}
          />
        </>
      )}
    </div>
  );
}
