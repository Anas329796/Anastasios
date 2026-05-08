import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const proxyAgentCtor = vi.hoisted(() =>
  vi.fn(function MockProxyAgent(this: { options: unknown }, options: unknown) {
    this.options = options;
  }),
);

vi.mock("proxy-agent", () => ({
  ProxyAgent: proxyAgentCtor,
}));

import { resolveAmbientNodeProxyAgent } from "./extension-shared.js";

describe("resolveAmbientNodeProxyAgent", () => {
  const envKeys = [
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "https_proxy",
    "http_proxy",
    "OPENCLAW_PROXY_ACTIVE",
    "OPENCLAW_PROXY_CA_FILE",
  ] as const;
  const tempDirs: string[] = [];

  beforeEach(() => {
    proxyAgentCtor.mockClear();
    for (const key of envKeys) {
      vi.stubEnv(key, "");
    }
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
  });

  function writeTempCa(contents: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-extension-shared-proxy-ca-"));
    tempDirs.push(dir);
    const caFile = path.join(dir, "proxy-ca.pem");
    writeFileSync(caFile, contents, "utf8");
    return caFile;
  }

  it("adds managed proxy CA trust to ambient Node proxy agents", async () => {
    const caFile = writeTempCa("extension-shared-managed-proxy-ca");
    vi.stubEnv("https_proxy", "https://proxy.example:8443");
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "1");
    vi.stubEnv("OPENCLAW_PROXY_CA_FILE", caFile);

    const agent = await resolveAmbientNodeProxyAgent<{ options?: unknown }>();

    expect(agent).toBeDefined();
    expect(proxyAgentCtor).toHaveBeenCalledWith({
      ca: "extension-shared-managed-proxy-ca",
    });
  });
});
