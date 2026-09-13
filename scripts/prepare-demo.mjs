// Prepara dados demo locais para QA manual.
//
// Requisitos:
//   AUTH_BOOTSTRAP_ENABLED=true
//   AUTH_BOOTSTRAP_KEY=<key local>
//   BETTER_AUTH_URL=http://localhost:3000
//   DEMO_OPERATOR_PASSWORD=<senha local, nao impressa>
//
// O script recusa producao e bancos fora do padrao local de dev/teste.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import pg from "pg";

function fail(message) {
  console.error(`[demo:prepare] ${message}`);
  process.exit(1);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    fail(`${name} ausente`);
  }
  return value;
}

function assertSafeDatabase(url) {
  const parsed = new URL(url);
  const database = parsed.pathname.split("/").filter(Boolean).at(-1);
  const host = parsed.hostname;
  const localHost = ["localhost", "127.0.0.1", "::1"].includes(host);
  const allowedDatabase = database === "jully_dev" || database?.endsWith("_test");
  if (process.env.NODE_ENV === "production" || !localHost || !allowedDatabase) {
    fail(
      `banco recusado (host=${host}, database=${database ?? "<missing>"}, NODE_ENV=${process.env.NODE_ENV ?? "<unset>"})`
    );
  }
}

async function main() {
  const databaseUrl = requireEnv("DATABASE_URL");
  const baseURL = requireEnv("BETTER_AUTH_URL").replace(/\/+$/, "");
  const bootstrapKey = requireEnv("AUTH_BOOTSTRAP_KEY");
  const password = requireEnv("DEMO_OPERATOR_PASSWORD");
  if (process.env.AUTH_BOOTSTRAP_ENABLED !== "true") {
    fail("AUTH_BOOTSTRAP_ENABLED precisa ser 'true'");
  }
  assertSafeDatabase(databaseUrl);

  const slug = process.env.DEMO_RESTAURANT_SLUG || `jully-demo-${Date.now()}`;
  const email =
    process.env.DEMO_OPERATOR_EMAIL || `operador-${slug}@example.local`;
  const qrToken = process.env.DEMO_QR_TOKEN || `demo-${randomUUID()}`;
  const tableNumber = Number(process.env.DEMO_TABLE_NUMBER || 17);

  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10_000,
    query_timeout: 10_000,
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    const restaurant = await client.query(
      `
        INSERT INTO restaurants
          (id, name, slug, currency, "serviceFeePercent", "createdAt", "updatedAt")
        VALUES (gen_random_uuid(), $1, $2, 'BRL', 10, now(), now())
        ON CONFLICT (slug) DO UPDATE SET
          name = EXCLUDED.name,
          currency = EXCLUDED.currency,
          "serviceFeePercent" = EXCLUDED."serviceFeePercent",
          "updatedAt" = now()
        RETURNING id
      `,
      ["JULLY Demo", slug]
    );
    const restaurantId = restaurant.rows[0].id;

    await client.query(
      `
        INSERT INTO tables
          (id, "restaurantId", number, "qrToken", active, "createdAt", "updatedAt")
        VALUES (gen_random_uuid(), $1, $2, $3, true, now(), now())
        ON CONFLICT ("qrToken") DO UPDATE SET
          "restaurantId" = EXCLUDED."restaurantId",
          number = EXCLUDED.number,
          active = true,
          "updatedAt" = now()
      `,
      [restaurantId, tableNumber, qrToken]
    );

    const category = await client.query(
      `
        INSERT INTO categories
          (id, "restaurantId", name, position, active, "createdAt", "updatedAt")
        VALUES (gen_random_uuid(), $1, 'Lanches', 1, true, now(), now())
        RETURNING id
      `,
      [restaurantId]
    );
    const categoryId = category.rows[0].id;

    for (const product of [
      ["Burger piloto", "Pao, carne e queijo", "32.90"],
      ["Suco natural", "Laranja 300 ml", "8.00"],
      ["Salada verde", "Folhas, tomate e molho", "24.50"],
    ]) {
      await client.query(
        `
          INSERT INTO products
            (id, "restaurantId", "categoryId", name, description, price, active, "createdAt", "updatedAt")
          VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, true, now(), now())
        `,
        [restaurantId, categoryId, ...product]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }

  const bootstrap = await fetch(`${baseURL}/api/auth/bootstrap`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bootstrap-key": bootstrapKey,
    },
    body: JSON.stringify({
      name: "Operador Demo",
      email,
      password,
      restaurantSlug: slug,
      role: "OWNER",
    }),
  });
  const body = await bootstrap.json().catch(() => null);
  if (!bootstrap.ok) {
    fail(`bootstrap falhou: ${body?.error ?? `HTTP ${bootstrap.status}`}`);
  }

  console.log("[demo:prepare] demo pronta");
  console.log(`Restaurante: ${slug}`);
  console.log(`Operador: ${email}`);
  console.log(`Mesa: ${tableNumber}`);
  console.log(`Cliente: ${baseURL}/t/${qrToken}`);
  console.log(`Operador: ${baseURL}/login`);
  console.log(`Painel: ${baseURL}/restaurant/${slug}/orders`);
  console.log("Senha: definida em DEMO_OPERATOR_PASSWORD (nao impressa).");
}

main().catch((error) => {
  console.error("[demo:prepare] erro inesperado:", error);
  process.exit(1);
});
