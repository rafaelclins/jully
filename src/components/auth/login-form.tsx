"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) {
      return;
    }
    setError(null);
    setLoading(true);

    const { error: signInError } = await authClient.signIn.email({
      email,
      password,
    });

    setLoading(false);
    if (signInError) {
      // Mensagem generica: nao revela se o email existe ou se a senha falhou.
      setError("Email ou senha inválidos.");
      return;
    }

    router.replace(next);
    router.refresh();
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-zinc-100 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm">
        <p className="text-xs font-bold uppercase tracking-widest text-zinc-400">
          JULLY
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-900">
          Acesso do restaurante
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          Entre com suas credenciais de operador.
        </p>

        <form className="mt-6 space-y-4" onSubmit={handleSubmit} noValidate>
          <div>
            <label
              htmlFor="login-email"
              className="block text-sm font-semibold text-zinc-700"
            >
              Email
            </label>
            <input
              id="login-email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="mt-1 w-full rounded-xl border border-zinc-300 px-4 py-2.5 text-sm text-zinc-900 outline-none transition-colors focus:border-zinc-900 focus-visible:ring-2 focus-visible:ring-zinc-900"
            />
          </div>

          <div>
            <label
              htmlFor="login-password"
              className="block text-sm font-semibold text-zinc-700"
            >
              Senha
            </label>
            <input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-1 w-full rounded-xl border border-zinc-300 px-4 py-2.5 text-sm text-zinc-900 outline-none transition-colors focus:border-zinc-900 focus-visible:ring-2 focus-visible:ring-zinc-900"
            />
          </div>

          {error ? (
            <p role="alert" className="text-sm font-semibold text-red-700">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-full bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-700 active:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? "Entrando…" : "Entrar"}
          </button>
        </form>
      </div>
    </main>
  );
}