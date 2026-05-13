import { describe, expect, it, vi } from "vitest";
import { sandboxExplainCommand } from "./sandbox-explain.js";

const SANDBOX_EXPLAIN_TEST_TIMEOUT_MS = process.platform === "win32" ? 45_000 : 30_000;

let mockCfg: unknown = {};

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: vi.fn().mockImplementation(() => mockCfg),
    loadConfig: vi.fn().mockImplementation(() => mockCfg),
  };
});

describe("sandbox explain command", () => {
  it("prints JSON shape + fix-it keys", { timeout: SANDBOX_EXPLAIN_TEST_TIMEOUT_MS }, async () => {
    mockCfg = {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent", workspaceAccess: "none" },
        },
      },
      tools: {
        sandbox: { tools: { deny: ["browser"] } },
        elevated: { enabled: true, allowFrom: { quietchat: ["*"] } },
      },
      session: { store: "/tmp/openclaw-test-sessions-{agentId}.json" },
    };

    const logs: string[] = [];
    await sandboxExplainCommand({ json: true, session: "agent:main:main" }, {
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => logs.push(msg),
      exit: (_code: number) => {},
    } as unknown as Parameters<typeof sandboxExplainCommand>[1]);

    const out = logs.join("");
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty("docsUrl", "https://docs.openclaw.ai/sandbox");
    expect(parsed).toHaveProperty("sandbox.mode", "all");
    expect(parsed).toHaveProperty("sandbox.tools.sources.allow.source");
    expect(parsed.fixIt).toEqual([
      "agents.defaults.sandbox.mode=off",
      "agents.list[].sandbox.mode=off",
      "tools.sandbox.tools.allow",
      "tools.sandbox.tools.alsoAllow",
      "tools.sandbox.tools.deny",
      "agents.list[].tools.sandbox.tools.allow",
      "agents.list[].tools.sandbox.tools.alsoAllow",
      "agents.list[].tools.sandbox.tools.deny",
      "tools.elevated.enabled",
    ]);
  });

  it("shows effective sandbox alsoAllow grants and default-deny removals", async () => {
    mockCfg = {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent", workspaceAccess: "none" },
        },
        list: [
          {
            id: "tavern",
            tools: {
              sandbox: {
                tools: {
                  alsoAllow: ["message", "tts"],
                },
              },
            },
          },
        ],
      },
      tools: {
        sandbox: {
          tools: {
            allow: ["browser"],
          },
        },
      },
      session: { store: "/tmp/openclaw-test-sessions-{agentId}.json" },
    };

    const logs: string[] = [];
    await sandboxExplainCommand({ json: true, agent: "tavern" }, {
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => logs.push(msg),
      exit: (_code: number) => {},
    } as unknown as Parameters<typeof sandboxExplainCommand>[1]);

    const parsed = JSON.parse(logs.join(""));
    expect(parsed.sandbox.tools.allow).toEqual(["browser", "message", "tts", "image"]);
    expect(parsed.sandbox.tools.deny).not.toContain("browser");
    expect(parsed.sandbox.tools.sources.allow).toEqual({
      source: "agent",
      key: "agents.list[].tools.sandbox.tools.alsoAllow",
    });
  });

  it(
    "normalizes non-agent-scoped colon keys (e.g. telegram:slash:200)",
    { timeout: SANDBOX_EXPLAIN_TEST_TIMEOUT_MS },
    async () => {
      mockCfg = {
        agents: {
          defaults: {
            sandbox: { mode: "all", scope: "agent", workspaceAccess: "none" },
          },
        },
        tools: {
          elevated: { enabled: true, allowFrom: { telegram: ["200"] } },
        },
        session: { store: "/tmp/openclaw-test-sessions-{agentId}.json" },
      };

      const logs: string[] = [];
      await sandboxExplainCommand({ json: true, session: "telegram:slash:200" }, {
        log: (msg: string) => logs.push(msg),
        error: (msg: string) => logs.push(msg),
        exit: (_code: number) => {},
      } as unknown as Parameters<typeof sandboxExplainCommand>[1]);

      const out = logs.join("");
      const parsed = JSON.parse(out);
      // The session key should have been normalized to agent-scoped format.
      expect(parsed.sessionKey).toBe("agent:main:telegram:slash:200");
      // Core bug: channel must be inferred correctly and config must allow it.
      expect(parsed.elevated.channel).toBe("telegram");
      expect(parsed.elevated.allowedByConfig).toBe(true);
    },
  );

  it(
    "preserves already agent-scoped colon keys unchanged",
    { timeout: SANDBOX_EXPLAIN_TEST_TIMEOUT_MS },
    async () => {
      mockCfg = {
        agents: {
          defaults: {
            sandbox: { mode: "all", scope: "agent", workspaceAccess: "none" },
          },
        },
        tools: {
          elevated: { enabled: true },
        },
        session: { store: "/tmp/openclaw-test-sessions-{agentId}.json" },
      };

      const logs: string[] = [];
      await sandboxExplainCommand({ json: true, session: "agent:main:telegram:slash:200" }, {
        log: (msg: string) => logs.push(msg),
        error: (msg: string) => logs.push(msg),
        exit: (_code: number) => {},
      } as unknown as Parameters<typeof sandboxExplainCommand>[1]);

      const out = logs.join("");
      const parsed = JSON.parse(out);
      // Already agent-scoped — should pass through unchanged.
      expect(parsed.sessionKey).toBe("agent:main:telegram:slash:200");
    },
  );
});
