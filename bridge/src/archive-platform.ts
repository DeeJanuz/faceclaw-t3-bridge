/** Archive files require POSIX ownership, no-follow opens, and directory fsync. */
export function assertArchivePlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error("Assistant archive is supported only on macOS and Linux; leave BRIDGE_ARCHIVE_PROJECT_ID and BRIDGE_ARCHIVE_WORKSPACE_ROOT unset on Windows");
  }
}
