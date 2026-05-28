// Network helpers for the Healthcare Agent frontend.
// All endpoints are same-origin (proxied by Vite in dev, nginx in prod) and
// include credentials. CSRF token is read from the `csrf_token` cookie and
// sent via the `X-CSRF-Token` header.
//
// Auth model: access token (15 min JWT) lives in memory and is sent as
// `Authorization: Bearer <token>` on every protected request. The refresh
// cookie is HttpOnly and rotates on `/api/auth/refresh`. On 401 we attempt one
// silent refresh and replay the request; if that fails, the caller is expected
// to send the user to the login screen.

import type { Message, ServerEvent } from "./protocol/frames";
import type { Conversation } from "./types";

// -------------------------------------------------------------------------
// CSRF helper
// -------------------------------------------------------------------------

const CSRF_COOKIE = "csrf_token";

/**
 * Reads the CSRF token from `document.cookie`. The backend issues this cookie
 * with `SameSite=Strict`; the frontend echoes it back via `X-CSRF-Token` for
 * any non-GET request as a double-submit defense.
 */
export function getCsrfToken(): string {
  if (typeof document === "undefined") return "";
  const prefix = `${CSRF_COOKIE}=`;
  const match = document.cookie
    .split("; ")
    .find((row) => row.startsWith(prefix));
  if (!match) return "";
  return decodeURIComponent(match.slice(prefix.length));
}

// -------------------------------------------------------------------------
// Access-token store (in-memory)
// -------------------------------------------------------------------------

let accessToken: string | null = null;
let accessExpiresAt: number = 0;
const authListeners = new Set<(token: string | null) => void>();

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null, expiresAtIso?: string): void {
  accessToken = token;
  accessExpiresAt = expiresAtIso ? Date.parse(expiresAtIso) : 0;
  for (const fn of authListeners) fn(token);
}

export function isAuthenticated(): boolean {
  return accessToken !== null && (accessExpiresAt === 0 || accessExpiresAt > Date.now());
}

export function onAuthChange(fn: (token: string | null) => void): () => void {
  authListeners.add(fn);
  return () => authListeners.delete(fn);
}

// -------------------------------------------------------------------------
// Common helpers
// -------------------------------------------------------------------------

type JsonInit = Omit<RequestInit, "body"> & { body?: unknown; skipAuth?: boolean };

