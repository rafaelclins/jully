import { test, before } from "node:test";
import { strict as assert } from "node:assert";

import { prisma } from "@/lib/prisma";
import {
  randomUuid,
  resetDatabase,
  seedClosedSession,
  seedOpenSession,
  type SeededTenant,
} from "@tests/helpers/db";

// Suites de smoke HTTP contra o servidor real (scripts/security-smoke.mjs).
// O servidor roda em jully_test com AUTH_BOOTSTRAP_ENABLED=true,
// RATE_LIMIT_DISABLED=true e PAYMENT_PROVIDER=fake.
const BASE = process.env.SMOKE_URL ?? "http://localhost:3210";

async function postPayment(
  slug: string,
  sessionId: string,
  body: Record<string, unknown>,
  cookies: string[]
): Promise<Response> {
  return fetch(`${BASE}/api/restaurant/${slug}/sessions/${sessionId}/payments`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookies.length > 0 ? { cookie: cookies.join("; ") } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function bootstrapOperatorFor(slug: string, email: string): Promise<string[]> {
  const password = "SmokePass!123";
  const bootstrap = await fetch(`${BASE}/api/auth/bootstrap`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bootstrap-key": process.env.AUTH_BOOTSTRAP_KEY ?? "",
    },
    body: JSON.stringify({
      name: "Smoke Operator",
      email,
      password,
      restaurantSlug: slug,
      role: "OPERATOR",
    }),
  });
  assert.ok(
    bootstrap.status === 200 || bootstrap.status === 201,
    `bootstrap de operador falhou: status ${bootstrap.status}`
  );

  const signIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    // Better Auth exige origem confiável em requests state-changing. O smoke
    // simula navegador real; sem Origin a proteção CSRF responde 403.
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(signIn.status, 200, "sign-in deve responder 200");
  const cookies = signIn.headers.getSetCookie().map((c) => c.split(";")[0]);
  assert.ok(cookies.length > 0, "sign-in deve devolver cookie de sessão");
  return cookies;
}

let closedCookies: string[] = [];
let openCookies: string[] = [];
let closedTenant: SeededTenant;
let openTenant: SeededTenant;

before(async () => {
  await resetDatabase();
  closedTenant = await seedClosedSession({ subtotal: "100.00", serviceFeePercent: 0 });
  openTenant = await seedOpenSession();
  closedCookies = await bootstrapOperatorFor(
    closedTenant.restaurantSlug,
    `smoke-a-${randomUuid()}@example.com`
  );
  openCookies = await bootstrapOperatorFor(
    openTenant.restaurantSlug,
    `smoke-b-${randomUuid()}@example.com`
  );
});

test("sem sessão de operador -> 401 Unauthorized", async () => {
  const res = await postPayment(
    closedTenant.restaurantSlug,
    closedTenant.sessionId,
    { method: "PIX", idempotencyKey: randomUuid() },
    []
  );
  assert.equal(res.status, 401);
});

test("slug inválido -> 400", async () => {
  const res = await fetch(
    `${BASE}/api/restaurant/INVALID_SLUG/sessions/${closedTenant.sessionId}/payments`,
    { method: "POST" }
  );
  assert.equal(res.status, 400);
});

