import { timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";

import { prisma } from "@/lib/prisma";
import { errorResponse } from "@/lib/public-api";

// Bootstrap de operadores - APENAS desenvolvimento.
// Sem credencial valida derivada de env vars a rota nunca abre:
//   - AUTH_BOOTSTRAP_ENABLED != "true"           -> 404 (rota inexistente)
//   - x-bootstrap-key != AUTH_BOOTSTRAP_KEY      -> 401
// Em producao essas envs simplesmente nao existem -> rota "mortinha".
const bootstrapSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(8).max(128),
    restaurantSlug: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9-]+$/, { message: "Invalid restaurant slug" }),
    role: z.enum(["OWNER", "OPERATOR"]).default("OPERATOR"),
  })
  .strict();

function keyMatches(supplied: string | null): boolean {
  const expected = process.env.AUTH_BOOTSTRAP_KEY;
  if (!expected || !supplied) {
    return false;
  }
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bootstrapAuth() {
  // Instancia dedicada: usa a MESMA primitiva signUpEmail do Better Auth
  // (hashing scrypt nativo), mas sem expor sign-up publico no app.
  return betterAuth({
    baseURL: process.env.BETTER_AUTH_URL,
    secret: process.env.BETTER_AUTH_SECRET,
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    emailAndPassword: {
      enabled: true,
      // autoSignIn=false evita criar sessao orfa ao criar o operador.
      autoSignIn: false,
    },
  });
}

// POST /api/auth/bootstrap
// Cria o usuario do operador (via primitiva oficial do Better Auth) e a
// RestaurantMembership dele no restaurante referenciado por slug. Nao
// altera opcoes do app nem cria sessoes.
export async function POST(request: Request) {
  if (process.env.AUTH_BOOTSTRAP_ENABLED !== "true") {
    return errorResponse(404, "Not found");
  }
  if (!keyMatches(request.headers.get("x-bootstrap-key"))) {
    return errorResponse(401, "Unauthorized");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const parsed = bootstrapSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(400, "Invalid bootstrap payload");
  }

  const { name, email, password, restaurantSlug, role } = parsed.data;

  const restaurant = await prisma.restaurant.findUnique({
    where: { slug: restaurantSlug },
    select: { id: true, name: true, slug: true },
  });
  if (!restaurant) {
    return errorResponse(404, "Restaurant not found", "RESTAURANT_NOT_FOUND");
  }

  const existingUser = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  let userId: string;
  if (existingUser) {
    userId = existingUser.id;
  } else {
    const auth = bootstrapAuth();
    const result = await auth.api.signUpEmail({
      body: { name, email, password },
    });
    const user = "user" in result && result.user ? result.user : null;
    if (!user?.id) {
      console.error("[bootstrap] signUpEmail did not return a user");
      return errorResponse(
        500,
        "Failed to create operator user",
        "OPERATOR_CREATE_FAILED"
      );
    }
    userId = user.id;
  }

  const existingMembership = await prisma.restaurantMembership.findUnique({
    where: {
      userId_restaurantId: { userId, restaurantId: restaurant.id },
    },
    select: { role: true },
  });
  if (existingMembership) {
    if (existingMembership.role === role) {
      return Response.json({
        status: "already-exists",
        operator: { userId, email },
        restaurant: { slug: restaurant.slug, name: restaurant.name },
        membership: { role: existingMembership.role },
      });
    }
    return errorResponse(
      409,
      `User already has a membership (${existingMembership.role}) in this restaurant`,
      "MEMBERSHIP_ROLE_MISMATCH"
    );
  }

  const membership = await prisma.restaurantMembership.create({
    data: { userId, restaurantId: restaurant.id, role },
    select: { id: true, role: true },
  });

  return Response.json({
    status: "created",
    operator: { userId, email },
    restaurant: { slug: restaurant.slug, name: restaurant.name },
    membership,
  });
}