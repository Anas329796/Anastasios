import {
  readConfigFileSnapshot,
  replaceConfigFile,
  validateConfigObjectWithPlugins,
} from "./config.js";
import {
  applyExperimentalConfigFlagValue,
  readExperimentalConfigFlagStates,
  resolveExperimentalConfigFlag,
  type ExperimentalConfigFlagState,
} from "./experimental-flags.js";
import type { ConfigWriteAfterWrite } from "./runtime-snapshot.js";

export type ExperimentalConfigFlagWriteResult = {
  path: string;
  value: boolean;
  changed: boolean;
};

function assertEditableConfigSnapshot(
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
): asserts snapshot is Awaited<ReturnType<typeof readConfigFileSnapshot>> & {
  parsed: Record<string, unknown>;
} {
  if (!snapshot.valid || !snapshot.parsed || typeof snapshot.parsed !== "object") {
    throw new Error("config file is invalid; fix it before using /experimental");
  }
  if (Array.isArray(snapshot.parsed)) {
    throw new Error("config file must be an object before using /experimental");
  }
}

export async function readExperimentalConfigFlagStatesFromFile(): Promise<
  ExperimentalConfigFlagState[]
> {
  const snapshot = await readConfigFileSnapshot();
  assertEditableConfigSnapshot(snapshot);
  return readExperimentalConfigFlagStates(snapshot.runtimeConfig ?? snapshot.resolved);
}

export async function writeExperimentalConfigFlagToFile(params: {
  path: string;
  value: boolean;
  afterWrite?: ConfigWriteAfterWrite;
}): Promise<ExperimentalConfigFlagWriteResult> {
  const flag = resolveExperimentalConfigFlag(params.path);
  if (!flag) {
    throw new Error(`unknown experimental flag: ${params.path}`);
  }
  const snapshot = await readConfigFileSnapshot();
  assertEditableConfigSnapshot(snapshot);
  const { nextConfig, delta } = applyExperimentalConfigFlagValue(structuredClone(snapshot.parsed), {
    path: flag.path,
    value: params.value,
  });
  if (!delta) {
    return { path: flag.path, value: params.value, changed: false };
  }
  const validated = validateConfigObjectWithPlugins(nextConfig);
  if (!validated.ok) {
    const issue = validated.issues[0];
    throw new Error(`config invalid after experimental update (${issue.path}: ${issue.message})`);
  }
  await replaceConfigFile({
    nextConfig: validated.config,
    ...(params.afterWrite ? { afterWrite: params.afterWrite } : {}),
  });
  return { path: flag.path, value: params.value, changed: true };
}
