import "dotenv/config";

import { spawn } from "node:child_process";

import {
  SMOKE_URL,
  startServer,
  stopServer,
  waitReady,
} from "./jully-lifecycle.mjs";

const smokeEnv = {
  BETTER_AUTH_URL: SMOKE_URL,
  AUTH_BOOTSTRAP_ENABLED: "false",
  RATE_LIMIT_DISABLED: "true",
  PAYMENT_PROVIDER: "fake",
  NODE_ENV: "development",
};

for (let cycle = 1; cycle <= 3; cycle++) {
  startServer(smokeEnv);
  await waitReady();
  const response = await fetch(SMOKE_URL);
  if (response.status < 100 || response.status >= 600) {
    throw new Error(`ciclo ${cycle}: resposta HTTP inválida`);
  }
  await stopServer();
  console.log(`[lifecycle-test] ciclo ${cycle} concluído`);
}

const foreign = spawn(
  process.execPath,
  [
    "-e",
    "require('node:http').createServer((_request,response)=>response.end('foreign')).listen(3210)",
  ],
  { stdio: "ignore", windowsHide: true }
);

try {
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  let refused = false;
  try {
    await stopServer();
  } catch (error) {
    refused = error instanceof Error && error.message.includes("fail-closed");
    console.log(`[lifecycle-test] owner inesperado recusado: ${error.message}`);
  }
  if (!refused) {
    throw new Error("stop deveria recusar owner inesperado");
  }
} finally {
  // O harness encerra somente o processo exato que ele próprio criou.
  foreign.kill();
}

console.log("[lifecycle-test] comando posterior executou");
