import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import {
  acquireLocalHeavyCheckLockSync,
  getLocalNativeTypecheckRefusalError,
  prepareLocalHeavyCheckEnvironment,
  resolveLocalHeavyCheckEnv,
} from "./lib/local-heavy-check-runtime.mjs";

const extraArgs = process.argv.slice(2);
const runner = path.resolve("scripts", "run-oxlint.mjs");
const shards = [
  {
    name: "core",
    args: ["--tsconfig", "config/tsconfig/oxlint.core.json", "src", "ui", "packages"],
  },
  {
    name: "extensions",
    args: ["--tsconfig", "config/tsconfig/oxlint.extensions.json", "extensions"],
  },
  {
    name: "scripts",
    args: ["--tsconfig", "config/tsconfig/oxlint.scripts.json", "scripts"],
  },
];
const env = prepareLocalHeavyCheckEnvironment({
  cwd: process.cwd(),
  env: resolveLocalHeavyCheckEnv(process.env),
});
const nativeTypecheckRefusalError = getLocalNativeTypecheckRefusalError({
  args: extraArgs,
  env,
  shouldRunHeavyCheck: true,
  toolName: "sharded type-aware oxlint",
});

if (nativeTypecheckRefusalError) {
  console.error(nativeTypecheckRefusalError);
  process.exitCode = 1;
} else {
  const releaseLock = acquireLocalHeavyCheckLockSync({
    cwd: process.cwd(),
    env,
    toolName: "oxlint-shards",
  });

  try {
    const prepareResult = spawnSync(
      process.execPath,
      [path.resolve("scripts", "prepare-extension-package-boundary-artifacts.mjs")],
      {
        stdio: "inherit",
        env,
      },
    );

    if (prepareResult.error) {
      throw prepareResult.error;
    }
    if ((prepareResult.status ?? 1) !== 0) {
      process.exitCode = prepareResult.status ?? 1;
    } else {
      const runSerial = env.OPENCLAW_OXLINT_SHARDS_SERIAL === "1";
      const results = runSerial
        ? await runShardsSerial(shards, env)
        : await Promise.all(shards.map((shard) => runShard(shard, env)));
      process.exitCode = results.find((status) => status !== 0) ?? 0;
    }
  } finally {
    releaseLock();
  }
}

async function runShardsSerial(entries, parentEnv) {
  const results = [];
  for (const shard of entries) {
    results.push(await runShard(shard, parentEnv));
  }
  return results;
}

async function runShard(shard, parentEnv) {
  console.error(`[oxlint:${shard.name}] starting`);
  const child = spawn(process.execPath, [runner, ...shard.args, ...extraArgs], {
    stdio: "inherit",
    env: {
      ...parentEnv,
      OPENCLAW_ALLOW_LOCAL_NATIVE_TYPECHECK: "1",
      OPENCLAW_OXLINT_SKIP_LOCK: "1",
      OPENCLAW_OXLINT_SKIP_PREPARE: "1",
    },
  });

  return await new Promise((resolve) => {
    child.once("error", (error) => {
      console.error(error);
      resolve(1);
    });
    child.once("close", (status) => {
      console.error(`[oxlint:${shard.name}] finished`);
      resolve(status ?? 1);
    });
  });
}
