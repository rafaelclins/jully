import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

export const tablePublicSelect = {
  id: true,
  number: true,
  qrToken: true,
  active: true,
} satisfies Prisma.TableSelect;

export type TablePublic = Prisma.TableGetPayload<{
  select: typeof tablePublicSelect;
}>;

export const tableWithRestaurantSelect = {
  id: true,
  number: true,
  qrToken: true,
  active: true,
  restaurant: {
    select: {
      id: true,
      name: true,
      slug: true,
      logo: true,
      primaryColor: true,
      secondaryColor: true,
      address: true,
      serviceFeePercent: true,
    },
  },
} satisfies Prisma.TableSelect;

export type TableWithRestaurant = Prisma.TableGetPayload<{
  select: typeof tableWithRestaurantSelect;
}>;

export async function getTableByQrToken(
  qrToken: string
): Promise<TableWithRestaurant | null> {
  return prisma.table.findUnique({
    where: { qrToken },
    select: tableWithRestaurantSelect,
  });
}

export async function getTableById({
  restaurantId,
  tableId,
}: {
  restaurantId: string;
  tableId: string;
}): Promise<TablePublic | null> {
  return prisma.table.findFirst({
    where: { id: tableId, restaurantId },
    select: tablePublicSelect,
  });
}

export async function listTablesByRestaurant(
  restaurantId: string
): Promise<TablePublic[]> {
  return prisma.table.findMany({
    where: { restaurantId },
    select: tablePublicSelect,
    orderBy: { number: "asc" },
  });
}