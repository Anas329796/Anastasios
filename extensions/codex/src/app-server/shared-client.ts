import { resolveDefaultAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import {
  applyCodexAppServerAuthProfile,
  bridgeCodexAppServerStartOptions,
  resolveCodexAppServerAuthProfileIdForAgent,
} from "./auth-bridge.js";
import { CodexAppServerClient } from "./client.js";
import {
  codexAppServerStartOptionsKey,
  resolveCodexAppServerRuntimeOptions,
  type CodexAppServerStartOptions,
} from "./config.js";
import { resolveManagedCodexAppServerStartOptions } from "./managed-binary.js";
import { withTimeout } from "./timeout.js";

type SharedCodexAppServerClientEntry = {
  client?: CodexAppServerClient;
  promise?: Promise<CodexAppServerClient>;
  key?: string;
};

type SharedCodexAppServerClientState = {
  entries?: Map<string, SharedCodexAppServerClientEntry>;
  client?: CodexAppServerClient;
  promise?: Promise<CodexAppServerClient>;
  key?: string;
};

const SHARED_CODEX_APP_SERVER_CLIENT_STATE = Symbol.for("openclaw.codexAppServerClientState");

function getSharedCodexAppServerClientState(): SharedCodexAppServerClientState {
  const globalState = globalThis as typeof globalThis & {
    [SHARED_CODEX_APP_SERVER_CLIENT_STATE]?: SharedCodexAppServerClientState;
  };
  globalState[SHARED_CODEX_APP_SERVER_CLIENT_STATE] ??= {};
  return globalState[SHARED_CODEX_APP_SERVER_CLIENT_STATE];
}

export async function getSharedCodexAppServerClient(options?: {
  startOptions?: CodexAppServerStartOptions;
  timeoutMs?: number;
  authProfileId?: string;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
  isolationKey?: string;
}): Promise<CodexAppServerClient> {
  const state = getSharedCodexAppServerClientState();
  const isolationKey = resolveSharedCodexAppServerClientIsolationKey(options?.isolationKey);
  const agentDir = options?.agentDir ?? resolveDefaultAgentDir(options?.config ?? {});
  const authProfileId = resolveCodexAppServerAuthProfileIdForAgent({
    authProfileId: options?.authProfileId,
    agentDir,
    config: options?.config,
  });
  const requestedStartOptions =
    options?.startOptions ?? resolveCodexAppServerRuntimeOptions().start;
  const managedStartOptions = await resolveManagedCodexAppServerStartOptions(requestedStartOptions);
  const startOptions = await bridgeCodexAppServerStartOptions({
    startOptions: managedStartOptions,
    agentDir,
    authProfileId,
    config: options?.config,
  });
  const key = codexAppServerStartOptionsKey(startOptions, {
    authProfileId,
    agentDir,
  });
  const entries = getSharedCodexAppServerClientEntries(state);
  let entry = entries.get(isolationKey);
  if (entry?.key && entry.key !== key) {
    closeSharedCodexAppServerClientEntry(state, isolationKey, entry);
    entry = undefined;
  }
  if (!entry) {
    entry = {};
    entries.set(isolationKey, entry);
  }
  entry.key = key;
  const sharedPromise =
    entry.promise ??
    (entry.promise = (async () => {
      const client = CodexAppServerClient.start(startOptions);
      entry.client = client;
      client.addCloseHandler((closedClient) =>
        clearSharedClientEntryIfCurrent(isolationKey, closedClient),
      );
      try {
        await client.initialize();
        await applyCodexAppServerAuthProfile({
          client,
          agentDir,
          authProfileId,
          startOptions,
          config: options?.config,
        });
        return client;
      } catch (error) {
        // Startup failures happen before callers own the shared client, so close
        // the child here instead of leaving a rejected daemon attached to stdio.
        client.close();
        throw error;
      }
    })());
  try {
    return await withTimeout(
      sharedPromise,
      options?.timeoutMs ?? 0,
      "codex app-server initialize timed out",
    );
  } catch (error) {
    const current = getSharedCodexAppServerClientEntries(state).get(isolationKey);
    if (current?.promise === sharedPromise && current.key === key) {
      closeSharedCodexAppServerClientEntry(state, isolationKey, current);
    }
    throw error;
  }
}

export async function createIsolatedCodexAppServerClient(options?: {
  startOptions?: CodexAppServerStartOptions;
  timeoutMs?: number;
  authProfileId?: string;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
}): Promise<CodexAppServerClient> {
  const agentDir = options?.agentDir ?? resolveDefaultAgentDir(options?.config ?? {});
  const authProfileId = resolveCodexAppServerAuthProfileIdForAgent({
    authProfileId: options?.authProfileId,
    agentDir,
    config: options?.config,
  });
  const requestedStartOptions =
    options?.startOptions ?? resolveCodexAppServerRuntimeOptions().start;
  const managedStartOptions = await resolveManagedCodexAppServerStartOptions(requestedStartOptions);
  const startOptions = await bridgeCodexAppServerStartOptions({
    startOptions: managedStartOptions,
    agentDir,
    authProfileId,
    config: options?.config,
  });
  const client = CodexAppServerClient.start(startOptions);
  const initialize = client.initialize();
  try {
    await withTimeout(initialize, options?.timeoutMs ?? 0, "codex app-server initialize timed out");
    await applyCodexAppServerAuthProfile({
      client,
      agentDir,
      authProfileId,
      startOptions,
      config: options?.config,
    });
    return client;
  } catch (error) {
    client.close();
    void initialize.catch(() => undefined);
    throw error;
  }
}

export function resetSharedCodexAppServerClientForTests(): void {
  const state = getSharedCodexAppServerClientState();
  state.entries = undefined;
  state.client = undefined;
  state.promise = undefined;
  state.key = undefined;
}

export function clearSharedCodexAppServerClient(): void {
  const state = getSharedCodexAppServerClientState();
  const clients = collectSharedCodexAppServerClients(state);
  state.entries = undefined;
  state.client = undefined;
  state.promise = undefined;
  state.key = undefined;
  for (const client of clients) {
    client.close();
  }
}

export function clearSharedCodexAppServerClientIfCurrent(
  client: CodexAppServerClient | undefined,
): boolean {
  if (!client) {
    return false;
  }
  const state = getSharedCodexAppServerClientState();
  const entries = getSharedCodexAppServerClientEntries(state);
  for (const [isolationKey, entry] of entries) {
    if (entry.client === client) {
      closeSharedCodexAppServerClientEntry(state, isolationKey, entry);
      return true;
    }
  }
  return false;
}

export function clearSharedCodexAppServerClientForIsolationKey(
  isolationKey: string | undefined,
): boolean {
  const resolvedIsolationKey = isolationKey?.trim();
  if (!resolvedIsolationKey) {
    return false;
  }
  const state = getSharedCodexAppServerClientState();
  const entry = getSharedCodexAppServerClientEntries(state).get(resolvedIsolationKey);
  if (!entry) {
    return false;
  }
  closeSharedCodexAppServerClientEntry(state, resolvedIsolationKey, entry);
  return true;
}

export async function clearSharedCodexAppServerClientAndWait(options?: {
  exitTimeoutMs?: number;
  forceKillDelayMs?: number;
}): Promise<void> {
  const state = getSharedCodexAppServerClientState();
  const clients = collectSharedCodexAppServerClients(state);
  state.entries = undefined;
  state.client = undefined;
  state.promise = undefined;
  state.key = undefined;
  await Promise.all(clients.map((client) => client.closeAndWait(options)));
}

function getSharedCodexAppServerClientEntries(
  state: SharedCodexAppServerClientState,
): Map<string, SharedCodexAppServerClientEntry> {
  if (state.entries) {
    return state.entries;
  }
  state.entries = new Map();
  if (state.client || state.promise || state.key) {
    state.entries.set(DEFAULT_SHARED_CODEX_APP_SERVER_CLIENT_ISOLATION_KEY, {
      client: state.client,
      promise: state.promise,
      key: state.key,
    });
    state.client = undefined;
    state.promise = undefined;
    state.key = undefined;
  }
  return state.entries;
}

const DEFAULT_SHARED_CODEX_APP_SERVER_CLIENT_ISOLATION_KEY = "agent";

function resolveSharedCodexAppServerClientIsolationKey(isolationKey: string | undefined): string {
  return isolationKey?.trim() || DEFAULT_SHARED_CODEX_APP_SERVER_CLIENT_ISOLATION_KEY;
}

function collectSharedCodexAppServerClients(
  state: SharedCodexAppServerClientState,
): CodexAppServerClient[] {
  const clients = new Set<CodexAppServerClient>();
  for (const entry of getSharedCodexAppServerClientEntries(state).values()) {
    if (entry.client) {
      clients.add(entry.client);
    }
  }
  if (state.client) {
    clients.add(state.client);
  }
  return [...clients];
}

function closeSharedCodexAppServerClientEntry(
  state: SharedCodexAppServerClientState,
  isolationKey: string,
  entry: SharedCodexAppServerClientEntry,
): void {
  const entries = getSharedCodexAppServerClientEntries(state);
  if (entries.get(isolationKey) === entry) {
    entries.delete(isolationKey);
  }
  entry.promise = undefined;
  entry.key = undefined;
  const client = entry.client;
  entry.client = undefined;
  client?.close();
}

function clearSharedClientEntryIfCurrent(isolationKey: string, client: CodexAppServerClient): void {
  const state = getSharedCodexAppServerClientState();
  const entry = getSharedCodexAppServerClientEntries(state).get(isolationKey);
  if (entry?.client !== client) {
    return;
  }
  entry.client = undefined;
  entry.promise = undefined;
  entry.key = undefined;
  state.entries?.delete(isolationKey);
}
