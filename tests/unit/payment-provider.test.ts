import { test } from "node:test";
import { strict as assert } from "node:assert";

import { PaymentMethod, PaymentStatus } from "@/generated/prisma/client";
import {
  FAKE_EVENT_FAILED,
  FAKE_EVENT_PAID,
  FAKE_EVENT_PENDING,
  FakePaymentProvider,
} from "@/payment-provider/fake-provider";
import { getPaymentProvider, getWebhookEventMapper } from "@/payment-provider/registry";
import {
  ProviderAmbiguousError,
  ProviderDefinitiveError,
} from "@/payment-provider/types";

const baseInput = {
  internalPaymentId: "11111111-1111-1111-1111-111111111111",
  idempotencyKey: "22222222-2222-2222-2222-222222222222",
  amount: "120.98",
  currency: "BRL",
  method: PaymentMethod.PIX,
} as const;

test("FakePaymentProvider create: pending", async () => {
  const provider = new FakePaymentProvider({ kind: "pending" });
  const result = await provider.createPayment(baseInput);
  assert.equal(result.status, "pending");
  assert.ok(result.providerPaymentId.startsWith("fake_"));
});

test("FakePaymentProvider create: paid", async () => {
  const provider = new FakePaymentProvider({ kind: "paid" });
  const result = await provider.createPayment(baseInput);
  assert.equal(result.status, "paid");
  assert.ok(result.providerPaymentId.startsWith("fake_"));
});

test("FakePaymentProvider create: failed (resultado definitivo)", async () => {
  const provider = new FakePaymentProvider({
    kind: "failed",
    failureCode: "FAKE_DECLINE",
  });
  const result = await provider.createPayment(baseInput);
  assert.equal(result.status, "failed");
  assert.equal(result.failureCode, "FAKE_DECLINE");
});

test("FakePaymentProvider create: ambiguous lança ProviderAmbiguousError", async () => {
  const provider = new FakePaymentProvider({ kind: "ambiguous" });
  await assert.rejects(
    () => provider.createPayment(baseInput),
    (error: unknown) => error instanceof ProviderAmbiguousError
  );
});

test("FakePaymentProvider create: exceção inesperada NÃO é ProviderDefinitiveError", async () => {
  const provider = new FakePaymentProvider({ kind: "exception" });
  await assert.rejects(
    () => provider.createPayment(baseInput),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof ProviderDefinitiveError) &&
      !(error instanceof ProviderAmbiguousError)
  );
});

test("FakePaymentProvider create: definitive-error lança ProviderDefinitiveError (FAILED)", async () => {
  const provider = new FakePaymentProvider({
    kind: "definitive-error",
    failureCode: "CARD_DECLINED",
  });
  await assert.rejects(
    () => provider.createPayment(baseInput),
    (error: unknown) =>
      error instanceof ProviderDefinitiveError &&
      error.failureCode === "CARD_DECLINED"
  );
});

test("providerPaymentId determinístico único por internalPaymentId", async () => {
  const provider = new FakePaymentProvider({ kind: "pending" });
  const a = await provider.createPayment(baseInput);
  const b = await provider.createPayment({
    ...baseInput,
    internalPaymentId: "33333333-3333-3333-3333-333333333333",
  });
  assert.notEqual(a.providerPaymentId, b.providerPaymentId);
  assert.equal(
    a.providerPaymentId,
    `fake_${baseInput.internalPaymentId}`
  );
});

test("FakePaymentProvider getPaymentStatus: pending/paid/failed", async () => {
  const pending = new FakePaymentProvider(undefined, { kind: "pending" });
  assert.equal(
    (await pending.getPaymentStatus({ providerPaymentId: "p1" })).status,
    "pending"
  );
  const paid = new FakePaymentProvider(undefined, { kind: "paid" });
  assert.equal(
    (await paid.getPaymentStatus({ providerPaymentId: "p1" })).status,
    "paid"
  );
  const failed = new FakePaymentProvider(undefined, { kind: "failed", failureCode: "X" });
  const result = await failed.getPaymentStatus({ providerPaymentId: "p1" });
  assert.equal(result.status, "failed");
  assert.equal(result.failureCode, "X");
});

test("FakePaymentProvider getPaymentStatus: ambiguous lança ambiguidade", async () => {
  const provider = new FakePaymentProvider(undefined, { kind: "ambiguous" });
  await assert.rejects(
    () => provider.getPaymentStatus({ providerPaymentId: "p1" }),
    (error: unknown) => error instanceof ProviderAmbiguousError
  );
});

test("mapWebhookEventType: eventos fake conhecidos e ruído", () => {
  const provider = new FakePaymentProvider();
  assert.equal(provider.mapWebhookEventType(FAKE_EVENT_PENDING), PaymentStatus.PENDING);
  assert.equal(provider.mapWebhookEventType(FAKE_EVENT_PAID), PaymentStatus.PAID);
  assert.equal(provider.mapWebhookEventType(FAKE_EVENT_FAILED), PaymentStatus.FAILED);
  assert.equal(provider.mapWebhookEventType("charge.created"), null);
  assert.equal(provider.mapWebhookEventType(""), null);
});

test("status mapping (seção 9): provider tem dezenas, JULLY no máximo 4", () => {
  const provider = new FakePaymentProvider();
  const known = [FAKE_EVENT_PENDING, FAKE_EVENT_PAID, FAKE_EVENT_FAILED];
  const mapped = known
    .map((t) => provider.mapWebhookEventType(t))
    .filter((s): s is "PENDING" | "PAID" | "FAILED" => s !== null);
  if (mapped.length === 0) {
    assert.fail("nenhum evento fake conhecido mapeado");
  }
  for (const status of mapped) {
    assert.ok(
      [PaymentStatus.PENDING, PaymentStatus.PAID, PaymentStatus.FAILED].includes(status)
    );
  }
});

test("registry: fake resolvível fora de produção", () => {
  const provider = getPaymentProvider("fake");
  assert.ok(provider instanceof FakePaymentProvider);
});

const envProxy = process.env as { NODE_ENV?: string };

test("registry: fake BLOQUEADO em produção", () => {
  const original = envProxy.NODE_ENV;
  envProxy.NODE_ENV = "production";
  try {
    assert.equal(getPaymentProvider("fake"), null);
    assert.equal(getWebhookEventMapper("fake"), null);
  } finally {
    envProxy.NODE_ENV = original;
  }
});

test("registry: provider desconhecido não resolve", () => {
  assert.equal(getPaymentProvider("stripe"), null);
  assert.equal(getPaymentProvider("mercado-pago"), null);
});

test("registry: event mapper de provider fake disponível fora de produção", () => {
  const mapper = getWebhookEventMapper("fake");
  assert.ok(mapper);
  assert.equal(mapper!(FAKE_EVENT_PAID), PaymentStatus.PAID);
});