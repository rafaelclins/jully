import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

export const categoryPublicSelect = {
  id: true,
  name: true,
  position: true,
  active: true,
} satisfies Prisma.CategorySelect;

export type CategoryPublic = Prisma.CategoryGetPayload<{
  select: typeof categoryPublicSelect;
}>;

export async function listActiveCategoriesByRestaurant(
  restaurantId: string
): Promise<CategoryPublic[]> {
  return prisma.category.findMany({
    where: { restaurantId, active: true },
    select: categoryPublicSelect,
    orderBy: { position: "asc" },
  });
}