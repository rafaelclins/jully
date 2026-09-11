import { Prisma, SessionStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { getTableByQrToken } from "@/services/tables";

export const sessionPublicSelect = {
  id: true,
  tableId: true,
  status: true,
  openedAt: true,
  closedAt: true,
} satisfies Prisma.SessionSelect;

export type SessionPublic = Prisma.SessionGetPayload<{
  select: typeof sessionPublicSelect;
}>;

export async function getOpenSessionByTable({
  restaurantId,
  tableId,
}: {
  restaurantId: string;
  tableId: string;
}): Promise<SessionPublic | null> {
  return prisma.session.findFirst({
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
  return prisma.session.findFirst({
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

export async function getOrCreateOpenSessionForTable({
  restaurantId,
  tableId,
}: {
  restaurantId: string;
  tableId: string;
}): Promise<{ session: SessionPublic; created: boolean }> {
  const existing = await getOpenSessionByTable({ restaurantId, tableId });
  if (existing) {
    return { session: existing, created: false };
  }

  try {
    const session = await prisma.session.create({
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
      const conflicting = await getOpenSessionByTable({ restaurantId, tableId });
      if (conflicting) {
        return { session: conflicting, created: false };
      }
    }
    throw error;
  }
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