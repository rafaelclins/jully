import { MembershipRole, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

export const membershipSelect = {
  id: true,
  userId: true,
  restaurantId: true,
  role: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.RestaurantMembershipSelect;

export type Membership = Prisma.RestaurantMembershipGetPayload<{
  select: typeof membershipSelect;
}>;

// Membership exitente entre um usuario e um restaurante. Unico pelo par
// (userId, restaurantId) no banco (constraint @@unique).
export async function getMembershipByUserAndRestaurant({
  userId,
  restaurantId,
}: {
  userId: string;
  restaurantId: string;
}): Promise<Membership | null> {
  return prisma.restaurantMembership.findUnique({
    where: { userId_restaurantId: { userId, restaurantId } },
    select: membershipSelect,
  });
}

export async function listMembershipRestaurantsForUser(
  userId: string
): Promise<
  {
    role: Membership["role"];
    restaurant: { id: string; name: string; slug: string };
  }[]
> {
  return prisma.restaurantMembership.findMany({
    where: { userId },
    select: {
      role: true,
      restaurant: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
    },
    orderBy: [{ createdAt: "asc" }],
  });
}

export { MembershipRole };
