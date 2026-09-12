import { test, before } from "node:test";
import { strict as assert } from "node:assert";

import { PaymentMethod } from "@/generated/prisma/client";
import { FakePaymentProvider } from "@/payment-provider/fake-provider";
import { prisma } from "@/lib/prisma";
import {
  initiatePayment,
  markPaymentFailed,
} from "@/services/payments";
import {
  randomUuid,
  resetDatabase,
  seedClosedSession,
  seedOpenSession,
  type SeededTenant,
} from "@tests/helpers/db";

before(async () => {
  await resetDatabase();
});

async function expectStatus(tenant: SeededTenant, paymentId: string, status: string) {
  const row = await prisma.payment.findFirst({
    where: { id: paymentId, restaurantId: tenant.restaurantId },
  });
  assert.ok(row);
  assert.equal(row.status, status);
  return row;
}

test("Session OPEN é rejeitada (sem pagamento de mesa aberta)", async () => {
  const tenant = await seedOpenSession();
  const provider = new FakePaymentProvider({ kind: "paid" });
  const result = await initiatePayment({
    restaurantId: tenant.restaurantId,
    sessionId: tenant.sessionId,
    idempotencyKey: randomUuid(),
    method: PaymentMethod.PIX,
    provider,
  });
  assert.equal(result.outcome, "session-not-closed");
  assert.equal(provider.createCalls, 0);
});

test("Session inexistente/cross-tenant -> session-not-found", async () => {
  const provider = new FakePaymentProvider({ kind: "paid" });
  const result = await initiatePayment({
    restaurantId: randomUuid(),
    sessionId: randomUuid(),
    idempotencyKey: randomUuid(),
    method: PaymentMethod.PIX,
    provider,
  });
  assert.equal(result.outcome, "session-not-found");
});

test("Session CLOSED aceita; amount/currency DERIVADOS do fechamento", async () => {
  const tenant = await seedClosedSession({ subtotal: "109.98", serviceFeePercent: 10 });
  assert.equal(tenant.closedTotal, "120.98");
  const provider = new FakePaymentProvider({ kind: "pending" });
  const result = await initiatePayment({
    restaurantId: tenant.restaurantId,
    sessionId: tenant.sessionId,
    idempotencyKey: randomUuid(),
    method: PaymentMethod.PIX,
    provider,
  });
  assert.equal(result.outcome, "created");
  assert.equal(result.payment.status, "PENDING");
  assert.equal(result.payment.amount, "120.98");
  assert.equal(result.payment.currency, "BRL");
  assert.equal(result.payment.sessionId, tenant.sessionId);
  assert.equal(result.payment.restaurantId, tenant.restaurantId);
  assert.equal(result.payment.provider, "fake");
  assert.ok(result.payment.providerPaymentId);
});

test("currency DERIVADA de currencySnapshot (USD)", async () => {
  const tenant = await seedClosedSession({ currency: "USD" });
  const provider = new FakePaymentProvider({ kind: "pending" });
  const result = await initiatePayment({
    restaurantId: tenant.restaurantId,
    sessionId: tenant.sessionId,
    idempotencyKey: randomUuid(),
    method: PaymentMethod.PIX,
    provider,
  });
  assert.equal(result.outcome, "created");
  assert.equal(result.payment.currency, "USD");
});

test("idempotência: mesma idempotencyKey -> MESMA tentativa (replay), 1 chamada provider", async () => {
  const tenant = await seedClosedSession();
  const provider = new FakePaymentProvider({ kind: "pending" });
  const key = randomUuid();
  const first = await initiatePayment({
    restaurantId: tenant.restaurantId,
    sessionId: tenant.sessionId,
    idempotencyKey: key,
    method: PaymentMethod.PIX,
    provider,
  });
  assert.equal(first.outcome, "created");
  const second = await initiatePayment({
    restaurantId: tenant.restaurantId,
    sessionId: tenant.sessionId,
    idempotencyKey: key,
    method: PaymentMethod.PIX,
    provider,
  });
  assert.equal(second.outcome, "replayed");
  assert.equal(second.payment.id, first.payment.id);
  assert.equal(provider.createCalls, 1);

  const count = await prisma.payment.count({
    where: { sessionId: tenant.sessionId, idempotencyKey: key },
  });
  assert.equal(count, 1);
});

