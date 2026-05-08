import type { EnvHttpProxyAgent } from "undici";
import { resolveEnvHttpProxyAgentOptions } from "../proxy-env.js";
import { getActiveManagedProxyTlsOptions } from "./active-proxy-state.js";
import {
  loadManagedProxyTlsOptionsSync,
  resolveManagedProxyCaFile,
  type ManagedProxyTlsOptions,
} from "./proxy-tls.js";

export type ManagedEnvHttpProxyAgentOptions = ConstructorParameters<typeof EnvHttpProxyAgent>[0];

function isProxyTlsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readProxyTlsRecord(options: object | undefined): Record<string, unknown> | undefined {
  if (!options || !("proxyTls" in options)) {
    return undefined;
  }
  return isProxyTlsRecord(options.proxyTls) ? options.proxyTls : undefined;
}

export function resolveActiveManagedProxyTlsOptions(): ManagedProxyTlsOptions | undefined {
  const activeProxyTls = getActiveManagedProxyTlsOptions();
  if (activeProxyTls) {
    return activeProxyTls;
  }
  if (process.env["OPENCLAW_PROXY_ACTIVE"] !== "1") {
    return undefined;
  }
  const proxyCaFile = resolveManagedProxyCaFile({
    caFileOverride: process.env["OPENCLAW_PROXY_CA_FILE"],
  });
  try {
    return loadManagedProxyTlsOptionsSync(proxyCaFile);
  } catch {
    return undefined;
  }
}

export function addActiveManagedProxyTlsOptions(
  options: undefined,
): { proxyTls: ManagedProxyTlsOptions } | undefined;
export function addActiveManagedProxyTlsOptions<TOptions extends object>(
  options: TOptions,
): TOptions | (TOptions & { proxyTls: Record<string, unknown> });
export function addActiveManagedProxyTlsOptions<TOptions extends object>(
  options: TOptions | undefined,
):
  | TOptions
  | (TOptions & { proxyTls: Record<string, unknown> })
  | {
      proxyTls: ManagedProxyTlsOptions;
    }
  | undefined;
export function addActiveManagedProxyTlsOptions<TOptions extends object>(
  options: TOptions | undefined,
):
  | TOptions
  | (TOptions & { proxyTls: Record<string, unknown> })
  | { proxyTls: ManagedProxyTlsOptions }
  | undefined {
  const proxyTls = resolveActiveManagedProxyTlsOptions();
  if (!proxyTls) {
    return options;
  }
  const existingProxyTls = readProxyTlsRecord(options);
  return {
    ...(options ?? {}),
    proxyTls: {
      ...proxyTls,
      ...(existingProxyTls ?? {}),
    },
  };
}

export function resolveManagedEnvHttpProxyAgentOptions(
  env: NodeJS.ProcessEnv = process.env,
): ManagedEnvHttpProxyAgentOptions | undefined {
  return addActiveManagedProxyTlsOptions(resolveEnvHttpProxyAgentOptions(env));
}
