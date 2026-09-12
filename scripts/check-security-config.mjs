// Preflight de configuração de segurança antes de produção (JUL-01).
//
// Espelha as regras de src/lib/auth-ip-policy.ts + a guarda de runtime
// (src/lib/auth-config-guard.ts). Manter em sincronia com o módulo TS.
//
// Uso:
//   node scripts/check-security-config.mjs            # checa como produção
//   node scripts/check-security-config.mjs --dev      # modo desenvolvimento
//
// Exit:
//   0  configuração aceitável para o modo
//   1  configuração insegura/inválida -> NÃO subir em produção
import "dotenv/config";
import { isIP } from "node:net";

const HEADER_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const isDevMode = process.argv.includes("--dev");
const isProduction = isDevMode
  ? false
  : (process.env.NODE_ENV ?? "").trim() === "production";

function parseIpOrCidr(value) {
  const slashIndex = value.lastIndexOf("/");
  const address = slashIndex === -1 ? value : value.slice(0, slashIndex);
  const family = isIP(address);
  if (family === 0) {
    return { ok: false, reason: `${JSON.stringify(value)} não é um IP válido` };
  }
  const maxBits = family === 4 ? 32 : 128;
  if (slashIndex === -1) {
    return { ok: true };
  }
  const prefix = value.slice(slashIndex + 1);
  if (!/^\d+$/.test(prefix)) {
    return { ok: false, reason: `${JSON.stringify(value)} tem prefixo de CIDR inválido` };
  }
  const bits = Number(prefix);
  if (bits > maxBits) {
    return { ok: false, reason: `${JSON.stringify(value)} tem prefixo fora da faixa` };
  }
  if (bits === 0) {
    return { ok: false, reason: `${JSON.stringify(value)} é rede universal (prefixo 0), proibida` };
  }
  return { ok: true };
}

function main() {
  const errors = [];
  const warnings = [];

  const rawHeader = (process.env.AUTH_IP_ADDRESS_HEADER ?? "")
    .trim()
    .toLowerCase();
  const rawProxies = process.env.AUTH_TRUSTED_PROXIES ?? "";
  const proxyEntries = rawProxies
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const headerValid =
    rawHeader.length === 0 || HEADER_TOKEN_PATTERN.test(rawHeader);
  if (rawHeader.length > 0 && !headerValid) {
    errors.push("AUTH_IP_ADDRESS_HEADER deve ser um nome de header HTTP válido.");
  }

  for (const entry of proxyEntries) {
    const parsed = parseIpOrCidr(entry);
    if (!parsed.ok) {
      errors.push(`AUTH_TRUSTED_PROXIES: ${parsed.reason}`);
    }
  }
  const proxyListFullyValid = proxyEntries.every((entry) => parseIpOrCidr(entry).ok);

  if (rawHeader.length > 0 && headerValid && proxyEntries.length === 0) {
    errors.push(
      "AUTH_IP_ADDRESS_HEADER definido sem AUTH_TRUSTED_PROXIES: header de IP forjável seria confiado (IP spoofing)."
    );
  }
  if (proxyEntries.length > 0 && !proxyListFullyValid) {
    errors.push("AUTH_TRUSTED_PROXIES com entradas inválidas/universais: recusado (fail-closed).");
  }

  if (proxyEntries.length === 0) {
    warnings.push(
      "Nenhum proxy declarado: headers de IP não são lidos. Em dev/teste identidade local; em produção bucket compartilhado por rota."
    );
  }

  if (isProduction) {
    if (process.env.RATE_LIMIT_DISABLED === "true") {
      errors.push("RATE_LIMIT_DISABLED=true em produção: inviável.");
    }
  } else if (process.env.RATE_LIMIT_DISABLED === "true") {
    warnings.push("Rate limit do login desligado (RATE_LIMIT_DISABLED=true) — somente dev/testes.");
  }

  const mode = isProduction ? "produção" : "desenvolvimento";
  console.log(`[security-config] modo: ${mode}`);
  console.log(
    `[security-config] AUTH_IP_ADDRESS_HEADER=${rawHeader === "" ? "<vazio>" : rawHeader}`
  );
  console.log(
    `[security-config] AUTH_TRUSTED_PROXIES=${proxyEntries.length === 0 ? "<vazio>" : proxyEntries.join(", ")}`
  );

  for (const warning of warnings) {
    console.warn(`[security-config] AVISO: ${warning}`);
  }
  for (const error of errors) {
    console.error(`[security-config] ERRO: ${error}`);
  }

  if (errors.length > 0) {
    console.error("[security-config] FAIL: corrija a configuração antes de subir.");
    process.exit(1);
  }

  console.log("[security-config] PASS");
  process.exit(0);
}

main();