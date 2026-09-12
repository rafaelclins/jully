import { test, before } from "node:test";
import { strict as assert } from "node:assert";

import {
  FAKE_EVENT_FAILED,
  FAKE_EVENT_PAID,
  FAKE_EVENT_PENDING,
} from "@/payment-provider/fake-provider";
import { prisma } from "@/lib/prisma";
import { processPaymentWebhookEvent } from "@/services/payment-webhooks";
import { markPaymentFailed } from "@/services/payments";
import {
  randomUuid,
  resetDatabase,
  seedClosedSession,
  seedPaymentPendingWithProvider,
  type SeededTenant,
} from "@tests/helpers/db";

before(async () => {
  await resetDatabase();
});

async function paymentStatus(tenant: SeededTenant, paymentId: string) {
  const row = await prisma.payment.findFirst({
    where: { id: paymentId, restaurantId: tenant.restaurantId },
  });
  assert.ok(row);
  return row;
}

test("evento válido PAID é aplicado (PENDING -> PAID)", async () => {
  const tenant = await seedClosedSession();
  const payment = await seedPaymentPendingWithProvider(tenant, {
    providerPaymentId: `fake_${randomUuid()}`,
  });
  const result = await processPaymentWebhookEvent({
    provider: "fake",
    eventId: `evt-${randomUuid()}`,
    providerPaymentId: payment.providerPaymentId!,
    eventType: FAKE_EVENT_PAID,
  });
  assert.equal(result.outcome, "applied");
  assert.equal(result.payment.status, "PAID");
  assert.equal(result.event.outcome, "applied");
  await paymentStatus(tenant, payment.id).then((row) => assert.equal(row.status, "PAID"));
});

test("evento duplicado processado UMA única vez", async () => {
  const tenant = await seedClosedSession();
  const payment = await seedPaymentPendingWithProvider(tenant, {
    providerPaymentId: `fake_${randomUuid()}`,
  });
  const eventId = `evt-${randomUuid()}`;
  const first = await processPaymentWebhookEvent({
    provider: "fake",
    eventId,
    providerPaymentId: payment.providerPaymentId!,
    eventType: FAKE_EVENT_PAID,
  });
  assert.equal(first.outcome, "applied");
  // Duplicação exata do mesmo evento (mesmo id) -> rejeitada pelo unique.
  const second = await processPaymentWebhookEvent({
    provider: "fake",
    eventId,
    providerPaymentId: payment.providerPaymentId!,
    eventType: FAKE_EVENT_PAID,
  });
  assert.equal(second.outcome, "duplicate");
  const rows = await prisma.paymentWebhookEvent.count({
    where: { provider: "fake", providerEventId: eventId },
  });
  assert.equal(rows, 1);
  await paymentStatus(tenant, payment.id).then((row) => assert.equal(row.status, "PAID"));
});

test("evento fora de ordem: PAID -> evento tardio PENDING não regride", async () => {
  const tenant = await seedClosedSession();
  const payment = await seedPaymentPendingWithProvider(tenant, {
    providerPaymentId: `fake_${randomUuid()}`,
  });
  const paid = await processPaymentWebhookEvent({
    provider: "fake",
    eventId: `evt-${randomUuid()}`,
    providerPaymentId: payment.providerPaymentId!,
    eventType: FAKE_EVENT_PAID,
  });
  assert.equal(paid.outcome, "applied");
  // Evento tardio de PENDING (que chegaria atrasado na rede).
  const latePending = await processPaymentWebhookEvent({
    provider: "fake",
    eventId: `evt-${randomUuid()}`,
    providerPaymentId: payment.providerPaymentId!,
    eventType: FAKE_EVENT_PENDING,
  });
  assert.equal(latePending.outcome, "ignored");
  assert.equal(latePending.reason, "no-regress");
  await paymentStatus(tenant, payment.id).then((row) => assert.equal(row.status, "PAID"));
});

test("PAID não regride para FAILED por evento tardio", async () => {
  const tenant = await seedClosedSession();
  const payment = await seedPaymentPendingWithProvider(tenant, {
    providerPaymentId: `fake_${randomUuid()}`,
  });
  const paid = await processPaymentWebhookEvent({
    provider: "fake",
    eventId: `evt-${randomUuid()}`,
    providerPaymentId: payment.providerPaymentId!,
    eventType: FAKE_EVENT_PAID,
  });
  assert.equal(paid.outcome, "applied");
  const lateFailed = await processPaymentWebhookEvent({
    provider: "fake",
    eventId: `evt-${randomUuid()}`,
    providerPaymentId: payment.providerPaymentId!,
    eventType: FAKE_EVENT_FAILED,
  });
  assert.equal(lateFailed.outcome, "ignored");
  assert.equal(lateFailed.reason, "no-regress");
  await paymentStatus(tenant, payment.id).then((row) => assert.equal(row.status, "PAID"));
});

