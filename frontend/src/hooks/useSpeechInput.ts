// Web Speech API wrapper for voice input.
//
// Provides a tiny stateful interface around `SpeechRecognition` (or its
// `webkitSpeechRecognition` alias). We:
//   1. Probe `navigator.mediaDevices.getUserMedia({ audio: true })` once before
//      starting so a permission denial surfaces with a clean `denied` code
//      instead of an opaque SpeechRecognition `not-allowed` error.
//   2. Stream interim + final transcripts into a single `transcript` string.
//   3. Auto-submit after `silenceMs` of inactivity (no `result` events) via
//      an optional `onAutoSubmit` callback.
//
// SpeechRecognition is undefined in Firefox + most Safari versions; in that
// case `isSupported === false` and `start()` is a no-op (sets `unsupported`).

import { useCallback, useEffect, useRef, useState } from "react";

export type SpeechErrorCode =
  | "denied"
  | "unsupported"
  | "network"
  | "unknown";

export type SpeechError = {
  code: SpeechErrorCode;
  message: string;
};

export type UseSpeechInputOptions = {
  onAutoSubmit?: (text: string) => void;
  silenceMs?: number;
};

export type UseSpeechInputReturn = {
  isSupported: boolean;
  isRecording: boolean;
  transcript: string;
  error?: SpeechError;
  start: () => void;
  stop: () => void;
};

function getRecognitionCtor(): SpeechRecognitionConstructor | undefined {
  if (typeof window === "undefined") return undefined;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition;
}

export function useSpeechInput(
  opts: UseSpeechInputOptions = {},
): UseSpeechInputReturn {
  const { onAutoSubmit, silenceMs = 1500 } = opts;
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<SpeechError | undefined>(undefined);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finalsRef = useRef<string>("");
  const interimRef = useRef<string>("");
  // Keep the latest auto-submit handler in a ref so the recognition handlers
  // (bound once) always call the freshest closure without forcing restarts.
  const onAutoSubmitRef = useRef<typeof onAutoSubmit>(onAutoSubmit);
  onAutoSubmitRef.current = onAutoSubmit;
  const silenceMsRef = useRef<number>(silenceMs);
  silenceMsRef.current = silenceMs;

  const isSupported = getRecognitionCtor() !== undefined;

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current !== null) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  const fireAutoSubmit = useCallback(() => {
    const text = (finalsRef.current + interimRef.current).trim();
    if (!text) return;
    const cb = onAutoSubmitRef.current;
    // Stop recognition first so subsequent transcript updates don't race the
    // submitted message.
    const rec = recognitionRef.current;
    if (rec) {
      try {
        rec.stop();
      } catch {
        // ignore — stop() can throw if already stopped
      }
    }
    // Reset internal buffers so the next session starts clean.
    finalsRef.current = "";
    interimRef.current = "";
    setTranscript("");
    if (cb) cb(text);
  }, []);

  const armSilenceTimer = useCallback(() => {
    clearSilenceTimer();
    silenceTimerRef.current = setTimeout(() => {
      fireAutoSubmit();
    }, silenceMsRef.current);
  }, [clearSilenceTimer, fireAutoSubmit]);

  const stop = useCallback(() => {
    clearSilenceTimer();
    const rec = recognitionRef.current;
    if (rec) {
      try {
        rec.stop();
      } catch {
        // ignore
      }
    }
    setIsRecording(false);
  }, [clearSilenceTimer]);

  const start = useCallback(async () => {
    setError(undefined);
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setError({
        code: "unsupported",
        message: "Voice input isn't supported in this browser.",
      });
      return;
    }

    // Probe mic permission. We immediately stop the resulting stream's tracks
    // because SpeechRecognition opens its own input.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) {
        track.stop();
      }
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setError({
          code: "denied",
          message: "Microphone access was denied.",
        });
      } else {
        setError({
          code: "unknown",
          message: err instanceof Error ? err.message : "Microphone error.",
        });
      }
      return;
    }

    // Reset buffers for a fresh session.
    finalsRef.current = "";
    interimRef.current = "";
    setTranscript("");

    let rec: SpeechRecognition;
    try {
      rec = new Ctor();
    } catch (err) {
      setError({
        code: "unknown",
        message:
          err instanceof Error
            ? err.message
            : "Failed to create speech recognition.",
      });
      return;
    }
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.lang =
      (typeof navigator !== "undefined" && navigator.language) || "en-US";

    rec.onresult = (ev: SpeechRecognitionEvent) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const result = ev.results[i];
        if (!result) continue;
        const alt = result[0];
        if (!alt) continue;
        if (result.isFinal) {
          finalsRef.current += alt.transcript;
        } else {
          interim += alt.transcript;
        }
      }
      interimRef.current = interim;
      setTranscript(finalsRef.current + interim);
      armSilenceTimer();
    };

    rec.onerror = (ev: SpeechRecognitionErrorEvent) => {
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        setError({
          code: "denied",
          message: "Microphone access was denied.",
        });
      } else if (ev.error === "network") {
        setError({
          code: "network",
          message: "Speech recognition network error.",
        });
      } else if (ev.error === "no-speech" || ev.error === "aborted") {
        // Benign — no surface to user.
      } else {
        setError({
          code: "unknown",
          message: ev.message || `Speech error: ${ev.error}`,
        });
      }
    };

    rec.onend = () => {
      clearSilenceTimer();
      setIsRecording(false);
    };

    rec.onstart = () => {
      setIsRecording(true);
    };

    recognitionRef.current = rec;
    try {
      rec.start();
    } catch (err) {
      setError({
        code: "unknown",
        message:
          err instanceof Error ? err.message : "Failed to start recognition.",
      });
      setIsRecording(false);
      return;
    }
    armSilenceTimer();
  }, [armSilenceTimer, clearSilenceTimer]);

  // Cleanup on unmount: cancel timers + abort any in-flight recognition.
  useEffect(() => {
    return () => {
      clearSilenceTimer();
      const rec = recognitionRef.current;
      if (rec) {
        try {
          rec.abort();
        } catch {
          // ignore
        }
        recognitionRef.current = null;
      }
    };
  }, [clearSilenceTimer]);

  return {
    isSupported,
    isRecording,
    transcript,
    error,
    start: () => {
      void start();
    },
    stop,
  };
}
