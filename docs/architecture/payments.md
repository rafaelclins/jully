# Arquitetura de pagamentos + moeda (Etapa 15)

**Escopo:** domínio de `Payment` + arquitetura monetária internacional (moeda por
Restaurante e `currencySnapshot` por Mesa) no JULLY. Sem gateway, sem API
externa, sem SDK, sem `fetch` para provedores: **esta etapa não processa
dinheiro de verdade** — constrói o armazenamento, as invariantes e as fronteiras
que uma integração futura usará.

> **Ponto importante:** o preparo arquitetural (moeda/snapshot/Payment) não
> significa suporte comercial/global. Cada moeda reconhecida precisa de revisão
> de política operacional (tarifas, arredondamento local, compliance) antes de
> ser oferecida a um restaurante.

---

## 1. Princípios

1. **Um restaurante opera em uma moeda por vez** (`Restaurant.currency`, código
   ISO 4217 uppercase — nunca símbolo). Sem câmbio, sem multi-moeda dentro da
   mesma conta, sem taxa de conversão.
2. **Sem conversão (FX)** em nenhuma camada. Uma moeda nunca é transformada em
   outra; valores são sempre originados em uma moeda e exibidos nela.
3. **A Mesa congela a moeda no fechamento** (`TableSession.currencySnapshot`) no
   mesmo `UPDATE`/transação dos snapshots financeiros (Etapa 14). Conta fechada
   é imutável: a moeda faz parte do histórico.
4. **O servidor/banco é a fonte da verdade monetária.** O browser nunca informa
   valor nem moeda. `amount`/`currency` do `Payment` são **derivados** da
   Session fechada (`closedTotal` + `currencySnapshot`).
5. **Idempotência**: `unique(sessionId, idempotencyKey)` — um retry da mesma
   intenção nunca cria tentativas equivalentes.
6. **Uma Session fechada tem no máximo UM pagamento efetivamente `PAID`**
   (pagamento integral). Tentativas `PENDING`/`FAILED`/`CANCELLED` podem
   coexistir e não pagam.
7. **Sem pagamento parcial.** A conta só é paga como um todo.
8. **Tenant isolamento em cascata**: `Payment` referencia a Session via FK
   composta `(sessionId, restaurantId) → sessions(id, restaurantId)`.
9. **Delete = Restrict**: histórico financeiro nunca some em cascade, nem por
   Restaurante nem por Mesa.
10. **Nenhum dado sensível armazenado** (número de cartão, CVV, PIN, senha).
    No máximo identificadores seguros/tokens do provedor (`providerPaymentId`).

---

## 2. Moeda

- Fonte de verdade: `src/lib/money/currency.ts` (client-safe, sem import do
  Prisma Client em runtime).
- Escopo inicial: `BRL`, `USD`, `EUR`, `GBP`, `JPY`.
- Banco armazena **código como TEXT** (não enum): adicionar moeda nova não gera
  migration, apenas acrescentar um registro no domínio.
- Validacão centralizada obrigatória: `assertSupportedCurrency()`. Nenhuma
  string arbitrária passa.
- Minor units: `BRL/USD/EUR/GBP` = 2; `JPY` = 0. Nunca assumir 2.
- Armazenamento monetário permanece `DECIMAL(10,2)` (valores com ≤ 2 casas).
  Para as moedas iniciais (2 minor units; JPY inteiro) isso é exato — **nenhuma
  migration de colunas financeiras é necessária**.
- Formatação: `Intl.NumberFormat(locale, { style: "currency", currency })`,
  sem símbolo manual. Usada por `cart`, `menu`, painel e fechamento.

### 2.1 Em cada camada

| Camada | Fonte da moeda |
|---|---|
| Cardápio público (`/menu`) | `Restaurant.currency` (viva) |
| Summary OPEN (mesa aberta) | `Restaurant.currency` (estimativa viva) |
| Summary CLOSED (conta fechada) | `TableSession.currencySnapshot` (congelada) |
| `Payment.currency` | derivada de `currencySnapshot` |
| Cart/painel de operação | moeda do restaurante/mesa em exibição |

---

## 3. Modelo `Payment`

Colunas essenciais (veja `prisma/schema.prisma` para o modelo completo):

| Campo | Tipo | Observação |
|---|---|---|
| `id` | UUID | PK |
| `restaurantId` | UUID | parte da FK composta |
| `sessionId` | UUID | parte da FK composta `(sessionId, restaurantId) → sessions(id, restaurantId)` `ON DELETE RESTRICT` |
| `amount` | `DECIMAL(10,2)` | **derivado** de `closedTotal`; integral |
| `currency` | TEXT | **derivado** de `currencySnapshot`; deve ser igual |
| `status` | enum `PENDING/PAID/FAILED/CANCELLED` | transições só para frente |
| `method` | enum `PIX/CARD/CASH/OTHER` | nullable, preenchido na tentativa |
| `provider` | TEXT | identificador do provedor na integração futura (nunca enum de providers) |
| `providerPaymentId` | TEXT | id seguro junto ao provedor (token, não número de cartão) |
| `idempotencyKey` | UUID | `unique(sessionId, idempotencyKey)` |
| `paidAt`/`failedAt` | timestamp | carimbo da transição terminal |

