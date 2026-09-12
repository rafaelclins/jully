# Security Gate — Remediação (2026-09-11)

> Base do worktree: commit `327458c` (`fix: serialize order creation and session closing`).
> Relatório original preservado: `docs/security/security-gate-2026-09-11.md`.
> Execução: ambiente local Windows PowerShell 5.1, Node v24.20.0, instâncias `next start` (produção) em `localhost:3211-3215`, PostgreSQL `jully_dev`.

---

## JUL-01 — HIGH — Rate limit do login contornável por IP spoofing (`X-Forwarded-For`)

### Estado anterior
- Better Auth 1.7.4 usa por padrão `ipAddressHeaders: ["x-forwarded-for"]` e, **sem `trustedProxies`, confia um header de valor único diretamente**. O atacante enviava `X-Forwarded-For: <ip-fake>` diferente a cada tentativa; o rate limit criava um bucket novo por "IP" e **nunca bloqueava** (validação confirmada no harness: rafaga de 12 origem com XFF variado → 0× `429`).
- Sem rede confiável declarada, a identidade do cliente é **indeterminada** — vale o bucket por rota, não o header forjado.

### Correção
1. **`src/lib/auth-ip-policy.ts` (novo)** — política fail-closed do IP para o rate limit:
   - `parseIpOrCidr` com `node:net.isIP`: endereço IP ou CIDR; prefixo fora da faixa rejeitado; **rede universal (`0.0.0.0/0`, `::/0`) proibida** → proxy universal é recusado.
   - `resolveAuthIpPolicy(env)`:
     - `AUTH_IP_ADDRESS_HEADER` + `AUTH_TRUSTED_PROXIES` válidos → política `trusted-proxy` (lê o header apenas dos hops confiáveis);
     - header **sem** proxies → **ERRO** (não assume rede);
     - qualquer entrada de proxy inválida → **ERRO** + fallback `direct-origin`;
     - nada declarado → `direct-origin` (**nenhum header de IP é lido**).
   - `productionSecurityErrors(env, report)`: em `NODE_ENV=production` adiciona erro para `RATE_LIMIT_DISABLED=true`.
2. **`src/lib/auth.ts`** — `advanced.ipAddress = { ipAddressHeaders, trustedProxies }` vindo da política; nunca um `X-Forwarded-For` arbitrário.
3. **`src/lib/auth-config-guard.ts` (novo)** — diagnóstico memoizado por processo; loga avisos (ex.: sem proxy → bucket compartilhado por rota) e erros da configuração.
4. **`src/app/api/auth/[...all]/route.ts`** — guarda de runtime envolvendo `GET`/`POST` do `toNextJsHandler`: produção com configuração inválida → **HTTP 500 `Server configuration error`** (fail-closed: autenticação não roda sem rate limit confiável).
5. **`scripts/check-security-config.mjs` (novo)** — preflight que espelha as regras; exit `1` para configuração insegura (usável no pipeline/CICD antes de subir).
6. **`.env.example`** — `AUTH_IP_ADDRESS_HEADER`, `AUTH_TRUSTED_PROXIES` documentadas com a regra de ouro (só declarar proxies reais; nunca `0.0.0.0/0`/`::/0`).

### Teste executado (instâncias de produção)
- **A — sem rede (porta 3211):** rafaga de 12 sign-ins `401`-provocantes com `X-Forwarded-For` variado → **`401×3 + 429×9`** (antigo: `0×429`, contornável). Rafaga com XFF fixo → `429×9`.
- **C — proxy declarado (3212, `AUTH_TRUSTED_PROXIES=127.0.0.1`):** identidade = valor do hop confiável (`401,401,401,429` na cadeia `203.0.113.50, 127.0.0.1`); cliente injetando valor **à esquerda** (`6.6.6.6, 203.0.113.50, 127.0.0.1`) → **continua `429`** (identidade inalterada); valor novo após o proxy (`9.9.9.9, 127.0.0.1`) → `401` (identidade nova); `x-real-ip` e `x-cf-connecting-ip` **ignorados**.
- **D/E — configuração inválida em produção:** `RATE_LIMIT_DISABLED=true` e `AUTH_IP_ADDRESS_HEADER` sem proxies → `GET/POST /api/auth/*` → **500**; `check-security-config.mjs` → exit 1 (também para `0.0.0.0/0` e CIDR inválido).

### Resultado
**REMEDIADO.** Impossível contornar o rate limit via `X-Forwarded-For`. Configuração insegura de produção é **recusada** no boot/preflight e na resposta das rotas de autenticação.

> Observação documentada: sem rede declarada, a identidade de IP é a conexão direta (dev/teste) ou o **bucket compartilhado por rota** (produção). Quando a rede de eixo for definida, declarar `AUTH_TRUSTED_PROXIES` para escores por IP reais. Bucket compartilhado só dura o window do rate limit (10s) e também protege o endpoint contra brute force (máx. 3 tentativas/10s em `/sign-in*`).

---

## JUL-02 — LOW — Security headers ausentes + `X-Powered-By`

### Estado anterior
- `X-Powered-By: Next.js` exposto em toda resposta (fingerprint de framework).
- Sem `Content-Security-Policy`; sem `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy`.

