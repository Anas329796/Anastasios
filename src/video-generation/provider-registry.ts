import { normalizeProviderId } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/types.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import * as capabilityProviderRuntime from "../plugins/capability-provider-runtime.js";
import type { VideoGenerationProviderPlugin } from "../plugins/types.js";

const BUILTIN_VIDEO_GENERATION_PROVIDERS: readonly VideoGenerationProviderPlugin[] = [];
const UNSAFE_PROVIDER_IDS = new Set(["__proto__", "constructor", "prototype"]);

function normalizeVideoGenerationProviderId(id: string | undefined): string | undefined {
  const normalized = normalizeProviderId(id ?? "");
  if (!normalized || isBlockedObjectKey(normalized)) {
    return undefined;
  }
  return normalized;
}

function isSafeVideoGenerationProviderId(id: string | undefined): id is string {
  return Boolean(id && !UNSAFE_PROVIDER_IDS.has(id));
}

function resolvePluginVideoGenerationProviders(
  cfg?: OpenClawConfig,
): VideoGenerationProviderPlugin[] {
  return capabilityProviderRuntime.resolvePluginCapabilityProviders({
    key: "videoGenerationProviders",
    cfg,
  });
}

function buildProviderMaps(providers: Iterable<VideoGenerationProviderPlugin>): {
  canonical: Map<string, VideoGenerationProviderPlugin>;
  aliases: Map<string, VideoGenerationProviderPlugin>;
} {
  const canonical = new Map<string, VideoGenerationProviderPlugin>();
  const aliases = new Map<string, VideoGenerationProviderPlugin>();
  const register = (provider: VideoGenerationProviderPlugin) => {
    const id = normalizeVideoGenerationProviderId(provider.id);
    if (!isSafeVideoGenerationProviderId(id)) {
      return;
    }
    canonical.set(id, provider);
    aliases.set(id, provider);
    for (const alias of provider.aliases ?? []) {
      const normalizedAlias = normalizeVideoGenerationProviderId(alias);
      if (isSafeVideoGenerationProviderId(normalizedAlias)) {
        aliases.set(normalizedAlias, provider);
      }
    }
  };

  for (const provider of providers) {
    register(provider);
  }

  return { canonical, aliases };
}

export function createVideoGenerationProviderRegistry(
  providers: Iterable<VideoGenerationProviderPlugin>,
): {
  listProviders: () => VideoGenerationProviderPlugin[];
  getProvider: (providerId: string | undefined) => VideoGenerationProviderPlugin | undefined;
} {
  const maps = buildProviderMaps(providers);
  return {
    listProviders: () => [...maps.canonical.values()],
    getProvider: (providerId) => {
      const normalized = normalizeVideoGenerationProviderId(providerId);
      if (!normalized) {
        return undefined;
      }
      return maps.aliases.get(normalized);
    },
  };
}

function resolveVideoGenerationProviderRegistry(
  cfg?: OpenClawConfig,
): ReturnType<typeof createVideoGenerationProviderRegistry> {
  return createVideoGenerationProviderRegistry([
    ...BUILTIN_VIDEO_GENERATION_PROVIDERS,
    ...resolvePluginVideoGenerationProviders(cfg),
  ]);
}

export function listVideoGenerationProviders(
  cfg?: OpenClawConfig,
): VideoGenerationProviderPlugin[] {
  return resolveVideoGenerationProviderRegistry(cfg).listProviders();
}

export function getVideoGenerationProvider(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
): VideoGenerationProviderPlugin | undefined {
  return resolveVideoGenerationProviderRegistry(cfg).getProvider(providerId);
}