test("spoof de amount/currency/status/restaurantId/providerPaymentId -> 400", async () => {
  const cases: Record<string, unknown>[] = [
    { method: "PIX", idempotencyKey: randomUuid(), amount: "1.00" },
    { method: "PIX", idempotencyKey: randomUuid(), currency: "USD" },
    { method: "PIX", idempotencyKey: randomUuid(), status: "PAID" },
    { method: "PIX", idempotencyKey: randomUuid(), paidAt: new Date().toISOString() },
    { method: "PIX", idempotencyKey: randomUuid(), restaurantId: randomUuid() },
    { method: "PIX", idempotencyKey: randomUuid(), providerPaymentId: "hack" },
    { method: "MONEY", idempotencyKey: randomUuid() },
    { method: "PIX", idempotencyKey: "not-a-uuid" },
  ];
  for (const body of cases) {
    const res = await postPayment(closedTenant.restaurantSlug, closedTenant.sessionId, body, closedCookies);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

test("restaurante sem membership / inexistente -> 404 RESTAURANT_NOT_FOUND", async () => {
  const res = await postPayment(
    `r-${randomUuid().replace(/-/g, "")}`,
    closedTenant.sessionId,
    { method: "PIX", idempotencyKey: randomUuid() },
    closedCookies
  );
  assert.equal(res.status, 404);
  const payload = (await res.json()) as { code?: string };
  assert.equal(payload.code, "RESTAURANT_NOT_FOUND");
});

test("Session de outro tenant -> 404 (sem confirmar existência)", async () => {
  const res = await postPayment(
    closedTenant.restaurantSlug,
    openTenant.sessionId,
    { method: "PIX", idempotencyKey: randomUuid() },
    closedCookies
  );
  assert.equal(res.status, 404);
  const payload = (await res.json()) as { code?: string };
  assert.equal(payload.code, "SESSION_NOT_FOUND");
});

test("Session OPEN -> 409 SESSION_NOT_CLOSED", async () => {
  const res = await postPayment(
    openTenant.restaurantSlug,
    openTenant.sessionId,
    { method: "PIX", idempotencyKey: randomUuid() },
    openCookies
  );
  assert.equal(res.status, 409);
  const payload = (await res.json()) as { code?: string };
  assert.equal(payload.code, "SESSION_NOT_CLOSED");
});

test("payload válido -> 201 com amount/currency DERIVADOS e status PENDING", async () => {
  const res = await postPayment(
    closedTenant.restaurantSlug,
    closedTenant.sessionId,
    { method: "PIX", idempotencyKey: randomUuid() },
    closedCookies
  );
  assert.equal(res.status, 201);
  const payload = (await res.json()) as { payment: Record<string, unknown> };
  assert.equal(payload.payment.amount, "100.00");
  assert.equal(payload.payment.currency, "BRL");
  assert.equal(payload.payment.status, "PENDING");
  assert.equal(payload.payment.provider, "fake");
  assert.ok(String(payload.payment.providerPaymentId).startsWith("fake_"));
});

test("replay da MESMA idempotencyKey -> 200 com a MESMA tentativa", async () => {
  const replayTenant = await seedClosedSession();
  const replayCookies = await bootstrapOperatorFor(
    replayTenant.restaurantSlug,
    `smoke-replay-${randomUuid()}@example.com`
  );
  const key = randomUuid();
  const first = await postPayment(
    replayTenant.restaurantSlug,
    replayTenant.sessionId,
    { method: "CARD", idempotencyKey: key },
    replayCookies
  );
  assert.equal(first.status, 201);
  const firstBody = (await first.json()) as { payment: Record<string, string> };

  const second = await postPayment(
    replayTenant.restaurantSlug,
    replayTenant.sessionId,
    { method: "CARD", idempotencyKey: key },
    replayCookies
  );
  assert.equal(second.status, 200);
  const secondBody = (await second.json()) as { payment: Record<string, string> };
  assert.equal(secondBody.payment.id, firstBody.payment.id);
  assert.equal(secondBody.payment.providerPaymentId, firstBody.payment.providerPaymentId);
});

test("início após Session já paga -> 409 PAYMENT_ALREADY_PAID", async () => {
  const paidTenant = await seedClosedSession();
  const paidCookies = await bootstrapOperatorFor(
    paidTenant.restaurantSlug,
    `smoke-c-${randomUuid()}@example.com`
  );
  const first = await postPayment(
    paidTenant.restaurantSlug,
    paidTenant.sessionId,
    { method: "PIX", idempotencyKey: randomUuid() },
    paidCookies
  );
  assert.equal(first.status, 201);
  const pending = (await first.json()) as { payment: { id: string } };
  await prisma.payment.update({
    where: { id: pending.payment.id },
    data: { status: "PAID" },
  });
  const second = await postPayment(
    paidTenant.restaurantSlug,
    paidTenant.sessionId,
    { method: "PIX", idempotencyKey: randomUuid() },
    paidCookies
  );
  assert.equal(second.status, 409);
  const payload = (await second.json()) as { code?: string };
  assert.equal(payload.code, "PAYMENT_ALREADY_PAID");
});

test("integridade do snapshot CLOSED: corrupção -> 500 (jamais marca faturamento)", async () => {
  const corruptTenant = await seedClosedSession({
    subtotal: "100.00",
    serviceFeePercent: 0,
  });
  const corruptCookies = await bootstrapOperatorFor(
    corruptTenant.restaurantSlug,
    `smoke-corrupt-${randomUuid()}@example.com`
  );
  await prisma.tableSession.update({
    where: { id: corruptTenant.sessionId },
    data: { currencySnapshot: "XYZ" },
  });
  const res = await postPayment(
    corruptTenant.restaurantSlug,
    corruptTenant.sessionId,
    { method: "PIX", idempotencyKey: randomUuid() },
    corruptCookies
  );
  assert.equal(res.status, 500);
  await prisma.tableSession.update({
    where: { id: corruptTenant.sessionId },
    data: { currencySnapshot: "BRL" },
  });

  await prisma.tableSession.update({
    where: { id: corruptTenant.sessionId },
    data: { closedTotal: 999.99 },
  });
  const resClosed = await postPayment(
    corruptTenant.restaurantSlug,
    corruptTenant.sessionId,
    { method: "PIX", idempotencyKey: randomUuid() },
    corruptCookies
  );
  assert.equal(resClosed.status, 500);
  await prisma.tableSession.update({
    where: { id: corruptTenant.sessionId },
    data: { closedTotal: 100.0 },
  });
});

test("headers de segurança presentes e fingerprint mínimo (JUL-02)", async () => {
  const res = await postPayment(
    closedTenant.restaurantSlug,
    closedTenant.sessionId,
    { method: "PIX", idempotencyKey: randomUuid() },
    closedCookies
  );
  assert.ok(res.status === 201 || res.status === 409);
  assert.ok(res.headers.get("x-powered-by") === null, "X-Powered-By deve estar ausente");
  assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.match(res.headers.get("referrer-policy") ?? "", /strict-origin-when-cross-origin/);
});