### Correção (`next.config.ts`)
- `poweredByHeader: false` (opção oficial do Next.js).
- `headers()` global:
  - **CSP**: `default-src 'self'; script-src 'self' 'unsafe-inline'` + `connect-src 'self' ws:` (apenas dev); `style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https:; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-src 'none'; frame-ancestors 'none'`.
  - `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `Permissions-Policy: geolocation=(), camera=(), microphone=(), payment=()`.
  - **HSTS** (`Strict-Transport-Security` + `upgrade-insecure-requests`) **off por padrão**, ativável via `SECURITY_HSTS_ENABLED` (nunca em HTTP localhost).
- Decisões de CSP (coerentes com a política de chips sem nonce do Next 16, que inline scripts da hidratação RSC):
  - `'unsafe-inline'` nos scripts = relaxamento mínimo necessário (sem nonce no app router com RSC fluido);
  - `'unsafe-eval'` somente em `NODE_ENV !== production` (exigência do React dev);
  - `img-src https:` permite imagens de produtos hospedadas em CDNs externas.

### Teste executado
- Headers presentes em páginas (`/`, `/login`, `/t/MESA-0001`) e em respostas JSON (`/api/public/.../menu`, `/api/auth/get-session`); `X-Powered-By` **ausente** em todas.
- Conformance CSP: todos os assets (`/_next/static/chunks/*.js|.css`) são **mesmo-origin** e retornam 200.
- HSTS ausente por padrão; CSP de produção sem `unsafe-eval`.
- XSS (produto `<img src=x onerror=...>`) renderizado **escapado** na página `t/[qrToken]`; JSON do menu o expõe apenas como string.

### Resultado
**REMEDIADO.** (Verificação de browser headless não executada: sem Playwright instalado; substituído por checagem de conformance CSP + 200 em todos os assets + escaping de payload XSS no HTML servido.)

---

## JUL-03 — LOW — `orderId` sem validação de UUID

### Estado anterior (perícia no código)
- A rota `PATCH /api/restaurant/[restaurantSlug]/orders/[orderId]/status` **já valida `orderId`** com `z.string().trim().min(1).max(64).uuid()` (linha 15), desde o commit `8e5c23c`. O relatório original apontou como ausente — **discrepância factual**; nenhuma mudança de código foi necessária.
- O parse ocorre **antes** de `requireRestaurantAccess` e de qualquer consulta, então IDs malformados não tocam o banco.

### Teste executado (autenticado)
- `abc`, 70 chars, não-UUID → **400** `Invalid order id`.
- UUID válido inexistente → **404** `ORDER_NOT_FOUND`.
- Pedido de outro tenant (mesmo slug A) → **404** `ORDER_NOT_FOUND` com corpo **idêntico** ao inexistente (anti-enumeração confirmada).
- Body com campo extra → **400**.

### Resultado
**JÁ IMPLEMENTADO — confirmado por teste.** Nenhuma alteração necessária.

---

## Regressões críticas (todas verdes no harness)
- Login com credenciais corretas/incorretas (200 / 401 genérica); logout revoga a sessão; cookie adulterado → rota protegida 401; `get-session` anônimo → null.
- CSRF: sign-in sem `Origin` → 403; sign-in com `Origin` malicioso → 403; sign-out cross-origin → 403 e sessão permanece válida; sign-out legítimo → 200.
- Open redirect: `/login?next=` com `//host`, `https://host` → `307` para `/`; caminho interno preservado.
- Tenant isolation: operador de outro restaurante/membro de outro tenant → 404 (idêntico a inexistente); usuário sem membership → 404; summary/close de sessão cross-tenant → 404.
- Sessão/mesa: fechar com pedido PENDING → 409; fechamento idempotente (200 em CLOSED, mesmo resumo); **2 fechamentos concorrentes → mesmo summary** (serialização por mesa); pedido em mesa com sessão CLOSED cria **nova** sessão OPEN (invariante preservada).
- Idempotência pública: 201 → replay 200 mesma ordem; payload diferente mesma key → 409; key inválida → 400; mesa inativa/inexistente → 409/404.
- Injeções: SQLi em slug/orderId/qrToken → 4xx (nunca 500); produto XSS escapa no HTML.

## Quality gates
- `eslint` (regras + script novo, `--max-warnings=0`) → 0 problemas.
- `tsc --noEmit` → 0 erros.
- `npm run build` (Next 16.3.4/Turbopack) → sucesso.
- `prisma validate` e `prisma migrate status` → schema válido, base up-to-date (sem migração nova — nenhuma mudança de schema).
- `npm audit` → mesmas 4 vulnerabilidades HIGH **transitivas** do CLI Prisma (`deepmerge-ts`, `mysql2`), **já presentes antes** e sem correção em versões compatíveis (não executado `npm audit fix`, que rebaixaria para Prisma 6 e é breaking). Nenhuma dependência nova adicionada.

## Notas de ambiente
- **Sem banner/abono**: o rate limit de produção fica **ON** por padrão. `RATE_LIMIT_DISABLED=true` existente no `.env` local (dev) NÃO é o padrão de produção e é recusado pela guarda quando `NODE_ENV=production`.
- Harness de teste foi criado fora do worktree (`%TEMP%`) e **removido** ao final; base `jully_dev` foi **re-seedada** pelos testes (aplicação de calibragem executável).

---

## Conclusão

| Achado | Severidade | Status |
| --- | --- | --- |
| JUL-01 | HIGH | **REMEDIADO** (fail-closed + preflight + guarda) |
| JUL-02 | LOW | **REMEDIADO** |
| JUL-03 | LOW | **JÁ IMPLEMENTADO** (discrepância do relatório; confirmado) |

Regressões críticas e quality gates executados com sucesso. Únicas alterações de código: `auth-ip-policy.ts`, `auth-config-guard.ts`, `auth.ts`, `route.ts` (guard), `next.config.ts`, `scripts/check-security-config.mjs`, `.env.example` — **sem mudança de schema, sem dependência nova, sem push**.

**SECURITY GATE: PASS**