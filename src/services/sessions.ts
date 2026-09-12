import {
  OrderStatus,
  Prisma,
  SessionStatus,
} from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { getRestaurantById } from "@/services/restaurants";
import { getTableByQrToken } from "@/services/tables";

// ---------- Etapa 12: resumo da mesa e fechamento da Session ----------

// Pedidos que entram no resumo financeiro (CANCELLED fica de fora).
export const FINANCIAL_ORDER_STATUSES = [
  OrderStatus.PENDING,
  OrderStatus.PREPARING,
  OrderStatus.READY,
] as const;

export const FINANCIAL_ORDER_STATUS_LIST: OrderStatus[] = [
  ...FINANCIAL_ORDER_STATUSES,
];

// Politica de arredondamento monetario (documentada na Etapa 12):
//   - subtotal : soma exata dos OrderItem.subtotal (decimais de 2 casas).
//   - taxa     : subtotal * serviceFeePercent / 100, arredondada com
//                ROUND_HALF_UP para 2 casas decimais.
//   - total    : subtotal + taxa arredondada (soma exata, sem novo rounding).
// Nunca Float: todo calculo usa Prisma.Decimal.
export const SERVICE_FEE_ROUNDING = Prisma.Decimal.ROUND_HALF_UP;

// Erro de dominio: Session CLOSED sem snapshots financeiros completos.
// Indica corrupcao/legado; a aplicacao NAO pode fabricar um historico
// financeiro a partir de dados vivos. As rotas convertem em erro interno
// generico (500), sem expor constraint/SQL/stack trace ao cliente.
export class SessionSummaryIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionSummaryIntegrityError";
  }
}

const summarySessionSelect = {
  id: true,
  status: true,
  openedAt: true,
  closedAt: true,
  // Snapshots financeiros (Etapa 14): NULL enquanto OPEN; preenchidos e
  // imutaveis a partir do fechamento.
  closedSubtotal: true,
  serviceFeePercentSnapshot: true,
  closedServiceFeeAmount: true,
  closedTotal: true,
  table: { select: { id: true, number: true } },
} satisfies Prisma.TableSessionSelect;

const summaryOrderSelect = {
  id: true,
  status: true,
  createdAt: true,
  items: {
    select: {
      id: true,
      productName: true,
      unitPrice: true,
      quantity: true,
      subtotal: true,
    },
    orderBy: { productName: "asc" },
  },
} satisfies Prisma.OrderSelect;

export type SessionSummaryDto = {
  session: {
    id: string;
    status: string;
    openedAt: string;
    closedAt: string | null;
  };
  table: { id: string; number: number };
  restaurant: { id: string; name: string; slug: string };
  orders: {
    id: string;
    status: string;
    createdAt: string;
    subtotal: string;
    items: {
      id: string;
      productName: string;
      unitPrice: string;
      quantity: number;
      subtotal: string;
    }[];
  }[];
  subtotal: string;
  serviceFeePercent: string;
  serviceFeeAmount: string;
  total: string;
};

type SummarySessionRow = Prisma.TableSessionGetPayload<{
  select: typeof summarySessionSelect;
}>;

function sumOrderItemsSubtotal(
  orders: Prisma.OrderGetPayload<{ select: typeof summaryOrderSelect }>[]
): Prisma.Decimal {
  return orders.reduce(
    (acc, order) =>
      order.items.reduce(
        (itemsAcc, item) => itemsAcc.add(item.subtotal),
        acc
      ),
    new Prisma.Decimal(0)
  );
}

