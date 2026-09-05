#!/usr/bin/env node

import { execFile } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { validatePort } from "./deployment-helpers.mjs";

const execFileAsync = promisify(execFile);

export function classifyPortOwnership(listenerPids, agentPid, parentByPid) {
  if (!Array.isArray(listenerPids) || listenerPids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) {
    throw new Error("Listener process data is invalid");
  }
  if (listenerPids.length === 0) return "free";
  if (!Number.isSafeInteger(agentPid) || agentPid <= 0) return "occupied";

  for (const listenerPid of listenerPids) {
    let current = listenerPid;
    const visited = new Set();
    let owned = current === agentPid;
    while (!owned && current > 1 && !visited.has(current)) {
      visited.add(current);
      current = parentByPid.get(current) ?? 0;
      owned = current === agentPid;
    }
    if (!owned) return "occupied";
  }
  return "owned";
}

function parsePositiveIntegers(raw) {
  return raw
    .split(/\s+/)
    .filter(Boolean)
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
}

async function listenerPids(port) {
  try {
    const { stdout } = await execFileAsync(
      "/usr/sbin/lsof",
      ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"],
      { encoding: "utf8", timeout: 5000, maxBuffer: 256 * 1024 },
    );
    return [...new Set(parsePositiveIntegers(stdout))];
  } catch (error) {
    if (error && typeof error === "object" && error.code === 1) return [];
    throw new Error("Could not inspect the bridge port");
  }
}

async function launchAgentPid(guiDomain, label) {
  try {
    const { stdout } = await execFileAsync(
      "/bin/launchctl",
      ["print", `${guiDomain}/${label}`],
      { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 },
    );
    const match = /^\s*pid\s*=\s*(\d+)\s*$/m.exec(stdout);
    return match ? Number(match[1]) : null;
  } catch (error) {
    if (error && typeof error === "object" && typeof error.code === "number") return null;
    throw new Error("Could not inspect the installed LaunchAgent");
  }
}

async function processParents() {
  const { stdout } = await execFileAsync(
    "/bin/ps",
    ["-axo", "pid=,ppid="],
    { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
  );
  const result = new Map();
  for (const line of stdout.split("\n")) {
    const [pid, parent, ...extra] = parsePositiveIntegers(line);
    if (extra.length === 0 && pid !== undefined && parent !== undefined) result.set(pid, parent);
  }
  return result;
}

async function inspect(label, guiDomain, rawPort) {
  if (!/^[A-Za-z0-9.-]{1,128}$/.test(label)) throw new Error("LaunchAgent label is invalid");
  if (!/^gui\/\d+$/.test(guiDomain)) throw new Error("launchctl domain is invalid");
  const port = validatePort(rawPort, "bridge port");
  const listeners = await listenerPids(port);
  if (listeners.length === 0) return "free";
  const agentPid = await launchAgentPid(guiDomain, label);
  return classifyPortOwnership(listeners, agentPid, await processParents());
}

async function main() {
  const [label, guiDomain, port] = process.argv.slice(2);
  if ([label, guiDomain, port].some((value) => typeof value !== "string")) {
    throw new Error("Usage: port-preflight.mjs LABEL GUI_DOMAIN PORT");
  }
  process.stdout.write(`${await inspect(label, guiDomain, port)}\n`);
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entry) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Port inspection failed"}\n`);
    process.exitCode = 1;
  });
}
