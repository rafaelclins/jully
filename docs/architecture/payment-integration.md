# Integração de pagamentos — fronteira de provedor (Etapa 16)

**Escopo:** a fronteira arquitetural para **multi-provedor** de pagamentos no
JULLY: interface `PaymentProvider`, registrador de adapters, `FakePaymentProvider`
(provedor fictício não-resolvível em produção), início de tentativa de pagamento
("initiate"), processamento de webhook interno, reconciliação, idempotência,
timeout/ambiguidade e a API autenticada do operador.

> **Continue sem processar dinheiro real.** Nenhum SDK de gateway é instalado;
> nenhuma chamada externa existe. `FakePaymentProvider` nunca move dinheiro e
> **não é resolvível quando a aplicação roda em produção** (garantia estrutural,
> não só de convenção).

---

## 1. Princípios

1. **A fronteira é uma interface, não um SDK.** `src/payment-provider/types.ts`
   define `PaymentProvider`; provedores reais (Mercado Pago, Stripe, ...) entram
   em etapas futuras como adapters atrás de `PAYMENT_PROVIDER`.
2. **O servidor é a única fonte de `amount`/`currency`.** vem da Session CLOSED
   (`closedTotal` + `currencySnapshot`), jamais do client.
3. **Idempotência por `idempotencyKey`** (UUID, `unique(sessionId, idempotencyKey)`).
   Retry da mesma chave = replay da mesma tentativa, **sem** nova chamada ao
   provider.
4. **Conservador em dúvida:** timeout/rede/resultado ambíguo → Payment permanece
   `PENDING` (nunca `FAILED`). Só uma recusa **definitiva** vira `FAILED`.
5. **Uma Session fechada tem no máximo UM `PAID`** — a barreira final é o índice
   parcial `payments_one_paid_per_session` (o banco, não o processo).
6. **Webhook idempotente e sem tenant por cliente:** o evento do provedor não
   conhece tenant; a resolução é `(provider, providerPaymentId)`. Cross-tenant é
   impossível por construção.
7. **Sem dados sensíveis:** nunca armazenamos número de cartão, CVV, token bruto,
   nem `providerPaymentId` em logs.

---

## 2. Diretório da fronteira

```
src/payment-provider/
  types.ts           # PaymentProvider + DTOs + erros (Ambiguous/Definitive)
  fake-provider.ts   # FakePaymentProvider (provedor fictício de testes)
  registry.ts        # getPaymentProvider / getWebhookEventMapper / resolveRuntimePaymentProvider
  logging.ts         # logProviderOperation (log seguro, sem secrets)
```

- `registry.ts` é um mapa simples de string → adapter (sem framework de DI).
- Registro de provedor real futuro: um `case` em `getPaymentProvider` + o mapper
  de eventos + variável de ambiente correspondente em `PAYMENT_PROVIDER`.

### 2.1 Seleção de runtime

- Fora de produção (`NODE_ENV !== "production"`): `PAYMENT_PROVIDER` não definido
  assume **`fake`**.
- Qualquer valor sem adapter registrado → resolução **null** → rota responde
  **503 `PROVIDER_UNAVAILABLE`** (fail-closed).
- Em produção, `PAYMENT_PROVIDER=fake` NÃO resolve (a aplicação nunca vira
  "fake money" em prod); o servidor responde 503 até existir um adapter real.

---

## 3. Contrato `PaymentProvider`

```ts
interface PaymentProvider {
  readonly name: string;
  createPayment(input: CreateProviderPaymentInput): Promise<CreateProviderPaymentResult>;
  getPaymentStatus(input: GetProviderPaymentStatusInput): Promise<GetProviderPaymentStatusResult>;
  mapWebhookEventType?(eventType: string): PaymentStatus | null; // adapter mapping
}
```

- **`createPayment`** `pending | paid | failed` — ou lança:
  - `ProviderAmbiguousError`: tempo/estado desconhecido após submissão
    (timeout, rede caiu) → o domínio mantém o Payment **PENDING**;
  - `ProviderDefinitiveError`: recusa definitiva e sem ambiguidade (ex.: cartão
    recusado) → o domínio marca **FAILED**;
  - exceção genérica: tratada como **ambiguidade** (nunca FAILED).
- **`getPaymentStatus`** — resolve o status real de um `providerPaymentId`
  (reconciliação/status). Mesmas regras de erro acima.
