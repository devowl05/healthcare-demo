// Left-side drawer listing past conversations. Fetches via `listConversations`,
// supports cursor-based "Load more", a manual refresh button, and a "New chat"
// CTA. The parent owns the active conversation id and bumps `refreshKey` to
// force a first-page refetch whenever a brand-new conversation is created.

import { useCallback, useEffect, useState } from "react";
import { listConversations } from "../api";
import type { Conversation } from "../types";
import { PlusCircleIcon, RefreshIcon } from "./icons";

type Props = {
  activeId?: string;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  refreshKey: number;
};

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; items: Conversation[]; nextCursor?: string }
  | { kind: "error"; message: string };

// One Intl instance per format avoids re-allocating on every render.
const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const MONTH_DAY_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const FULL_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function formatUpdatedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const dayDiff = Math.floor((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (dayDiff === 0) return `Today ${TIME_FMT.format(d)}`;
  if (dayDiff === 1) return `Yesterday ${TIME_FMT.format(d)}`;
  if (dayDiff < 7) return MONTH_DAY_FMT.format(d);
  if (d.getFullYear() === now.getFullYear()) return MONTH_DAY_FMT.format(d);
  return FULL_FMT.format(d);
}

function shortId(id: string): string {
  // Render an 8-char prefix; UUIDs are unwieldy as a full title.
  return id.length > 8 ? `Chat ${id.slice(0, 8)}` : `Chat ${id}`;
}

export function ConversationSidebar({
  activeId,
  onSelect,
  onNewChat,
  refreshKey,
}: Props) {
  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState(false);

  const loadFirstPage = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const page = await listConversations();
      setState({
        kind: "loaded",
        items: page.conversations,
        nextCursor: page.nextCursor,
      });
    } catch (err) {
      setState({
        kind: "error",
        message:
          err instanceof Error ? err.message : "Failed to load conversations",
      });
    }
  }, []);

  // Initial load + reload whenever the parent bumps `refreshKey`.
  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage, refreshKey]);

  const loadMore = useCallback(async () => {
    if (state.kind !== "loaded" || !state.nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await listConversations(state.nextCursor);
      setState((cur) =>
        cur.kind === "loaded"
          ? {
              kind: "loaded",
              items: [...cur.items, ...page.conversations],
              nextCursor: page.nextCursor,
            }
          : cur,
      );
    } catch (err) {
      setState({
        kind: "error",
        message:
          err instanceof Error ? err.message : "Failed to load more",
      });
    } finally {
      setLoadingMore(false);
    }
  }, [state, loadingMore]);

  const handleSelect = useCallback(
    (id: string) => {
      onSelect(id);
      setOpen(false); // close mobile drawer on selection
    },
    [onSelect],
  );

  const handleNewChat = useCallback(() => {
    onNewChat();
    setOpen(false);
  }, [onNewChat]);

  return (
    <>
      <button
        type="button"
        className="sidebar-toggle"
        aria-label={open ? "Close conversation list" : "Open conversation list"}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden>{open ? "✕" : "☰"}</span>
      </button>
      {open && (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="Close conversation list"
          onClick={() => setOpen(false)}
        />
      )}
      <aside
        className="sidebar"
        data-open={open ? "true" : "false"}
        aria-label="Past conversations"
      >
        <div className="sidebar__header">
          <button
            type="button"
            className="sidebar__new-chat"
            onClick={handleNewChat}
          >
            <PlusCircleIcon size={16} />
            <span>New chat</span>
          </button>
          <button
            type="button"
            className="sidebar__refresh"
            onClick={() => void loadFirstPage()}
            aria-label="Refresh conversation list"
            title="Refresh"
            disabled={state.kind === "loading"}
          >
            <RefreshIcon size={16} />
          </button>
        </div>

        {state.kind === "loading" && (
          <div className="sidebar__list" aria-busy="true">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="sidebar__skeleton" aria-hidden />
            ))}
          </div>
        )}

        {state.kind === "error" && (
          <div className="sidebar__error" role="alert">
            <p>{state.message}</p>
            <button type="button" onClick={() => void loadFirstPage()}>
              Retry
            </button>
          </div>
        )}

        {state.kind === "loaded" && state.items.length === 0 && (
          <p className="sidebar__empty">No past chats yet</p>
        )}

        {state.kind === "loaded" && state.items.length > 0 && (
          <ul className="sidebar__list" role="list">
            {state.items.map((c) => {
              const isActive = c.id === activeId;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    className={
                      "conversation-item" +
                      (isActive ? " conversation-item--active" : "")
                    }
                    aria-current={isActive ? "page" : undefined}
                    onClick={() => handleSelect(c.id)}
                    title={c.id}
                  >
                    <span className="conversation-item__title">
                      {c.title ?? shortId(c.id)}
                    </span>
                    <span className="conversation-item__date">
                      {formatUpdatedAt(c.updatedAt)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {state.kind === "loaded" && state.nextCursor && (
          <button
            type="button"
            className="sidebar__load-more"
            onClick={() => void loadMore()}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        )}
      </aside>
    </>
  );
}
