# Inventário de Endpoints — JULLY

**Data:** 2026-09-11/12 · **Fonte:** build (`next build` route map) + leitura de código · **Versão:** `327458c`

---

## Público (sem autenticação)

| Método | Rota | Permissão/Validacão | Auxílio |
|---|---|---|---|
| GET | `/` | Cobre/landing estática | — |
| GET | `/t/[qrToken]` | Página pública da mesa; `qrToken` regex `^[A-Z0-9-]+$`; HTML servido | Roda SSR; dados via ``/api/public` |
| GET | `/api/public/restaurants/[slug]/menu` | `slug` regex `^[a-z0-9-]+$`; restaurante ativo | Expõe `id`, `restaurantId`, `serviceFeePercent` (INFO) |
| GET | `/api/public/tables/[qrToken]` | resolve mesa ativa / sessão ativa | — |
| POST | `/api/public/tables/[qrToken]/session` | abre/retoma sessão da mesa | Sem rate limit próprio (aceito) |
| POST | `/api/public/tables/[qrToken]/orders` | `Idempotency-Key` obrigatório (UUID); zod estrito; merge por produto; limite qty ≤ 99, ≤ 50 itens; bloqueio por lock de linha (`FOR UPDATE`) | Cria comanda |

## API operacional (autenticada — sessão cookie + membership)

| Método | Rota | Autorização | Comportamento observado |
|---|---|---|---|
| GET | `/api/restaurant/[restaurantSlug]/orders` | `requireRestaurantAccess` | Lista orders PENDING/PREPARING/READY do tenant |
| PATCH | `/api/restaurant/[restaurantSlug]/orders/[orderId]/status` | `requireRestaurantAccess` + owner-check do order | Transição inválida → `409 INVALID_STATUS_TRANSITION`; id inexistente/cross-tenant → `404 ORDER_NOT_FOUND`; `orderId` sem regex uuid (aceita e rejeita com 400) |
| GET | `/api/restaurant/[restaurantSlug]/sessions/[sessionId]/summary` | `requireRestaurantAccess` | Resumo financeiro; `sessionId` validado `.uuid()` → `400 Invalid session id`; inexistente/cross-tenant → `404 SESSION_NOT_FOUND` |
| POST | `/api/restaurant/[restaurantSlug]/sessions/[sessionId]/close` | `requireRestaurantAccess` | Body estrito vazio; `409 SESSION_HAS_ACTIVE_ORDERS` se houver PENDING/PREPARING; idempotente (`200` no replay); serializado por lock da mesa |

Política unificada (`src/lib/require-restaurant-access.ts`):
- `unauthenticated` → `401`
- restaurante inexistente **ou** sem membership → **mesmo** `404 RESTAURANT_NOT_FOUND`
- Id de outro tenant usado no slug com acesso → `404` com mesmo shape de "inexistente" (sem oráculo)

## Auth (Better Auth 1.7.4)

| Método | Rota | Observação |
|---|---|---|
| GET | `/api/auth/get-session` | Retorna `user` + `session` (incl. `token.id` e `ipAddress`); não expõe a assinatura do cookie |
| POST | `/api/auth/sign-in/email` | Origin check: sem/malicioso → `403 MISSING_OR_NULL_ORIGIN`/`INVALID_ORIGIN`; erro genérico `401 INVALID_EMAIL_OR_PASSWORD`; cookie `session_token` HttpOnly, SameSite=Lax, Max-Age=604800 |
| POST | `/api/auth/sign-out` | Revoga sessão; cross-origin → `403` (sessão preservada) |
| POST | `/api/auth/sign-up/email` | Desabilitado → `403` |
| GET/POST | `/api/auth/[...all]` | Fallback do handler do Better Auth |

## Bootstrap (administrativo, chave compartilhada)

| Método | Rota | Observação |
|---|---|---|
| POST | `/api/auth/bootstrap` | Liga apenas com `AUTH_BOOTSTRAP_ENABLED === "true"` (senão `404` para qualquer combinação, inclusive chave correta). Autenticação: `x-bootstrap-key`, comparação com `timingSafeEqual`. Payload zod `.strict()`: `name ≤ 100`, `email` válido, `password ≥ 8`, `restaurantSlug` existe, `role ∈ {OPERATOR, OWNER}`. Sem membro: `404 RESTAURANT_NOT_FOUND`; conflito de papel no mesmo restaurante: `409 MEMBERSHIP_ROLE_MISMATCH`; idempotente (`200 already-exists`). Chave/token não vazam nos logs |

## Páginas autenticadas

| Rota | Nota |
|---|---|
| `/login` | `safeNext` valida `next` (só caminho relativo interno); redireciona se sessão ativa |
| `/restaurant/[restaurantSlug]/orders` | Painel (client) |
| `/restaurant/[restaurantSlug]/sessions/[sessionId]` | Painel (client) |

## Misc

- Sem endpoint de cadastro público, senha, recuperação, ou e-mail.
- Total de rotas dinâmicas no build: 16 (3 auth, 1 bootstrap, 6 públicas, 4 operacionais de API, 2 painel + `/login` + `/` + `/_not-found`).