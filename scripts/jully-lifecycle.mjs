// Ciclo de vida do servidor de smoke (seção 29).
//
// Regras de ouro:
//   - NUNCA matar processos Node globalmente (`Get-Process node | Stop-Process`
//     é proibido): o stop é SEMPRE por PID persistido e validado.
//   - A porta 3210 é o único endereço do smoke. Em `next dev` o listener é um
//     PROCESSO FILHO do launcher (`node_modules/next/dist/server/lib/start-server.js`),
//     então o pidfile guarda DOIS PIDs separados:
//       launcherPid -> processo `next dev` spawnado por este script;
//       serverPid   -> dono LISTENING da porta (netstat), descendente do launcher.
//   - Antes do stop, o script CONFERE TUDO AO MESMO TEMPO (fail-closed):
//       1) serverPid do pidfile == dono atual LISTENING da porta;
//       2) command line do owner casa com JULLY/Next dentro deste repositório;
//       3) árvore: owner é descendente (ou igual) do launcher registrado;
//       4) launcher registrado ainda é o `next dev` do projeto.
//     Qualquer divergência => recusa; nada é morto.
//   - Formato legado (só launcherPid, sem serverPid) é aceito pelo stop: ele
//     adota o dono atual da porta somente se a árvore validar.
//   - O servidor foi spawnado detached (stdio em arquivo de log), com
//     JULLY_NEXT_DIST=smoke-dist para não colidir com .next de dev/build.
import { spawn, execSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const SMOKE_PORT = 3210;
export const SMOKE_URL = `http://localhost:${SMOKE_PORT}`;
export const SMOKE_DIST = "smoke-dist";

const PID_FILE = path.join(os.tmpdir(), "jully-next-smoke-3210.pid");
const LOG_FILE = path.join(os.tmpdir(), "jully-next-smoke-3210.log");
const PROJECT_ROOT_NORMALIZED = path.resolve(".").toLowerCase().replaceAll("\\", "/");
const NEXT_DEV_MARKER = "node_modules/next/dist/bin/next";
const NEXT_SERVER_MARKER = "node_modules/next/dist/server/lib/start-server.js";

export function getSmokePidFile() {
  return PID_FILE;
}

// PIDs titulares de LISTENING na porta (ignora ESTABLISHED/TIME_WAIT).
function listPortOwners(port) {
  try {
    const out = execSync(`netstat -ano -p tcp | findstr :${port}`, {
      encoding: "utf8",
    });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes("LISTENING")) {
        continue;
      }
      const match = line.trim().match(/(\d+)\s*$/);
      if (match) {
        pids.add(Number(match[1]));
      }
    }
    return [...pids];
  } catch {
    return [];
  }
}

function readPidFile() {
  if (!existsSync(PID_FILE)) {
    return null;
  }
  const raw = readFileSync(PID_FILE, "utf8").trim();
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    const launcherPid = Number(parsed.launcherPid);
    const serverPid = parsed.serverPid ? Number(parsed.serverPid) : null;
    if (Number.isInteger(launcherPid) && launcherPid > 0) {
      return {
        launcherPid,
        serverPid: Number.isInteger(serverPid) && serverPid > 0 ? serverPid : null,
      };
    }
  } catch {
    const pid = Number(raw);
    if (Number.isInteger(pid) && pid > 0) {
      return { launcherPid: pid, serverPid: null };
    }
  }
  return null;
}

function writePidFile(record) {
  writeFileSync(PID_FILE, JSON.stringify(record));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Dados do processo Windows (pid, ppid, command line).
function getWinProc(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object ProcessId,ParentProcessId,CommandLine | Format-List | Out-String)"`,
      { encoding: "utf8", windowsHide: true, timeout: 15_000 }
    );
    const pidMatch = out.match(/ProcessId\s*:\s*(\d+)/);
    const ppidMatch = out.match(/ParentProcessId\s*:\s*(\d+)/);
    const cmdMatch = out.match(/CommandLine\s*:\s*([\s\S]*)$/);
    if (!pidMatch || !ppidMatch) {
      return null;
    }
    return {
      pid: Number(pidMatch[1]),
      ppid: Number(ppidMatch[1]),
      cmdline: cmdMatch ? cmdMatch[1].trim() : "",
    };
  } catch {
    return null;
  }
}

