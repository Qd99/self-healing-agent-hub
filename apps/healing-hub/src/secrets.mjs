import { readFileSync } from "node:fs";

/**
 * Reads a secret from `NAME_FILE` when it is set, otherwise from `NAME`.
 *
 * Keeping the value in a 0600 file instead of the process environment means a
 * crash dump or a `/proc/<pid>/environ` read does not expose the credential.
 * The file path is resolved once at startup; a missing or unreadable file
 * fails closed rather than silently degrading to an unauthenticated client.
 */
export function readSecret(env, name) {
  const file = env[`${name}_FILE`]?.trim();
  if (file) {
    let value;
    try {
      value = readFileSync(file, "utf8");
    } catch {
      throw new Error(`${name}_FILE could not be read.`);
    }
    return value.trim();
  }
  return env[name]?.trim() || "";
}

/** Reads a secret from a file only; the value never enters the environment. */
export function readSecretFile(env, name) {
  const file = env[`${name}_FILE`]?.trim();
  if (!file) return "";
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    throw new Error(`${name}_FILE could not be read.`);
  }
}
