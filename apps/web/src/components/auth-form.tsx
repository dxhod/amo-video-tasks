"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Film, ArrowRight } from "lucide-react";
import { Button } from "./ui/button";
import { browserClient } from "@/lib/supabase/browser";
export function AuthForm({ reset = false }: { reset?: boolean }) {
  const [mode, setMode] = useState<"login" | "register" | "recover" | "reset">(
      reset ? "reset" : "login",
    ),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const router = useRouter();
  const titles = {
    login: "З поверненням.",
    register: "Створіть свій простір.",
    recover: "Відновлення доступу.",
    reset: "Новий пароль.",
  };
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const f = new FormData(e.currentTarget),
        email = String(f.get("email") ?? ""),
        password = String(f.get("password") ?? ""),
        db = browserClient();
      const base = ["localhost", "127.0.0.1"].includes(window.location.hostname)
        ? window.location.origin
        : (process.env.NEXT_PUBLIC_APP_URL ?? window.location.origin);
      if (mode === "login") {
        const { error } = await db.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.push("/");
        router.refresh();
      }
      if (mode === "register") {
        const { error } = await db.auth.signUp({
          email,
          password,
          options: {
            data: { display_name: String(f.get("name")) },
            emailRedirectTo: `${base}/auth/callback`,
          },
        });
        if (error) throw error;
        setMessage("Перевірте пошту та підтвердьте реєстрацію.");
      }
      if (mode === "recover") {
        const { error } = await db.auth.resetPasswordForEmail(email, {
          redirectTo: `${base}/auth/callback?next=/reset-password`,
        });
        if (error) throw error;
        setMessage(
          "Якщо адреса зареєстрована, лист для відновлення вже надіслано.",
        );
      }
      if (mode === "reset") {
        const { error } = await db.auth.updateUser({ password });
        if (error) throw error;
        router.push("/");
        router.refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не вдалося увійти.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-page">
      <section className="auth-art">
        <div className="brand">
          <span className="brand-icon">
            <Film size={22} />
          </span>
          amo / studio
        </div>
        <div>
          <div
            className="eyebrow"
            style={{ color: "#aebf95", marginBottom: 24 }}
          >
            Ваш наступний вдалий кадр
          </div>
          <h1>
            Ідея.
            <br />
            Монтаж.
            <br />
            Готово.
          </h1>
          <p>
            Один простір для команди, відео та всіх версій вашої наступної
            історії.
          </p>
          <div className="auth-mark">
            <i style={{ height: 70 }} />
            <i style={{ height: 115 }} />
            <i style={{ height: 90 }} />
            <i style={{ height: 130 }} />
          </div>
        </div>
        <small style={{ color: "#94a185" }}>
          AMO VIDEO TASKS · CREATIVE WORKSPACE
        </small>
      </section>
      <div className="auth-form-wrap">
        <form className="auth-form" onSubmit={submit}>
          <div className="eyebrow" style={{ marginBottom: 14 }}>
            Почнімо створювати
          </div>
          <h1>{titles[mode]}</h1>
          <p>Відео, команда та зворотний зв’язок — поруч.</p>
          {error && (
            <div role="alert" className="error">
              {error}
            </div>
          )}
          {message && (
            <div role="status" className="notice">
              {message}
            </div>
          )}
          {mode === "register" && (
            <label>
              Ваше ім’я
              <input name="name" required maxLength={100} autoComplete="name" />
            </label>
          )}
          {mode !== "reset" && (
            <label>
              Email
              <input
                name="email"
                type="email"
                required
                autoComplete="email"
                placeholder="you@company.com"
              />
            </label>
          )}
          {mode !== "recover" && (
            <label>
              Пароль
              <input
                name="password"
                type="password"
                required
                minLength={8}
                autoComplete={
                  mode === "login" ? "current-password" : "new-password"
                }
              />
            </label>
          )}
          <Button disabled={busy}>
            {busy
              ? "Зачекайте…"
              : mode === "login"
                ? "Увійти"
                : mode === "register"
                  ? "Зареєструватися"
                  : mode === "recover"
                    ? "Надіслати лист"
                    : "Зберегти пароль"}
            <ArrowRight size={16} />
          </Button>
          <div className="auth-links">
            {mode !== "login" && (
              <button
                type="button"
                onClick={() => {
                  setMode("login");
                  setError("");
                  setMessage("");
                }}
              >
                До входу
              </button>
            )}
            {mode === "login" && (
              <>
                <button type="button" onClick={() => setMode("register")}>
                  Створити акаунт
                </button>
                <button type="button" onClick={() => setMode("recover")}>
                  Забули пароль?
                </button>
              </>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