- **`mapWebhookEventType`** — mapeia o tipo bruto do evento (dezenas de nomes por
  provedor) para no máximo 3 status JULLY (`PENDING|PAID|FAILED`). Nomes de
  evento não maplineáveis (ruído) → `null` → evento ignorado (dedup ainda grava).

### 3.1 FakePaymentProvider

Comportamento determinístico por cenário (`pending | paid | failed | ambiguous |
exception | definitive-error`) tanto para `create` quanto para `status`, mais
contadores `createCalls`/`statusCalls` para asserções de idempotência e
concorrência. `providerPaymentId` derivado (`fake_<internalPaymentId>`);
eventos `payment.pending | payment.paid | payment.failed`.

---

## 4. Modelo `PaymentWebhookEvent`

Tabela nova (`prisma/migrations/20260912140000_add_payment_provider_boundary`):

| Campo | Tipo | Observação |
|---|---|---|
| `id` | UUID | PK |
| `provider` | TEXT | nome do provedor do evento |
| `providerEventId` | TEXT | id bruto do evento no provedor |
| `providerPaymentId` | TEXT | payment id junto ao provedor |
| `eventType` | TEXT | tipo bruto recebido |
| `occurredAt` | timestamp nullable | instante informado pelo provedor |
| `receivedAt` | timestamp | instante de recebimento no JULLY |
| `processedAt` | timestamp nullable | instante do processamento efetivo |
| `outcome` | TEXT nullable | `applied / duplicate / ignored / no-regress` |

Payload bruto não é persistido. Status normalizado existe apenas durante o
processamento e na transição segura de `Payment`.

- **Dedup** = `UNIQUE(provider, providerEventId)` (replay de rede sobre o mesmo
  evento é rejeitado no banco).
- **Cross-tenant impossível**: não há tenant no evento; só `(provider,
  providerPaymentId) → unique payments_provider_providerPaymentId_key`.

---

## 5. Application services

### 5.1 `initiatePayment` (`src/services/payments.ts`)

```
1. Session CLOSED + integrity do snapshot
2. Session já tem Payment PAID?        -> payment-already-paid
3. Provider resolve?                    -> (503 na rota)
4. Tentativa PENDING ENGAGADA existente -> payment-already-pending (conservador)
5. unique(sessionId, idempotencyKey):
   - primeira vez                      -> chama provider.createPayment
       * pending  -> Payment PENDING + providerPaymentId (ENGAGED)
       * paid     -> Payment PAID (terminal)
       * failed   -> Payment FAILED (terminal)
       * ambíguo  -> Payment PENDING SEM providerPaymentId (reconciliação decide)
   - retry da MESMA chave             -> replay: devolve a tentativa, NÃO chama provider
6. marcação PAID/FAILED concorrente    -> one-paid-per-session (índice parcial)
```

Saídas: `created | replayed | paid | failed | session-not-closed |
session-not-found | payment-already-pending | payment-already-paid |
one-paid-per-session`.

### 5.2 `processPaymentWebhookEvent` (`src/services/payment-webhooks.ts`)

```
1. GRAVA o evento (register) primeiro — dedup no banco em corridas.
2. Mapper do provider -> status (ruído = ignorado).
3. provider não registrado / payment não existe -> ignorado (registrado).
4. Aplica na máquina de estados atômica:
     PENDING -> PAID | FAILED       (aplica)
     PAID    -> tudo                 (ignored: no-regress)
     FAILED  -> PAID/PENDING/FAILED  (ignored: no-regress)
```

Sem regressão em nenhuma direção: depois de `PAID` ou `FAILED` a tentativa é
histórica.

### 5.3 `reconcilePayment` (`src/services/payment-reconciliation.ts`)

- Utilizada por futura rotina (essa etapa **não** cria cron/scheduler).
- Aceita `provider` **injetado** → determinístico em testes; sem provider
  resolvido → `cannot-reconcile` (permanece PENDING).
- `PENDING` (com `providerPaymentId`) → consulta `getPaymentStatus`:
  `paid` → PAID, `failed` → FAILED, `pending`/ambiguous → permanece PENDING.
- `PAID` → `already-terminal` (não consulta o provider de novo).
- Sem `providerPaymentId` → `cannot-reconcile`.

---

## 6. API HTTP — iniciar pagamento

```
POST /api/restaurant/:restaurantSlug/sessions/:sessionId/payments
```

Autenticação: **operador do restaurante** (session cookie Better Auth). Cliente
anônimo nunca marca nada como pago. Body estrito (`zod .strict()`):

