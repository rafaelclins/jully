import { z } from "zod";

import { errorResponse } from "@/lib/public-api";
import { createOrderForTableQrToken } from "@/services/orders";

const qrTokenSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9_-]+$/);

const orderItemSchema = z
  .object({
    productId: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9-]+$/),
    quantity: z.number().int().min(1).max(99),
  })
  .strict();

const createOrderBodySchema = z
  .object({
    items: z.array(orderItemSchema).min(1).max(50),
  })
  .strict();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ qrToken: string }> }
) {
  const { qrToken } = await params;

  const parsedToken = qrTokenSchema.safeParse(qrToken);
  if (!parsedToken.success) {
    return errorResponse(400, "Invalid table token");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const parsedBody = createOrderBodySchema.safeParse(body);
  if (!parsedBody.success) {
    return errorResponse(400, "Invalid order payload");
  }

  let result: Awaited<
    ReturnType<typeof createOrderForTableQrToken>
  >;
  try {
    result = await createOrderForTableQrToken(
      parsedToken.data,
      parsedBody.data.items
    );
  } catch (error) {
    console.error("[order] failed to create order:", error);
    return errorResponse(500, "Internal server error");
  }

  switch (result.outcome) {
    case "table-not-found":
      return errorResponse(404, "Table not found", "TABLE_NOT_FOUND");
    case "table-inactive":
      return errorResponse(
        409,
        "Table is not active",
        "TABLE_INACTIVE"
      );
    case "menu-changed":
      return errorResponse(
        409,
        "Menu changed. Review your cart and try again.",
        "MENU_CHANGED"
      );
    case "quantity-over-limit":
      return errorResponse(
        400,
        "Item quantity exceeds the allowed limit",
        "QUANTITY_OVER_LIMIT"
      );
    case "created":
      return Response.json({ order: result.order }, { status: 201 });
  }
}