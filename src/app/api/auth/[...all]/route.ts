import { toNextJsHandler } from "better-auth/next-js";

import { securityDiagnosticsForRuntime } from "@/lib/auth-config-guard";
import { auth } from "@/lib/auth";
import { errorResponse } from "@/lib/public-api";

// Handler do Better Auth montado em /api/auth/[...all].
// A guarda de runtime avalia a configuracao de seguranca (JUL-01) e recusa
// processar autenticacao quando producao esta com configuracao insegura:
//   - RATE_LIMIT_DISABLED=true em producao
//   - AUTH_IP_ADDRESS_HEADER sem AUTH_TRUSTED_PROXIES
//   - AUTH_TRUSTED_PROXIES com entradas invalidas/universais
// Em dev/teste nada muda.

const { GET: nextGet, POST: nextPost } = toNextJsHandler(auth);

function guard(handler: (request: Request) => Promise<Response>) {
  return async function guarded(request: Request): Promise<Response> {
    const { errors } = securityDiagnosticsForRuntime();
    if (errors.length > 0) {
      return errorResponse(500, "Server configuration error");
    }
    return handler(request);
  };
}

export const GET = guard(nextGet);
export const POST = guard(nextPost);