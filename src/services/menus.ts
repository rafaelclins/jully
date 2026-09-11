import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

export const activeMenuCategorySelect = {
  id: true,
  name: true,
  position: true,
  products: {
    select: {
      id: true,
      name: true,
      description: true,
      price: true,
      image: true,
    },
    where: { active: true },
    orderBy: { name: "asc" },
  },
} satisfies Prisma.CategorySelect;

export type ActiveMenuCategory = Prisma.CategoryGetPayload<{
  select: typeof activeMenuCategorySelect;
}>;

export async function getActiveMenuByRestaurantId(
  restaurantId: string
): Promise<ActiveMenuCategory[]> {
  return prisma.category.findMany({
    where: { restaurantId, active: true },
    select: activeMenuCategorySelect,
    orderBy: { position: "asc" },
  });
}