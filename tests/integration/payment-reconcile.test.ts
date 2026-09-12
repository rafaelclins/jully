import { test, before } from "node:test";
import { strict as assert } from "node:assert";

import { FakePaymentProvider } from "@/payment-provider/fake-provider";
import { prisma } from "@/lib/prisma";
import { reconcilePayment } from "@/services/payment-reconciliation";
import { markPaymentPaid } from "@/services/payments";
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

test("PENDING -> provider diz PAID -> reconcile marca PAID", async () => {
  const tenant = await seedClosedSession();
  const payment = await seedPaymentPendingWithProvider(tenant, {
    providerPaymentId: `fake_${randomUuid()}`,
  });
  const provider = new FakePaymentProvider(undefined, { kind: "paid" });
  const result = await reconcilePayment({
    restaurantId: tenant.restaurantId,
    paymentId: payment.id,
    provider,
  });
  assert.equal(result.outcome, "paid");
  assert.equal(result.payment.status, "PAID");
  assert.ok(result.payment.paidAt);
  await paymentStatus(tenant, payment.id).then((row) => assert.equal(row.status, "PAID"));
});

test("PENDING -> provider diz FAILED -> reconcile marca FAILED", async () => {
  const tenant = await seedClosedSession();
  const payment = await seedPaymentPendingWithProvider(tenant, {
    providerPaymentId: `fake_${randomUuid()}`,
  });
  const provider = new FakePaymentProvider(undefined, { kind: "failed", failureCode: "X" });
  const result = await reconcilePayment({
    restaurantId: tenant.restaurantId,
    paymentId: payment.id,
    provider,
  });
  assert.equal(result.outcome, "failed");
  assert.equal(result.payment.status, "FAILED");
  assert.ok(result.payment.failedAt);
});

test("timeout na reconciliação -> mantém PENDING (nunca FAILED)", async () => {
  const tenant = await seedClosedSession();
  const payment = await seedPaymentPendingWithProvider(tenant, {
    providerPaymentId: `fake_${randomUuid()}`,
  });
  const provider = new FakePaymentProvider(undefined, { kind: "ambiguous" });
  const result = await reconcilePayment({
    restaurantId: tenant.restaurantId,
    paymentId: payment.id,
    provider,
  });
  assert.equal(result.outcome, "ambiguous");
  assert.equal(result.payment.status, "PENDING");
  await paymentStatus(tenant, payment.id).then((row) => assert.equal(row.status, "PENDING"));
});

test("PAID permanece PAID (estado terminal não consulta provider de novo)", async () => {
  const tenant = await seedClosedSession();
  const payment = await seedPaymentPendingWithProvider(tenant, {
    providerPaymentId: `fake_${randomUuid()}`,
  });
  const marked = await markPaymentPaid({
    restaurantId: tenant.restaurantId,
    paymentId: payment.id,
  });
  assert.equal(marked.outcome, "updated");
  const provider = new FakePaymentProvider(undefined, { kind: "failed" });
  const result = await reconcilePayment({
    restaurantId: tenant.restaurantId,
    paymentId: payment.id,
    provider,
  });
  assert.equal(result.outcome, "already-terminal");
  assert.equal(provider.statusCalls, 0);
  await paymentStatus(tenant, payment.id).then((row) => assert.equal(row.status, "PAID"));
});

test("Payment sem providerPaymentId -> cannot-reconcile (permanece PENDING)", async () => {
  const tenant = await seedClosedSession();
  const payment = await seedPaymentPendingWithProvider(tenant); // sem providerPaymentId
  const provider = new FakePaymentProvider(undefined, { kind: "paid" });
  const result = await reconcilePayment({
    restaurantId: tenant.restaurantId,
    paymentId: payment.id,
    provider,
  });
  assert.equal(result.outcome, "cannot-reconcile");
  assert.equal(provider.statusCalls, 0);
  await paymentStatus(tenant, payment.id).then((row) => assert.equal(row.status, "PENDING"));
});

test("Payment cross-tenant -> payment-not-found (sem oráculo)", async () => {
  const tenant = await seedClosedSession();
  const payment = await seedPaymentPendingWithProvider(tenant, {
    providerPaymentId: `fake_${randomUuid()}`,
  });
  const result = await reconcilePayment({
    restaurantId: randomUuid(),
    paymentId: payment.id,
    provider: new FakePaymentProvider(undefined, { kind: "paid" }),
  });
  assert.equal(result.outcome, "payment-not-found");
});

test("provider não resolvido -> cannot-reconcile (permanece PENDING)", async () => {
  const tenant = await seedClosedSession();
  const payment = await seedPaymentPendingWithProvider(tenant, {
    provider: "unregistered-provider",
    providerPaymentId: "p-1",
  });
  const result = await reconcilePayment({
    restaurantId: tenant.restaurantId,
    paymentId: payment.id,
  });
  assert.equal(result.outcome, "cannot-reconcile");
  await paymentStatus(tenant, payment.id).then((row) => assert.equal(row.status, "PENDING"));
});

test("reconcile PENDING -> provider diz PENDING -> unchanged", async () => {
  const tenant = await seedClosedSession();
  const payment = await seedPaymentPendingWithProvider(tenant, {
    providerPaymentId: `fake_${randomUuid()}`,
  });
  const result = await reconcilePayment({
    restaurantId: tenant.restaurantId,
    paymentId: payment.id,
    provider: new FakePaymentProvider(undefined, { kind: "pending" }),
  });
  assert.equal(result.outcome, "unchanged");
  assert.equal(result.payment.status, "PENDING");
});