import crypto from "node:crypto";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import type {
  JsonSchemaType,
  JsonSchemaValidator,
  jsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation/types.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { redactSensitiveUrlLikeString } from "../shared/net/redact-sensitive-url.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { loadEmbeddedPiMcpConfig } from "./embedded-pi-mcp.js";
import { isMcpConfigRecord } from "./mcp-config-shared.js";
import { resolveMcpTransport } from "./mcp-transport.js";
import { sanitizeServerName } from "./pi-bundle-mcp-names.js";
import type {
  McpCatalogTool,
  McpServerCatalog,
  McpToolCatalog,
  SessionMcpRuntime,
  SessionMcpRuntimeManager,
} from "./pi-bundle-mcp-types.js";

type BundleMcpSession = {
  serverName: string;
  client: Client;
  transport: Transport;
  transportType: "stdio" | "sse" | "streamable-http";
  detachStderr?: () => void;
};

type LoadedMcpConfig = ReturnType<typeof loadEmbeddedPiMcpConfig>;
type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
type CreateSessionMcpRuntime = (
  params: Parameters<typeof createSessionMcpRuntime>[0] & { configFingerprint?: string },
) => SessionMcpRuntime;

const require = createRequire(import.meta.url);
const SESSION_MCP_RUNTIME_MANAGER_KEY = Symbol.for("openclaw.sessionMcpRuntimeManager");
const DRAFT_2020_12_SCHEMA = "https://json-schema.org/draft/2020-12/schema";
const DEFAULT_SESSION_MCP_RUNTIME_IDLE_TTL_MS = 10 * 60 * 1000;
const SESSION_MCP_RUNTIME_SWEEP_INTERVAL_MS = 60 * 1000;

type Ajv2020Like = {
  compile: (schema: JsonSchemaType) => ValidateFunction;
  errorsText: (errors?: ErrorObject[] | null) => string;
};

function isDraft202012Schema(schema: JsonSchemaType): boolean {
  return (schema as { $schema?: unknown }).$schema === DRAFT_2020_12_SCHEMA;
}

export function createBundleMcpJsonSchemaValidator(): jsonSchemaValidator {
  const defaultValidator = new AjvJsonSchemaValidator();
  const Ajv2020Ctor = require("ajv/dist/2020") as new (opts?: object) => Ajv2020Like;
  const ajv2020 = new Ajv2020Ctor({
    strict: false,
    validateFormats: false,
    validateSchema: false,
    allErrors: true,
  });

  return {
    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
      if (!isDraft202012Schema(schema)) {
        return defaultValidator.getValidator<T>(schema);
      }
      const ajvValidator = ajv2020.compile(schema);
      return (input: unknown) => {
        const valid = ajvValidator(input);
        if (valid) {
          return {
            valid: true,
            data: input as T,
            errorMessage: undefined,
          };
        }
        return {
          valid: false,
          data: undefined,
          errorMessage: ajv2020.errorsText(ajvValidator.errors),
        };
      };
    },
  };
}

