// Runner de testes (Etapa 16). Cria/atualiza o banco dedicado de teste
// (<base>_test) e roda as suites tsx/node:test com DATABASE_URL apontando
// para ele. O banco de produção/dev nunca é tocado.
import "dotenv/config";
import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export function deriveTestUrl(baseUrl) {
  if (!baseUrl) {
    throw new Error("DATABASE_URL não definida (configure o .env)");
  }
  const u = new URL(baseUrl);
  const segments = u.pathname.split("/").filter(Boolean);
  const db = segments[segments.length - 1];
  if (!db.endsWith("_test")) {
    segments[segments.length - 1] = `${db}_test`;
  }
  u.pathname = `/${segments.join("/")}`;
  return u.toString();
}

export function redactDatabaseUrl(databaseUrl) {
  const u = new URL(databaseUrl);
  if (u.password) {
    u.password = "****";
  }
  return u.toString();
}

export async function ensureTestDatabase() {
  const baseUrl = process.env.DATABASE_URL;
  const testUrl = deriveTestUrl(baseUrl);
  const dbName = new URL(testUrl).pathname.split("/").filter(Boolean).at(-1);

  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = "/postgres";
  const client = new pg.Client({
    connectionString: adminUrl.toString(),
    connectionTimeoutMillis: 10_000,
    query_timeout: 10_000,
  });
  await client.connect();
  try {
    const { rowCount } = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [dbName]
    );
    if (rowCount === 0) {
      await client.query(`CREATE DATABASE "${dbName}"`);
      console.log(`[test-runner] banco de teste criado: ${dbName}`);
    }
  } finally {
    await client.end();
  }
  return testUrl;
}

function* listTests(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // testes/security/faz parte do security-smoke (servidor real na 3210),
      // não do `npm run test`.
      if (entry.name === "security") {
        continue;
      }
      yield* listTests(full);
    } else if (entry.name.endsWith(".test.ts")) {
      yield full;
    }
  }
}

async function main() {
  const testUrl = await ensureTestDatabase();
  const runnerEnv = {
    ...process.env,
    DATABASE_URL: testUrl,
    NODE_ENV: "test",
    PAYMENT_PROVIDER: "fake",
  };

  console.log(`[test-runner] DATABASE_URL de teste: ${redactDatabaseUrl(testUrl)}`);
  execSync("npx prisma migrate deploy", { stdio: "inherit", env: runnerEnv });

  const tests = [...listTests("tests")];
  if (tests.length === 0) {
    throw new Error("nenhuma suite *.test.ts encontrada em tests/");
  }

  // --test-concurrency=1: cada suite integralmente contra o banco truncado
  // isolado (databases compartilhadas seriam sensíveis à ordem).
  execSync(
    `npx tsx --test --test-concurrency=1 ${tests.map((t) => JSON.stringify(t)).join(" ")}`,
    { stdio: "inherit", env: runnerEnv }
  );
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
