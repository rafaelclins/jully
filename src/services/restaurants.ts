import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

export const restaurantPublicSelect = {
  id: true,
  name: true,
  slug: true,
  currency: true,
  logo: true,
  primaryColor: true,
  secondaryColor: true,
  address: true,
  serviceFeePercent: true,
} satisfies Prisma.RestaurantSelect;

export type RestaurantPublic = Prisma.RestaurantGetPayload<{
  select: typeof restaurantPublicSelect;
}>;

export async function getRestaurantById(
  restaurantId: string
): Promise<RestaurantPublic | null> {
  return prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: restaurantPublicSelect,
  });
}

export async function getRestaurantBySlug(
  slug: string
): Promise<RestaurantPublic | null> {
  return prisma.restaurant.findUnique({
    where: { slug },
    select: restaurantPublicSelect,
  });
}