function buildSummaryDto(
  session: SummarySessionRow,
  restaurant: NonNullable<Awaited<ReturnType<typeof getRestaurantById>>>,
  orders: Prisma.OrderGetPayload<{ select: typeof summaryOrderSelect }>[]
): SessionSummaryDto {
  const orderDtos = orders.map((order) => {
    const orderSubtotal = order.items.reduce(
      (acc, item) => acc.add(item.subtotal),
      new Prisma.Decimal(0)
    );
    return {
      id: order.id,
      status: order.status,
      createdAt: order.createdAt.toISOString(),
      subtotal: orderSubtotal.toFixed(2),
      items: order.items.map((item) => ({
        id: item.id,
        productName: item.productName,
        unitPrice: item.unitPrice.toFixed(2),
        quantity: item.quantity,
        subtotal: item.subtotal.toFixed(2),
      })),
    };
  });

  // Financeiro:
  //   - Session OPEN: estimativa viva (subtotal dos OrderItem historicos +
  //     taxa atual do Restaurant). Snapshots sao NULL.
  //   - Session CLOSED: exclusivamente os snapshots gravados no fechamento.
  //     NUNCA recalcula com configuracao/dados atuais. Se algum snapshot
  //     estiver NULL (base legada pre-CHECK, restauracao corrompida, SQL
  //     manual), e violacao de integridade: lanca SessionSummaryIntegrityError
  //     em vez de transformar dado corrompido em valor financeiro aparentemente
  //     valido (nunca responde 200 com valores estimados).
  let subtotal: Prisma.Decimal;
  let serviceFeePercent: Prisma.Decimal;
  let serviceFeeAmount: Prisma.Decimal;
  let total: Prisma.Decimal;

  if (session.status === SessionStatus.CLOSED) {
    if (
      session.closedSubtotal === null ||
      session.serviceFeePercentSnapshot === null ||
      session.closedServiceFeeAmount === null ||
      session.closedTotal === null
    ) {
      throw new SessionSummaryIntegrityError(
        `session ${session.id} is CLOSED but financial snapshot is incomplete`
      );
    }
    subtotal = session.closedSubtotal;
    serviceFeePercent = session.serviceFeePercentSnapshot;
    serviceFeeAmount = session.closedServiceFeeAmount;
    total = session.closedTotal;
  } else {
    subtotal = sumOrderItemsSubtotal(orders);
    serviceFeePercent = restaurant.serviceFeePercent;
    serviceFeeAmount = subtotal
      .mul(serviceFeePercent)
      .div(100)
      .toDecimalPlaces(2, SERVICE_FEE_ROUNDING);
    total = subtotal.add(serviceFeeAmount);
  }

  return {
    session: {
      id: session.id,
      status: session.status,
      openedAt: session.openedAt.toISOString(),
      closedAt: session.closedAt?.toISOString() ?? null,
    },
    table: { id: session.table.id, number: session.table.number },
    restaurant: {
      id: restaurant.id,
      name: restaurant.name,
      slug: restaurant.slug,
    },
    orders: orderDtos,
    subtotal: subtotal.toFixed(2),
    serviceFeePercent: serviceFeePercent.toFixed(2),
    serviceFeeAmount: serviceFeeAmount.toFixed(2),
    total: total.toFixed(2),
  };
}

// Tenant-scoped: a Session so existe para o operador se pertence ao
// restaurantId autorizado. Fora do tenant -> null (404 SESSION_NOT_FOUND),
// sem revelar que a Session existe em outro restaurante.
export async function getSessionSummary({
  restaurantId,
  sessionId,
}: {
  restaurantId: string;
  sessionId: string;
}): Promise<SessionSummaryDto | null> {
  const session = await prisma.tableSession.findFirst({
    where: { id: sessionId, restaurantId },
    select: summarySessionSelect,
  });
  if (!session) {
    return null;
  }

  const restaurant = await getRestaurantById(restaurantId);
  if (!restaurant) {
    return null;
  }

  const orders = await prisma.order.findMany({
    where: {
      sessionId,
      restaurantId,
      status: { in: FINANCIAL_ORDER_STATUS_LIST },
    },
    select: summaryOrderSelect,
    orderBy: { createdAt: "asc" },
  });

  return buildSummaryDto(session, restaurant, orders);
}

export type CloseSessionResult =
  | { outcome: "closed" | "already-closed"; summary: SessionSummaryDto }
  | { outcome: "not-found" }
  | { outcome: "has-orders-in-progress" };

