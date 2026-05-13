import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  ensureAuthProfileStore,
  resolveDefaultAgentDir,
  resolveProviderIdForAuth,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import {
  CODEX_PLUGINS_MARKETPLACE_NAME,
  normalizeCodexServiceTier,
  type CodexAppServerApprovalPolicy,
  type CodexAppServerSandboxMode,
} from "./config.js";
import type { PluginAppPolicyContext } from "./plugin-thread-config.js";
import type { CodexServiceTier } from "./protocol.js";

const CODEX_APP_SERVER_NATIVE_AUTH_PROVIDER = "openai-codex";
const PUBLIC_OPENAI_MODEL_PROVIDER = "openai";

type ProviderAuthAliasLookupParams = Parameters<typeof resolveProviderIdForAuth>[1];
type ProviderAuthAliasConfig = NonNullable<ProviderAuthAliasLookupParams>["config"];

export type CodexAppServerAuthProfileLookup = {
  authProfileId?: string;
  authProfileStore?: AuthProfileStore;
  agentDir?: string;
  config?: ProviderAuthAliasConfig;
  isolationKey?: string;
};

export type CodexAppServerThreadBinding = {
  schemaVersion: 1;
  threadId: string;
  sessionFile: string;
  isolationKey?: string;
  cwd: string;
  authProfileId?: string;
  model?: string;
  modelProvider?: string;
  approvalPolicy?: CodexAppServerApprovalPolicy;
  sandbox?: CodexAppServerSandboxMode;
  serviceTier?: CodexServiceTier;
  dynamicToolsFingerprint?: string;
  pluginAppsFingerprint?: string;
  pluginAppsInputFingerprint?: string;
  pluginAppPolicyContext?: PluginAppPolicyContext;
  createdAt: string;
  updatedAt: string;
};

export function resolveCodexAppServerBindingPath(
  sessionFile: string,
  options: { isolationKey?: string } = {},
): string {
  const isolationKey = normalizeCodexAppServerBindingIsolationKey(options.isolationKey);
  if (!isolationKey) {
    return `${sessionFile}.codex-app-server.json`;
  }
  const digest = crypto.createHash("sha256").update(isolationKey).digest("hex").slice(0, 16);
  return `${sessionFile}.codex-app-server.${digest}.json`;
}

