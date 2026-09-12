import { isIP } from "node:net";

// Politica de resolucao de IP para o rate limit do Better Auth (JUL-01).
//
// Regra arquitetural (fail-closed):
//   - O JULLY NAO confia em X-Forwarded-For (ou qualquer header de IP) que os
//     clientes possam forjar. Antes da remediacao, um unico valor em
//     X-Forwarded-For era adotado como identidade do rate limit, permitindo a
//     um atacante criar buckets independentes apenas trocando o header.
//   - Header de IP so e lido quando uma politica explicita de proxy existir:
//     AUTH_IP_ADDRESS_HEADER + AUTH_TRUSTED_PROXIES validos (sem proxy
//     universal como 0.0.0.0/0 ou ::/0).
//   - Sem politica: nenhum header e lido. Em dev/teste o Better Auth usa a
//     identidade local (127.0.0.1). Em producao o rate limit cai num bucket
//     compartilhado por rota (seguro, porem envie AUTH_TRUSTED_PROXIES para
//     obter granularidade por cliente real).
//   - Configuracao invalida em producao (header sem proxies, proxy invalido,
//     RATE_LIMIT_DISABLED) recusa processar /api/auth/* (veja auth-config-guard)
//     em vez de assumir headers inseguros silenciosamente.

export const DEFAULT_FORWARDED_HEADER = "x-forwarded-for";

const HEADER_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export type IpTrustPolicy = {
  tier: "direct-origin" | "trusted-proxy";
  ipAddressHeaders: string[];
  trustedProxies: string[];
};

export type AuthIpPolicyReport = {
  policy: IpTrustPolicy;
  errors: string[];
  warnings: string[];
};

type CidrEntry = { family: number; prefix: number };

function parseIpOrCidr(value: string): { ok: true; entry: CidrEntry } | { ok: false; reason: string } {
  const slashIndex = value.lastIndexOf("/");
  const address = slashIndex === -1 ? value : value.slice(0, slashIndex);
  const family = isIP(address);
  if (family === 0) {
    return { ok: false, reason: `${JSON.stringify(value)} nao e um IP valido` };
  }
  const maxBits = family === 4 ? 32 : 128;
  if (slashIndex === -1) {
    return { ok: true, entry: { family, prefix: maxBits } };
  }
  const prefixPart = value.slice(slashIndex + 1);
  if (!/^\d+$/.test(prefixPart)) {
    return { ok: false, reason: `${JSON.stringify(value)} tem prefixo de CIDR invalido` };
  }
  const prefix = Number(prefixPart);
  if (prefix > maxBits) {
    return { ok: false, reason: `${JSON.stringify(value)} tem prefixo fora da faixa (0-${maxBits})` };
  }
  if (prefix === 0) {
    return {
      ok: false,
      reason: `${JSON.stringify(value)} e uma rede universal (prefixo 0) — proxy universal e proibido`,
    };
  }
  return { ok: true, entry: { family, prefix } };
}

export function splitProxyList(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function resolveAuthIpPolicy(env: NodeJS.ProcessEnv = process.env): AuthIpPolicyReport {
  const rawHeader = (env.AUTH_IP_ADDRESS_HEADER ?? "").trim().toLowerCase();
  const rawProxies = env.AUTH_TRUSTED_PROXIES ?? "";
  const proxyEntries = splitProxyList(rawProxies);

  const errors: string[] = [];
  const warnings: string[] = [];

  const headerPresent = rawHeader.length > 0;
  const headerValid = !headerPresent || HEADER_TOKEN_PATTERN.test(rawHeader);
  if (headerPresent && !headerValid) {
    errors.push(
      "AUTH_IP_ADDRESS_HEADER deve ser um nome de header HTTP valido (letras, numeros, hifen ou underscore)."
    );
  }

  const proxyResults = proxyEntries.map((entry) => ({ entry, parsed: parseIpOrCidr(entry) }));
  for (const item of proxyResults) {
    if (!item.parsed.ok) {
      errors.push(`AUTH_TRUSTED_PROXIES: ${item.parsed.reason}`);
    }
  }

  const proxyListPresent = proxyEntries.length > 0;
  const proxyListFullyValid = proxyResults.every((item) => item.parsed.ok);

  if (headerPresent && headerValid && !proxyListPresent) {
    errors.push(
      "AUTH_IP_ADDRESS_HEADER definido sem AUTH_TRUSTED_PROXIES: um header de IP forjavel pelo cliente seria confiado (IP spoofing). Defina os dois juntos."
    );
  }

  if (proxyListPresent && !proxyListFullyValid) {
    errors.push("AUTH_TRUSTED_PROXIES possui entradas invalidas ou universais: recusado (fail-closed).");
  }

  let policy: IpTrustPolicy;
  if (headerValid && proxyListPresent && proxyListFullyValid) {
    const header = headerPresent ? rawHeader : DEFAULT_FORWARDED_HEADER;
    policy = {
      tier: "trusted-proxy",
      ipAddressHeaders: [header],
      trustedProxies: proxyEntries,
    };
    warnings.push(
      `Confianca em forwarded headers habilitada apenas para proxies declarados: header="${header}", trustedProxies=[${proxyEntries.join(", ")}].`
    );
  } else {
    policy = {
      tier: "direct-origin",
      ipAddressHeaders: [],
      trustedProxies: [],
    };
    if (!headerPresent && !proxyListPresent) {
      warnings.push(
        "Sem AUTH_IP_ADDRESS_HEADER/AUTH_TRUSTED_PROXIES: nenhum header de IP e lido (fail-closed). Dev/teste usa 127.0.0.1; em producao o rate limit usa bucket compartilhado por rota ate declarar um proxy real."
      );
    }
  }

  return { policy, errors, warnings };
}

// Erros que tornam uma producao INVIAVEL (recusar processar autenticacao em
// vez de rodar de forma insegura). Fora de NODE_ENV=production retorna [].
// Estende o relatorio de politica com o caso RATE_LIMIT_DISABLED.
export function productionSecurityErrors(
  env: NodeJS.ProcessEnv = process.env,
  report: AuthIpPolicyReport = resolveAuthIpPolicy(env)
): string[] {
  if ((env.NODE_ENV ?? "").trim() !== "production") {
    return [];
  }
  const errors = [...report.errors];
  if (env.RATE_LIMIT_DISABLED === "true") {
    errors.push(
      "RATE_LIMIT_DISABLED=true em producao: o rate limit de login ficaria silenciosamente desligado. Remova a variavel."
    );
  }
  return errors;
}