### 3.1 Estados e transições

```
                 ┌──────────┐
      create ──▶ │ PENDING  │
                 └────┬─────┘
      ┌───────────────┼───────────────┐
      ▼               ▼               ▼
   START_PAY...    SUCCESS        FAILURE/CANCEL
      │               │               │
   (mantém)          PAID           FAILED / CANCELLED
```

- `PENDING → PAID | FAILED | CANCELLED`. Estados terminais não retornam a
  `PENDING`.
- Só `PAID` paga a conta; `FAILED`/`CANCELLED` permitem nova tentativa.
- Sem `REFUNDED` nesta etapa.
- Garantia no banco: índice parcial
  `payments_one_paid_per_session ON payments(sessionId) WHERE status='PAID'`
  (máximo um PAID por Session). **Preservá-lo manualmente** ao gerar migrations
  seguintes (Prisma não expressa partial unique no schema).

### 3.2 Fronteira com gateways (futuro)

- `provider`/`providerPaymentId` existem para a integração; nada de
  credencial/chave de gateway é armazenado.
- Pré-condição da fronteira: Session `CLOSED` com snapshots completos
  (`currencySnapshot` incluído); a integração só recebe `amount`+`currency`
  derivados — nunca valores do client.
- Webhooks futuros devem ser **idempotentes**: um mesmo `providerPaymentId`
  nunca marca a conta duas vezes (o `PRIMARY KEY`/índice parcial protege).

---

## 4. Exposição HTTP

- `Payment` **não possui rota HTTP própria nesta etapa**; o serviço
  `src/services/payments.ts` é a fronteira de domínio (testável) para a
  integração futura.
- O contrato público ganhou apenas o bloco de leitura no resumo de mesa:
  `summary.payment = { status: "UNPAID" | "PAID" }` (CLOSED) ou `null` (OPEN),
  e `summary.currency` + `restaurant.currency` no cardápio.

---

## 5. Invariantes no banco (nível check/index)

Na migration `20260912120212_add_payment_and_currency_domain`:

1. `restaurants.currency TEXT NOT NULL DEFAULT 'BRL'`.
2. `sessions.currencySnapshot TEXT NULL` — participa da mesma CHECK
   `sessions_financial_snapshot_consistency`:
   - `CLOSED` → `closedSubtotal`, `serviceFeePercentSnapshot`,
     `closedServiceFeeAmount`, `closedTotal`, `currencySnapshot` **todos
     NOT NULL**;
   - `OPEN` → todos **NULL**.
3. Backfill executado na migration: Sessions já `CLOSED` recebem `BRL` antes de
   re-adicionar a CHECK.
4. `unique(restaurants.currency = 'BRL' default)` garantido apenas por domínio
   (`assertSupportedCurrency` no fechamento e onde moeda entra); o banco guarda
   TEXT para permitir novas moedas sem migration — o domínio rejeita inválidas.
5. `unique(sessionId, idempotencyKey)` de `orders` estendido para `payments`.
6. FK `payments(sessionId, restaurantId) → sessions(id, restaurantId)`
   `ON DELETE RESTRICT ON UPDATE CASCADE`.

---

## 6. Detecção de fraude/consistência (resultado)

- `SUPPORTED_CURRENCIES` coberto por testes unitários (case/trim, minor units,
  formato por moeda).
- Regressão financeira executada com moeda presente (BRL): subtotal `109.98`,
  10% → `11.00`, total `120.98`; CLOSED inalterado por mudança
  restaurant BRL→USD e por mudança de `Product`/fee.
- Integridade das Sessions: CLOSED inconsistentes retornam erro genérico 500
  (nunca valores estimados).

---

## 7. Limitações e decisões assumidas

- **Sem gateway, sem processamento real, sem PIX/cartão de verdade.** Nada de
  transação financeira efetiva acontece nesta etapa.
- Um `Payment` `PAID` fora do fluxo da aplicação (insert direto no banco) é
  possível tecnicamente; a prevenção de fraudes completas depende da futura
  integração + `providerPaymentId`. As invariantes estruturais (FK composta,
  partial unique, idempotência) valem sempre.
- Moeda por Session via snapshot; não há histórico de moedas por pedido/item.
- `DECIMAL(10,2)` como storage universal: suficiente para as moedas iniciais.
  Se no futuro uma moeda exigir mais casas, será uma migration dedicada.