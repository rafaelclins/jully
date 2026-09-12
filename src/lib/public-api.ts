import { Prisma } from "@/generated/prisma/client";
import type { RestaurantPublic } from "@/services/restaurants";

export function decimalToString(value: Prisma.Decimal): string {
  return value.toFixed(2);
}

export type RestaurantDto = {
  id: string;
  name: string;
  slug: string;
  currency: string;
  logo: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  serviceFeePercent: string;
};

export function toRestaurantDto(
  restaurant: RestaurantPublic
): RestaurantDto {
  return {
    id: restaurant.id,
    name: restaurant.name,
    slug: restaurant.slug,
    currency: restaurant.currency,
    logo: restaurant.logo,
    primaryColor: restaurant.primaryColor,
    secondaryColor: restaurant.secondaryColor,
    serviceFeePercent: decimalToString(restaurant.serviceFeePercent),
  };
}

export function errorResponse(
  status: number,
  message: string,
  code?: string
): Response {
  return Response.json(
    code ? { error: message, code } : { error: message },
    { status }
  );
}