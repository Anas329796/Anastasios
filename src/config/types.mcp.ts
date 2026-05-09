export type McpServerConfig = {
  /** Stdio transport: command to spawn. */
  command?: string;
  /** Stdio transport: arguments for the command. */
  args?: string[];
  /** Environment variables passed to the server process (stdio only). */
  env?: Record<string, string | number | boolean>;
  /** Working directory for stdio server. */
  cwd?: string;
  /** Alias for cwd. */
  workingDirectory?: string;
  /** HTTP transport: URL of the remote MCP server (http or https). */
  url?: string;
  /** HTTP transport type for remote MCP servers. */
  transport?: "sse" | "streamable-http";
  /** HTTP transport: extra HTTP headers sent with every request. */
  headers?: Record<string, string | number | boolean>;
  /** Optional connection timeout in milliseconds. */
  connectionTimeoutMs?: number;
  [key: string]: unknown;
};

export type McpConfig = {
  /** Named MCP server definitions managed by OpenClaw. */
  servers?: Record<string, McpServerConfig>;
  /**
   * Idle TTL for session-scoped bundled MCP runtimes, in milliseconds.
   *
   * Defaults to 10 minutes. Set to 0 to disable idle eviction.
   */
  sessionIdleTtlMs?: number;
  /**
   * Scope for the bundled MCP runtime cache.
   *
   * - `"session"` (default): one runtime per session. Per-session disposal
   *   tears the runtime down. Matches behavior prior to the introduction of
   *   this flag.
   * - `"shared"`: one runtime per `(workspaceDir, configFingerprint)` tuple.
   *   Multiple sessions can attach to the same runtime; per-session disposal
   *   only detaches the session and disposes the runtime when the last
   *   session detaches. Suitable for single-tenant deployments where every
   *   session shares one workspace and the same MCP server config.
   */
  runtimeScope?: "session" | "shared";
};