export async function readCodexAppServerBinding(
  sessionFile: string,
  lookup: Omit<CodexAppServerAuthProfileLookup, "authProfileId"> = {},
): Promise<CodexAppServerThreadBinding | undefined> {
  const isolationKey = normalizeCodexAppServerBindingIsolationKey(lookup.isolationKey);
  const path = resolveCodexAppServerBindingPath(sessionFile, { isolationKey });
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    embeddedAgentLog.warn("failed to read codex app-server binding", { path, error });
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CodexAppServerThreadBinding>;
    if (parsed.schemaVersion !== 1 || typeof parsed.threadId !== "string") {
      return undefined;
    }
    const parsedIsolationKey =
      typeof parsed.isolationKey === "string" && parsed.isolationKey.trim()
        ? parsed.isolationKey.trim()
        : undefined;
    if (parsedIsolationKey !== isolationKey) {
      return undefined;
    }
    const authProfileId =
      typeof parsed.authProfileId === "string" ? parsed.authProfileId : undefined;
    return {
      schemaVersion: 1,
      threadId: parsed.threadId,
      sessionFile,
      isolationKey: parsedIsolationKey,
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
      authProfileId,
      model: typeof parsed.model === "string" ? parsed.model : undefined,
      modelProvider: normalizeCodexAppServerBindingModelProvider({
        ...lookup,
        authProfileId,
        modelProvider: typeof parsed.modelProvider === "string" ? parsed.modelProvider : undefined,
      }),
      approvalPolicy: readApprovalPolicy(parsed.approvalPolicy),
      sandbox: readSandboxMode(parsed.sandbox),
      serviceTier: readServiceTier(parsed.serviceTier),
      dynamicToolsFingerprint:
        typeof parsed.dynamicToolsFingerprint === "string"
          ? parsed.dynamicToolsFingerprint
          : undefined,
      pluginAppsFingerprint:
        typeof parsed.pluginAppsFingerprint === "string" ? parsed.pluginAppsFingerprint : undefined,
      pluginAppsInputFingerprint:
        typeof parsed.pluginAppsInputFingerprint === "string"
          ? parsed.pluginAppsInputFingerprint
          : undefined,
      pluginAppPolicyContext: readPluginAppPolicyContext(parsed.pluginAppPolicyContext),
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch (error) {
    embeddedAgentLog.warn("failed to parse codex app-server binding", { path, error });
    return undefined;
  }
}

export async function writeCodexAppServerBinding(
  sessionFile: string,
  binding: Omit<
    CodexAppServerThreadBinding,
    "schemaVersion" | "sessionFile" | "createdAt" | "updatedAt"
  > & {
    createdAt?: string;
  },
  lookup: Omit<CodexAppServerAuthProfileLookup, "authProfileId"> = {},
): Promise<void> {
  const now = new Date().toISOString();
  const isolationKey = normalizeCodexAppServerBindingIsolationKey(
    lookup.isolationKey ?? binding.isolationKey,
  );
  const payload: CodexAppServerThreadBinding = {
    schemaVersion: 1,
    sessionFile,
    isolationKey,
    threadId: binding.threadId,
    cwd: binding.cwd,
    authProfileId: binding.authProfileId,
    model: binding.model,
    modelProvider: normalizeCodexAppServerBindingModelProvider({
      ...lookup,
      authProfileId: binding.authProfileId,
      modelProvider: binding.modelProvider,
    }),
    approvalPolicy: binding.approvalPolicy,
    sandbox: binding.sandbox,
    serviceTier: binding.serviceTier,
    dynamicToolsFingerprint: binding.dynamicToolsFingerprint,
    pluginAppsFingerprint: binding.pluginAppsFingerprint,
    pluginAppsInputFingerprint: binding.pluginAppsInputFingerprint,
    pluginAppPolicyContext: binding.pluginAppPolicyContext,
    createdAt: binding.createdAt ?? now,
    updatedAt: now,
  };
  await fs.writeFile(
    resolveCodexAppServerBindingPath(sessionFile, { isolationKey }),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
}

function readPluginAppPolicyContext(value: unknown): PluginAppPolicyContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.fingerprint !== "string") {
    return undefined;
  }
  const apps = record.apps;
  if (!apps || typeof apps !== "object" || Array.isArray(apps)) {
    return undefined;
  }
  const parsedApps: PluginAppPolicyContext["apps"] = {};
  for (const [appId, rawEntry] of Object.entries(apps)) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      return undefined;
    }
    const entry = rawEntry as Record<string, unknown>;
    if (
      "appId" in entry ||
      typeof entry.configKey !== "string" ||
      entry.marketplaceName !== CODEX_PLUGINS_MARKETPLACE_NAME ||
      typeof entry.pluginName !== "string" ||
      typeof entry.allowDestructiveActions !== "boolean" ||
      !Array.isArray(entry.mcpServerNames) ||
      entry.mcpServerNames.some((serverName) => typeof serverName !== "string")
    ) {
      return undefined;
    }
    parsedApps[appId] = {
      configKey: entry.configKey,
      marketplaceName: entry.marketplaceName,
      pluginName: entry.pluginName,
      allowDestructiveActions: entry.allowDestructiveActions,
      mcpServerNames: entry.mcpServerNames,
    };
  }
  const parsedPluginAppIds: PluginAppPolicyContext["pluginAppIds"] = {};
  const rawPluginAppIds = record.pluginAppIds;
  if (rawPluginAppIds && (typeof rawPluginAppIds !== "object" || Array.isArray(rawPluginAppIds))) {
    return undefined;
  }
  if (rawPluginAppIds && typeof rawPluginAppIds === "object") {
    for (const [configKey, appIds] of Object.entries(rawPluginAppIds)) {
      if (!Array.isArray(appIds) || appIds.some((appId) => typeof appId !== "string")) {
        return undefined;
      }
      parsedPluginAppIds[configKey] = appIds;
    }
  }
  return {
    fingerprint: record.fingerprint,
    apps: parsedApps,
    pluginAppIds: parsedPluginAppIds,
  };
}

