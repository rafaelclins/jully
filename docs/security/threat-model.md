# Modelo de Ameaças — JULLY

**Data:** 2026-09-11/12 · **Versão auditada:** commit `327458c` (Etapa 12.1 pós-fix) · **Tipo:** auditoria ofensiva (Etapa 13), sem correções aplicadas.

---

## 1. Escopo e premissas

O JULLY possui duas superfícies:

| Superfície | Autenticação | Público | Encontra-se em |
|---|---|---|---|
| **Painel operacional** (`/restaurant/*`, `/api/restaurant/*`, `/login`, `/api/auth/*`) | Sessão Better Auth (senha + cookie) | Não | Requer membership `OPERATOR`/`OWNER` |
| **Public menu/Mesa** (`/t/[qrToken]`, `/api/public/*`) | — (token de mesa `qrToken`) | Sim | Autoriza leitura e criação de comanda vinculada à mesa |

Confianças (trust boundaries):
- **Attacker externo** sem credenciais; pode forjar **qualquer cabeçalho HTTP** (incl. `X-Forwarded-For`) e conhecer `qrToken` de uma mesa por vazamento físico/QR.
- **Operador legítimo** de um restaurante X tentando ler/mutar dados de Y (IDOR).
- **Ex-funcionário** com sessão revogada ou membership removida.
- **Detentor da chave de bootstrap** (`AUTH_BOOTSTRAP_KEY`) — capacidade administrativa por design (criar OWNERs).
- Modelo de rede: **sem proxy/load balancer entre o cliente e o Next.js** (implicação JUL-01). Em produção com proxy, a origem real vem em `X-Forwarded-For` de uma fonte confiável.

## 2. Ativos

1. Credenciais de operadores (email+senha) e sessões.
2. Dados financeiros das comandas (itens, preços, subtotais, taxa de serviço).
3. Cadastro de restaurante, mesas e produtos.
4. Configuração de integração/API keys (`.env` / `BETTER_AUTH_SECRET`, `AUTH_BOOTSTRAP_KEY`).
5. Logs de servidor e `ipAddress`/`userAgent` registrados nas sessões.

## 3. Vetores de ameaça priorizados

| # | Ameaça | Superfície | Mitigação atual | Status |
|---|---|---|---|---|
| T1 | Força bruta de senha do painel | `/api/auth/sign-in/email` | Rate limit Better Auth (`window:10, max:100`) | ⚠️ **Burlável** (JUL-01) |
| T2 | Sequestro de sessão (cookie) | Cookies | HttpOnly, SameSite=Lax, 7d, updateAge 1d, validação de origem no logout | Mitigado |
| T3 | CSRF em endpoints de mutação | `/api/*` panel + públicos | Better Auth origin-check em `/api/auth/*`; endpoints próprios não usam cookie para autorizar estado (sessão muda o mundo) | Parcial/baixo risco |
| T4 | IDOR entre restaurantes | `/api/restaurant/*` | `requireRestaurantAccess` = 404 idêntico, sem oráculo | Mitigado |
| T5 | Enumeração de tenants/recursos | ids e slugs | Respostas 404 homogêneas; slug regex; body fixo | Mitigado |
| T6 | Injeção SQL | serviços | Prisma + `$queryRaw` sempre com tags `Prisma.sql` (parametrizado) | Mitigado |
| T7 | XSS armazenado (produto/mesa) | `/t/[qrToken]` | React escapa por padrão; sem `dangerouslySetInnerHTML` | Mitigado |
| T8 | Open redirect pós-login | `/login?next=` | `safeNext` bloqueia `//`, `\`, não-`/`, e codificações | Mitigado |
| T9 | Criação indevida de OWNER | `/api/auth/bootstrap` | Chave 64-char, `timingSafeEqual`, 404 com flag OFF | Mitigado |
| T10 | Abuso de endpoints públicos | `/api/public/*` | Nenhum rate limit próprio (público) | Aceito (baixa severidade) |
| T11 | Vazamento de stack/dados em erro | respostas | Corpos genéricos com `code` estável | Mitigado |
| T12 | Segredos em git | repositório | `.env` não versionado; histórico com placeholders | Mitigado |
| T13 | Dependências vulneráveis | runtime+CLI | `npm audit`: 4 HIGH (CLI `prisma`, não reachable em runtime) | Aceito (retirar no upgrade 6.19.3+) |
| T14 | Exposição de configuração | `/api/public/*/menu` | IDs e `serviceFeePercent` expostos | Aceito (INFO) |

## 4. Diagrama de fluxo (resumo textual)

```
Attacker ──► (public) /t/<qrToken> ──► React ──► /api/public/* ──► services ──► Prisma ──► PG
Operator ──► /login ──► /api/auth/* (Better Auth) ──► cookie session ──► /api/restaurant/* ──► requireRestaurantAccess ──► services ──► PG
Ops ────────► /api/auth/bootstrap (chave) ──► cria User + Membership(papéis)
```

Autorização do painel: `session.user.id + Restaurant.slug + RestaurantMembership` — slug nunca é autorização sozinho (`src/lib/require-restaurant-access.ts`).

## 5. Posição final

Único risco de tratamento prioritário encontrado: **JUL-01 (burlar o rate limit de login via `X-Forwarded-For`)**. Demais controles respondem bem aos vetores testados. Detalhes quantitativos e reprodutíveis no relatório `security-gate-2026-09-11.md`.