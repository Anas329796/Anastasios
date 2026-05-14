import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type { VideoGenerationProviderPlugin } from "../plugins/types.js";
import {
  createVideoGenerationProviderRegistry,
  listVideoGenerationProviders,
} from "./provider-registry.js";

function createProvider(
  params: Pick<VideoGenerationProviderPlugin, "id"> & Partial<VideoGenerationProviderPlugin>,
): VideoGenerationProviderPlugin {
  return {
    label: params.id,
    capabilities: {},
    generateVideo: async () => ({
      videos: [{ buffer: Buffer.from("video"), mimeType: "video/mp4" }],
    }),
    ...params,
  };
}

function requireLoadedVideoProvider(
  registry: ReturnType<typeof createVideoGenerationProviderRegistry>,
  id: string,
): VideoGenerationProviderPlugin {
  const provider = registry.getProvider(id);
  if (!provider) {
    throw new Error(`expected video generation provider ${id}`);
  }
  return provider;
}

describe("video-generation provider registry", () => {
  it("returns no providers when plugin resolution is disabled", () => {
    const cfg = { plugins: { enabled: false } } as OpenClawConfig;

    expect(listVideoGenerationProviders(cfg)).toStrictEqual([]);
  });

  it("indexes custom providers by id", () => {
    const registry = createVideoGenerationProviderRegistry([
      createProvider({ id: "custom-video" }),
    ]);

    const provider = registry.getProvider("custom-video");

    expect(provider?.id).toBe("custom-video");
  });

  it("ignores prototype-like provider ids and aliases", () => {
    const registry = createVideoGenerationProviderRegistry([
      createProvider({ id: "__proto__", aliases: ["constructor", "prototype"] }),
      createProvider({ id: "safe-video", aliases: ["safe-alias", "constructor"] }),
    ]);

    expect(registry.listProviders().map((provider) => provider.id)).toEqual(["safe-video"]);
    expect(registry.getProvider("__proto__")).toBeUndefined();
    expect(registry.getProvider("constructor")).toBeUndefined();
    expect(requireLoadedVideoProvider(registry, "safe-alias").id).toBe("safe-video");
  });
});
