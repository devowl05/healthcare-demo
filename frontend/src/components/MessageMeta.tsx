// Per-message pill row: model, tokens, cost, latency. Optional Langfuse link
// when `?debug=1` is in the URL and `VITE_LANGFUSE_PUBLIC_HOST` is set.

import type { Metadata } from "../protocol/frames";
import { LinkIcon } from "./icons";

type Props = {
  metadata?: Metadata;
  createdAt?: string;
};

function formatCost(usd: number): string {
  if (!Number.isFinite(usd)) return "$0.000000";
  return `$${usd.toFixed(6)}`;
}

function formatLatency(ms: number): string {
  if (!Number.isFinite(ms)) return "0.0s";
  return `${(ms / 1000).toFixed(1)}s`;
}

// Localized HH:MM:SS for the timestamp pill. The ISO string is kept on the
// hover `title` for precision (timezone, milliseconds, full date).
const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function formatTimestamp(iso: string): { label: string; iso: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { label: iso, iso };
  return { label: TIME_FMT.format(d), iso: d.toISOString() };
}

function shouldShowDebugLink(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const url = new URL(window.location.href);
    return url.searchParams.get("debug") === "1";
  } catch {
    return false;
  }
}

export function MessageMeta({ metadata, createdAt }: Props) {
  if (!metadata) return null;
  const cached = metadata.cachedInputTokens ?? 0;
  const langfuseHost = (import.meta.env.VITE_LANGFUSE_PUBLIC_HOST as
    | string
    | undefined) ?? "";
  const showDebug = shouldShowDebugLink() && !!langfuseHost && !!metadata.traceId;
  const ts = createdAt ? formatTimestamp(createdAt) : null;

  return (
    <div className="meta" data-trace-id={metadata.traceId ?? ""}>
      {ts && (
        <span className="meta__pill" title={ts.iso}>
          {ts.label}
        </span>
      )}
      <span className="meta__pill" title="Model">
        {metadata.model}
      </span>
      <span className="meta__pill" title="Tokens">
        {metadata.inputTokens} → {metadata.outputTokens} tok
        {cached > 0 ? ` (${cached} cached)` : ""}
      </span>
      <span className="meta__pill" title="Cost">
        {formatCost(metadata.costUsd)}
      </span>
      <span className="meta__pill" title="Latency">
        {formatLatency(metadata.latencyMs)}
      </span>
      {showDebug && (
        <a
          className="meta__pill meta__pill--link"
          href={`${langfuseHost.replace(/\/$/, "")}/trace/${metadata.traceId}`}
          target="_blank"
          rel="noreferrer noopener"
          title="Open trace in Langfuse"
        >
          <LinkIcon size={12} />
          <span>trace</span>
        </a>
      )}
    </div>
  );
}