// Fechamento idempotente e concorrente-seguro.
//
// Serializacao: criacao de pedido e fechamento de mesa participam do MESMO
// protocolo de lock por mesa. Antes da Etapa 13, cada fluxo usava um lock
// proprio (o create nao travava nada; o close travava so a linha da Session),
// permitindo a corrida: create lia a Session OPEN, close fechava a mesa, e o
// create commitava um Order PENDING numa Session ja CLOSED.
//
// Protocolo atual: dentro da transacao, a linha da Tabela da Session e travada
// com SELECT ... FOR UPDATE (mesma regiao que a criacao de pedido). Depois de
// travar a tabela, o estado da Session e relido (nao mais reutiliza estado
// lido fora do lock). Com isso:
//   - close vence: Session vira CLOSED e o create que estava serializado apos
//     encontra apenas OPEN resolver/criar uma NOVA Session;
//   - pedido vence: o close relido apos o lock ve a Order PENDING/PREPARING e
//     responde 409 (has-orders-in-progress).
// Invariante garantida: nenhuma Session CLOSED possui Order PENDING/PREPARING
// criada depois do seu fechamento.
//
// Idempotencia do close: dois operadores fechando a mesma mesa: o primeiro
// marca CLOSED e faz commit; o segundo (serializado no lock da tabela) reler a
// Session ja CLOSED e responde "already-closed" com o MESMO resumo/closedAt.
// So fecha com status OPEN e sem Order PENDING/PREPARING (READY/CANCELLED nao
// bloqueiam). A rejeicao e atomica com a mudanca de estado (mesma transacao).
//
// Etapa 14: o fechamento grava atomicamente, na MESMA transacao e dentro do
// lock da Tabela, os snapshots financeiros (closedSubtotal,
// serviceFeePercentSnapshot, closedServiceFeeAmount e closedTotal). A partir
// de CLOSED o resumo e imutavel: a configuracao atual do Restaurant e o
// Product atual NAO influenciam mais o total historico.
export async function closeSession({
  restaurantId,
  sessionId,
}: {
  restaurantId: string;
  sessionId: string;
}): Promise<CloseSessionResult> {
  const outcome = await prisma.$transaction(async (tx) => {
    const resolved = await tx.$queryRaw<{ tableId: string }[]>(
      Prisma.sql`
        SELECT "tableId" FROM "sessions"
        WHERE "id" = ${sessionId}::uuid
          AND "restaurantId" = ${restaurantId}::uuid
      `
    );
    if (resolved.length === 0) {
      return { outcome: "not-found" } as const;
    }

    // Regiao de serializacao compartilhada com a criacao de pedido: lock na
    // linha da Tabela (um so fluxo de escrita por mesa por vez).
    await tx.$queryRaw(
      Prisma.sql`
        SELECT "id" FROM "tables"
        WHERE "id" = ${resolved[0].tableId}::uuid
          AND "restaurantId" = ${restaurantId}::uuid
        FOR UPDATE
      `
    );

    // Estado relido dentro da regiao serializada: nao reutilizar a leitura
    // feita antes do lock.
    const rows = await tx.$queryRaw<{ status: string }[]>(
      Prisma.sql`
        SELECT "status" FROM "sessions"
        WHERE "id" = ${sessionId}::uuid
          AND "restaurantId" = ${restaurantId}::uuid
      `
    );
    if (rows.length === 0) {
      return { outcome: "not-found" } as const;
    }
    if (rows[0].status === SessionStatus.CLOSED) {
      return { outcome: "already-closed" } as const;
    }

    const blockers = await tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`
        SELECT "id" FROM "orders"
        WHERE "sessionId" = ${sessionId}::uuid
          AND "restaurantId" = ${restaurantId}::uuid
          AND CAST("status" AS text)
            IN (${OrderStatus.PENDING}, ${OrderStatus.PREPARING})
        LIMIT 1
      `
    );
    if (blockers.length > 0) {
      return { outcome: "has-orders-in-progress" as const };
    }

    // ---------- Etapa 14: snapshot financeiro imutavel do fechamento ----------
    // Tudo acontece DENTRO da mesma transacao (regiao serializada pelo lock da
    // Tabela): a configuracao atual do Restaurant e lida aqui, o subtotal
    // historico e calculado dos OrderItem.values, e os quatro snapshots sao
    // persistidos atomicamente junto com status=CLOSED + closedAt.
    // Ou tudo fecha, ou nada fecha: nao ha gravacao financeira posterior.

    // 1) subtotal historico: soma exata dos OrderItem.subtotal dos pedidos
    //    financeiros (PENDING/PREPARING/READY); CANCELLED fica de fora.
    const financialOrders = await tx.order.findMany({
      where: {
        sessionId,
        restaurantId,
        status: { in: FINANCIAL_ORDER_STATUS_LIST },
      },
      select: { items: { select: { subtotal: true } } },
    });
    let closedSubtotal = new Prisma.Decimal(0);
    for (const order of financialOrders) {
      for (const item of order.items) {
        closedSubtotal = closedSubtotal.add(item.subtotal);
      }
    }

    // 2) taxa: percentual atual do restaurante neste instante (unico momento
    //    em que a configuracao atual influencia o fechamento).
    const restaurant = await tx.restaurant.findFirst({
      where: { id: restaurantId },
      select: { serviceFeePercent: true },
    });
    if (!restaurant) {
      return { outcome: "not-found" as const };
    }
    const serviceFeePercentSnapshot = restaurant.serviceFeePercent;

    // 3) ROUND_HALF_UP de 2 casas sobre subtotal * percent/100 (nunca Float).
    const closedServiceFeeAmount = closedSubtotal
      .mul(serviceFeePercentSnapshot)
      .div(100)
      .toDecimalPlaces(2, SERVICE_FEE_ROUNDING);
    const closedTotal = closedSubtotal.add(closedServiceFeeAmount);

    const closedAt = new Date();
    await tx.tableSession.update({
      where: { id: sessionId },
      data: {
        status: SessionStatus.CLOSED,
        closedAt,
        closedSubtotal,
        serviceFeePercentSnapshot,
        closedServiceFeeAmount,
        closedTotal,
      },
    });
    return { outcome: "closed" as const };
  });

  if (outcome.outcome === "not-found") {
    return outcome;
  }
  if (outcome.outcome === "has-orders-in-progress") {
    return outcome;
  }

  const summary = await getSessionSummary({ restaurantId, sessionId });
  if (!summary) {
    return { outcome: "not-found" };
  }
  return { outcome: outcome.outcome, summary };
}

