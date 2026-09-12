// Security smoke (Etapa 16): sobe o servidor real (next dev isolado em
// smoke-dist + jully_test), roda as suites HTTP de segurança contra ele e
// para o servidor pelo PID validado. NUNCA mata processos alheios.
import "dotenv/config";
import { execSync } from "node:child_process";

import {
  SMOKE_PORT,
  SMOKE_URL,
  startServer,
  stopServer,
  waitReady,
} from "./jully-lifecycle.mjs";
import { ensureTestDatabase } from "./test-runner.mjs";

const testUrl = await ensureTestDatabase();

const smokeEnv = {
  DATABASE_URL: testUrl,
  PORT: String(SMOKE_PORT),
  BETTER_AUTH_URL: SMOKE_URL,
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  AUTH_BOOTSTRAP_ENABLED: "true",
  AUTH_BOOTSTRAP_KEY: process.env.AUTH_BOOTSTRAP_KEY,
  RATE_LIMIT_DISABLED: "true",
  PAYMENT_PROVIDER: "fake",
  NODE_ENV: "development",
  SMOKE_URL,
};

if (!process.env.BETTER_AUTH_SECRET || !process.env.AUTH_BOOTSTRAP_KEY) {
  throw new Error("security-smoke exige BETTER_AUTH_SECRET e AUTH_BOOTSTRAP_KEY no .env");
}

startServer(smokeEnv);
try {
  await waitReady();
  execSync("npx tsx --test --test-concurrency=1 tests/security/http-smoke.test.ts", {
    stdio: "inherit",
    env: { ...process.env, ...smokeEnv },
  });
  console.log("[security-smoke] suites HTTP concluídas com sucesso");
} finally {
  await stopServer();
}