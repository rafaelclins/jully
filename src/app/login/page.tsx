import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { LoginForm } from "@/components/auth/login-form";
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";

function safeNext(value: string | undefined): string {
  if (!value) {
    return "/";
  }
  // Somente caminhos internos (evita open redirect para questoes externas).
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return "/";
  }
  return value;
}

// /login
// Login de operadores (email + senha). Entrada generica de credenciais;
// ja autenticado -> redireciona para o destino (evita loop).
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const nextPath = safeNext(next);

  const session = await auth.api.getSession({ headers: await headers() });
  if (session) {
    redirect(nextPath);
  }

  return <LoginForm next={nextPath} />;
}