test("replay após PAID devolve a MESMA tentativa paga", async () => {
  const tenant = await seedClosedSession();
  const provider = new FakePaymentProvider({ kind: "paid" });
  const key = randomUuid();
  const first = await initiatePayment({
    restaurantId: tenant.restaurantId,
    sessionId: tenant.sessionId,
    idempotencyKey: key,
    method: PaymentMethod.PIX,
    provider,
  });
  assert.equal(first.outcome, "paid");
  const second = await initiatePayment({
    restaurantId: tenant.restaurantId,
    sessionId: tenant.sessionId,
    idempotencyKey: key,
    method: PaymentMethod.PIX,
    provider,
  });
  assert.equal(second.outcome, "replayed");
  assert.equal(second.payment.id, first.payment.id);
  assert.equal(second.payment.status, "PAID");
});

test("FAILED definitivo + nova idempotencyKey permite nova tentativa", async () => {
  const tenant = await seedClosedSession();
  const declining = new FakePaymentProvider({ kind: "definitive-error", failureCode: "CARD_DECLINED" });
  const first = await initiatePayment({
    restaurantId: tenant.restaurantId,
    sessionId: tenant.sessionId,
    idempotencyKey: randomUuid(),
    method: PaymentMethod.CARD,
    provider: declining,
  });
  assert.equal(first.outcome, "failed");
  assert.equal(first.payment.status, "FAILED");
  assert.ok(first.payment.failedAt);

  // Mesma chave -> replay da tentativa FAILED (nunca nova cobrança).
  const sameKey = await initiatePayment({
    restaurantId: tenant.restaurantId,
    sessionId: tenant.sessionId,
    idempotencyKey: first.payment.idempotencyKey,
    method: PaymentMethod.CARD,
    provider: declining,
  });
  assert.equal(sameKey.outcome, "replayed");
  assert.equal(sameKey.payment.id, first.payment.id);
  assert.equal(sameKey.payment.status, "FAILED");

  // Nova chave -> nova tentativa permitida.
  const retry = new FakePaymentProvider({ kind: "paid" });
  const second = await initiatePayment({
    restaurantId: tenant.restaurantId,
    sessionId: tenant.sessionId,
    idempotencyKey: randomUuid(),
    method: PaymentMethod.PIX,
    provider: retry,
  });
  assert.equal(second.outcome, "paid");
  assert.notEqual(second.payment.id, first.payment.id);
  await expectStatus(tenant, second.payment.id, "PAID");
});

test("provider create retorna failed (resultado, não exceção) -> FAILED", async () => {
  const tenant = await seedClosedSession();
  const provider = new FakePaymentProvider({ kind: "failed", failureCode: "FAKE_DECLINE" });
  const result = await initiatePayment({
    restaurantId: tenant.restaurantId,
    sessionId: tenant.sessionId,
    idempotencyKey: randomUuid(),
    method: PaymentMethod.PIX,
    provider,
  });
  assert.equal(result.outcome, "failed");
  assert.equal(result.payment.status, "FAILED");
});

test("timeout/ambiguidade -> Payment permanece PENDING (NUNCA FAILED)", async () => {
  const tenant = await seedClosedSession();
  const provider = new FakePaymentProvider({ kind: "ambiguous" });
  const result = await initiatePayment({
    restaurantId: tenant.restaurantId,
    sessionId: tenant.sessionId,
    idempotencyKey: randomUuid(),
    method: PaymentMethod.PIX,
    provider,
  });
  assert.equal(result.outcome, "created");
  assert.equal(result.payment.status, "PENDING");
  assert.equal(result.payment.providerPaymentId, null);
  // Re-tentar a MESMA chave ainda é replay (mesma tentativa PENDING).
  const retry = await initiatePayment({
    restaurantId: tenant.restaurantId,
    sessionId: tenant.sessionId,
    idempotencyKey: result.payment.idempotencyKey,
    method: PaymentMethod.PIX,
    provider: new FakePaymentProvider({ kind: "paid" }),
  });
  assert.equal(retry.outcome, "replayed");
  assert.equal(retry.payment.status, "PENDING");
  assert.equal(retry.payment.id, result.payment.id);
});