// Command line compatível com JULLY/Next dentro deste repositório?
function procIsJulllyNext(proc) {
  if (!proc || typeof proc.cmdline !== "string") {
    return { ok: false, mode: null, reason: "processo inexistente/sem command line" };
  }
  const n = proc.cmdline.toLowerCase().replaceAll("\\", "/");
  if (!n.includes(PROJECT_ROOT_NORMALIZED)) {
    return { ok: false, mode: null, reason: `fora do workspace (${path.resolve(".")})` };
  }
  if (n.includes(NEXT_SERVER_MARKER)) {
    return { ok: true, mode: "server" };
  }
  if (n.includes(NEXT_DEV_MARKER) && /\bdev\b/.test(n)) {
    return { ok: true, mode: "launcher" };
  }
  return { ok: false, mode: null, reason: "command line não é JULLY/Next" };
}

// serverPid é igual ou descendente de launcherPid?
function isDescendantOf(serverPid, launcherPid) {
  let current = serverPid;
  for (let i = 0; i < 6; i++) {
    if (current === launcherPid) {
      return true;
    }
    const proc = getWinProc(current);
    if (!proc || proc.ppid === current || proc.ppid <= 0) {
      return false;
    }
    current = proc.ppid;
  }
  return false;
}

// Valida o estado persistido contra os donos atuais da porta (fail-closed).
function validateSmokePair(recorded, owners) {
  const launcher = getWinProc(recorded.launcherPid);
  const launcherCheck = procIsJulllyNext(launcher);
  if (!launcherCheck.ok) {
    return { ok: false, reason: `launcher ${recorded.launcherPid} ${launcherCheck.reason}` };
  }
  const serverPid =
    recorded.serverPid && owners.includes(recorded.serverPid)
      ? recorded.serverPid
      : owners.find((owner) => isDescendantOf(owner, recorded.launcherPid));
  if (!serverPid || !owners.includes(serverPid)) {
    return {
      ok: false,
      reason:
        `nenhum dono LISTENING de ${SMOKE_PORT} casa com o pidfile ` +
        `(donos: ${owners.join(", ")}, pidfile: launcher ${recorded.launcherPid})`,
    };
  }
  const server = getWinProc(serverPid);
  const serverCheck = procIsJulllyNext(server);
  if (!serverCheck.ok) {
    return { ok: false, reason: `owner ${serverPid} ${serverCheck.reason}` };
  }
  if (serverPid !== recorded.launcherPid && !isDescendantOf(serverPid, recorded.launcherPid)) {
    return {
      ok: false,
      reason: `owner ${serverPid} não é descendente do launcher ${recorded.launcherPid}`,
    };
  }
  return { ok: true, serverPid };
}

// Inicia o servidor Next (dev, NODE_ENV de desenvolvimento para permitir o
// FakePaymentProvider) em porta dedicada, detached. Retorna o PID do launcher.
export function startServer(envOverrides = {}) {
  const owners = listPortOwners(SMOKE_PORT);
  if (owners.length > 0) {
    const recorded = readPidFile();
    if (recorded && isAlive(recorded.launcherPid)) {
      const validation = validateSmokePair(recorded, owners);
      if (validation.ok && isAlive(validation.serverPid)) {
        console.log(
          `[lifecycle] servidor já ativo (launcher ${recorded.launcherPid}, owner ${validation.serverPid})`
        );
        writePidFile({ launcherPid: recorded.launcherPid, serverPid: validation.serverPid });
        return recorded.launcherPid;
      }
    }
    throw new Error(
      `[lifecycle] porta ${SMOKE_PORT} já está em uso (PIDs ${owners.join(", ")}) ` +
        "por processo não validado — recusando inicialização cega"
    );
  }

  if (existsSync(LOG_FILE)) {
    unlinkSync(LOG_FILE);
  }
  const nextBin = path.resolve("node_modules/next/dist/bin/next");
  const outFd = openSync(LOG_FILE, "a");
  const child = spawn(
    process.execPath,
    [nextBin, "dev", "-p", String(SMOKE_PORT)],
    {
      env: { ...process.env, JULLY_NEXT_DIST: SMOKE_DIST, ...envOverrides },
      stdio: ["ignore", outFd, outFd],
      detached: true,
      windowsHide: true,
    }
  );
  closeSync(outFd);
  child.unref();
  writePidFile({ launcherPid: child.pid, serverPid: null });
  console.log(`[lifecycle] servidor iniciado (launcher ${child.pid}, log em ${LOG_FILE})`);
  return child.pid;
}

