import { z } from "zod";

import { errorResponse } from "@/lib/public-api";
import { getOrCreateOpenSessionByQrToken } from "@/services/sessions";

const qrTokenSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9_-]+$/);

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ qrToken: string }> }
) {
  const { qrToken } = await params;

  const parsed = qrTokenSchema.safeParse(qrToken);
  if (!parsed.success) {
    return errorResponse(400, "Invalid table token");
  }

  let result: Awaited<ReturnType<typeof getOrCreateOpenSessionByQrToken>>;
  try {
    result = await getOrCreateOpenSessionByQrToken(parsed.data);
  } catch (error) {
    console.error("[session] failed to open session:", error);
    return errorResponse(500, "Internal server error");
  }

  if (result.outcome === "table-not-found") {
    return errorResponse(404, "Table not found");
  }
  if (result.outcome === "table-inactive") {
    return errorResponse(409, "Table is not active");
  }

  return Response.json(
    {
      session: {
        id: result.session.id,
        status: result.session.status,
        openedAt: result.session.openedAt,
      },
      table: {
        number: result.tableNumber,
      },
      restaurant: result.restaurant,
    },
    { status: result.outcome === "created" ? 201 : 200 }
  );
}