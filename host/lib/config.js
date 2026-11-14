// Shared constants and user config. No deps.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_NAME = "io.openbrowser.mcp";
export const EXTENSION_ID = "egpoedeomkhpkhiikghpjjcghafafbdc";
export const SERVER_NAME = "openbrowser";

// extension/manifest.json is the one place the version is set: the host always runs from the same
// checkout, and Chromium reports the extension's version from that file. An unreadable manifest must not
// take the host down over a label.
export const VERSION = (() => {
  try {
    const manifest = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "extension", "manifest.json");
    return JSON.parse(fs.readFileSync(manifest, "utf-8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
export const PROTOCOL_VERSION = "2025-06-18";

// 18766, not 18765: the parent repo owns 18765 and speaks a subtly different
// protocol, so sharing the port makes an old broker answer new agents.
export const DEFAULT_PORT = 18766;
export const LEGACY_PORT = 18765;

const DEFAULTS = {
  port: DEFAULT_PORT,
  outDir: "./source",
  captureBodies: true,
  maxResultSizeChars: 20000,
};

export function configDir() {
  return path.join(os.homedir(), ".config", "openbrowser-mcp");
}

export function configPath() {
  return path.join(configDir(), "config.json");
}

export function spoolDir() {
  return path.join(configDir(), "spool");
}

export function loadConfig() {
  let user = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), "utf-8"));
    if (parsed && typeof parsed === "object") user = parsed;
  } catch {
    // no config file, or unreadable/malformed — defaults are the contract
  }
  const config = { ...DEFAULTS, ...user };
  const port = Number(config.port);
  config.port = Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
  config.captureBodies = config.captureBodies !== false;
  return config;
}

export function pidfilePath(port = DEFAULT_PORT) {
  return path.join(os.tmpdir(), `openbrowser-mcp-${port}.pid`);
}

// Both ancestors' pidfile names, on the legacy port and on ours. A stale broker
// from either repo has to be detected and cleaned rather than fought with.
const LEGACY_PIDFILE_NAMES = ["unblocked-chrome-mcp", "open-claude-in-chrome-mcp"];

export function legacyPidfilePaths(port = DEFAULT_PORT) {
  const ports = port === LEGACY_PORT ? [LEGACY_PORT] : [LEGACY_PORT, port];
  const paths = [];
  for (const name of LEGACY_PIDFILE_NAMES) {
    for (const p of ports) paths.push(path.join(os.tmpdir(), `${name}-${p}.pid`));
  }
  return paths;
}