// Aguarda o servidor responder HTTP (qualquer status válido = pronto) e, ao
// ficar pronto, persiste o owner real da porta (serverPid) junto do launcher.
export async function waitReady(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${SMOKE_URL}/api/auth/bootstrap`, {
        method: "POST",
        signal: AbortSignal.timeout(4_000),
      });
      if (res.status >= 100 && res.status < 600) {
        const recorded = readPidFile();
        const owners = listPortOwners(SMOKE_PORT);
        if (recorded && isAlive(recorded.launcherPid) && owners.length > 0) {
          const validation = validateSmokePair(recorded, owners);
          if (validation.ok) {
            writePidFile({
              launcherPid: recorded.launcherPid,
              serverPid: validation.serverPid,
            });
            console.log(
              `[lifecycle] owner validado: launcher ${recorded.launcherPid} -> server ${validation.serverPid}`
            );
          } else {
            console.warn(`[lifecycle] owner não validado: ${validation.reason}`);
          }
        }
        console.log(`[lifecycle] pronto: ${SMOKE_URL} (status ${res.status})`);
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(1_000);
  }
  throw new Error(
    `[lifecycle] servidor não respondeu em ${timeoutMs}ms: ${lastError?.message ?? "sem erro capturável"}`
  );
}

// Para o servidor de smoke (fail-closed). Não mata nada sem validação completa.
export async function stopServer() {
  const owners = listPortOwners(SMOKE_PORT);
  const recorded = readPidFile();

  if (owners.length === 0) {
    if (recorded) {
      unlinkSync(PID_FILE);
    }
    console.log("[lifecycle] porta livre — nada a parar");
    return;
  }
  if (!recorded) {
    throw new Error(
      `[lifecycle] stop recusado (fail-closed): porta ${SMOKE_PORT} ocupada por ` +
        `${owners.join(", ")} sem pidfile — não mato dono desconhecido`
    );
  }
  if (!isAlive(recorded.launcherPid)) {
    throw new Error(
      `[lifecycle] stop recusado (fail-closed): launcher ${recorded.launcherPid} morto ` +
        `mas porta ${SMOKE_PORT} ainda ocupada por ${owners.join(", ")}`
    );
  }

  const validation = validateSmokePair(recorded, owners);
  if (!validation.ok) {
    throw new Error(`[lifecycle] stop recusado (fail-closed): ${validation.reason}`);
  }
  const serverPid = validation.serverPid;

  process.kill(serverPid);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && isAlive(serverPid)) {
    await sleep(200);
  }
  if (isAlive(serverPid)) {
    throw new Error(`[lifecycle] owner ${serverPid} não saiu em 10s — pidfile preservado`);
  }
  console.log(`[lifecycle] servidor de smoke parado (owner ${serverPid})`);

  if (isAlive(recorded.launcherPid)) {
    const launcher = getWinProc(recorded.launcherPid);
    if (procIsJulllyNext(launcher).ok) {
      process.kill(recorded.launcherPid);
      const launcherDeadline = Date.now() + 5_000;
      while (Date.now() < launcherDeadline && isAlive(recorded.launcherPid)) {
        await sleep(100);
      }
      console.log(`[lifecycle] launcher de smoke parado (${recorded.launcherPid})`);
    }
  }
  if (existsSync(PID_FILE)) {
    unlinkSync(PID_FILE);
  }
}