export async function clearCodexAppServerBinding(
  sessionFile: string,
  options: { isolationKey?: string } = {},
): Promise<void> {
  const isolationKey = normalizeCodexAppServerBindingIsolationKey(options.isolationKey);
  try {
    await fs.unlink(resolveCodexAppServerBindingPath(sessionFile, { isolationKey }));
  } catch (error) {
    if (!isNotFound(error)) {
      embeddedAgentLog.warn("failed to clear codex app-server binding", { sessionFile, error });
    }
  }
}

export async function clearAllCodexAppServerBindings(sessionFile: string): Promise<void> {
  const dir = path.dirname(sessionFile);
  const base = path.basename(sessionFile);
  const prefix = `${base}.codex-app-server`;
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if (isNotFound(error)) {
      return;
    }
    embeddedAgentLog.warn("failed to list codex app-server binding directory", {
      sessionFile,
      error,
    });
    return;
  }
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry === `${prefix}.json` || (entry.startsWith(`${prefix}.`) && entry.endsWith(".json")),
      )
      .map((entry) => unlinkCodexAppServerBindingPath(path.join(dir, entry), sessionFile)),
  );
}

async function unlinkCodexAppServerBindingPath(
  bindingPath: string,
  sessionFile: string,
): Promise<void> {
  try {
    await fs.unlink(bindingPath);
  } catch (error) {
    if (!isNotFound(error)) {
      embeddedAgentLog.warn("failed to clear codex app-server binding", { sessionFile, error });
    }
  }
}

function normalizeCodexAppServerBindingIsolationKey(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export function isCodexAppServerNativeAuthProfile(
  lookup: CodexAppServerAuthProfileLookup,
): boolean {
  const authProfileId = lookup.authProfileId?.trim();
  if (!authProfileId) {
    return false;
  }
  try {
    const credential = resolveCodexAppServerAuthProfileCredential({
      ...lookup,
      authProfileId,
    });
    return isCodexAppServerNativeAuthProvider({
      provider: credential?.provider,
      config: lookup.config,
    });
  } catch (error) {
    embeddedAgentLog.debug("failed to resolve codex app-server auth profile provider", {
      authProfileId,
      error,
    });
    return false;
  }
}

export function normalizeCodexAppServerBindingModelProvider(params: {
  authProfileId?: string;
  modelProvider?: string;
  authProfileStore?: AuthProfileStore;
  agentDir?: string;
  config?: ProviderAuthAliasConfig;
}): string | undefined {
  const modelProvider = params.modelProvider?.trim();
  if (!modelProvider) {
    return undefined;
  }
  if (
    isCodexAppServerNativeAuthProfile(params) &&
    modelProvider.toLowerCase() === PUBLIC_OPENAI_MODEL_PROVIDER
  ) {
    return undefined;
  }
  return modelProvider;
}

function resolveCodexAppServerAuthProfileCredential(
  lookup: CodexAppServerAuthProfileLookup,
): AuthProfileStore["profiles"][string] | undefined {
  const authProfileId = lookup.authProfileId?.trim();
  if (!authProfileId) {
    return undefined;
  }
  const store =
    lookup.authProfileStore ?? loadCodexAppServerAuthProfileStore(lookup.agentDir, lookup.config);
  return store.profiles[authProfileId];
}

function loadCodexAppServerAuthProfileStore(
  agentDir: string | undefined,
  config?: ProviderAuthAliasConfig,
): AuthProfileStore {
  return ensureAuthProfileStore(agentDir?.trim() || resolveDefaultAgentDir(config ?? {}), {
    allowKeychainPrompt: false,
  });
}

function isCodexAppServerNativeAuthProvider(params: {
  provider?: string;
  config?: ProviderAuthAliasConfig;
}): boolean {
  const provider = params.provider?.trim();
  return Boolean(
    provider &&
    resolveProviderIdForAuth(provider, { config: params.config }) ===
      CODEX_APP_SERVER_NATIVE_AUTH_PROVIDER,
  );
}

function readApprovalPolicy(value: unknown): CodexAppServerApprovalPolicy | undefined {
  return value === "never" ||
    value === "on-request" ||
    value === "on-failure" ||
    value === "untrusted"
    ? value
    : undefined;
}

function readSandboxMode(value: unknown): CodexAppServerSandboxMode | undefined {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access"
    ? value
    : undefined;
}

function readServiceTier(value: unknown): CodexServiceTier | undefined {
  return normalizeCodexServiceTier(value);
}
