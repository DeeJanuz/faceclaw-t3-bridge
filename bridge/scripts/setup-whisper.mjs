import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dataDirectory } from "../../scripts/portable-deployment.mjs";
const MODEL_NAME = "ggml-base.en.bin";
const MODEL_URL = new URL(
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
);
const MODEL_BYTES = 147_964_211;
const MODEL_SHA256 = "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002";
const modelDirectory = path.resolve(
  process.env.WHISPER_MODEL_DIRECTORY ||
    path.join(dataDirectory(), "models"),
);
const modelPath = path.join(modelDirectory, MODEL_NAME);

async function executableOnPath(name) {
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, process.platform === "win32" ? `${name}.exe` : name);
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue through the fixed PATH entries.
    }
  }
  return null;
}

async function ensureWhisperServer() {
  if (process.env.WHISPER_CPP_SERVER_PATH) {
    const configured = await realpath(path.resolve(process.env.WHISPER_CPP_SERVER_PATH));
    await access(configured, constants.X_OK);
    return configured;
  }
  const existing = await executableOnPath("whisper-server");
  if (existing) return existing;
  if (process.platform !== "darwin") throw new Error("Install whisper.cpp from https://github.com/ggml-org/whisper.cpp and set WHISPER_CPP_SERVER_PATH to whisper-server (whisper-server.exe on Windows).");
  const brew = await executableOnPath("brew");
  if (!brew) {
    throw new Error("Homebrew is required. Install it, then run this setup again.");
  }
  await new Promise((resolve, reject) => {
    const child = execFile(brew, ["install", "whisper-cpp"], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error("Homebrew could not install whisper-cpp."));
    });
  });
  const installed = await executableOnPath("whisper-server");
  if (!installed) throw new Error("whisper-server was not found after installation.");
  return installed;
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function ensureModel() {
  try {
    await access(modelPath);
    if ((await sha256(modelPath)) !== MODEL_SHA256) {
      throw new Error(`Existing model failed its SHA-256 check: ${modelPath}`);
    }
    return;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Existing model")) throw error;
  }

  await mkdir(modelDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(modelDirectory, `.${MODEL_NAME}.${randomUUID()}.download`);
  const temporary = await open(temporaryPath, "wx", 0o600);
  await temporary.close();
  try {
    const response = await fetch(MODEL_URL, {
      redirect: "follow",
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!response.ok || response.body === null) {
      throw new Error("The Whisper model download failed.");
    }
    const declaredBytes = Number(response.headers.get("content-length"));
    if (declaredBytes !== MODEL_BYTES) {
      throw new Error("The Whisper model download had an unexpected size.");
    }
    const hash = createHash("sha256");
    let receivedBytes = 0;
    const verify = new Transform({
      transform(chunk, _encoding, callback) {
        receivedBytes += chunk.byteLength;
        if (receivedBytes > MODEL_BYTES) {
          callback(new Error("The Whisper model download exceeded its expected size."));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      verify,
      createWriteStream(temporaryPath, { flags: "r+", mode: 0o600 }),
    );
    if (receivedBytes !== MODEL_BYTES || hash.digest("hex") !== MODEL_SHA256) {
      throw new Error("The Whisper model failed its SHA-256 check.");
    }
    await rename(temporaryPath, modelPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function main() {
  if (process.argv.length === 3 && ["--help", "-h"].includes(process.argv[2])) {
    process.stdout.write("Usage: node bridge/scripts/setup-whisper.mjs\nVerify/install whisper-server and the checksum-pinned base.en model. Windows/Linux: set WHISPER_CPP_SERVER_PATH to an installed whisper-server executable. Optional WHISPER_MODEL_DIRECTORY overrides the per-user model directory. No positional options.\n");
    return;
  }
  if (process.argv.length > 2) throw new Error("Unsupported option. Use --help.");
  const executable = await ensureWhisperServer();
  await ensureModel();
  process.stdout.write(`whisper-server: ${executable}\nmodel: ${modelPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Whisper setup failed."}\n`);
  process.exitCode = 1;
});