async function doFetch(url: string, init: JsonInit): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    const csrf = getCsrfToken();
    if (csrf) headers.set("X-CSRF-Token", csrf);
  }
  if (!init.skipAuth && accessToken && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${accessToken}`);
  }
  return fetch(url, {
    ...init,
    headers,
    credentials: "include",
    body:
      init.body === undefined || init.body instanceof FormData
        ? (init.body as BodyInit | undefined)
        : JSON.stringify(init.body),
  });
}

let refreshInFlight: Promise<boolean> | null = null;

async function trySilentRefresh(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await fetch("/api/auth/refresh", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        setAccessToken(null);
        return false;
      }
      const body = (await res.json()) as {
        accessToken: string;
        expiresAt?: string;
      };
      setAccessToken(body.accessToken, body.expiresAt);
      return true;
    } catch {
      setAccessToken(null);
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function jsonFetch<T>(url: string, init: JsonInit = {}): Promise<T> {
  let res = await doFetch(url, init);
  if (res.status === 401 && !init.skipAuth) {
    const ok = await trySilentRefresh();
    if (ok) {
      res = await doFetch(url, init);
    }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(res.status, text || res.statusText);
  }
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// -------------------------------------------------------------------------
// Streaming chat (SSE)
// -------------------------------------------------------------------------

export type StreamChatOptions = {
  message: string;
  conversationId?: string;
  csrfToken?: string;
  idempotencyKey: string;
  signal?: AbortSignal;
  model?: string;
  cheap?: boolean;
};

/**
 * POSTs to `/api/chat` and yields each typed `ServerEvent` parsed from the
 * SSE response. The server emits frames of the form:
 *
 *     event: <name>\n
 *     data: <json>\n
 *     \n
 *
 * We split on the blank-line frame boundary and JSON-parse each `data:` body.
 * Unknown event names are skipped.
 */
export async function* streamChat(
  opts: StreamChatOptions,
): AsyncGenerator<ServerEvent> {
  const buildHeaders = () => {
    const headers = new Headers({
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "Idempotency-Key": opts.idempotencyKey,
    });
    const csrf = opts.csrfToken ?? getCsrfToken();
    if (csrf) headers.set("X-CSRF-Token", csrf);
    if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
    return headers;
  };

  const body: Record<string, unknown> = { message: opts.message };
  if (opts.conversationId) body.conversationId = opts.conversationId;
  if (opts.model) body.model = opts.model;
  if (opts.cheap) body.cheap = true;
  const serialized = JSON.stringify(body);

  let res = await fetch("/api/chat", {
    method: "POST",
    headers: buildHeaders(),
    credentials: "include",
    body: serialized,
    signal: opts.signal,
  });

  if (res.status === 401) {
    const ok = await trySilentRefresh();
    if (ok) {
      res = await fetch("/api/chat", {
        method: "POST",
        headers: buildHeaders(),
        credentials: "include",
        body: serialized,
        signal: opts.signal,
      });
    }
  }

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new ApiError(res.status, text || res.statusText || "Stream failed");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line. Accept both \n\n and \r\n\r\n.
      let sep: number;
      while (
        (sep = indexOfBlankLine(buffer)) >= 0
      ) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^(\r?\n){2}/, "");
        const ev = parseFrame(frame);
        if (ev) yield ev;
      }
    }
    // Flush any final frame without trailing blank line (rare).
    if (buffer.trim().length > 0) {
      const ev = parseFrame(buffer);
      if (ev) yield ev;
    }
  } finally {
    reader.releaseLock();
  }
}

function indexOfBlankLine(buf: string): number {
  const a = buf.indexOf("\n\n");
  const b = buf.indexOf("\r\n\r\n");
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function parseFrame(frame: string): ServerEvent | null {
  let name = "";
  let dataLines: string[] = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(":")) continue;
    const colon = rawLine.indexOf(":");
    if (colon === -1) continue;
    const field = rawLine.slice(0, colon);
    let value = rawLine.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") name = value;
    else if (field === "data") dataLines.push(value);
  }
  if (!name || dataLines.length === 0) return null;
  let data: unknown;
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {
    return null;
  }
  // The wire types are validated server-side; we trust the discriminant here.
  return { event: name, data } as ServerEvent;
}

// -------------------------------------------------------------------------
// REST endpoints
// -------------------------------------------------------------------------

export type HistoryPage = {
  messages: Message[];
  prevCursor?: string;
  hasMore: boolean;
};

// The backend returns rows in snake_case with numeric/string metadata fields;
// we normalize at the API boundary so the rest of the app speaks Message.
type RawMessageRow = {
  id: string;
  conversation_id: string;
  role: string;
  parts: unknown;
  created_at: string;
  metadata: {
    model: string;
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
    cost_usd: string | number;
    latency_ms: number;
  } | null;
};

function normalizeMessage(row: RawMessageRow): Message {
  const parts = Array.isArray(row.parts) ? (row.parts as Message["parts"]) : [];
  const m: Message = {
    id: row.id,
    role: row.role as Message["role"],
    parts,
    createdAt: row.created_at,
  };
  if (row.metadata) {
    m.metadata = {
      model: row.metadata.model,
      inputTokens: row.metadata.input_tokens,
      outputTokens: row.metadata.output_tokens,
      cachedInputTokens: row.metadata.cached_input_tokens,
      costUsd:
        typeof row.metadata.cost_usd === "string"
          ? Number(row.metadata.cost_usd)
          : row.metadata.cost_usd,
      latencyMs: row.metadata.latency_ms,
      requestId: "",
    };
  }
  return m;
}

export async function fetchHistory(
  conversationId: string,
  beforeCursor?: string,
): Promise<HistoryPage> {
  const params = new URLSearchParams({ limit: "50" });
  if (beforeCursor) params.set("before", beforeCursor);
  const raw = await jsonFetch<{
    items: RawMessageRow[];
    prev_cursor: string | null;
  }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages?${params}`,
  );
  return {
    messages: raw.items.map(normalizeMessage),
    prevCursor: raw.prev_cursor ?? undefined,
    hasMore: raw.prev_cursor != null,
  };
}

