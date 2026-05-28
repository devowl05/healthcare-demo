// Auto-grow textarea + mic + send. Enter submits, Shift+Enter inserts newline.
//
// Tier 3c additions:
//   - When `recording` is true, the mic button swaps to a StopIcon and pulses.
//   - `liveTranscript` (passed in from useSpeechInput via App) is appended to
//     the visible draft while recording so the user sees what's being heard.
//     We persist the textbox's pre-recording value internally and reset it
//     when recording ends.
//   - `micError` renders a small inline warning under the composer.

import { useEffect, useRef, useState } from "react";
import type { SpeechError } from "../hooks/useSpeechInput";
import { MicIcon, SendIcon, StopIcon } from "./icons";

type Props = {
  onSubmit: (text: string) => void;
  onMic?: () => void;
  disabled?: boolean;
  recording?: boolean;
  liveTranscript?: string;
  micError?: SpeechError;
  externalDraft?: string;
  onDraftChange?: (text: string) => void;
  placeholder?: string;
};

const MAX_HEIGHT = 160;

function micErrorMessage(err: SpeechError): string {
  switch (err.code) {
    case "denied":
      return "Microphone access was denied. Enable it in your browser settings to use voice input.";
    case "unsupported":
      return "Voice input isn't supported in this browser. Try Chrome or Edge.";
    case "network":
      return "Speech recognition needs an internet connection. Check your network and try again.";
    default:
      return err.message || "Voice input is unavailable right now.";
  }
}

export function ChatInput({
  onSubmit,
  onMic,
  disabled = false,
  recording = false,
  liveTranscript = "",
  micError,
  externalDraft,
  onDraftChange,
  placeholder = "Ask about a medication or describe a symptom…",
}: Props) {
  const isControlled = externalDraft !== undefined;
  const [internalDraft, setInternalDraft] = useState("");
  const draft = isControlled ? externalDraft : internalDraft;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Snapshot the draft at the moment recording starts so we can append the
  // transcript WITHOUT overwriting what the user already typed.
  const baseDraftRef = useRef<string>("");
  const prevRecordingRef = useRef<boolean>(false);
  useEffect(() => {
    if (recording && !prevRecordingRef.current) {
      baseDraftRef.current = draft;
    }
    prevRecordingRef.current = recording;
  }, [recording, draft]);

  // Composite display value: base + space + live transcript while recording.
  const displayValue = recording
    ? `${baseDraftRef.current}${
        baseDraftRef.current && liveTranscript ? " " : ""
      }${liveTranscript}`
    : draft;

  // Auto-grow.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [displayValue]);

  const setDraft = (next: string) => {
    if (isControlled) onDraftChange?.(next);
    else setInternalDraft(next);
  };

  const submit = () => {
    const text = displayValue.trim();
    if (!text || disabled) return;
    onSubmit(text);
    setDraft("");
    baseDraftRef.current = "";
  };

  return (
    <>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <button
          type="button"
          className={`icon-btn${recording ? " icon-btn--recording" : ""}`}
          aria-label={recording ? "Stop voice input" : "Start voice input"}
          aria-pressed={recording}
          onClick={() => onMic?.()}
          disabled={disabled && !recording}
        >
          {recording ? <StopIcon /> : <MicIcon />}
        </button>
        <label htmlFor="composer-textarea" className="visually-hidden">
          Message
        </label>
        <textarea
          id="composer-textarea"
          ref={textareaRef}
          className="composer__textarea"
          placeholder={placeholder}
          value={displayValue}
          onChange={(e) => {
            // Editing while recording cancels the "merged" view — write back
            // to the underlying draft directly.
            if (recording) {
              baseDraftRef.current = e.target.value;
            }
            setDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          disabled={disabled}
        />
        <button
          type="submit"
          className="icon-btn icon-btn--primary"
          aria-label="Send message"
          disabled={disabled || displayValue.trim().length === 0}
        >
          <SendIcon />
        </button>
      </form>
      {micError && (
        <p className="mic-error" role="status">
          {micErrorMessage(micError)}
        </p>
      )}
    </>
  );
}
