import { useCallback, useEffect, useRef, useState } from "react";
import { ChatInput } from "./components/ChatInput";
import { ConversationSidebar } from "./components/ConversationSidebar";
import { Disclaimer } from "./components/Disclaimer";
import { ErrorToast } from "./components/ErrorToast";
import { LoginScreen } from "./components/LoginScreen";
import {
  CrossIcon,
  SparkleIcon,
} from "./components/icons";
import { MessageList } from "./components/MessageList";
import { PrivacyBanner } from "./components/PrivacyBanner";
import { useChat } from "./hooks/useChat";
import { useSpeechInput } from "./hooks/useSpeechInput";
import {
  logout,
  restoreSession,
  type AuthUserDto,
} from "./api";

const SUGGESTIONS = [
  "What are the warnings for ibuprofen?",
  "I have a fever and a sore throat",
  "Compare acetaminophen and ibuprofen",
  "Is it safe to take aspirin daily?",
];

type AuthState =
  | { kind: "checking" }
  | { kind: "anonymous" }
  | { kind: "authenticated"; user: AuthUserDto };

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ kind: "checking" });

  // On mount, try to restore an existing session via the refresh cookie.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const user = await restoreSession();
      if (cancelled) return;
      setAuth(user ? { kind: "authenticated", user } : { kind: "anonymous" });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (auth.kind === "checking") {
    return (
      <main className="auth-shell">
        <div className="auth-loading" role="status" aria-live="polite">
          <span className="brand-mark" aria-hidden>
            <CrossIcon size={22} />
          </span>
          <p>Loading…</p>
        </div>
      </main>
    );
  }

  if (auth.kind === "anonymous") {
    return (
      <LoginScreen
        onAuth={(user) => setAuth({ kind: "authenticated", user })}
      />
    );
  }

  return (
    <ChatApp
      user={auth.user}
      onSignOut={async () => {
        await logout();
        setAuth({ kind: "anonymous" });
      }}
    />
  );
}

// UUID v4-ish shape used to validate the `?c=` query param before we trust
// it. The backend itself rejects malformed ids with a 404, so this is purely
// a "don't bother the server with junk" guard.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readInitialConversationId(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const p = new URLSearchParams(window.location.search).get("c");
  return p && UUID_RE.test(p) ? p : undefined;
}

function writeConversationIdToUrl(id: string | undefined): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("c", id);
  else url.searchParams.delete("c");
  window.history.replaceState(null, "", url.toString());
}

function ChatApp({
  user,
  onSignOut,
}: {
  user: AuthUserDto;
  onSignOut: () => Promise<void>;
}) {
  const [voiceOn, setVoiceOn] = useState(false);
  const [draft, setDraft] = useState("");
  // Read the URL once on mount; subsequent URL changes are driven by us.
  const initialIdRef = useRef<string | undefined>(readInitialConversationId());
  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0);
  // Track whether the current conversationId was already in the sidebar list,
  // so we only bump `sidebarRefreshKey` when a brand-new convo is born.
  const knownIdsRef = useRef<Set<string>>(new Set());

  const {
    messages,
    streaming,
    error,
    send,
    deleteMessage,
    loadOlder,
    hasMoreOlder,
    isLoadingOlder,
    conversationId,
    selectConversation,
    startNew,
    clearError,
  } = useChat(initialIdRef.current);

  const handleAutoSubmit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setDraft("");
      void send(trimmed);
    },
    [send],
  );

  const speech = useSpeechInput({ onAutoSubmit: handleAutoSubmit });

  // Mirror conversationId into the URL so a reload resumes the same chat.
  // When a brand-new id appears (one we haven't seen in the sidebar list),
  // bump the refresh key so the sidebar re-fetches and includes it.
  useEffect(() => {
    writeConversationIdToUrl(conversationId);
    if (conversationId && !knownIdsRef.current.has(conversationId)) {
      knownIdsRef.current.add(conversationId);
      setSidebarRefreshKey((k) => k + 1);
    }
  }, [conversationId]);

  const handleSelect = useCallback(
    (id: string) => {
      knownIdsRef.current.add(id);
      selectConversation(id);
    },
    [selectConversation],
  );

  const handleNewChat = useCallback(() => {
    startNew();
  }, [startNew]);

  const showEmpty = messages.length === 0 && !streaming;

  const handleMicClick = useCallback(() => {
    if (speech.isRecording) {
      speech.stop();
    } else {
      speech.start();
    }
  }, [speech]);

  return (
    <div className="app-shell">
      <ConversationSidebar
        activeId={conversationId}
        onSelect={handleSelect}
        onNewChat={handleNewChat}
        refreshKey={sidebarRefreshKey}
      />
      <main className="app">
      <header className="topbar">
        <div className="topbar__brand">
          <span className="brand-mark" aria-hidden>
            <CrossIcon size={18} />
          </span>
          <h1 className="topbar__title">Healthcare Agent</h1>
        </div>
        <div className="topbar__spacer" />
        <span className="status-dot" aria-hidden />
        <span className="status-label">Online</span>
        <button
          type="button"
          className="switch"
          data-on={voiceOn ? "true" : "false"}
          aria-pressed={voiceOn}
          aria-label="Toggle voice"
          onClick={() => setVoiceOn((v) => !v)}
        >
          <span className="switch__track">
            <span className="switch__thumb" />
          </span>
          <span>Voice</span>
        </button>
        <span className="topbar__user" title={user.email}>
          {user.email}
        </span>
        <button
          type="button"
          className="topbar__signout"
          onClick={() => void onSignOut()}
          aria-label="Sign out"
        >
          Sign out
        </button>
      </header>

      <PrivacyBanner />
      <Disclaimer />

      <section className="chat" aria-label="Conversation">
        {showEmpty ? (
          <div className="empty">
            <span className="empty__icon" aria-hidden>
              <SparkleIcon size={28} />
            </span>
            <h2 className="empty__title">How can I help you today?</h2>
            <p className="empty__subtitle">
              Ask about a medication, describe symptoms, or compare common
              over-the-counter options. General information only — not a
              substitute for professional medical advice.
            </p>
            <div className="chips" role="list">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="listitem"
                  className="chip"
                  onClick={() => {
                    setDraft(s);
                    void send(s);
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <MessageList
            messages={messages}
            streaming={streaming}
            hasMoreOlder={hasMoreOlder}
            isLoadingOlder={isLoadingOlder}
            voiceOn={voiceOn}
            onLoadOlder={() => void loadOlder()}
            onDelete={(id) => void deleteMessage(id)}
          />
        )}
      </section>

      <div className="composer-wrap">
        <ChatInput
          externalDraft={draft}
          onDraftChange={setDraft}
          onSubmit={(text) => {
            setDraft("");
            void send(text);
          }}
          onMic={handleMicClick}
          recording={speech.isRecording}
          liveTranscript={speech.transcript}
          micError={speech.error}
          disabled={streaming}
        />
        <p className="disclaimer">
          Healthcare Agent can make mistakes. Not medical advice.
        </p>
      </div>

      {error && <ErrorToast error={error} onDismiss={clearError} />}
      </main>
    </div>
  );
}