export const sessionPublicSelect = {
  id: true,
  tableId: true,
  status: true,
  openedAt: true,
  closedAt: true,
} satisfies Prisma.TableSessionSelect;

export type SessionPublic = Prisma.TableSessionGetPayload<{
  select: typeof sessionPublicSelect;
}>;

export async function getOpenSessionByTable({
  restaurantId,
  tableId,
}: {
  restaurantId: string;
  tableId: string;
}): Promise<SessionPublic | null> {
  return prisma.tableSession.findFirst({
    where: { restaurantId, tableId, status: SessionStatus.OPEN },
    select: sessionPublicSelect,
  });
}

export async function getSessionById({
  restaurantId,
  sessionId,
}: {
  restaurantId: string;
  sessionId: string;
}): Promise<SessionPublic | null> {
  return prisma.tableSession.findFirst({
    where: { id: sessionId, restaurantId },
    select: sessionPublicSelect,
  });
}

export type OpenSessionResult =
  | {
      outcome: "created" | "existing";
      session: SessionPublic;
      tableNumber: number;
      restaurant: { slug: string; name: string };
    }
  | { outcome: "table-not-found" }
  | { outcome: "table-inactive" };

type TableSessionClient = Prisma.TransactionClient | typeof prisma;

// Resolver/criar a Session OPEN de uma mesa, operando sobre um client
// arbitrario (o prisma global ou uma transacao). A criacao de pedido usa a
// variante de transacao: resolve a Session DENTRO da regiao serializada pelo
// lock da Tabela, garantindo que nunca reutiliza uma Session ja fechada.
// A variante global mantem o P2002 da indice unico parcial
// (sessions_one_open_per_table) como rede de seguranca para produtores que
// nao participam do lock (ex.: endpoint publico de abertura de sessao).
export async function getOrCreateOpenSessionForTableWithClient(
  db: TableSessionClient,
  { restaurantId, tableId }: { restaurantId: string; tableId: string }
): Promise<{ session: SessionPublic; created: boolean }> {
  const existing = await db.tableSession.findFirst({
    where: { restaurantId, tableId, status: SessionStatus.OPEN },
    select: sessionPublicSelect,
  });
  if (existing) {
    return { session: existing, created: false };
  }

  try {
    const session = await db.tableSession.create({
      data: {
        restaurantId,
        tableId,
        status: SessionStatus.OPEN,
      },
      select: sessionPublicSelect,
    });
    return { session, created: true };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const conflicting = await db.tableSession.findFirst({
        where: { restaurantId, tableId, status: SessionStatus.OPEN },
        select: sessionPublicSelect,
      });
      if (conflicting) {
        return { session: conflicting, created: false };
      }
    }
    throw error;
  }
}

export async function getOrCreateOpenSessionForTable({
  restaurantId,
  tableId,
}: {
  restaurantId: string;
  tableId: string;
}): Promise<{ session: SessionPublic; created: boolean }> {
  return getOrCreateOpenSessionForTableWithClient(prisma, {
    restaurantId,
    tableId,
  });
}

export async function getOrCreateOpenSessionByQrToken(
  qrToken: string
): Promise<OpenSessionResult> {
  const table = await getTableByQrToken(qrToken);
  if (!table) {
    return { outcome: "table-not-found" };
  }
  if (!table.active) {
    return { outcome: "table-inactive" };
  }

  const { session, created } = await getOrCreateOpenSessionForTable({
    restaurantId: table.restaurant.id,
    tableId: table.id,
  });

  return {
    outcome: created ? "created" : "existing",
    session,
    tableNumber: table.number,
    restaurant: { slug: table.restaurant.slug, name: table.restaurant.name },
  };
}