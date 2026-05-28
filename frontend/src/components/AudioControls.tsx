// Per-assistant-message TTS playback controls.
//
// Behavior:
//   - Hidden entirely while `voiceEnabled` is false or `isStreaming` is true.
//   - For the latest assistant message: auto-fetches TTS once and starts
//     playing. The "already played" guard is keyed off the messageId so we
//     don't re-fetch on every re-render.
//   - For older messages: renders a manual play/pause + scrubber + volume row.
//     Audio is lazily fetched the first time the user hits play.
//   - Every TTS network error is swallowed (console.warn only) so a flaky TTS
//     endpoint can never break message rendering.

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTTS } from "../api";
import { SoundOnIcon, StopIcon } from "./icons";

type Props = {
  messageId: string;
  voiceEnabled: boolean;
  isLatest: boolean;
  isStreaming: boolean;
};

type Status = "idle" | "loading" | "ready" | "playing" | "paused" | "error";

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function AudioControls({
  messageId,
  voiceEnabled,
  isLatest,
  isStreaming,
}: Props) {
  const [status, setStatus] = useState<Status>("idle");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Track which messageIds have already auto-played in this session so a
  // re-render of the latest assistant message doesn't re-trigger playback.
  const autoPlayedRef = useRef<Set<string>>(new Set());
  // Snapshot the blob URL so cleanup can revoke it without stale refs.
  const audioUrlRef = useRef<string | null>(null);
  audioUrlRef.current = audioUrl;

  // Lazy fetch helper — swallows errors and toggles status.
  const loadAudio = useCallback(async (): Promise<string | null> => {
    setStatus("loading");
    try {
      const { url } = await fetchTTS(messageId);
      setAudioUrl(url);
      setStatus("ready");
      return url;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("TTS fetch failed:", err);
      setStatus("error");
      return null;
    }
  }, [messageId]);

  // Auto-play for the latest assistant message, once per session per id.
  useEffect(() => {
    if (!voiceEnabled || isStreaming || !isLatest) return;
    if (autoPlayedRef.current.has(messageId)) return;
    autoPlayedRef.current.add(messageId);

    let cancelled = false;
    void (async () => {
      const url = await loadAudio();
      if (cancelled || !url) return;
      // Defer to a microtask so React has rendered the <audio> with the src.
      queueMicrotask(() => {
        const el = audioRef.current;
        if (!el) return;
        el.volume = volume;
        el.play().then(
          () => setStatus("playing"),
          (err) => {
            // Autoplay can be blocked — leave it ready so the user can press play.
            // eslint-disable-next-line no-console
            console.warn("Auto-play blocked:", err);
            setStatus("ready");
          },
        );
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [voiceEnabled, isStreaming, isLatest, messageId, loadAudio, volume]);

  // Revoke the blob URL when this component unmounts or the URL changes.
  useEffect(() => {
    return () => {
      const url = audioUrlRef.current;
      if (url) URL.revokeObjectURL(url);
    };
  }, []);

  const handlePlayPause = useCallback(async () => {
    const el = audioRef.current;
    // Lazy-load audio if we haven't yet.
    if (!audioUrl) {
      const url = await loadAudio();
      if (!url) return;
      // Wait a tick for the src binding before play().
      queueMicrotask(() => {
        const fresh = audioRef.current;
        if (!fresh) return;
        fresh.volume = volume;
        fresh.play().then(
          () => setStatus("playing"),
          (err) => {
            // eslint-disable-next-line no-console
            console.warn("Play failed:", err);
            setStatus("ready");
          },
        );
      });
      return;
    }
    if (!el) return;
    if (status === "playing") {
      el.pause();
      setStatus("paused");
    } else {
      el.volume = volume;
      try {
        await el.play();
        setStatus("playing");
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("Play failed:", err);
      }
    }
  }, [audioUrl, status, loadAudio, volume]);

  const handleStop = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    el.pause();
    el.currentTime = 0;
    setCurrentTime(0);
    setStatus("paused");
  }, []);

  const handleSeek = useCallback((next: number) => {
    const el = audioRef.current;
    if (!el || !Number.isFinite(next)) return;
    el.currentTime = next;
    setCurrentTime(next);
  }, []);

  const handleVolume = useCallback((next: number) => {
    setVolume(next);
    const el = audioRef.current;
    if (el) el.volume = next;
  }, []);

  if (!voiceEnabled) return null;
  if (isStreaming) return null;

  const isLoading = status === "loading";
  const isPlaying = status === "playing";

  return (
    <div
      className={`audio-controls${isLoading ? " audio-controls--loading" : ""}`}
      role="group"
      aria-label="Message audio playback"
    >
      <button
        type="button"
        className="audio-controls__btn"
        aria-label={isPlaying ? "Pause audio" : "Play audio"}
        onClick={() => void handlePlayPause()}
        disabled={isLoading}
      >
        {isPlaying ? (
          // Pause glyph (two bars) — inline to keep the icon set small.
          <svg
            width={16}
            height={16}
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden
          >
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        ) : (
          // Play glyph.
          <svg
            width={16}
            height={16}
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden
          >
            <path d="M7 5v14l12-7L7 5z" />
          </svg>
        )}
      </button>

      {isLoading && (
        <span className="audio-controls__hint" role="status">
          <span className="audio-controls__spinner" aria-hidden />
          Loading audio…
        </span>
      )}

      {!isLoading && (
        <>
          <input
            type="range"
            className="audio-controls__scrubber"
            min={0}
            max={duration || 0}
            step={0.1}
            value={currentTime}
            onChange={(e) => handleSeek(Number(e.target.value))}
            disabled={!audioUrl || duration === 0}
            aria-label="Seek"
          />
          <span className="audio-controls__time" aria-live="off">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
          <span
            className="audio-controls__volume-wrap"
            aria-label="Volume"
            title="Volume"
          >
            <SoundOnIcon size={14} />
            <input
              type="range"
              className="audio-controls__volume"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              onChange={(e) => handleVolume(Number(e.target.value))}
              aria-label="Volume"
            />
          </span>
          <button
            type="button"
            className="audio-controls__btn audio-controls__btn--stop"
            aria-label="Stop audio"
            onClick={handleStop}
            disabled={!audioUrl}
          >
            <StopIcon size={12} />
          </button>
        </>
      )}

      {/*
        Audio element is always rendered (so refs stay stable) but src is only
        set once we've fetched the blob. preload="none" prevents idle traffic
        before the user opts in.
      */}
      <audio
        ref={audioRef}
        src={audioUrl ?? undefined}
        preload="none"
        onLoadedMetadata={(e) => {
          const t = e.currentTarget.duration;
          setDuration(Number.isFinite(t) ? t : 0);
        }}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onEnded={() => {
          setStatus("paused");
          setCurrentTime(0);
        }}
        onPause={() => {
          if (status === "playing") setStatus("paused");
        }}
        onPlay={() => setStatus("playing")}
      />
    </div>
  );
}
