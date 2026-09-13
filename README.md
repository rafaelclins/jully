# JULLY

JULLY é um MVP local para restaurantes pequenos: cliente pede pelo QR Code da mesa, operador acompanha pedidos em painel, avança status e fecha a conta.

Status atual: fluxo piloto funciona sem pagamento real. Infra de pagamentos existe com provider `fake` para testes. Mercado Pago, Stripe, PIX real e cartão real ainda não estão integrados.

## Stack

- Next.js 16 App Router
- React 19
- TypeScript
- Tailwind CSS
- Prisma 7 + PostgreSQL
- Better Auth para operador
- Node test runner + smoke HTTP/lifecycle

## Setup

```bash
npm install
copy .env.example .env
```

Configure `.env`:

- `DATABASE_URL`: PostgreSQL local.
- `BETTER_AUTH_SECRET`: segredo forte local.
- `BETTER_AUTH_URL`: origem da app, ex. `http://localhost:3000`.
- `PAYMENT_PROVIDER=fake`: somente dev/teste.
- `AUTH_BOOTSTRAP_ENABLED=true` e `AUTH_BOOTSTRAP_KEY`: somente para criar operador local/demo.

Nunca versionar `.env`. Não use `RATE_LIMIT_DISABLED=true` em produção.

## Banco

```bash
npx prisma migrate deploy
npx prisma validate
npx prisma migrate status
```

Testes usam banco derivado com sufixo `_test`. O helper de limpeza recusa banco não `_test`.

## Rodar local

```bash
npm run dev
```

App padrão: `http://localhost:3000`.

Lifecycle oficial para smoke local:

```bash
npm run test:lifecycle
```

Esse fluxo usa `scripts/jully-lifecycle.mjs`, valida ownership da porta e falha fechado quando a porta pertence a outro processo.

## Demo local

1. Inicie a app com bootstrap habilitado:

```bash
npm run dev
```

2. Em outro terminal, defina senha demo sem gravar no código:

```powershell
$env:DEMO_OPERATOR_PASSWORD="senha-local-forte"
npm run demo:prepare
```

O script cria restaurante, mesa, categoria, produtos e operador via `/api/auth/bootstrap`. Ele recusa produção e bancos fora de `localhost` com database `jully_dev` ou `_test`.

Saída informa:

- URL cliente: `/t/{qrToken}`
- URL operador: `/login`
- URL painel: `/restaurant/{slug}/orders`
- email do operador

Senha não é impressa.

## Jornada QA

Cliente:

1. Abra URL `/t/{qrToken}`.
2. Confira restaurante e mesa.
3. Adicione produtos.
4. Abra carrinho.
5. Confira subtotal, taxa de serviço e total estimado.
6. Envie pedido.

Operador:

1. Abra `/login`.
2. Entre com operador demo.
3. Acesse painel do restaurante.
4. Veja mesa, itens, horário, status e total do pedido.
5. Avance Pendente, Em preparo, Pronto.
6. Envie segundo pedido pela mesma mesa.
7. Abra conta da mesa.
8. Atualize se necessário.
9. Confira subtotal, taxa e total.
10. Feche mesa.
11. Volte ao painel.

## Testes

```bash
npm run test
npm run security:smoke
npm run test:lifecycle
npm run lint
npx tsc --noEmit
npm run build
npx prisma validate
npx prisma migrate status
```

`security:smoke` sobe servidor real pelo lifecycle oficial e testa auth, tenant isolation, status, fechamento e pagamentos fake.

## Scripts úteis

- `npm run dev`: servidor dev.
- `npm run build`: build produção.
- `npm run start`: serve build.
- `npm run lint`: ESLint.
- `npm run test`: unit/integration.
- `npm run security:smoke`: smoke HTTP com servidor real.
- `npm run test:lifecycle`: lifecycle oficial.
- `npm run demo:prepare`: prepara demo local.
- `npm run auth:create-operator`: cria operador via bootstrap seguro.
