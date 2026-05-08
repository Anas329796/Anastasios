import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetActiveManagedProxyStateForTests,
  registerActiveManagedProxyUrl,
  stopActiveManagedProxyRegistration,
} from "./proxy/active-proxy-state.js";
import { TEST_UNDICI_RUNTIME_DEPS_KEY, createHttp1EnvHttpProxyAgent } from "./undici-runtime.js";

class MockAgent {
  constructor(public readonly options?: Record<string, unknown>) {}
}

class MockEnvHttpProxyAgent {
  static lastCreated: MockEnvHttpProxyAgent | undefined;
  constructor(public readonly options?: Record<string, unknown>) {
    MockEnvHttpProxyAgent.lastCreated = this;
  }
}

class MockProxyAgent {
  constructor(public readonly options?: Record<string, unknown>) {}
}

describe("createHttp1EnvHttpProxyAgent managed proxy TLS", () => {
  beforeEach(() => {
    _resetActiveManagedProxyStateForTests();
    MockEnvHttpProxyAgent.lastCreated = undefined;
    (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: MockAgent,
      EnvHttpProxyAgent: MockEnvHttpProxyAgent,
      ProxyAgent: MockProxyAgent,
      fetch: async () => new Response(),
    };
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY];
    _resetActiveManagedProxyStateForTests();
  });

  it("adds active managed proxy CA trust to env proxy agents", () => {
    const registration = registerActiveManagedProxyUrl(new URL("https://proxy.example:8443"), {
      proxyTls: { ca: "managed-proxy-ca" },
    });

    createHttp1EnvHttpProxyAgent({
      httpProxy: "https://proxy.example:8443",
      httpsProxy: "https://proxy.example:8443",
    });

    expect(MockEnvHttpProxyAgent.lastCreated?.options).toEqual(
      expect.objectContaining({
        allowH2: false,
        httpProxy: "https://proxy.example:8443",
        httpsProxy: "https://proxy.example:8443",
        proxyTls: expect.objectContaining({ ca: "managed-proxy-ca" }),
      }),
    );

    stopActiveManagedProxyRegistration(registration);
  });
});
