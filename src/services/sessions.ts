import { Prisma, SessionStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

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