test("exceção inesperada do provider também NÃO vira FAILED", async () => {
  const tenant = await seedClosedSession();
  const provider = new FakePaymentProvider({ kind: "exception" });
  const result = await initiatePayment({
    restaurantId: tenant.restaurantId,
    sessionId: tenant.sessionId,
    idempotencyKey: randomUuid(),
    method: PaymentMethod.PIX,
    provider,
  });
  assert.equal(result.outcome, "created");
  assert.equal(result.payment.status, "PENDING");
});

test("sucesso imediato -> PAID com paidAt", async () => {
  const tenant = await seedClosedSession();
  const provider = new FakePaymentProvider({ kind: "paid" });
  const result = await initiatePayment({
    restaurantId: tenant.restaurantId,
    sessionId: tenant.sessionId,
    idempotencyKey: randomUuid(),
    method: PaymentMethod.PIX,
    provider,
  });
  assert.equal(result.outcome, "paid");
  assert.equal(result.payment.status, "PAID");
  assert.ok(result.payment.paidAt);
  await expectStatus(tenant, result.payment.id, "PAID");
});

test("aceita PENDING engajado; nova chave bloqueada (conservador, evita cobrança dupla)", async () => {
  const tenant = await seedClosedSession();
  const pending = new FakePaymentProvider({ kind: "pending" });
  const first = await initiatePayment({
    restaurantId: tenant.restaurantId,
    sessionId: tenant.sessionId,
    idempotencyKey: randomUuid(),
    method: PaymentMethod.PIX,
    provider: pending,
  });
  assert.equal(first.outcome, "created");
  assert.ok(first.payment.providerPaymentId);

  const second = await initiatePayment({
    restaurantId: tenant.restaurantId,
    sessionId: tenant.sessionId,
    idempotencyKey: randomUuid(),
    method: PaymentMethod.PIX,
    provider: new FakePaymentProvider({ kind: "paid" }),
  });
  assert.equal(second.outcome, "payment-already-pending");
});

test("Session já PAID -> nova tentativa bloqueada (payment-already-paid)", async () => {
  const tenant = await seedClosedSession();
  const first = await initiatePayment({
    restaurantId: tenant.restaurantId,
    sessionId: tenant.sessionId,
    idempotencyKey: randomUuid(),
    method: PaymentMethod.PIX,
    provider: new FakePaymentProvider({ kind: "paid" }),
  });
  assert.equal(first.outcome, "paid");
  const second = await initiatePayment({
    restaurantId: tenant.restaurantId,
    sessionId: tenant.sessionId,
    idempotencyKey: randomUuid(),
    method: PaymentMethod.PIX,
    provider: new FakePaymentProvider({ kind: "paid" }),
  });
  assert.equal(second.outcome, "payment-already-paid");
});

test("FAILED via markPaymentFailed não permite regressar a PENDING pelo fluxo", async () => {
  const tenant = await seedClosedSession();
  const first = await initiatePayment({
    restaurantId: tenant.restaurantId,
    sessionId: tenant.sessionId,
    idempotencyKey: randomUuid(),
    method: PaymentMethod.PIX,
    provider: new FakePaymentProvider({ kind: "definitive-error" }),
  });
  assert.equal(first.outcome, "failed");
  const transition = await markPaymentFailed({
    restaurantId: tenant.restaurantId,
    paymentId: first.payment.id,
  });
  assert.equal(transition.outcome, "already");
  await expectStatus(tenant, first.payment.id, "FAILED");
});