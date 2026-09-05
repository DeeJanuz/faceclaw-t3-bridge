import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { ArchiveStore, type ArchiveConfig, type Collection, type TaskStatus } from "./assistant-archive.js";

const execFileAsync = promisify(execFile);
async function main(): Promise<void> {
  const [workspace, command, ...args] = process.argv.slice(2);
  if (!workspace || resolve(workspace) !== workspace) throw new Error("Expected absolute workspace root");
  const store = new ArchiveStore({ workspaceRoot: workspace, projectId: "configuration-check" });
  const configPath = await store.safePath(".runtime/archive/config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as ArchiveConfig;
  if (config.workspaceRoot !== workspace || !/^[A-Za-z0-9_-]{1,128}$/.test(config.projectId)) throw new Error("Invalid archive configuration");
  const archive = new ArchiveStore(config);
  const flags = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]; const value = args[index + 1];
    if (!flag?.startsWith("--") || !value) throw new Error("Expected --flag value pairs");
    flags.set(flag, [...(flags.get(flag) ?? []), value]);
  }
  const single = (flag: string, fallback?: string) => {
    const values = flags.get(flag) ?? [];
    if (values.length > 1 || (!values.length && fallback === undefined)) throw new Error(`Expected one ${flag}`);
    return values[0] ?? fallback!;
  };
  const allowed = command === "task" ? ["--thread", "--collection", "--status", "--outcome"] : command === "preview" ? ["--thread", "--message", "--file"] : command === "apply" ? ["--plan", "--confirm"] : [];
  for (const flag of flags.keys()) if (!allowed.includes(flag)) throw new Error("Unknown option");
  const syncIndex = async (paths: string[]) => {
    const executable = await archive.safePath("tools/memory-runtime");
    // No shell, no caller-selected executable, no tool output in public bridge status.
    await execFileAsync(executable, ["forget-index", ...paths], { cwd: workspace, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
  };
  if (command === "task") {
    await archive.task(single("--thread"), { collection: single("--collection") as Collection, status: single("--status", "active") as TaskStatus, outcome: single("--outcome", ""), updatedAt: new Date().toISOString() });
    process.stdout.write("Task bookkeeping saved.\n");
  } else if (command === "preview") {
    const plan = await archive.previewForget(single("--thread", "") || null, flags.get("--message") ?? [], flags.get("--file") ?? []);
    process.stdout.write(`${JSON.stringify({ ...plan, warning: "Review the listed files and source IDs. Applying removes assistant-owned records only; T3 history and backups require separate deletion." }, null, 2)}\n`);
  } else if (command === "apply") {
    await archive.applyForget(single("--plan"), single("--confirm"), syncIndex);
    process.stdout.write("Reviewed material removed; index refreshed. T3 history and backups are unchanged.\n");
  } else if (command === "resume-forget") {
    await archive.finishForget(syncIndex);
    process.stdout.write("Previously approved forget operation finished; index refreshed.\n");
  } else throw new Error("Usage: assistant-archive task|preview|apply|resume-forget [--flag value]");
}
main().catch((error: unknown) => {
  // execFile errors can contain raw child logs. Keep those out of surfaced errors.
  const message = error instanceof Error && !('cmd' in error) ? error.message : "Index refresh failed; run resume-forget after correcting memory runtime";
  process.stderr.write(`${message}\n`); process.exitCode = 1;
});
