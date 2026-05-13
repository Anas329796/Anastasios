import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { isDangerousHostEnvVarName, normalizeEnvVarKey } from "../infra/host-env-security.js";
import { collectConfigServiceEnvVars } from "./config-env-vars.js";
import { resolveStateDir } from "./paths.js";
import type { OpenClawConfig } from "./types.js";

// `~/.openclaw/.env` is an operator-curated, owner-only durable service env
// source. Keys that are blocked only as agent request-overrides
// (`isDangerousHostEnvOverrideVarName`, e.g. `GH_TOKEN`, `AWS_*`, `NPM_TOKEN`)
// are intentionally allowed here; the gateway exec layer decides whether to
// inherit them per its trusted-mode allowlist. Keys that are dangerous
// everywhere (`LD_PRELOAD`, `NODE_OPTIONS`, `BASH_ENV`, `DYLD_*`, `GIT_DIR`,
// etc.) stay blocked.
function isBlockedServiceEnvVar(key: string): boolean {
  return isDangerousHostEnvVarName(key);
}

function parseStateDirDotEnvContent(content: string): Record<string, string> {
  const parsed = dotenv.parse(content);
  const entries: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(parsed)) {
    if (!value?.trim()) {
      continue;
    }
    const key = normalizeEnvVarKey(rawKey, { portable: true });
    if (!key) {
      continue;
    }
    if (isBlockedServiceEnvVar(key)) {
      continue;
    }
    entries[key] = value;
  }
  return entries;
}

export function readStateDirDotEnvVarsFromStateDir(stateDir: string): Record<string, string> {
  const dotEnvPath = path.join(stateDir, ".env");
  try {
    return parseStateDirDotEnvContent(fs.readFileSync(dotEnvPath, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Read and parse `~/.openclaw/.env` (or `$OPENCLAW_STATE_DIR/.env`), returning
 * a filtered record of key-value pairs suitable for a managed service
 * environment source.
 */
export function readStateDirDotEnvVars(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const stateDir = resolveStateDir(env as NodeJS.ProcessEnv);
  return readStateDirDotEnvVarsFromStateDir(stateDir);
}

export type DurableServiceEnvVarSources = {
  stateDirDotEnvEnvironment: Record<string, string>;
  configEnvironment: Record<string, string>;
  durableEnvironment: Record<string, string>;
};

export function collectDurableServiceEnvVarSources(params: {
  env: Record<string, string | undefined>;
  config?: OpenClawConfig;
}): DurableServiceEnvVarSources {
  const stateDirDotEnvEnvironment = readStateDirDotEnvVars(params.env);
  const configEnvironment = collectConfigServiceEnvVars(params.config);
  return {
    stateDirDotEnvEnvironment,
    configEnvironment,
    durableEnvironment: {
      ...stateDirDotEnvEnvironment,
      ...configEnvironment,
    },
  };
}

/**
 * Durable service env sources survive beyond the invoking shell and are safe to
 * persist into owner-only gateway service environment sources.
 *
 * Precedence:
 * 1. state-dir `.env` file vars
 * 2. config service env vars
 */
export function collectDurableServiceEnvVars(params: {
  env: Record<string, string | undefined>;
  config?: OpenClawConfig;
}): Record<string, string> {
  return collectDurableServiceEnvVarSources(params).durableEnvironment;
}
