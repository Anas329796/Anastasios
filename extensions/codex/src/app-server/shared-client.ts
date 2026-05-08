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

type SharedCodexAppServerClientState = {
  entries: Map<string, SharedCodexAppServerClientEntry>;
};

type SharedCodexAppServerClientEntry = {
  client?: CodexAppServerClient;
  promise?: Promise<CodexAppServerClient>;
};

const SHARED_CODEX_APP_SERVER_CLIENT_STATE = Symbol.for("openclaw.codexAppServerClientState");

function getSharedCodexAppServerClientState(): SharedCodexAppServerClientState {
  const globalState = globalThis as typeof globalThis & {
    [SHARED_CODEX_APP_SERVER_CLIENT_STATE]?: SharedCodexAppServerClientState;
  };
  globalState[SHARED_CODEX_APP_SERVER_CLIENT_STATE] ??= { entries: new Map() };
  return globalState[SHARED_CODEX_APP_SERVER_CLIENT_STATE];
}

function deleteSharedEntryIfCurrent(
  state: SharedCodexAppServerClientState,
  key: string,
  entry: SharedCodexAppServerClientEntry,
): boolean {
  if (state.entries.get(key) !== entry) {
    return false;
  }
  state.entries.delete(key);
  return true;
}

function isCodexAppServerClient(
  client: CodexAppServerClient | undefined,
): client is CodexAppServerClient {
  return client !== undefined;
}

export async function getSharedCodexAppServerClient(options?: {
  startOptions?: CodexAppServerStartOptions;
  timeoutMs?: number;
  authProfileId?: string;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
}): Promise<CodexAppServerClient> {
  const state = getSharedCodexAppServerClientState();
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
  let entry = state.entries.get(key);
  if (!entry) {
    entry = {};
    state.entries.set(key, entry);
  }
  const sharedPromise =
    entry.promise ??
    (entry.promise = (async () => {
      const client = CodexAppServerClient.start(startOptions);
      entry.client = client;
      client.addCloseHandler(clearSharedClientIfCurrent);
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
    if (entry.promise === sharedPromise && deleteSharedEntryIfCurrent(state, key, entry)) {
      entry.client?.close();
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
  state.entries.clear();
}

export function clearSharedCodexAppServerClient(): void {
  const state = getSharedCodexAppServerClientState();
  const clients = [...state.entries.values()]
    .map((entry) => entry.client)
    .filter(isCodexAppServerClient);
  state.entries.clear();
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
  for (const [key, entry] of state.entries) {
    if (entry.client !== client) {
      continue;
    }
    state.entries.delete(key);
    client.close();
    return true;
  }
  return false;
}

export async function clearSharedCodexAppServerClientAndWait(options?: {
  exitTimeoutMs?: number;
  forceKillDelayMs?: number;
}): Promise<void> {
  const state = getSharedCodexAppServerClientState();
  const clients = [...state.entries.values()]
    .map((entry) => entry.client)
    .filter(isCodexAppServerClient);
  state.entries.clear();
  await Promise.all(clients.map((client) => client.closeAndWait(options)));
}

function clearSharedClientIfCurrent(client: CodexAppServerClient): void {
  const state = getSharedCodexAppServerClientState();
  for (const [key, entry] of state.entries) {
    if (entry.client === client) {
      state.entries.delete(key);
      return;
    }
  }
}
