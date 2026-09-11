import { z } from "zod";

import { errorResponse, toRestaurantDto } from "@/lib/public-api";
import { getTableByQrToken } from "@/services/tables";

const qrTokenSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9_-]+$/);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ qrToken: string }> }
) {
  const { qrToken } = await params;

  const parsed = qrTokenSchema.safeParse(qrToken);
  if (!parsed.success) {
    return errorResponse(400, "Invalid table token");
  }

  const table = await getTableByQrToken(parsed.data);
  if (!table) {
    return errorResponse(404, "Table not found");
  }

  if (!table.active) {
    return errorResponse(409, "Table is not active");
  }

  return Response.json({
    restaurant: toRestaurantDto(table.restaurant),
    table: {
      id: table.id,
      number: table.number,
    },
  });
}