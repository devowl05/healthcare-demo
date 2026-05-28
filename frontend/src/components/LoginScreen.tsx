import { useState } from "react";
import { CrossIcon } from "./icons";
import { login, register, type AuthUserDto } from "../api";

type Mode = "login" | "register";

export function LoginScreen({ onAuth }: { onAuth: (user: AuthUserDto) => void }) {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "register") {
        await register(email, password);
        const user = await login(email, password);
        onAuth(user);
      } else {
        const user = await login(email, password);
        onAuth(user);
      }
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? friendlyAuthMessage(err.message)
          : "Sign-in failed. Please try again.";
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="auth-title">
        <span className="brand-mark auth-card__brand" aria-hidden>
          <CrossIcon size={22} />
        </span>
        <h1 id="auth-title" className="auth-card__title">
          {mode === "login" ? "Sign in to Healthcare Agent" : "Create your account"}
        </h1>
        <p className="auth-card__subtitle">
          Informational use only — not a substitute for professional medical advice.
        </p>
        <form className="auth-form" onSubmit={handleSubmit} noValidate>
          <label className="auth-field">
            <span className="auth-field__label">Email</span>
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              placeholder="you@example.com"
            />
          </label>
          <label className="auth-field">
            <span className="auth-field__label">Password</span>
            <input
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              required
              minLength={mode === "register" ? 8 : 1}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              placeholder={
                mode === "register" ? "At least 8 characters" : "Your password"
              }
            />
          </label>
          {error && (
            <div className="auth-error" role="alert">
              {error}
            </div>
          )}
          <button
            type="submit"
            className="auth-submit"
            disabled={busy || !email || !password}
          >
            {busy
              ? "Working…"
              : mode === "login"
              ? "Sign in"
              : "Create account & sign in"}
          </button>
        </form>
        <button
          type="button"
          className="auth-mode-toggle"
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError(null);
          }}
          disabled={busy}
        >
          {mode === "login"
            ? "No account? Create one"
            : "Already have an account? Sign in"}
        </button>
      </section>
    </main>
  );
}

function friendlyAuthMessage(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("invalid_credentials") || lower.includes("invalid email")) {
    return "Invalid email or password.";
  }
  if (lower.includes("email_taken") || lower.includes("already registered")) {
    return "That email is already registered. Try signing in instead.";
  }
  if (lower.includes("registration_disabled")) {
    return "Registration is disabled on this server.";
  }
  if (lower.includes("validation_failed")) {
    return "Please check your email and password format.";
  }
  return "Sign-in failed. Please try again.";
}
