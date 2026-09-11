import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";

import { prisma } from "@/lib/prisma";

// Configuracao do Better Auth (1.7.4) para operadores do restaurante.
// - Email + senha (escopo desta etapa).
// - Adapter Prisma 7 + PostgreSQL (mesma conexao da aplicacao).
// - Cookies: httpOnly e sameSite=lax por padrao; secure em producao (https).
//   CSRF nativo do Better Auth (origin-check + fetch metadata) para /api/auth/*.
// - Sessao: expira em 7 dias; renovada automaticamente a cada 1 dia de uso.
// - Rate limiting nativo do Better Auth ligado por padrao (producao). Em
//   desenvolvimento/testes locais pode-se desativar via RATE_LIMIT_DISABLED.
const rateLimitEnabled = process.env.RATE_LIMIT_DISABLED !== "true";

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
    // Nesta etapa nao ha cadastro publico: sign-up fica desabilitado.
    // O bootstrap do primeiro operador usa script dedicado (scripts/).
    disableSignUp: true,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
  rateLimit: {
    // Rate limit nativo do Better Auth: ligado por padrao (producao).
    // Em dev/testes locais pode-se desligar via RATE_LIMIT_DISABLED=true.
    enabled: rateLimitEnabled,
    window: 10,
    max: 100,
  },
});