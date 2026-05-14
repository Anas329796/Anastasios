import { normalizeProviderId } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import * as capabilityProviderRuntime from "../plugins/capability-provider-runtime.js";
import type { ImageGenerationProviderPlugin } from "../plugins/types.js";

const BUILTIN_IMAGE_GENERATION_PROVIDERS: readonly ImageGenerationProviderPlugin[] = [];
const UNSAFE_PROVIDER_IDS = new Set(["__proto__", "constructor", "prototype"]);

function normalizeImageGenerationProviderId(id: string | undefined): string | undefined {
  const normalized = normalizeProviderId(id ?? "");
  if (!normalized || isBlockedObjectKey(normalized)) {
    return undefined;
  }
  return normalized;
}

function isSafeImageGenerationProviderId(id: string | undefined): id is string {
  return Boolean(id && !UNSAFE_PROVIDER_IDS.has(id));
}

function resolvePluginImageGenerationProviders(
  cfg?: OpenClawConfig,
): ImageGenerationProviderPlugin[] {
  return capabilityProviderRuntime.resolvePluginCapabilityProviders({
    key: "imageGenerationProviders",
    cfg,
  });
}

function buildProviderMaps(providers: Iterable<ImageGenerationProviderPlugin>): {
  canonical: Map<string, ImageGenerationProviderPlugin>;
  aliases: Map<string, ImageGenerationProviderPlugin>;
} {
  const canonical = new Map<string, ImageGenerationProviderPlugin>();
  const aliases = new Map<string, ImageGenerationProviderPlugin>();
  const register = (provider: ImageGenerationProviderPlugin) => {
    const id = normalizeImageGenerationProviderId(provider.id);
    if (!isSafeImageGenerationProviderId(id)) {
      return;
    }
    canonical.set(id, provider);
    aliases.set(id, provider);
    for (const alias of provider.aliases ?? []) {
      const normalizedAlias = normalizeImageGenerationProviderId(alias);
      if (isSafeImageGenerationProviderId(normalizedAlias)) {
        aliases.set(normalizedAlias, provider);
      }
    }
  };

  for (const provider of providers) {
    register(provider);
  }

  return { canonical, aliases };
}

export function createImageGenerationProviderRegistry(
  providers: Iterable<ImageGenerationProviderPlugin>,
): {
  listProviders: () => ImageGenerationProviderPlugin[];
  getProvider: (providerId: string | undefined) => ImageGenerationProviderPlugin | undefined;
} {
  const maps = buildProviderMaps(providers);
  return {
    listProviders: () => [...maps.canonical.values()],
    getProvider: (providerId) => {
      const normalized = normalizeImageGenerationProviderId(providerId);
      if (!normalized) {
        return undefined;
      }
      return maps.aliases.get(normalized);
    },
  };
}

function resolveImageGenerationProviderRegistry(
  cfg?: OpenClawConfig,
): ReturnType<typeof createImageGenerationProviderRegistry> {
  return createImageGenerationProviderRegistry([
    ...BUILTIN_IMAGE_GENERATION_PROVIDERS,
    ...resolvePluginImageGenerationProviders(cfg),
  ]);
}

export function listImageGenerationProviders(
  cfg?: OpenClawConfig,
): ImageGenerationProviderPlugin[] {
  return resolveImageGenerationProviderRegistry(cfg).listProviders();
}

export function getImageGenerationProvider(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
): ImageGenerationProviderPlugin | undefined {
  return resolveImageGenerationProviderRegistry(cfg).getProvider(providerId);
}
