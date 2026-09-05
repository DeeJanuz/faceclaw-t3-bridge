/** Log only bounded HTTP(S) origins, never URL credentials, paths, or query data. */
export function diagnosticOrigin(value: unknown): string {
  if (value === undefined) return "[missing]";
  if (value === "null") return "null";
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    !/^[\x21-\x7e]+$/.test(value) ||
    !/^https?:\/\/[^/?#\\]+$/i.test(value)
  ) {
    return "[invalid]";
  }
  try {
    const url = new URL(value);
    if (url.username || url.password || url.origin === "null") return "[invalid]";
    return url.origin;
  } catch {
    return "[invalid]";
  }
}
