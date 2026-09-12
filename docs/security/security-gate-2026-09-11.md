# Security Gate 2026-09-11 — JULLY

**Data:** 2026-09-11/12 · **Alcance:** auditoria ofensiva da Etapa 13 · **Base testada:** commit `327458c` (árvore limpa) · **Modo:** investigar/reproduzir/provar/classificar — **nenhuma correção aplicada**.

---

## 1. Resumo executivo

**Veredito: FAIL (bloqueante)** por **1 achado HIGH** em autenticação (JUL-01). Nenhum CRITICAL. O restante do inventário apresentou controles consistentes: isolamento multi-tenant robusto (sem IDOR, sem oráculo de enumeração), sem SQLi, sem XSS, sem open redirect, bootstrap bem protegido, sign-up fechado, origem/CSRF do Better Auth funcionando, erros genéricos sem vazamento de stack. Nada em `git` é segredo real. As 4 vulnerabilidades HIGH do `npm audit` são do **CLI `prisma`** (transitivas), não-reachables pelo runtime da aplicação.

O achado bloqueante é de **baixo custo de correção** (configuração de `trustedProxies`/proxy real + decisão de confiar em `X-Forwarded-For` apenas de hop confiável, ou reforço adicional de login). Recomenda-se re-abrir o gate após a mitigação.

---

## 2. Método e ambiente

- **Harness próprio** em `%TEMP%\opencode\jully-audit` (fora da árvore; isolado do repo; usa `node_modules` via junction), executando contra **build de produção** (`next start`, porta 3210) com o `.env` de dev e uma **instância de controle** (porta 3216) com `RATE_LIMIT_DISABLED=""`, `AUTH_BOOTSTRAP_ENABLED=false` e `BETTER_AUTH_URL` próprio.
- Banco de desenvolvimento (`jully_dev`) semeado com fixtures controladas (2 restaurantes, 3 mesas, produtos — incl. payload XSS, usuários `OPERATOR`/`OWNER`, sessões com pedidos `READY`/`PENDING`).
- **151 checagens automáticas: todas passando (151/151).** Cobertura: auth, IDOR/autorização, bootstrap, validação de entrada (zod), XSS/headers/open-redirect/disclosure, varredura estática de SQL, rate limit.
- Regressões pós-harness: `eslint src --max-warnings=0` ✅ · `tsc --noEmit` ✅ · `next build` ✅ · `prisma validate` ✅ · `prisma migrate status` (5 migrações, schema em dia) ✅.

---

## 3. Achados

### 3.1 JUL-01 — Rate limit de login burlável via `X-Forwarded-For` (HIGH)

| Campo | Conteúdo |
|---|---|
| **Severidade** | HIGH |
| **Componente** | `src/lib/auth.ts:30-36` (`rateLimit: { enabled, window: 10, max: 100 }`) + Better Auth `getIP` | 
| **Pré-condição** | `RATE_LIMIT_DISABLED` ausente (produção). Nenhum proxy/`trustedProxies` configurado em `advanced.ipAddress` |
| **Passos (prova)** | Servidor de controle com rate limit ativo: (1) 10 tentativas de login com IP fixo → 3×`401` + 7×`429`; (2) 60 tentativas **rotacionando** `X-Forwarded-For` (`203.0.113.100..149`) → **0× `429`** (todos `401`); (3) sem header → bloqueado como `::1`. Sem o spoof, `max` só dispara após ~100/janela |
| **Resultado observado** | `X-Forwarded-For` com valor único equivale à identidade do rate limit. O código do Better Auth (`node_modules/@better-auth/core/dist/utils/ip.mjs`, `getIPFromHeader`) valida: sem `trustedProxies`, confia em um header de valor único vindo **do próprio cliente** |
| **Impacto** | Força bruta de senha do painel sem limite efetivo (todo atacante controla os próprios headers). Unica barreira restante é a qualidade da senha |
| **Evidência** | `brute force com IP (XFF) fixo: limiter conta e bloqueia (429=7)`;
`brute force rotacionando X-Forwarded-For: 429=0 -> mesmo cliente ilimitado` |
| **Recomendação** | Não confiar em `X-Forwarded-For` de origem arbitrária: configurar `advanced.ipAddress.trustedProxies` (hop real) e/ou extrair IP da conexão direta; colocar o Next.js atrás de proxy terminando TLS com originação confiável; manter `RATE_LIMIT_DISABLED` fora de produção. Re-auditar após a mudança |

