import type { NextConfig } from "next";

// Security headers (JUL-02). Nenhum framing/fingerprint desnecessario.
// A CSP segue a abordagem oficial "without nonces" do Next.js (paginas do app
// usam scripts inline de hydration; 'unsafe-inline' e o relaxamento minimo
// documentado para scripts). `'unsafe-eval'` so entra em desenvolvimento,
// onde o React dev exige eval (documentacao oficial); producao nao usa.
//
// HSTS e upgrade-insecure-requests ficam OFF por padrao: so fazem sentido em
// HTTP(S) reais e sao ativados explicitamente (SECURITY_HSTS_ENABLED=true)
// quando a terminacao HTTPS da infraestrutura estiver garantida.
const isDev = process.env.NODE_ENV !== "production";

function parseBool(value: string | undefined): boolean {
  return value === "true";
}

const hstsEnabled = parseBool(process.env.SECURITY_HSTS_ENABLED);
const hstsIncludeSubDomains = parseBool(process.env.SECURITY_HSTS_INCLUDE_SUBDOMAINS);
const hstsPreload = parseBool(process.env.SECURITY_HSTS_PRELOAD);

function hstsValue(): string {
  let value = `max-age=${process.env.SECURITY_HSTS_MAX_AGE ?? "31536000"}`;
  if (hstsIncludeSubDomains) {
    value += "; includeSubDomains";
  }
  if (hstsPreload) {
    value += "; preload";
  }
  return value;
}

const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data: https:",
  "font-src 'self' data:",
  `connect-src 'self'${isDev ? " ws:" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  ...(hstsEnabled ? ["upgrade-insecure-requests"] : []),
].join("; ");

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: contentSecurityPolicy,
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  // frame-ancestors 'none' (CSP) + X-Frame-Options DENY: politicas coerentes,
  // sem contradicao, bloqueando clickjacking nos navegadores antigos.
  {
    key: "X-Frame-Options",
    value: "DENY",
  },
  {
    key: "Permissions-Policy",
    value: "geolocation=(), camera=(), microphone=(), payment=()",
  },
  ...(hstsEnabled
    ? [{ key: "Strict-Transport-Security", value: hstsValue() }]
    : []),
];

const nextConfig: NextConfig = {
  // Remove o header X-Powered-By: Next.js (disclosure de framework).
  poweredByHeader: false,
  // Dist independente por processo (JULLY_NEXT_DIST) evita colisão entre o
  // servidor de smoke (etapa 16) e um `next dev`/`next build` em andamento.
  distDir: process.env.JULLY_NEXT_DIST ?? ".next",
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders.map(({ key, value }) => ({ key, value })),
      },
    ];
  },
};

export default nextConfig;