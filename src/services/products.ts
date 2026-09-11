import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

export const productPublicSelect = {
  id: true,
  categoryId: true,
  name: true,
  description: true,
  price: true,
  image: true,
  active: true,
} satisfies Prisma.ProductSelect;

export type ProductPublic = Prisma.ProductGetPayload<{
  select: typeof productPublicSelect;
}>;

export async function listActiveProductsByRestaurant(
  restaurantId: string,
  categoryId?: string
): Promise<ProductPublic[]> {
  return prisma.product.findMany({
    where: {
      restaurantId,
      active: true,
      ...(categoryId ? { categoryId } : {}),
    },
    select: productPublicSelect,
    orderBy: { name: "asc" },
  });
}

export async function getProductById({
  restaurantId,
  productId,
}: {
  restaurantId: string;
  productId: string;
}): Promise<ProductPublic | null> {
  return prisma.product.findFirst({
    where: { id: productId, restaurantId },
    select: productPublicSelect,
  });
}