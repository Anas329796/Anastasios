import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "../../infra/diagnostic-events.js";
import {
  resetDiagnosticStabilityRecorderForTest,
  startDiagnosticStabilityRecorder,
  stopDiagnosticStabilityRecorder,
} from "../../logging/diagnostic-stability.js";
import { replaceGatewayModelPricingCache } from "../model-pricing-cache-state.js";
import {
  GATEWAY_MODEL_PRICING_CACHE_TTL_MS,
  __resetGatewayModelPricingCacheForTest,
} from "../model-pricing-cache.js";
import { diagnosticsHandlers } from "./diagnostics.js";

describe("diagnostics gateway methods", () => {
  beforeEach(() => {
    resetDiagnosticStabilityRecorderForTest();
    resetDiagnosticEventsForTest();
    startDiagnosticStabilityRecorder();
  });

  afterEach(() => {
    stopDiagnosticStabilityRecorder();
    resetDiagnosticStabilityRecorderForTest();
    resetDiagnosticEventsForTest();
    vi.useRealTimers();
  });

  it("returns a filtered stability snapshot", async () => {
    const now = new Date("2026-01-02T03:04:05.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    emitDiagnosticEvent({ type: "webhook.received", channel: "telegram" });
    emitDiagnosticEvent({
      type: "payload.large",
      surface: "gateway.http.json",
      action: "rejected",
      bytes: 1024,
      limitBytes: 512,
    });

    const respond = vi.fn();
    await diagnosticsHandlers["diagnostics.stability"]({
      req: { type: "req", id: "1", method: "diagnostics.stability", params: {} },
      params: { type: "payload.large", limit: 10 },
      client: null,
      isWebchatConnect: () => false,
      context: {} as never,
      respond,
    });

    expect(respond).toHaveBeenCalledTimes(1);
    const firstRespondCall = respond.mock.calls[0];
    expect(firstRespondCall).toEqual([
      true,
      {
        generatedAt: now.toISOString(),
        capacity: 1000,
        count: 1,
        dropped: 0,
        firstSeq: 2,
        lastSeq: 2,
        events: [
          {
            seq: 2,
            ts: now.getTime(),
            type: "payload.large",
            surface: "gateway.http.json",
            action: "rejected",
            bytes: 1024,
            limitBytes: 512,
            count: undefined,
            channel: undefined,
            pluginId: undefined,
          },
        ],
        summary: {
          byType: { "payload.large": 1 },
          payloadLarge: {
            count: 1,
            rejected: 1,
            truncated: 0,
            chunked: 0,
            bySurface: { "gateway.http.json": 1 },
          },
        },
      },
      undefined,
    ]);
    expect(Object.keys(firstRespondCall?.[1] as Record<string, unknown>).toSorted()).toEqual([
      "capacity",
      "count",
      "dropped",
      "events",
      "firstSeq",
      "generatedAt",
      "lastSeq",
      "summary",
    ]);
  });

  it("returns pricing cache meta when empty", async () => {
    __resetGatewayModelPricingCacheForTest();
    const respond = vi.fn();
    await diagnosticsHandlers["diagnostics.pricing"]({
      req: { type: "req", id: "1", method: "diagnostics.pricing", params: {} },
      params: {},
      client: null,
      isWebchatConnect: () => false,
      context: {} as never,
      respond,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        cachedAt: null,
        age: null,
        ttlMs: GATEWAY_MODEL_PRICING_CACHE_TTL_MS,
        size: 0,
      }),
      undefined,
    );
  });

  it("returns pricing cache meta when populated", async () => {
    const now = Date.now();
    replaceGatewayModelPricingCache(
      new Map([
        ["anthropic/claude-sonnet-4-6", { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
      ]),
      now,
    );
    const respond = vi.fn();
    await diagnosticsHandlers["diagnostics.pricing"]({
      req: { type: "req", id: "1", method: "diagnostics.pricing", params: {} },
      params: {},
      client: null,
      isWebchatConnect: () => false,
      context: {} as never,
      respond,
    });

    const payload = respond.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.cachedAt).toBe(now);
    expect(payload.size).toBe(1);
    expect(typeof payload.age).toBe("number");
    expect(payload.ttlMs).toBe(GATEWAY_MODEL_PRICING_CACHE_TTL_MS);
    __resetGatewayModelPricingCacheForTest();
  });

  it("rejects invalid stability params", async () => {
    const respond = vi.fn();
    await diagnosticsHandlers["diagnostics.stability"]({
      req: { type: "req", id: "1", method: "diagnostics.stability", params: {} },
      params: { limit: 0 },
      client: null,
      isWebchatConnect: () => false,
      context: {} as never,
      respond,
    });

    expect(respond.mock.calls).toEqual([
      [
        false,
        undefined,
        {
          code: "INVALID_REQUEST",
          message: "limit must be between 1 and 1000",
        },
      ],
    ]);
  });
});
