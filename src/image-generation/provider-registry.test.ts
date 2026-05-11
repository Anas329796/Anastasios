import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type { ImageGenerationProviderPlugin } from "../plugins/types.js";
import {
  createImageGenerationProviderRegistry,
  listImageGenerationProviders,
} from "./provider-registry.js";

function createProvider(
  params: Pick<ImageGenerationProviderPlugin, "id"> & Partial<ImageGenerationProviderPlugin>,
): ImageGenerationProviderPlugin {
  return {
    label: params.id,
    capabilities: {
      generate: {},
      edit: { enabled: false },
    },
    generateImage: async () => ({
      images: [{ buffer: Buffer.from("image"), mimeType: "image/png" }],
    }),
    ...params,
  };
}

function requireLoadedImageProvider(
  registry: ReturnType<typeof createImageGenerationProviderRegistry>,
  id: string,
): ImageGenerationProviderPlugin {
  const provider = registry.getProvider(id);
  if (!provider) {
    throw new Error(`expected image generation provider ${id}`);
  }
  return provider;
}

describe("image-generation provider registry", () => {
  it("returns no providers when plugin resolution is disabled", () => {
    const cfg = { plugins: { enabled: false } } as OpenClawConfig;

    expect(listImageGenerationProviders(cfg)).toStrictEqual([]);
  });

  it("indexes custom providers by id", () => {
    const registry = createImageGenerationProviderRegistry([
      createProvider({ id: "custom-image" }),
    ]);

    const provider = registry.getProvider("custom-image");

    expect(provider?.id).toBe("custom-image");
  });

  it("ignores prototype-like provider ids and aliases", () => {
    const registry = createImageGenerationProviderRegistry([
      createProvider({ id: "__proto__", aliases: ["constructor", "prototype"] }),
      createProvider({ id: "safe-image", aliases: ["safe-alias", "constructor"] }),
    ]);

    expect(registry.listProviders().map((provider) => provider.id)).toEqual(["safe-image"]);
    expect(registry.getProvider("__proto__")).toBeUndefined();
    expect(registry.getProvider("constructor")).toBeUndefined();
    expect(requireLoadedImageProvider(registry, "safe-alias").id).toBe("safe-image");
  });
});
