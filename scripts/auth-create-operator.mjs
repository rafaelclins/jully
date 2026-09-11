// Bootstrap (dev) de operador: cria usuario (email+senha) e membership.
//
// O cliente HTTP conversa exclusivamente com o endpoint interno
// POST /api/auth/bootstrap, que usa a primitiva segura do Better Auth
// (signUpEmail) para criar a credencial - hashing/scrypt nativo da lib,
// sem senha hardcoded e sem criptografia artesanal.
//
// Uso:
//   npm run auth:create-operator -- --email operador@restaurante.com \
//     --password "$SENHA" --name "Operador" \
//     --restaurant-slug meu-restaurante --role OWNER
//
// Requisitos no .env: BETTER_AUTH_URL, AUTH_BOOTSTRAP_ENABLED=true e
// AUTH_BOOTSTRAP_KEY (chave de bootstrap). A senha vem de --password ou da
// env var AUTH_OPERATOR_PASSWORD (nao gravar no historico).
import "dotenv/config";

function fail(message) {
  console.error(`[auth:create-operator] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      fail(`argumento inesperado: ${token}`);
    }
    const [flag, inlineValue] = token.split("=", 2);
    const value =
      inlineValue !== undefined ? inlineValue : argv[i + 1] ?? "";
    if (inlineValue === undefined && value.startsWith("--")) {
      fail(`faltou valor para ${flag}`);
    }
    args[flag.slice(2)] = value;
    if (inlineValue === undefined) {
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const email = (args.email ?? "").trim().toLowerCase();
  const password = args.password ?? process.env.AUTH_OPERATOR_PASSWORD;
  const name = (args.name ?? "").trim();
  const restaurantSlug = (args["restaurant-slug"] ?? "").trim();
  const role = (args.role ?? "OPERATOR").toUpperCase();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fail("--email valido e obrigatorio");
  }
  if (!password || typeof password !== "string") {
    fail("--password (ou AUTH_OPERATOR_PASSWORD) e obrigatorio");
  }
  if (!name) {
    fail("--name e obrigatorio");
  }
  if (!restaurantSlug) {
    fail("--restaurant-slug e obrigatorio");
  }
  if (!["OWNER", "OPERATOR"].includes(role)) {
    fail(`--role deve ser OWNER ou OPERATOR (recebido: ${role})`);
  }

  const baseURL = process.env.BETTER_AUTH_URL;
  const bootstrapKey = process.env.AUTH_BOOTSTRAP_KEY;
  if (!baseURL) {
    fail("BETTER_AUTH_URL ausente no .env");
  }
  if (!bootstrapKey) {
    fail("AUTH_BOOTSTRAP_KEY ausente no .env");
  }
  if (process.env.AUTH_BOOTSTRAP_ENABLED !== "true") {
    fail("AUTH_BOOTSTRAP_ENABLED precisa ser 'true' para criar operadores");
  }

  const base = baseURL.replace(/\/+$/, "");
  const response = await fetch(`${base}/api/auth/bootstrap`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bootstrap-key": bootstrapKey,
    },
    body: JSON.stringify({
      name,
      email,
      password,
      restaurantSlug,
      role,
    }),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body?.error ?? `HTTP ${response.status}`;
    fail(`bootstrap falhou: ${message}`);
  }

  console.log(JSON.stringify(body, null, 2));
}

main().catch((error) => {
  console.error("[auth:create-operator] erro inesperado:", error);
  process.exit(1);
});