function connectWithTimeout(
  client: Client,
  transport: Transport,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`MCP server connection timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    client.connect(transport).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function redactErrorUrls(error: unknown): string {
  return redactSensitiveUrlLikeString(String(error));
}

async function listAllTools(client: Client) {
  const tools: ListedTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

async function disposeSession(session: BundleMcpSession) {
  session.detachStderr?.();
  if (session.transportType === "streamable-http") {
    await (session.transport as StreamableHTTPClientTransport).terminateSession().catch(() => {});
  }
  await session.transport.close().catch(() => {});
  await session.client.close().catch(() => {});
}

function createCatalogFingerprint(servers: Record<string, unknown>): string {
  return crypto.createHash("sha1").update(JSON.stringify(servers)).digest("hex");
}

function loadSessionMcpConfig(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  logDiagnostics?: boolean;
}): {
  loaded: LoadedMcpConfig;
  fingerprint: string;
} {
  const loaded = loadEmbeddedPiMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
  });
  if (params.logDiagnostics !== false) {
    for (const diagnostic of loaded.diagnostics) {
      logWarn(`bundle-mcp: ${diagnostic.pluginId}: ${diagnostic.message}`);
    }
  }
  return {
    loaded,
    fingerprint: createCatalogFingerprint(loaded.mcpServers),
  };
}

function createDisposedError(sessionId: string): Error {
  return new Error(`bundle-mcp runtime disposed for session ${sessionId}`);
}

function resolveSessionMcpRuntimeIdleTtlMs(cfg?: OpenClawConfig): number {
  const raw = cfg?.mcp?.sessionIdleTtlMs;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  return DEFAULT_SESSION_MCP_RUNTIME_IDLE_TTL_MS;
}

type SessionMcpRuntimeScope = "session" | "shared";

function resolveSessionMcpRuntimeScope(cfg?: OpenClawConfig): SessionMcpRuntimeScope {
  return cfg?.mcp?.runtimeScope === "shared" ? "shared" : "session";
}

function buildSharedRuntimeKey(workspaceDir: string, configFingerprint: string): string {
  // Prefix chosen to be non-colliding with caller-supplied sessionIds, which in
  // practice look like `agent:<id>:...` or `bundle-mcp:<uuid>`.
  return `__mcp-shared__::${workspaceDir}::${configFingerprint}`;
}

export function createSessionMcpRuntime(params: {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  cfg?: OpenClawConfig;
}): SessionMcpRuntime {
  const { loaded, fingerprint: configFingerprint } = loadSessionMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    logDiagnostics: true,
  });
  const createdAt = Date.now();
  let lastUsedAt = createdAt;
  let activeLeases = 0;
  let disposed = false;
  let catalog: McpToolCatalog | null = null;
  let catalogInFlight: Promise<McpToolCatalog> | undefined;
  const sessions = new Map<string, BundleMcpSession>();
  const failIfDisposed = () => {
    if (disposed) {
      throw createDisposedError(params.sessionId);
    }
  };

  const getCatalog = async (): Promise<McpToolCatalog> => {
    failIfDisposed();
    if (catalog) {
      return catalog;
    }
    if (catalogInFlight) {
      return catalogInFlight;
    }
    catalogInFlight = (async () => {
      if (Object.keys(loaded.mcpServers).length === 0) {
        return {
          version: 1,
          generatedAt: Date.now(),
          servers: {},
          tools: [],
        };
      }

      const servers: Record<string, McpServerCatalog> = {};
      const tools: McpCatalogTool[] = [];
      const usedServerNames = new Set<string>();

      try {
        for (const [serverName, rawServer] of Object.entries(loaded.mcpServers)) {
          failIfDisposed();
          const resolved = resolveMcpTransport(serverName, rawServer);
          if (!resolved) {
            continue;
          }
          const safeServerName = sanitizeServerName(serverName, usedServerNames);
          if (safeServerName !== serverName) {
            logWarn(
              `bundle-mcp: server key "${serverName}" registered as "${safeServerName}" for provider-safe tool names.`,
            );
          }

          const client = new Client(
            {
              name: "openclaw-bundle-mcp",
              version: "0.0.0",
            },
            {
              jsonSchemaValidator: createBundleMcpJsonSchemaValidator(),
            },
          );
          const session: BundleMcpSession = {
            serverName,
            client,
            transport: resolved.transport,
            transportType: resolved.transportType,
            detachStderr: resolved.detachStderr,
          };
          sessions.set(serverName, session);

          try {
            failIfDisposed();
            await connectWithTimeout(client, resolved.transport, resolved.connectionTimeoutMs);
            failIfDisposed();
            const listedTools = await listAllTools(client);
            failIfDisposed();
            servers[serverName] = {
              serverName,
              launchSummary: resolved.description,
              toolCount: listedTools.length,
            };
            for (const tool of listedTools) {
              const toolName = tool.name.trim();
              if (!toolName) {
                continue;
              }
              tools.push({
                serverName,
                safeServerName,
                toolName,
                title: tool.title,
                description: normalizeOptionalString(tool.description),
                inputSchema: tool.inputSchema,
                fallbackDescription: `Provided by bundle MCP server "${serverName}" (${resolved.description}).`,
              });
            }
          } catch (error) {
            if (!disposed) {
              logWarn(
                `bundle-mcp: failed to start server "${serverName}" (${resolved.description}): ${redactErrorUrls(error)}`,
              );
            }
            await disposeSession(session);
            sessions.delete(serverName);
            failIfDisposed();
          }
        }

        failIfDisposed();
        return {
          version: 1,
          generatedAt: Date.now(),
          servers,
          tools,
        };
      } catch (error) {
        await Promise.allSettled(
          Array.from(sessions.values(), (session) => disposeSession(session)),
        );
        sessions.clear();
        throw error;
      }
    })();

    try {
      const nextCatalog = await catalogInFlight;
      failIfDisposed();
      catalog = nextCatalog;
      return nextCatalog;
    } finally {
      catalogInFlight = undefined;
    }
  };

  return {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    configFingerprint,
    createdAt,
    get lastUsedAt() {
      return lastUsedAt;
    },
    get activeLeases() {
      return activeLeases;
    },
    acquireLease() {
      activeLeases += 1;
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        activeLeases = Math.max(0, activeLeases - 1);
        lastUsedAt = Date.now();
      };
    },
    getCatalog,
    markUsed() {
      lastUsedAt = Date.now();
    },
    async callTool(serverName, toolName, input) {
      failIfDisposed();
      await getCatalog();
      const session = sessions.get(serverName);
      if (!session) {
        throw new Error(`bundle-mcp server "${serverName}" is not connected`);
      }
      return (await session.client.callTool({
        name: toolName,
        arguments: isMcpConfigRecord(input) ? input : {},
      })) as CallToolResult;
    },
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      catalog = null;
      catalogInFlight = undefined;
      const sessionsToClose = Array.from(sessions.values());
      sessions.clear();
      await Promise.allSettled(sessionsToClose.map((session) => disposeSession(session)));
    },
  };
}

function createSessionMcpRuntimeManager(
  opts: {
    createRuntime?: CreateSessionMcpRuntime;
    now?: () => number;
    enableIdleSweepTimer?: boolean;
    idleSweepIntervalMs?: number;
  } = {},
): SessionMcpRuntimeManager {
  // Indirection: callers address runtimes by sessionId, but we cache by an
  // internal `runtimeKey`. In session scope (default) the key is the sessionId
  // itself, preserving the legacy 1:1 relationship. In shared scope the key is
  // a hash of (workspaceDir, configFingerprint) so multiple sessions with the
  // same workspace+config share one runtime, ref-counted by attached sessionIds.
  const runtimesByKey = new Map<string, SessionMcpRuntime>();
  const runtimeKeyBySessionId = new Map<string, string>();
  const sessionIdsByRuntimeKey = new Map<string, Set<string>>();
  const sessionIdBySessionKey = new Map<string, string>();
  const idleTtlMsByRuntimeKey = new Map<string, number>();
  const createRuntime = opts.createRuntime ?? createSessionMcpRuntime;
  const now = opts.now ?? Date.now;
  const createInFlight = new Map<
    string,
    {
      promise: Promise<SessionMcpRuntime>;
      workspaceDir: string;
      configFingerprint: string;
    }
  >();
  const idleSweepIntervalMs = opts.idleSweepIntervalMs ?? SESSION_MCP_RUNTIME_SWEEP_INTERVAL_MS;
  let idleSweepTimer: ReturnType<typeof setInterval> | undefined;
  let idleSweepInFlight: Promise<void> | undefined;

  const forgetSessionKeysForSessionId = (sessionId: string) => {
    for (const [sessionKey, mappedSessionId] of sessionIdBySessionKey.entries()) {
      if (mappedSessionId === sessionId) {
        sessionIdBySessionKey.delete(sessionKey);
      }
    }
  };

  const attachSessionToRuntimeKey = (sessionId: string, runtimeKey: string) => {
    runtimeKeyBySessionId.set(sessionId, runtimeKey);
    let attached = sessionIdsByRuntimeKey.get(runtimeKey);
    if (!attached) {
      attached = new Set<string>();
      sessionIdsByRuntimeKey.set(runtimeKey, attached);
    }
    attached.add(sessionId);
  };

  const detachSessionFromRuntimeKey = (sessionId: string, runtimeKey: string) => {
    const mapped = runtimeKeyBySessionId.get(sessionId);
    if (mapped === runtimeKey) {
      runtimeKeyBySessionId.delete(sessionId);
    }
    const attached = sessionIdsByRuntimeKey.get(runtimeKey);
    if (attached) {
      attached.delete(sessionId);
      if (attached.size === 0) {
        sessionIdsByRuntimeKey.delete(runtimeKey);
      }
    }
  };

  const bumpIdleTtlForRuntimeKey = (runtimeKey: string, idleTtlMs: number) => {
    // Take the max across attached sessions so one strict-TTL session can't
    // evict a runtime another session expected to keep alive. The sweep treats
    // ttl <= 0 as "never evict", so 0 is unbounded: it wins over any nonzero
    // TTL and can't be overridden by a later attaching session.
    const previous = idleTtlMsByRuntimeKey.get(runtimeKey);
    if (previous === 0) {
      return;
    }
    if (idleTtlMs === 0 || previous === undefined || idleTtlMs > previous) {
      idleTtlMsByRuntimeKey.set(runtimeKey, idleTtlMs);
    }
  };

  const evictRuntimeByKey = async (
    runtimeKey: string,
    runtime: SessionMcpRuntime,
  ): Promise<void> => {
    runtimesByKey.delete(runtimeKey);
    idleTtlMsByRuntimeKey.delete(runtimeKey);
    const attached = sessionIdsByRuntimeKey.get(runtimeKey);
    sessionIdsByRuntimeKey.delete(runtimeKey);
    if (attached) {
      for (const sessionId of attached) {
        if (runtimeKeyBySessionId.get(sessionId) === runtimeKey) {
          runtimeKeyBySessionId.delete(sessionId);
        }
        forgetSessionKeysForSessionId(sessionId);
      }
    }
    await runtime.dispose();
  };

  const sweepIdleRuntimes = async (): Promise<number> => {
    const nowMs = now();
    const expired: { key: string; runtime: SessionMcpRuntime }[] = [];
    for (const [runtimeKey, runtime] of runtimesByKey.entries()) {
      const idleTtlMs =
        idleTtlMsByRuntimeKey.get(runtimeKey) ?? DEFAULT_SESSION_MCP_RUNTIME_IDLE_TTL_MS;
      if (idleTtlMs <= 0 || (runtime.activeLeases ?? 0) > 0) {
        continue;
      }
      if (nowMs - runtime.lastUsedAt < idleTtlMs) {
        continue;
      }
      expired.push({ key: runtimeKey, runtime });
    }
    await Promise.allSettled(expired.map(({ key, runtime }) => evictRuntimeByKey(key, runtime)));
    return expired.length;
  };

  const queueIdleSweep = () => {
    if (idleSweepInFlight) {
      return;
    }
    idleSweepInFlight = sweepIdleRuntimes()
      .then(() => undefined)
      .catch((error: unknown) => {
        logWarn(`bundle-mcp: idle runtime sweep failed: ${String(error)}`);
      })
      .finally(() => {
        idleSweepInFlight = undefined;
      });
  };

  const ensureIdleSweepTimer = () => {
    if (opts.enableIdleSweepTimer === false || idleSweepIntervalMs <= 0 || idleSweepTimer) {
      return;
    }
    idleSweepTimer = setInterval(queueIdleSweep, idleSweepIntervalMs);
    idleSweepTimer.unref?.();
  };

  const clearIdleSweepTimer = () => {
    if (!idleSweepTimer) {
      return;
    }
    clearInterval(idleSweepTimer);
    idleSweepTimer = undefined;
  };

  return {
    async getOrCreate(params) {
      const idleTtlMs = resolveSessionMcpRuntimeIdleTtlMs(params.cfg);
      const scope = resolveSessionMcpRuntimeScope(params.cfg);
      // Apply the caller's latest TTL to its currently-attached runtime BEFORE
      // the sweep, so a caller raising or disabling its TTL doesn't get an
      // avoidable cold start because the sweep ran under the previous TTL.
      // Sole owner: replace (matches main's session-scope semantics, allowing
      // lower/raise/zero). Shared: take max so a stricter caller can't evict a
      // runtime another session expected to keep alive.
      const attachedRuntimeKey = runtimeKeyBySessionId.get(params.sessionId);
      if (attachedRuntimeKey && runtimesByKey.has(attachedRuntimeKey)) {
        const attached = sessionIdsByRuntimeKey.get(attachedRuntimeKey);
        if (!attached || attached.size <= 1) {
          idleTtlMsByRuntimeKey.set(attachedRuntimeKey, idleTtlMs);
        } else {
          bumpIdleTtlForRuntimeKey(attachedRuntimeKey, idleTtlMs);
        }
      }
      await sweepIdleRuntimes();
      if (idleTtlMs > 0) {
        ensureIdleSweepTimer();
      }
      if (params.sessionKey) {
        sessionIdBySessionKey.set(params.sessionKey, params.sessionId);
      }
      const { fingerprint: nextFingerprint } = loadSessionMcpConfig({
        workspaceDir: params.workspaceDir,
        cfg: params.cfg,
        logDiagnostics: false,
      });
      const desiredRuntimeKey =
        scope === "shared"
          ? buildSharedRuntimeKey(params.workspaceDir, nextFingerprint)
          : params.sessionId;

      // If this sessionId was previously attached to a different runtime
      // (workspace, fingerprint, or scope changed), detach it. Dispose the old
      // runtime if no other sessions are still using it.
      const previousRuntimeKey = runtimeKeyBySessionId.get(params.sessionId);
      if (previousRuntimeKey && previousRuntimeKey !== desiredRuntimeKey) {
        detachSessionFromRuntimeKey(params.sessionId, previousRuntimeKey);
        if ((sessionIdsByRuntimeKey.get(previousRuntimeKey)?.size ?? 0) === 0) {
          const stalePending = createInFlight.get(previousRuntimeKey);
          const stale = runtimesByKey.get(previousRuntimeKey);
          createInFlight.delete(previousRuntimeKey);
          runtimesByKey.delete(previousRuntimeKey);
          idleTtlMsByRuntimeKey.delete(previousRuntimeKey);
          sessionIdsByRuntimeKey.delete(previousRuntimeKey);
          if (stale) {
            await stale.dispose();
          }
          if (stalePending) {
            // The pending promise's .then writes the runtime into runtimesByKey
            // under previousRuntimeKey. Wait for it to settle, drop the orphan
            // entry, and dispose the runtime so we don't leak an MCP child.
            const pendingRuntime = await stalePending.promise.catch(() => undefined);
            runtimesByKey.delete(previousRuntimeKey);
            if (pendingRuntime) {
              await pendingRuntime.dispose();
            }
          }
        }
      }

      const existing = runtimesByKey.get(desiredRuntimeKey);
      if (existing) {
        if (
          existing.workspaceDir !== params.workspaceDir ||
          existing.configFingerprint !== nextFingerprint
        ) {
          // Runtime exists at this key but reflects stale config. Tear it down
          // and recreate (mostly a session-scope concern; in shared scope the
          // key already encodes (workspaceDir, fingerprint), but a manual cache
          // poke or buggy createRuntime impl could still trip this).
          await evictRuntimeByKey(desiredRuntimeKey, existing);
        } else {
          attachSessionToRuntimeKey(params.sessionId, desiredRuntimeKey);
          bumpIdleTtlForRuntimeKey(desiredRuntimeKey, idleTtlMs);
          existing.markUsed();
          return existing;
        }
      }

      const inFlight = createInFlight.get(desiredRuntimeKey);
      if (inFlight) {
        if (
          inFlight.workspaceDir === params.workspaceDir &&
          inFlight.configFingerprint === nextFingerprint
        ) {
          attachSessionToRuntimeKey(params.sessionId, desiredRuntimeKey);
          bumpIdleTtlForRuntimeKey(desiredRuntimeKey, idleTtlMs);
          return inFlight.promise;
        }
        // In-flight has stale params (rare: cfg mutated between calls).
        // Wait for it to land, dispose it, then create fresh.
        createInFlight.delete(desiredRuntimeKey);
        const staleRuntime = await inFlight.promise.catch(() => undefined);
        runtimesByKey.delete(desiredRuntimeKey);
        idleTtlMsByRuntimeKey.delete(desiredRuntimeKey);
        const attached = sessionIdsByRuntimeKey.get(desiredRuntimeKey);
        sessionIdsByRuntimeKey.delete(desiredRuntimeKey);
        if (attached) {
          for (const sessionId of attached) {
            if (runtimeKeyBySessionId.get(sessionId) === desiredRuntimeKey) {
              runtimeKeyBySessionId.delete(sessionId);
            }
          }
        }
        await staleRuntime?.dispose();
      }

      const created = Promise.resolve(
        createRuntime({
          // In shared scope, surface the runtimeKey so logs unambiguously
          // identify the shared runtime rather than masquerading as one of its
          // attached sessionIds.
          sessionId: scope === "shared" ? desiredRuntimeKey : params.sessionId,
          sessionKey: params.sessionKey,
          workspaceDir: params.workspaceDir,
          cfg: params.cfg,
          configFingerprint: nextFingerprint,
        }),
      ).then((runtime) => {
        runtime.markUsed();
        runtimesByKey.set(desiredRuntimeKey, runtime);
        return runtime;
      });
      createInFlight.set(desiredRuntimeKey, {
        promise: created,
        workspaceDir: params.workspaceDir,
        configFingerprint: nextFingerprint,
      });
      attachSessionToRuntimeKey(params.sessionId, desiredRuntimeKey);
      bumpIdleTtlForRuntimeKey(desiredRuntimeKey, idleTtlMs);
      try {
        return await created;
      } finally {
        createInFlight.delete(desiredRuntimeKey);
      }
    },
    bindSessionKey(sessionKey, sessionId) {
      sessionIdBySessionKey.set(sessionKey, sessionId);
    },
    resolveSessionId(sessionKey) {
      return sessionIdBySessionKey.get(sessionKey);
    },
    async disposeSession(sessionId) {
      const runtimeKey = runtimeKeyBySessionId.get(sessionId);
      forgetSessionKeysForSessionId(sessionId);
      if (!runtimeKey) {
        return;
      }
      detachSessionFromRuntimeKey(sessionId, runtimeKey);
      if ((sessionIdsByRuntimeKey.get(runtimeKey)?.size ?? 0) > 0) {
        // Other sessions are still using this runtime (shared scope) — keep it.
        return;
      }
      const inFlight = createInFlight.get(runtimeKey);
      createInFlight.delete(runtimeKey);
      let runtime = runtimesByKey.get(runtimeKey);
      if (!runtime && inFlight) {
        runtime = await inFlight.promise.catch(() => undefined);
      }
      runtimesByKey.delete(runtimeKey);
      sessionIdsByRuntimeKey.delete(runtimeKey);
      idleTtlMsByRuntimeKey.delete(runtimeKey);
      if (runtime) {
        await runtime.dispose();
      }
    },
    async disposeAll() {
      clearIdleSweepTimer();
      const inFlightRuntimes = Array.from(createInFlight.values());
      createInFlight.clear();
      const runtimes = Array.from(runtimesByKey.values());
      runtimesByKey.clear();
      runtimeKeyBySessionId.clear();
      sessionIdsByRuntimeKey.clear();
      sessionIdBySessionKey.clear();
      idleTtlMsByRuntimeKey.clear();
      const lateRuntimes = await Promise.all(
        inFlightRuntimes.map(async ({ promise }) => await promise.catch(() => undefined)),
      );
      const allRuntimes = new Set<SessionMcpRuntime>(runtimes);
      for (const runtime of lateRuntimes) {
        if (runtime) {
          allRuntimes.add(runtime);
        }
      }
      await Promise.allSettled(Array.from(allRuntimes, (runtime) => runtime.dispose()));
    },
    sweepIdleRuntimes,
    listSessionIds() {
      return Array.from(runtimeKeyBySessionId.keys());
    },
  };
}

export function getSessionMcpRuntimeManager(): SessionMcpRuntimeManager {
  return resolveGlobalSingleton(SESSION_MCP_RUNTIME_MANAGER_KEY, createSessionMcpRuntimeManager);
}

export async function getOrCreateSessionMcpRuntime(params: {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  cfg?: OpenClawConfig;
}): Promise<SessionMcpRuntime> {
  return await getSessionMcpRuntimeManager().getOrCreate(params);
}

export async function disposeSessionMcpRuntime(sessionId: string): Promise<void> {
  await getSessionMcpRuntimeManager().disposeSession(sessionId);
}

export async function retireSessionMcpRuntime(params: {
  sessionId?: string | null;
  reason: string;
  onError?: (error: unknown, sessionId: string, reason: string) => void;
}): Promise<boolean> {
  const sessionId = normalizeOptionalString(params.sessionId);
  if (!sessionId) {
    return false;
  }
  try {
    await disposeSessionMcpRuntime(sessionId);
    return true;
  } catch (error) {
    params.onError?.(error, sessionId, params.reason);
    return false;
  }
}

export async function retireSessionMcpRuntimeForSessionKey(params: {
  sessionKey?: string | null;
  reason: string;
  onError?: (error: unknown, sessionId: string, reason: string) => void;
}): Promise<boolean> {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    return false;
  }
  const sessionId = getSessionMcpRuntimeManager().resolveSessionId(sessionKey);
  return await retireSessionMcpRuntime({
    sessionId,
    reason: params.reason,
    onError: params.onError,
  });
}

export async function disposeAllSessionMcpRuntimes(): Promise<void> {
  await getSessionMcpRuntimeManager().disposeAll();
}

export const __testing = {
  createSessionMcpRuntimeManager,
  async resetSessionMcpRuntimeManager() {
    await disposeAllSessionMcpRuntimes();
  },
  getCachedSessionIds() {
    return getSessionMcpRuntimeManager().listSessionIds();
  },
  resolveSessionMcpRuntimeIdleTtlMs,
  resolveSessionMcpRuntimeScope,
  buildSharedRuntimeKey,
};