**Nota:** o `.env` de dev traz `RATE_LIMIT_DISABLED=true` (rate limit **desligado** em dev). O achado é sobre o comportamento de produção (flag ausente).

### 3.2 JUL-02 — Security headers ausentes + disclosura de framework (LOW)

| Campo | Conteúdo |
|---|---|
| **Severidade** | LOW (coletivo) |
| **Componente** | Respostas HTTP globais (sem `headers()` em `next.config.ts`) |
| **Passos** | `GET /t/MESA-0001` → inspecionar cabeçalhos |
| **Observado** | Ausentes: `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`. Presente: `X-Powered-By: Next.js` (disclosure de stack) e `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate` (correto em páginas dinâmicas) |
| **Impacto** | Clickjacking/Antisniffing de degradação; fingerprinting facilitado; sem CSP dificulta bloqueio a blast radius de eventual XSS futuro |
| **Nota** | HSTS sem efeito em HTTP local (esperado); deve ser adicionado na terminação TLS |
| **Recomendação** | Adicionar `headers()` com `CSP`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: geolocation=(),camera=(),microphone=()` e remover/obscurecer `X-Powered-By`. **Aplicar apenas novos headers — não altera lógica de negócio** |

### 3.3 JUL-03 — Validação de formato inconsistente no path `orderId` (LOW/INFO)

| Campo | Conteúdo |
|---|---|
| **Severidade** | LOW (não explorável: sem crash, sem injeção; unicamente rigidez) |
| **Componente** | `PATCH /api/restaurant/[slug]/orders/[orderId]/status` — **não** valida `orderId` como UUID (o `sessionId` de `summary`/`close` valida via `z.uuid()`) |
| **Passos** | `PATCH .../orders/not-a-uuid/status` com sessão válida |
| **Observado** | `400` (rejeitado com segurança, shape de erro genérico). Para `sessionId` não-UUID → `400` explícito |
| **Recomendação** | Adicionar `schema.uuid()` no parâmetro `orderId` para paridade de contrato |

### 3.4 Achados INFO (sem ação imediata)

| ID | Título | Detalhe |
|---|---|---|
| JUL-04 | `RATE_LIMIT_DISABLED=true` no `.env` dev | Deliberado para desenvolvimento; risco residual apenas se o mesmo valor chegar à produção. Revista-se em release |
| JUL-05 | Acúmulo de sessões no banco | Cada login cria nova linha de `session`; as anteriores não são removidas (observado n=7 na suíte; expiração rejeita uso de sessões vencidas). Não há job de purga — INFO para operação |
| JUL-06 | Bootstrap = capacidade administrativa completa | Uma única chave 64-char cria `OWNER` de qualquer restaurante. Mitigado por: flag OFF fora de dev, `timingSafeEqual`, ausência de vazamento da chave em logs, idempotência e `409` em conflito de papel. Manter a chave sob gestão de segredo |
| JUL-07 | Config financeira exposta no menu público | `/api/public/*/menu` devolve `restaurantId` e `serviceFeePercent`; necessário apenas se preço/consumo precisar ser conferido. Avaliar remover campos não consumidos |
| JUL-08 | `OWNER` e `OPERATOR` com acesso idêntico no painel | Observado 200=200 (`owner=200 operator=200`). Nos fluxos atuais não há privilégio extra de `OWNER` no painel; registrar para quando RBAC diferenciar ações |
| JUL-09 | Descobrimento acidental de URI de conexão no terminal | Durante o desenvolvimento do harness, um erro de formato de env printou a `DATABASE_URL` completa do banco **dev** em stdout local. **Não** está versionada; não está no repo nem nos docs. Ação operacional: rotacionar a senha do banco de desenvolvimento se o log for distribuído |
| JUL-10 | Sinal de identity: `get-session` devolve `session.token.id` e `ipAddress` | By design do Better Auth; a assinatura do cookie (metade secreta) não é exposta. Risco real apenas se logs de sessão vazarem |

---

## 4. Controles validados (evidência positiva consolidada)

- **Sign-up público:** `403`, sem criação de usuário.
- **Login:** erro genérico idêntico para "usuário inexistente" e "senha errada" (anti-enumeração); cookie `session_token` `HttpOnly`, `SameSite=Lax`, `Max-Age=604800`; sem `session_data` exposto a JS.
- **Origem/CSRF:** `sign-in` sem `Origin` → `403 MISSING_OR_NULL_ORIGIN`; com origem maliciosa → `403 INVALID_ORIGIN`; `sign-out` cross-origin → `403` com sessão preservada.
- **Sessão:** revogação no logout (painel: `401`); expiração manual rejeitada; anti-fixation (tokens distintos a cada login); token adulterado rejeitado.
- **Autorização/IDOR:** matriz completa (membro de A × dados de B; usuário sem membership; ids aleatórios; ids válidos de outro tenant) → 404 homogêneo: `A lista orders de B` `404`; `id de outro tenant via slug proprio ==` id inexistente (sem oráculo); mutações cross-tenant não alteram estado (`PENDING` segue `PENDING`).
- **Bootstrap:** sem chave/errada/parcial → `401` idêntico; payloads inválidos → `400` (zod strict, incl. campo extra); restaurante inexistente → `404`; `OWNER` criado; idempotência `200`; conflito de papel `409`; com flag OFF → `404` até com chave correta; chave e token nunca nos logs.
- **SQLi:** nenhum `$queryRawUnsafe`/`$executeRaw*`; `$queryRaw` **5×** (4× `sessions.ts`, 1× `orders.ts`), todos via `Prisma.sql` com parâmetros (`FOR UPDATE`/locks).
- **XSS:** payload `<img src=x onerror=...>` não aparece cru no HTML server-side; aparece escapado (`&lt;img…`); JSON do menu carrega a string literal (não executa).
- **Open redirect:** 10 variantes de `next` (externo https, `//`, `\\`, `%2F%2F`, `javascript:`, double-encode) → todas `307` para `/` seguro.
- **Input:** quantidades ≤ 99 (400), ≤ 50 itens, `Idempotency-Key` obrigatório/UUID, merge correto (30+40 → 1 item qty 70), mensagens de erro com `code` estável, `close` body estrito.
- **Segredos em git:** `.env` não versionado (só `.env.example`); histórico `git log --all -p` contém apenas placeholders (`postgresql://USER:PASSWORD@…`).
- **Dependências:** `npm audit` → 4 HIGH/0 CRITICAL, todas transitivas do **CLI `prisma`** (deepmerge-ts `≤7` GHSA-ggr8-5vv4-36mx, mysql2); a app é executada com `@prisma/client` + `@prisma/adapter-pg` — não atinge esse código em runtime; corrigir no próximo `prisma` semver-major (≥6.19.3).

---

## 5. Classificação e decisão do gate

| Severidade | Qtd |
|---|---|
| CRITICAL | 0 |
| HIGH | **1** (JUL-01) |
| MEDIUM | 0 |
| LOW | 2 (JUL-02, JUL-03) |
| INFO | 7 (JUL-04 … JUL-10) |

**Decisão: FAIL** — conforme regra do gate (falha automática com qualquer HIGH), o **Security Gate 2026-09-11 é REPROVADO** em virtude de JUL-01 (proteção contra força bruta de autenticação é burlável por spoofing de `X-Forwarded-For`).

**Trilha de remediação sugerida (fora do escopo da Etapa 13):**
1. Fix de rede/identity para JUL-01 (trusted proxies OU origem confiável do IP; garantir `RATE_LIMIT_DISABLED` fora de ambientes produtivos) → re-executar o harness de rate limit.
2. Aplicar headers de segurança (JUL-02) e padronizar validação de `orderId` (JUL-03).
3. Upgrade do CLI `prisma` quando o semver-major estiver disponível (JUL-13/audit).

Reabrir o gate apenas com JUL-01 mitigado e reprovado empiricamente (0×429 com XFF fixo **e** rotativo esperando bloqueio após o limite, agora com identidade real).

---

## 6. Riscos residuais e limitações

- Testes executados sobre ambiente local/dev; não houve teste em infraestrutura de produção com proxy/CDN.
- Auditoria é de comportamento HTTP + varredura estática; inexiste revisão formal de cadeia de suprimentos além de `npm audit`.
- Não foi testada recuperação de dados/backup (fora de escopo).
- Nenhum fluxo de senha-esquecida/IDP externo existe (escopo da Etapa atual).
- Os artefatos temporários do harness (`%TEMP%\opencode\jully-audit`) e a massa de dados dos testes no `jully_dev` **não fazem parte** do repositório; recomenda-se truncar o banco de dev após leitura do relatório.