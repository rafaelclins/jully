import { randomUUID } from "node:crypto";

import { OrderStatus, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { getOrCreateOpenSessionForTable } from "@/services/sessions";
import { closeSession } from "@/services/sessions";
import { createPayment, paymentSelect, toPaymentDto, type PaymentDto } from "@/services/payments";
import { updateOrderStatus } from "@/services/orders";

// ---------- Helpers de banco p/ integração/teste (jully_test) ----------
// Fixtures criadas via serviços de domínio (não SQL cru) sempre que possível.
// O banco de testes é isolado (jully_test) e truncado por arquivo de teste.

function randomId(): string {
  return randomUUID().replace(/-/g, "");
}

export function randomUuid(): string {
  return randomUUID();
}

export async function resetDatabase(): Promise<void> {
  const candidates = [
    "payment_webhook_events",
    "payments",
    "order_items",
    "orders",
    "sessions",
    "tables",
    "categories",
    "products",
    "restaurant_memberships",
    "restaurants",
    "verification",
    "account",
    "session",
    "user",
  ];
  const existing: string[] = [];
  for (const table of candidates) {
    const rows = await prisma.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT COUNT(*)::int AS n FROM pg_tables
      WHERE schemaname = 'public' AND tablename = ${table}
    `);
    if (rows[0].n === 1) {
      existing.push(`"${table}"`);
    }
  }
  if (existing.length > 0) {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${existing.join(", ")} RESTART IDENTITY CASCADE`
    );
  }
}

export type SeedOptions = {
  subtotal: string;
  serviceFeePercent: number;
  currency: string;
};

export type SeededTenant = {
  restaurantId: string;
  restaurantSlug: string;
  tableId: string;
  tableNumber: number;
  qrToken: string;
  sessionId: string;
  currency: string;
  closedTotal: string;
  serviceFeePercentSnapshot: string;
};

// Restaurante + mesa + Session OPEN + pedido READY + Session CLOSED com
// snapshots financeiros (amount = subtotal + taxa). Recomendada para testes de
// pagamento: use subtotal "109.98", fee 10 -> closedTotal "120.98".
export async function seedClosedSession(
  opts?: Partial<SeedOptions>
): Promise<SeededTenant> {
  const subtotal = opts?.subtotal ?? "100.00";
  const serviceFeePercent = opts?.serviceFeePercent ?? 0;
  const currency = opts?.currency ?? "BRL";

  const slug = `r-${randomId()}`;
  const restaurant = await prisma.restaurant.create({
    data: {
      name: slug,
      slug,
      currency,
      serviceFeePercent,
    },
  });

  const tableNumber = 1 + Math.floor(Math.random() * 1000);
  const qrToken = `t${randomUuid()}`;
  const table = await prisma.table.create({
    data: {
      restaurantId: restaurant.id,
      number: tableNumber,
      qrToken,
    },
  });

  const category = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: "Cat" },
  });
  const product = await prisma.product.create({
    data: {
      categoryId: category.id,
      restaurantId: restaurant.id,
      name: "Item",
      price: new Prisma.Decimal(subtotal),
    },
  });

  const { session } = await getOrCreateOpenSessionForTable({
    restaurantId: restaurant.id,
    tableId: table.id,
  });

  const order = await prisma.order.create({
    data: {
      sessionId: session.id,
      restaurantId: restaurant.id,
      idempotencyKey: randomUuid(),
      requestFingerprint: `fixture-${randomUuid()}`,
      status: OrderStatus.PENDING,
    },
  });
  await prisma.orderItem.createMany({
    data: [
      {
        orderId: order.id,
        productId: product.id,
        restaurantId: restaurant.id,
        productName: "Item",
        unitPrice: new Prisma.Decimal(subtotal),
        quantity: 1,
        subtotal: new Prisma.Decimal(subtotal),
      },
    ],
  });

  // O fechamento só aceita sessão sem pedidos PENDING/PREPARING: leva o pedido
  // ao estado READY pela própria máquina de estados do domínio.
  const first = await updateOrderStatus({
    restaurantId: restaurant.id,
    orderId: order.id,
    status: OrderStatus.PREPARING,
  });
  if (first.outcome !== "updated") {
    throw new Error(`seed: PREPARING transition failed (${first.outcome})`);
  }
  const second = await updateOrderStatus({
    restaurantId: restaurant.id,
    orderId: order.id,
    status: OrderStatus.READY,
  });
  if (second.outcome !== "updated") {
    throw new Error(`seed: READY transition failed (${second.outcome})`);
  }

  const closed = await closeSession({
    restaurantId: restaurant.id,
    sessionId: session.id,
  });
  if (closed.outcome !== "closed") {
    throw new Error(`seed: closeSession failed (${closed.outcome})`);
  }

  return {
    restaurantId: restaurant.id,
    restaurantSlug: slug,
    tableId: table.id,
    tableNumber,
    qrToken,
    sessionId: session.id,
    currency,
    closedTotal: closed.summary.total,
    serviceFeePercentSnapshot: closed.summary.serviceFeePercent,
  };
}

// Tenant com Session ainda OPEN (não fecha): teste "Session OPEN não paga".
export async function seedOpenSession(opts?: {
  currency?: string;
}): Promise<SeededTenant> {
  const currency = opts?.currency ?? "BRL";
  const slug = `r-${randomId()}`;
  const restaurant = await prisma.restaurant.create({
    data: { name: slug, slug, currency },
  });
  const qrToken = `t${randomUuid()}`;
  const table = await prisma.table.create({
    data: { restaurantId: restaurant.id, number: 1, qrToken },
  });
  const { session } = await getOrCreateOpenSessionForTable({
    restaurantId: restaurant.id,
    tableId: table.id,
  });
  return {
    restaurantId: restaurant.id,
    restaurantSlug: slug,
    tableId: table.id,
    tableNumber: 1,
    qrToken,
    sessionId: session.id,
    currency,
    closedTotal: "",
    serviceFeePercentSnapshot: "",
  };
}

// Tentativa PENDING gravada com provider + providerPaymentId (pré-condição de
// webhook/reconciliação). Usa o serviço de domínio createPayment e depois
// grava o id do provider (mesma jornada da integração futura).
export async function seedPaymentPendingWithProvider(
  tenant: Pick<SeededTenant, "restaurantId" | "sessionId">,
  opts?: {
    idempotencyKey?: string;
    provider?: string;
    providerPaymentId?: string;
  }
): Promise<PaymentDto> {
  const { provider = "fake", providerPaymentId } = opts ?? {};
  const key = opts?.idempotencyKey ?? randomUuid();
  const result = await createPayment({
    restaurantId: tenant.restaurantId,
    sessionId: tenant.sessionId,
    idempotencyKey: key,
    provider,
  });
  if (result.outcome !== "created" && result.outcome !== "replayed") {
    throw new Error(`seedPaymentPendingWithProvider failed: ${result.outcome}`);
  }
  if (providerPaymentId) {
    const updated = await prisma.payment.update({
      where: { id: result.payment.id },
      data: { providerPaymentId },
      select: paymentSelect,
    });
    return toPaymentDto(updated);
  }
  return result.payment;
}