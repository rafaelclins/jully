import { test, before } from "node:test";
import { strict as assert } from "node:assert";

import { PaymentMethod, PaymentStatus } from "@/generated/prisma/client";
import { FakePaymentProvider } from "@/payment-provider/fake-provider";
import { prisma } from "@/lib/prisma";
import {
  initiatePayment,
  markPaymentPaid,
} from "@/services/payments";
import { reconcilePayment } from "@/services/payment-reconciliation";
import { processPaymentWebhookEvent } from "@/services/payment-webhooks";
import {
  randomUuid,
  resetDatabase,
  seedClosedSession,
  seedPaymentPendingWithProvider,
} from "@tests/helpers/db";

before(async () => {
  await resetDatabase();
});

// ---------- Caso A: 12 requests com a MESMA idempotencyKey ----------
test("12 same-key requests -> 1 Payment, 11 replays, 1 chamada ao provider", async () => {
  const tenant = await seedClosedSession();
  const provider = new FakePaymentProvider({ kind: "paid" });
  const key = randomUuid();

  const results = await Promise.all(
    Array.from({ length: 12 }, () =>
      initiatePayment({
        restaurantId: tenant.restaurantId,
        sessionId: tenant.sessionId,
        idempotencyKey: key,
        method: PaymentMethod.PIX,
        provider,
      })
    )
  );

  const paymentsCount = await prisma.payment.count({
    where: { sessionId: tenant.sessionId, idempotencyKey: key },
  });
  assert.equal(paymentsCount, 1);
  assert.equal(provider.createCalls, 1);

  const nonReplay = results.filter((r) => r.outcome !== "replayed");
  const replays = results.filter((r) => r.outcome === "replayed");
  assert.equal(replays.length, 11);
  assert.equal(nonReplay.length, 1);

  const withPayment = results.filter(
    (r): r is Extract<typeof r, { payment: { id: string } }> => "payment" in r
  );
  const ids = new Set(withPayment.map((r) => r.payment.id));
  assert.equal(ids.size, 1);
  const finalRow = await prisma.payment.findFirst({
    where: { sessionId: tenant.sessionId, idempotencyKey: key },
  });
  assert.ok(finalRow);
  assert.equal(finalRow.status, PaymentStatus.PAID);
});

// ---------- Caso B: duas tentativas diferentes marcadas PAID concorrentemente ----------
test("2 PAID concorrentes -> exatamente UMA PAID (banco é a última barreira)", async () => {
  const tenant = await seedClosedSession();
  const a = await seedPaymentPendingWithProvider(tenant, {
    idempotencyKey: randomUuid(),
    providerPaymentId: `fake_a1_${randomUuid()}`,
  });
  const b = await seedPaymentPendingWithProvider(tenant, {
    idempotencyKey: randomUuid(),
    providerPaymentId: `fake_b1_${randomUuid()}`,
  });

  const [ra, rb] = await Promise.all([
    markPaymentPaid({ restaurantId: tenant.restaurantId, paymentId: a.id }),
    markPaymentPaid({ restaurantId: tenant.restaurantId, paymentId: b.id }),
  ]);

  const paidRows = await prisma.payment.findMany({
    where: { sessionId: tenant.sessionId, status: PaymentStatus.PAID },
  });
  assert.equal(paidRows.length, 1);
  const outcomes = [ra.outcome, rb.outcome].sort();
  // Um "updated", outro "one-paid-per-session" (ou dois deles, se a corrida
  // serializar o P2002 — nunca dois "updated").
  assert.ok(outcomes.includes("updated"));
  assert.ok(outcomes.includes("one-paid-per-session"));
});

// ---------- Caso C: webhook PAID concorrente com reconciliation PAID ----------
test("webhook PAID x reconciliation PAID -> estado final PAID sem duplicação", async () => {
  const tenant = await seedClosedSession();
  const providerPaymentId = `fake_c1_${randomUuid()}`;
  const payment = await seedPaymentPendingWithProvider(tenant, {
    providerPaymentId,
  });

  const provider = new FakePaymentProvider(undefined, { kind: "paid" });
  const results = await Promise.all([
    processPaymentWebhookEvent({
      provider: "fake",
      eventId: `evt_${randomUuid()}`,
      providerPaymentId,
      eventType: "payment.paid",
    }),
    reconcilePayment({
      restaurantId: tenant.restaurantId,
      paymentId: payment.id,
      provider,
    }),
  ]);

  const paidRows = await prisma.payment.findMany({
    where: { sessionId: tenant.sessionId, status: PaymentStatus.PAID },
  });
  assert.equal(paidRows.length, 1);
  assert.equal(paidRows[0].id, payment.id);

  const finalRow = await prisma.payment.findFirst({ where: { id: payment.id } });
  assert.ok(finalRow);
  assert.equal(finalRow.status, PaymentStatus.PAID);

  for (const result of results) {
    if (result.outcome === "paid" || result.outcome === "applied") {
      assert.equal(result.payment.status, PaymentStatus.PAID);
    } else if (result.outcome === "unchanged" || result.outcome === "already-terminal") {
      // tolerável na corrida: o outro fluxo venceu
    } else {
      assert.fail(`unexpected outcome: ${result.outcome}`);
    }
  }
});

// ---------- Webhook duplicado concorrente (mesmo evento) ----------
test("2 webhooks com o MESMO eventoId concorrentes -> registrado UMA vez", async () => {
  const tenant = await seedClosedSession();
  const providerPaymentId = `fake_c2_${randomUuid()}`;
  const payment = await seedPaymentPendingWithProvider(tenant, {
    providerPaymentId,
  });
  const eventId = `evt_dup_${randomUuid()}`;

  const results = await Promise.all([
    processPaymentWebhookEvent({ provider: "fake", eventId, providerPaymentId, eventType: "payment.paid" }),
    processPaymentWebhookEvent({ provider: "fake", eventId, providerPaymentId, eventType: "payment.paid" }),
  ]);

  const eventRows = await prisma.paymentWebhookEvent.count({
    where: { provider: "fake", providerEventId: eventId },
  });
  assert.equal(eventRows, 1);
  assert.ok(results.some((r) => r.outcome === "applied"));

  const row = await prisma.payment.findFirst({ where: { id: payment.id } });
  assert.equal(row?.status, PaymentStatus.PAID);
});

// ---------- Retry concorrente após FAILED (novas chaves) ----------
test("retries concorrentes com chaves distintas após FAILED criam tentativas distintas", async () => {
  const tenant = await seedClosedSession();
  const first = await initiatePayment({
    restaurantId: tenant.restaurantId,
    sessionId: tenant.sessionId,
    idempotencyKey: randomUuid(),
    method: PaymentMethod.PIX,
    provider: new FakePaymentProvider({ kind: "definitive-error" }),
  });
  assert.equal(first.outcome, "failed");

  const provider = new FakePaymentProvider({ kind: "paid" });
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      initiatePayment({
        restaurantId: tenant.restaurantId,
        sessionId: tenant.sessionId,
        idempotencyKey: randomUuid(),
        method: PaymentMethod.PIX,
        provider,
      })
    )
  );
  assert.ok(results.some((r) => r.outcome === "paid"));
  const paidRows = await prisma.payment.findMany({
    where: { sessionId: tenant.sessionId, status: PaymentStatus.PAID },
  });
  assert.equal(paidRows.length, 1);
});