test("evento FAILED em Payment PENDING é aplicado (PAID nunca aconteceu)", async () => {
  const tenant = await seedClosedSession();
  const payment = await seedPaymentPendingWithProvider(tenant, {
    providerPaymentId: `fake_${randomUuid()}`,
  });
  const result = await processPaymentWebhookEvent({
    provider: "fake",
    eventId: `evt-${randomUuid()}`,
    providerPaymentId: payment.providerPaymentId!,
    eventType: FAKE_EVENT_FAILED,
  });
  assert.equal(result.outcome, "applied");
  await paymentStatus(tenant, payment.id).then((row) => assert.equal(row.status, "FAILED"));
});

test("evento de provider desconhecido -> ignorado (provider-unknown) e registrado", async () => {
  const result = await processPaymentWebhookEvent({
    provider: "stripe",
    eventId: `evt-${randomUuid()}`,
    providerPaymentId: "whatever",
    eventType: "payment.paid",
  });
  assert.equal(result.outcome, "ignored");
  assert.equal(result.reason, "provider-unknown");
  assert.equal(result.event.outcome, "ignored-provider-unknown");
});

test("providerPaymentId desconhecido -> ignorado (no-payment)", async () => {
  const result = await processPaymentWebhookEvent({
    provider: "fake",
    eventId: `evt-${randomUuid()}`,
    providerPaymentId: "fake_does-not-exist",
    eventType: FAKE_EVENT_PAID,
  });
  assert.equal(result.outcome, "ignored");
  assert.equal(result.reason, "no-payment");
});

test("evento ruído (sem mapeamento) -> ignorado (noise-event)", async () => {
  const tenant = await seedClosedSession();
  const payment = await seedPaymentPendingWithProvider(tenant, {
    providerPaymentId: `fake_${randomUuid()}`,
  });
  const result = await processPaymentWebhookEvent({
    provider: "fake",
    eventId: `evt-${randomUuid()}`,
    providerPaymentId: payment.providerPaymentId!,
    eventType: "payment.created",
  });
  assert.equal(result.outcome, "ignored");
  assert.equal(result.reason, "noise-event");
  await paymentStatus(tenant, payment.id).then((row) => assert.equal(row.status, "PENDING"));
});

test("cross-tenant impossível por construção: webhook não aceita tenant", async () => {
  // O evento NÃO possui campos de tenant (restaurantId/sessionId) — a
  // resolução é estritamente por (provider, providerPaymentId). Um atacante
  // não tem como direcionar o evento para a Session de outro restaurante.
  const tenantA = await seedClosedSession();
  const tenantB = await seedClosedSession();
  const paymentA = await seedPaymentPendingWithProvider(tenantA, {
    providerPaymentId: `fake_a_${randomUuid()}`,
  });
  await seedPaymentPendingWithProvider(tenantB, {
    providerPaymentId: `fake_b_${randomUuid()}`,
  });
  const result = await processPaymentWebhookEvent({
    provider: "fake",
    eventId: `evt-${randomUuid()}`,
    providerPaymentId: paymentA.providerPaymentId!,
    eventType: FAKE_EVENT_PAID,
  });
  // Aplica SOMENTE no Payment dono do providerPaymentId (tenant A), jamais em B.
  assert.equal(result.outcome, "applied");
  const rowA = await paymentStatus(tenantA, paymentA.id);
  assert.equal(rowA.status, "PAID");
  const rowsB = await prisma.payment.findMany({ where: { restaurantId: tenantB.restaurantId } });
  for (const row of rowsB) {
    assert.notEqual(row.status, "PAID");
  }
});

test("evento PAID tardio em Payment FAILED não promove (sem regressão para a frente)", async () => {
  const tenant = await seedClosedSession();
  const payment = await seedPaymentPendingWithProvider(tenant, {
    providerPaymentId: `fake_${randomUuid()}`,
  });
  const failed = await markPaymentFailed({
    restaurantId: tenant.restaurantId,
    paymentId: payment.id,
  });
  assert.equal(failed.outcome, "updated");
  const latePaid = await processPaymentWebhookEvent({
    provider: "fake",
    eventId: `evt-${randomUuid()}`,
    providerPaymentId: payment.providerPaymentId!,
    eventType: FAKE_EVENT_PAID,
  });
  assert.equal(latePaid.outcome, "ignored");
  assert.equal(latePaid.reason, "no-regress");
  await paymentStatus(tenant, payment.id).then((row) => assert.equal(row.status, "FAILED"));
});

test("evento PENDING em Payment PENDING é aplicado como no-op coerente", async () => {
  const tenant = await seedClosedSession();
  const payment = await seedPaymentPendingWithProvider(tenant, {
    providerPaymentId: `fake_${randomUuid()}`,
  });
  const result = await processPaymentWebhookEvent({
    provider: "fake",
    eventId: `evt-${randomUuid()}`,
    providerPaymentId: payment.providerPaymentId!,
    eventType: FAKE_EVENT_PENDING,
  });
  assert.equal(result.outcome, "applied");
  await paymentStatus(tenant, payment.id).then((row) => assert.equal(row.status, "PENDING"));
});