import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import { resolveElevatedPermissions } from "./reply-elevated.js";

const channelPluginLookup = vi.hoisted(() => vi.fn());
const normalizeChannelIdMock = vi.hoisted(() => vi.fn());

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: channelPluginLookup,
  normalizeChannelId: normalizeChannelIdMock,
}));

function buildConfig(allowFrom: string[]): OpenClawConfig {
  return {
    tools: {
      elevated: {
        allowFrom: {
          whatsapp: allowFrom,
        },
      },
    },
  } as OpenClawConfig;
}

function buildContext(overrides?: Partial<MsgContext>): MsgContext {
  return {
    Provider: "whatsapp",
    Surface: "whatsapp",
    SenderId: "+15550001111",
    From: "whatsapp:+15550001111",
    SenderE164: "+15550001111",
    To: "+15559990000",
    ...overrides,
  } as MsgContext;
}

function expectAllowFromDecision(params: {
  allowFrom: string[];
  ctx?: Partial<MsgContext>;
  allowed: boolean;
}) {
  const result = resolveElevatedPermissions({
    cfg: buildConfig(params.allowFrom),
    agentId: "main",
    provider: "whatsapp",
    ctx: buildContext(params.ctx),
  });

  expect(result.enabled).toBe(true);
  expect(result.allowed).toBe(params.allowed);
  if (params.allowed) {
    expect(result.failures).toHaveLength(0);
    return;
  }

  expect(result.failures).toEqual([
    {
      gate: "allowFrom",
      key: "tools.elevated.allowFrom.whatsapp",
    },
  ]);
}

describe("resolveElevatedPermissions", () => {
  beforeEach(() => {
    normalizeChannelIdMock.mockImplementation(
      (raw?: string | null) => raw?.trim().toLowerCase() || null,
    );
  });

  afterEach(() => {
    channelPluginLookup.mockReset();
    normalizeChannelIdMock.mockReset();
  });

  it("authorizes when sender matches allowFrom", () => {
    expectAllowFromDecision({
      allowFrom: ["+15550001111"],
      allowed: true,
    });
  });

  it("uses bundled channel formatting when no plugin registry is loaded", () => {
    channelPluginLookup.mockReturnValue({
      config: {
        formatAllowFrom: ({ allowFrom }: { allowFrom: Array<string | number> }) =>
          allowFrom.flatMap((entry) => {
            const digits = String(entry).replace(/\D/g, "");
            return digits ? [digits] : [];
          }),
      },
    });

    expectAllowFromDecision({
      allowFrom: ["15550001111"],
      ctx: {
        SenderId: "+1 (555) 000-1111",
        From: undefined,
        SenderE164: undefined,
      },
      allowed: true,
    });

    expect(channelPluginLookup).toHaveBeenCalledWith("whatsapp");
  });

  it("does not authorize when only recipient matches allowFrom", () => {
    expectAllowFromDecision({
      allowFrom: ["+15559990000"],
      allowed: false,
    });
  });

  it("does not authorize untyped mutable sender fields", () => {
    expectAllowFromDecision({
      allowFrom: ["owner-display-name"],
      allowed: false,
      ctx: {
        SenderName: "owner-display-name",
        SenderUsername: "owner-display-name",
        SenderTag: "owner-display-name",
      },
    });
  });

  it("authorizes mutable sender fields only with explicit prefix", () => {
    expectAllowFromDecision({
      allowFrom: ["username:owner_username"],
      allowed: true,
      ctx: {
        SenderUsername: "owner_username",
      },
    });
  });

  it("does not use elevated allowFrom fallback when the channel disables it", () => {
    channelPluginLookup.mockReturnValue({
      doctor: { elevatedAllowFromFallbackToAllowFrom: false },
      elevated: {
        allowFromFallback: () => ["user:1"],
      },
    });

    const result = resolveElevatedPermissions({
      cfg: { tools: { elevated: {} } } as OpenClawConfig,
      agentId: "main",
      provider: "nofallback",
      ctx: buildContext({ Provider: "nofallback", Surface: "nofallback", SenderId: "user:1" }),
    });

    expect(result.allowed).toBe(false);
  });

  it("uses elevated allowFrom fallback when the channel keeps it enabled", () => {
    channelPluginLookup.mockReturnValue({
      elevated: {
        allowFromFallback: () => ["user:1"],
      },
    });

    const result = resolveElevatedPermissions({
      cfg: { tools: { elevated: {} } } as OpenClawConfig,
      agentId: "main",
      provider: "fallback",
      ctx: buildContext({
        Provider: "fallback",
        Surface: "fallback",
        SenderId: "user:1",
        From: undefined,
        SenderE164: undefined,
      }),
    });

    expect(result.allowed).toBe(true);
  });

  it("falls back to the raw provider key when registry normalization is unavailable", () => {
    normalizeChannelIdMock.mockReturnValueOnce(null);
    channelPluginLookup.mockReturnValue({
      config: {
        formatAllowFrom: ({ allowFrom }: { allowFrom: Array<string | number> }) =>
          allowFrom.map(String),
      },
    });

    const result = resolveElevatedPermissions({
      cfg: {
        tools: {
          elevated: {
            allowFrom: {
              unregistered: ["sender"],
            },
          },
        },
      } as OpenClawConfig,
      agentId: "main",
      provider: "unregistered",
      ctx: buildContext({
        Provider: "unregistered",
        Surface: "unregistered",
        SenderId: "sender",
        From: undefined,
        SenderE164: undefined,
      }),
    });

    expect(result.allowed).toBe(true);
    expect(channelPluginLookup).toHaveBeenCalledWith("unregistered");
  });
});
