import { productionSecurityErrors, resolveAuthIpPolicy } from "@/lib/auth-ip-policy";

// Guarda de runtime para /api/auth/* (JUL-01/JUL-04).
//
// Politica fail-closed em producao (NODE_ENV=production):
//   - Configuracao de seguranca invalida -> recusa processar (HTTP 500 com
//     log claro) em vez de rodar silenciosamente com rate limit desligado ou
//     com confianca em header de IP forjavel.
//   - Configuracao valida mas sem proxy declarado -> aviso unico no log
//     indicando que o rate limit usa bucket compartilhado por rota.
//   - Fora de producao nenhum erro e produzido (dev/teste seguem normais).
//
// O diagnostico e cacheado por processo: avaliar o ambiente a cada request
// seria custoso (get-session e chamado com frequencia).

type SecurityDiagnostics = { errors: string[]; warnings: string[] };

let cachedDiagnostics: SecurityDiagnostics | null = null;

export function securityDiagnosticsForRuntime(
  env: NodeJS.ProcessEnv = process.env
): SecurityDiagnostics {
  if (cachedDiagnostics) {
    return cachedDiagnostics;
  }

  const report = resolveAuthIpPolicy(env);
  const errors = productionSecurityErrors(env, report);
  const warnings = errors.length > 0 ? [] : report.warnings;

  for (const warning of warnings) {
    console.warn(`[auth] security: ${warning}`);
  }
  if (errors.length > 0) {
    console.error(
      `[auth] security: recusando autenticacao por configuracao invalida: ${JSON.stringify(errors)}`
    );
  }

  cachedDiagnostics = { errors, warnings };
  return cachedDiagnostics;
}