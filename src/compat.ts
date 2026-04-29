const MIN_VERSION = "2026.3.22";

export function assertHostCompatibility(version?: string) {
  if (!version) {
    throw new Error(
      `openclaw-chatclaw: requires OpenClaw >= ${MIN_VERSION}, but version is unknown`,
    );
  }
  // Simple version check - in production use semver
  const [major, minor] = version.split(".").map(Number);
  const [minMajor, minMinor] = MIN_VERSION.split(".").map(Number);

  if (major < minMajor || (major === minMajor && minor < minMinor)) {
    throw new Error(
      `openclaw-chatclaw: requires OpenClaw >= ${MIN_VERSION}, but found ${version}`,
    );
  }
}