```json
{ "method": "PIX", "idempotencyKey": "uuid" }
```

Qualquer campo extra (`amount`, `currency`, `status`, `restaurantId`,
`providerPaymentId`, `paidAt`) → **400**. `amount`/`currency` são derivados no
servidor da Session CLOSED.

| Status | Código | Significado |
|---|---|---|
| 201 | — | tentativa criada (PENDING/ENGAGED) |
| 200 | — | replay (mesma tentativa) / provider pagou na hora / recusa definitiva |
| 400 | — | payload inválido / slug ou sessionId malformados |
| 401 | — | sem sessão de operador |
| 404 | `RESTAURANT_NOT_FOUND` | restaurante inexistente **ou** sem membership |
| 404 | `SESSION_NOT_FOUND` | Session inexistente/cross-tenant |
| 409 | `SESSION_NOT_CLOSED` | mesa ainda aberta |
| 409 | `PAYMENT_ALREADY_PENDING` | tentativa PENDING engajada em andamento |
| 409 | `PAYMENT_ALREADY_PAID` | Session já paga |
| 409 | `ONE_PAID_PER_SESSION` | corrida: outra tentativa venceu o PAID |
| 503 | `PROVIDER_UNAVAILABLE` | sem adapter registrado (fail-closed) |
| 500 | — | integridade CLOSED violada (snapshot inconsistente) — nunca fatura |

> **Webhook HTTP não existe nesta etapa** — o processamento é serviço interno
> (`processPaymentWebhookEvent`). O endpoint público de webhook (com autenticação
> por assinatura) é escopo futuro, atrás de provider real.

---

## 7. Testes mandatórios

- **Unit** (`tests/unit/payment-provider.test.ts`): interface, cenários fake,
  mapping de eventos, registro e o bloqueio do fake em produção.
- **Integração** (`tests/integration/`):
  - `payment-initiate.test.ts`: derivacao de amount/currency, idempotência
    (replay), FAILED+chave nova, ambiguidade/tempo → PENDING, bloqueio
    conservador e limite de 1 PAID.
  - `payment-webhook.test.ts`: dedup, fora-de-ordem, no-regress, tenant, ruído.
  - `payment-reconcile.test.ts`: transições por status, timeout → PENDING,
    terminal não consulta provider.
  - `payment-concurrency.test.ts`: 12× mesma chave → 1 payment/1 chamada;
    2 PAID concorrentes → exatamente 1 vence; webhook×reconciliation; dedup
    concorrente.
- **Security smoke** (`scripts/security-smoke.mjs`, `tests/security/`): sobe o
  servidor real em `smoke-dist` (porta 3210, `jully_dev_test`,
  `PAYMENT_PROVIDER=fake`, bootstrap ligado, rate-limit desligado) e valida o
  contrato HTTP de ponta a ponta (401/400/404/409/503), spoofing de body,
  integridade do snapshot e headers de segurança.
- Runner: `scripts/test-runner.mjs` deriva `<base>_test` de `DATABASE_URL`,
  cria/cria-migra o banco dedicado e roda `tsx --test --test-concurrency=1`.
- Lifecycle (`scripts/lifecycle-smoke.mjs`): executa 3 ciclos reais, persiste
  `launcherPid` e `serverPid`, valida owner/workspace/árvore e recusa owner
  inesperado sem encerrar o processo.

Comandos:

```
npm run lint        # eslint --max-warnings=0
npx tsc --noEmit
npm run test        # integração + unit contra <base>_test
npm run security:smoke   # smoke HTTP contra servidor real (porta 3210)
npm run test:lifecycle   # 3 ciclos + prova fail-closed
```

---

## 8. Operação e decisões assumidas

- Sessions CLOSED corruptas (snapshot incompleto) → **500**, nunca valor
  estimado; a integridade é revalidada a cada início de pagamento.
- O replay **antes** da chamada ao provider evita cobrança dupla em retries;
  a ambiguidade resolve-se **depois** por reconciliação/webhook (nunca re-cria).
- Sem pagamento parcial, sem estorno (`REFUNDED`), sem transação de teste real.
- A migração `payments_provider_providerPaymentId_key` substitui a indexação de
  `provider` isolado; **preservar** o partial unique
  `payments_one_paid_per_session` e a CHECK `sessions_financial_snapshot_consistency`
  em migrations futuras (Prisma não os expressa no schema).