export type ConversationsPage = {
  conversations: Conversation[];
  nextCursor?: string;
};

type RawConversationRow = {
  id: string;
  cheap_mode?: boolean;
  created_at: string;
  updated_at: string;
};

export async function listConversations(
  cursor?: string,
): Promise<ConversationsPage> {
  const params = new URLSearchParams({ limit: "20" });
  if (cursor) params.set("cursor", cursor);
  const raw = await jsonFetch<{
    items: RawConversationRow[];
    next_cursor: string | null;
  }>(`/api/conversations?${params}`);
  return {
    conversations: raw.items.map(
      (r): Conversation => ({
        id: r.id,
        title: null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }),
    ),
    nextCursor: raw.next_cursor ?? undefined,
  };
}

export async function deleteMessage(messageId: string): Promise<void> {
  await jsonFetch<void>(`/api/messages/${encodeURIComponent(messageId)}`, {
    method: "DELETE",
  });
}

// -------------------------------------------------------------------------
// Text-to-speech
// -------------------------------------------------------------------------

export type TtsResult = { blob: Blob; url: string };

export async function fetchTTS(
  messageId: string,
  voice = "alloy",
): Promise<TtsResult> {
  const send = async () => {
    const headers = new Headers({ "Content-Type": "application/json" });
    const csrf = getCsrfToken();
    if (csrf) headers.set("X-CSRF-Token", csrf);
    if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
    return fetch("/api/tts", {
      method: "POST",
      headers,
      credentials: "include",
      body: JSON.stringify({ message_id: messageId, voice }),
    });
  };
  let res = await send();
  if (res.status === 401) {
    const ok = await trySilentRefresh();
    if (ok) res = await send();
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(res.status, text || res.statusText);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  return { blob, url };
}

// -------------------------------------------------------------------------
// Authentication
// -------------------------------------------------------------------------

export type AuthUserDto = { id: string; email: string; role: string };
export type AuthResult = { user: AuthUserDto; accessToken: string; expiresAt: string };

export async function login(email: string, password: string): Promise<AuthUserDto> {
  const body = await jsonFetch<AuthResult>("/api/auth/login", {
    method: "POST",
    body: { email, password },
    skipAuth: true,
  });
  setAccessToken(body.accessToken, body.expiresAt);
  return body.user;
}

export async function register(
  email: string,
  password: string,
): Promise<AuthUserDto> {
  const body = await jsonFetch<{ user: AuthUserDto }>("/api/auth/register", {
    method: "POST",
    body: { email, password },
    skipAuth: true,
  });
  return body.user;
}

export async function logout(): Promise<void> {
  try {
    await jsonFetch<void>("/api/auth/logout", { method: "POST", skipAuth: true });
  } finally {
    setAccessToken(null);
  }
}

/** Restore a session via refresh cookie. Returns the user or null. */
export async function restoreSession(): Promise<AuthUserDto | null> {
  try {
    const body = await jsonFetch<AuthResult>("/api/auth/refresh", {
      method: "POST",
      skipAuth: true,
    });
    setAccessToken(body.accessToken, body.expiresAt);
    return body.user;
  } catch {
    setAccessToken(null);
    return null;
  }
}
