import { randomBytes } from "node:crypto";
import { ApiError } from "./security.js";
import type { BridgeConfig, Transcriber } from "./types.js";

const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

export function pcmToWav(pcmChunks: readonly Buffer[]): Buffer {
  const dataBytes = pcmChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = Buffer.allocUnsafe(44 + dataBytes);
  output.write("RIFF", 0, "ascii");
  output.writeUInt32LE(36 + dataBytes, 4);
  output.write("WAVE", 8, "ascii");
  output.write("fmt ", 12, "ascii");
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(CHANNELS, 22);
  output.writeUInt32LE(SAMPLE_RATE, 24);
  output.writeUInt32LE(SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8), 28);
  output.writeUInt16LE(CHANNELS * (BITS_PER_SAMPLE / 8), 32);
  output.writeUInt16LE(BITS_PER_SAMPLE, 34);
  output.write("data", 36, "ascii");
  output.writeUInt32LE(dataBytes, 40);
  let offset = 44;
  for (const chunk of pcmChunks) {
    chunk.copy(output, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function multipartBody(wav: Buffer, language: string): { boundary: string; body: Buffer } {
  const boundary = `even-t3-${randomBytes(16).toString("hex")}`;
  const field = (name: string, value: string) =>
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      "utf8",
    );
  const fileHeader = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="dictation.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
    "utf8",
  );
  const ending = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const body = Buffer.concat([
    field("response_format", "json"),
    field("language", language),
    field("temperature", "0.0"),
    field("no_context", "true"),
    fileHeader,
    wav,
    ending,
  ]);
  return { boundary, body };
}

export class WhisperCppTranscriber implements Transcriber {
  constructor(private readonly config: BridgeConfig) {}

  async transcribe(pcm: readonly Buffer[], signal: AbortSignal): Promise<string> {
    const wav = pcmToWav(pcm);
    const multipart = multipartBody(wav, this.config.whisperLanguage);
    const requestBody = new ArrayBuffer(multipart.body.byteLength);
    const requestBytes = new Uint8Array(requestBody);
    requestBytes.set(multipart.body);
    try {
      const timeout = AbortSignal.timeout(this.config.transcriptionTimeoutMs);
      const combined = AbortSignal.any([signal, timeout]);
      let response: Response;
      try {
        response = await fetch(this.config.whisperServerUrl, {
          method: "POST",
          headers: {
            "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
            "Content-Length": String(multipart.body.byteLength),
          },
          body: requestBody,
          redirect: "error",
          signal: combined,
        });
      } catch {
        if (signal.aborted) throw new ApiError(409, "voice_cancelled", "Dictation was cancelled");
        throw new ApiError(502, "transcription_unavailable", "Local speech transcription is unavailable");
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > 65_536) {
        throw new ApiError(502, "transcription_invalid_response", "Speech transcription failed");
      }
      const raw = await response.text();
      if (Buffer.byteLength(raw) > 65_536) {
        throw new ApiError(502, "transcription_invalid_response", "Speech transcription failed");
      }
      if (!response.ok) {
        throw new ApiError(502, "transcription_failed", "Speech transcription failed");
      }
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        throw new ApiError(502, "transcription_invalid_response", "Speech transcription failed");
      }
      if (!isRecord(value) || typeof value.text !== "string") {
        throw new ApiError(502, "transcription_invalid_response", "Speech transcription failed");
      }
      const text = value.text.trim();
      if (text.length === 0) throw new ApiError(422, "no_speech", "No speech was detected");
      if (text.length > this.config.maxTextChars) {
        throw new ApiError(413, "text_too_large", "Transcription is too long");
      }
      return text;
    } finally {
      requestBytes.fill(0);
      multipart.body.fill(0);
      wav.fill(0);
    }
  }
}
