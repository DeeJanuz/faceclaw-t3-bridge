#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { access, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { dataDirectory } from "./portable-deployment.mjs";
import {
  deploymentManifest,
  nextPatchVersion,
  normalizeTailscaleDnsName,
  tailscaleInfoFromStatus,
  tailscaleOrigins,
  validatePort,
} from "./deployment-helpers.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutputDirectory = path.join(
  dataDirectory(),
  "artifacts",
);

function parseArguments(argv) {
  const options = {
    host: null,
    httpsPort: 8443,
    outputDirectory: defaultOutputDirectory,
    includeLocalDevelopment: false,
    tailscaleWildcard: false,
    dryRun: false,
  };
  const nextValue = (index, option) => {
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      throw new Error(`${option} requires a value`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--tailscale-host") options.host = nextValue(index++, argument);
    else if (argument === "--tailscale-wildcard") options.tailscaleWildcard = true;
    else if (argument === "--https-port") options.httpsPort = validatePort(nextValue(index++, argument), "HTTPS port");
    else if (argument === "--output-dir") options.outputDirectory = path.resolve(nextValue(index++, argument));
    else if (argument === "--include-local-dev") options.includeLocalDevelopment = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else throw new Error(`Unsupported argument: ${argument}`);
  }
  if (options.tailscaleWildcard && options.host !== null) {
    throw new Error("--tailscale-wildcard cannot be combined with --tailscale-host");
  }
  if (options.tailscaleWildcard && options.includeLocalDevelopment) {
    throw new Error("--tailscale-wildcard cannot be combined with --include-local-dev");
  }
  if (/\u0000|\r|\n/.test(options.outputDirectory)) throw new Error("Output directory is invalid");
  return options;
}

async function findExecutable(name) {
  const candidates = (process.env.PATH || "").split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, process.platform === "win32" && name === "tailscale" ? "tailscale.exe" : name));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return await realpath(candidate);
    } catch {
      // Continue through the fixed PATH entries.
    }
  }
  throw new Error(`${name} was not found on PATH`);
}

async function discoverHost() {
  const tailscale = await findExecutable("tailscale");
  const { stdout } = await execFileAsync(tailscale, ["status", "--json"], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10_000,
  });
  return tailscaleInfoFromStatus(JSON.parse(stdout)).dnsName;
}

async function run(executable, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { ...options, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(executable)} failed${signal ? ` with ${signal}` : ` with code ${code}`}`));
    });
  });
}

async function main() {
  if (process.argv.length === 3 && ["--help", "-h"].includes(process.argv[2])) {
    process.stdout.write("Usage: node scripts/package-evenhub.mjs [--tailscale-host HOST] [--https-port PORT] [--output-dir ABSOLUTE_DIRECTORY] [--dry-run]\nBuild an Even Hub package for your exact Tailscale hostname. Defaults: discovered connected hostname, HTTPS port 8443, per-user artifacts directory. --include-local-dev is for local testing only.\n");
    return;
  }
  const options = parseArguments(process.argv.slice(2));
  const host = options.tailscaleWildcard
    ? null
    : options.host === null
      ? options.dryRun
        ? "your-mac.your-tailnet.ts.net"
        : await discoverHost()
      : normalizeTailscaleDnsName(options.host);
  const origins = host === null ? null : tailscaleOrigins(host, options.httpsPort);
  const appJsonPath = path.join(repoRoot, "app.json");
  const source = JSON.parse(await readFile(appJsonPath, "utf8"));
  const manifest = deploymentManifest(source, {
    host,
    httpsPort: options.httpsPort,
    includeLocalDevelopment: options.includeLocalDevelopment,
    tailscaleWildcard: options.tailscaleWildcard,
  });
  if (options.tailscaleWildcard) manifest.version = nextPatchVersion(source.version);
  const version = typeof manifest.version === "string" && /^[0-9A-Za-z._-]{1,64}$/.test(manifest.version)
    ? manifest.version
    : "deployment";
  const artifactKey = options.tailscaleWildcard
    ? `tailscale-wildcard-port-${options.httpsPort}`
    : host;
  const artifactDirectory = path.join(options.outputDirectory, artifactKey);
  const manifestPath = path.join(artifactDirectory, "app.generated.json");
  const packageName = options.tailscaleWildcard
    ? `t3-code-assistant-tailscale-wildcard-${version}.ehpk`
    : `t3-code-assistant-${version}.ehpk`;
  const packagePath = path.join(artifactDirectory, packageName);

  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({
      bridgeUrl: origins?.eventsUrl ?? "Enter the user's own Tailscale WSS URL",
      manifestVersion: version,
      manifestPath,
      packagePath,
      whitelist: manifest.permissions.find((permission) => permission.name === "network").whitelist,
      actions: ["npm run build", "evenhub pack generated-manifest dist"],
    }, null, 2)}\n`);
    return;
  }

  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  const helper = path.join(repoRoot, "scripts", "deployment-helpers.mjs");
  const node = process.execPath;
  const manifestArguments = options.tailscaleWildcard
    ? [helper, "manifest-tailscale-wildcard", appJsonPath, manifestPath, String(options.httpsPort)]
    : [helper, "manifest", appJsonPath, manifestPath, host, String(options.httpsPort), String(options.includeLocalDevelopment)];
  await run(node, manifestArguments, {
    cwd: repoRoot,
  });
  const npm = process.platform === "win32"
    ? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
    : await findExecutable("npm");
  await access(npm);
  const buildEnvironment = { ...process.env };
  delete buildEnvironment.VITE_DEFAULT_BRIDGE_URL;
  delete buildEnvironment.VITE_BRIDGE_URL;
  delete buildEnvironment.VITE_BRIDGE_TOKEN;
  await run(process.platform === "win32" ? node : npm, process.platform === "win32" ? [npm, "run", "build"] : ["run", "build"], {
    cwd: repoRoot,
    env: buildEnvironment,
  });
  const evenhub = await realpath(path.join(repoRoot, "node_modules", "@evenrealities", "evenhub-cli", "main.js")).catch(() => null);
  if (evenhub === null) throw new Error("evenhub CLI is missing. Run npm ci first");
  await run(node, [
    evenhub,
    "pack",
    manifestPath,
    path.join(repoRoot, "dist"),
    "-o",
    packagePath,
    "--sdk-ver",
    String(manifest.min_sdk_version),
  ], { cwd: repoRoot });
  const bridgeUrl = origins?.eventsUrl ?? "Enter the user's own Tailscale WSS URL";
  process.stdout.write(`Bridge URL: ${bridgeUrl}\nManifest: ${manifestPath}\nPackage: ${packagePath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Even Hub packaging failed"}\n`);
  process.exitCode = 1;
});
