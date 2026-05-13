import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexAppServerAgentHarness } from "./harness.js";
import plugin from "./index.js";
import { CodexAppServerClient } from "./src/app-server/client.js";
import {
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
} from "./src/app-server/session-binding.js";
import {
  clearSharedCodexAppServerClient,
  getSharedCodexAppServerClient,
  resetSharedCodexAppServerClientForTests,
} from "./src/app-server/shared-client.js";
import { createClientHarness } from "./src/app-server/test-support.js";

async function sendInitializeResult(harness: ReturnType<typeof createClientHarness>) {
  await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(1));
  const initialize = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
  harness.send({ id: initialize.id, result: { userAgent: "openclaw/0.125.0 (test)" } });
}

describe("codex plugin", () => {
  afterEach(() => {
    clearSharedCodexAppServerClient();
    resetSharedCodexAppServerClientForTests();
    vi.restoreAllMocks();
  });

  it("is opt-in by default", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { enabledByDefault?: unknown };

    expect(manifest.enabledByDefault).toBeUndefined();
  });

  it("registers the codex provider and agent harness", () => {
    const registerAgentHarness = vi.fn();
    const registerCommand = vi.fn();
    const registerMediaUnderstandingProvider = vi.fn();
    const registerMigrationProvider = vi.fn();
    const registerProvider = vi.fn();
    const on = vi.fn();
    const onConversationBindingResolved = vi.fn();

    plugin.register(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: {} as never,
        registerAgentHarness,
        registerCommand,
        registerMediaUnderstandingProvider,
        registerMigrationProvider,
        registerProvider,
        on,
        onConversationBindingResolved,
      }),
    );

    const providerRegistration = registerProvider.mock.calls[0]?.[0] as Record<string, unknown>;
    const agentHarnessRegistration = registerAgentHarness.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const mediaProviderRegistration = registerMediaUnderstandingProvider.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    const inboundClaimRegistration = on.mock.calls[0] as [unknown, unknown] | undefined;
    const bindingResolvedRegistration = onConversationBindingResolved.mock.calls[0] as
      | [unknown]
      | undefined;

    expect(providerRegistration.id).toBe("codex");
    expect(providerRegistration.label).toBe("Codex");
    expect(agentHarnessRegistration.id).toBe("codex");
    expect(agentHarnessRegistration.label).toBe("Codex agent harness");
    expect(agentHarnessRegistration.deliveryDefaults).toEqual({
      sourceVisibleReplies: "message_tool",
    });
    expect(typeof agentHarnessRegistration.dispose).toBe("function");
    expect(mediaProviderRegistration?.id).toBe("codex");
    expect(mediaProviderRegistration?.capabilities).toEqual(["image"]);
    expect(mediaProviderRegistration?.defaultModels).toEqual({ image: "gpt-5.5" });
    expect(typeof mediaProviderRegistration?.describeImage).toBe("function");
    expect(typeof mediaProviderRegistration?.describeImages).toBe("function");
    const commandRegistration = registerCommand.mock.calls[0]?.[0];
    expect(commandRegistration?.name).toBe("codex");
    expect(commandRegistration?.description).toBe(
      "Inspect and control the Codex app-server harness",
    );
    const migrationRegistration = registerMigrationProvider.mock.calls[0]?.[0];
    expect(migrationRegistration?.id).toBe("codex");
    expect(migrationRegistration?.label).toBe("Codex");
    expect(inboundClaimRegistration?.[0]).toBe("inbound_claim");
    expect(typeof inboundClaimRegistration?.[1]).toBe("function");
    expect(typeof bindingResolvedRegistration?.[0]).toBe("function");
  });

  it("registers with capture APIs that do not expose conversation binding hooks yet", () => {
    const registerProvider = vi.fn();
    const api = createTestPluginApi({
      id: "codex",
      name: "Codex",
      source: "test",
      config: {},
      pluginConfig: {},
      runtime: {} as never,
      registerAgentHarness: vi.fn(),
      registerCommand: vi.fn(),
      registerMediaUnderstandingProvider: vi.fn(),
      registerProvider,
      on: vi.fn(),
    });
    delete (api as { onConversationBindingResolved?: unknown }).onConversationBindingResolved;

    plugin.register(api);
    expect(registerProvider).toHaveBeenCalledTimes(1);
    expect(registerProvider.mock.calls[0]?.[0].id).toBe("codex");
  });

  it("keeps compaction runtime code behind the lazy harness boundary", () => {
    const source = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");

    expect(source).not.toContain('from "./src/app-server/compact.js"');
    expect(source).toContain('import("./src/app-server/compact.js")');
  });

  it("only claims the codex provider by default", () => {
    const harness = createCodexAppServerAgentHarness();

    expect(harness.deliveryDefaults?.sourceVisibleReplies).toBe("message_tool");
    expect(
      harness.supports({ provider: "codex", modelId: "gpt-5.4", requestedRuntime: "auto" })
        .supported,
    ).toBe(true);
    const unsupported = harness.supports({
      provider: "openai-codex",
      modelId: "gpt-5.4",
      requestedRuntime: "auto",
    });
    expect(unsupported.supported).toBe(false);
  });

  it("clears session-isolated app-server clients when the harness resets a session", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);
    const startOptions = {
      transport: "stdio" as const,
      command: "codex",
      commandSource: "config" as const,
      args: ["app-server", "--listen", "stdio://"],
      headers: {},
    };

    const firstClientPromise = getSharedCodexAppServerClient({
      startOptions,
      timeoutMs: 1000,
      isolationKey: "agent:main:telegram:default:direct:12345",
    });
    await sendInitializeResult(first);
    await firstClientPromise;

    const secondClientPromise = getSharedCodexAppServerClient({
      startOptions,
      timeoutMs: 1000,
      isolationKey: "agent:main:topic-b",
    });
    await sendInitializeResult(second);
    await secondClientPromise;

    const harness = createCodexAppServerAgentHarness({
      pluginConfig: { appServer: { clientIsolation: "session" } },
    });
    await harness.reset?.({
      sessionKey: "agent:main:main",
      sandboxSessionKey: "agent:main:telegram:default:direct:12345",
      sessionId: "session-a",
    });

    expect(first.process.stdin.destroyed).toBe(true);
    expect(second.process.stdin.destroyed).toBe(false);
  });

  it("clears every app-server binding beside the reset session file", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-harness-"));
    try {
      const sessionFile = path.join(tempDir, "session.jsonl");
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-default",
        cwd: tempDir,
      });
      await writeCodexAppServerBinding(
        sessionFile,
        {
          threadId: "thread-topic-a",
          cwd: tempDir,
        },
        { isolationKey: "agent:main:topic-a" },
      );

      const harness = createCodexAppServerAgentHarness({
        pluginConfig: { appServer: { clientIsolation: "session" } },
      });
      await harness.reset?.({
        sessionKey: "agent:main:main",
        sandboxSessionKey: "agent:main:topic-a",
        sessionId: "session-a",
        sessionFile,
      });

      await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();
      await expect(
        readCodexAppServerBinding(sessionFile, { isolationKey: "agent:main:topic-a" }),
      ).resolves.toBeUndefined();
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});
