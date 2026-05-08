#!/usr/bin/env node
// Runs local workflow sanity checks.
// Uses an installed actionlint when present, otherwise falls back to `go run`
// for the pinned version used by CI, then runs repo-specific composite guards.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const ACTIONLINT_VERSION = "1.7.11";
const WORKFLOW_DIR = ".github/workflows";

function commandExists(command) {
  return spawnSync("bash", ["-lc", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function workflowFiles() {
  return readdirSync(WORKFLOW_DIR)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .sort()
    .map((file) => join(WORKFLOW_DIR, file));
}

function runPreCommitHook(hook, files) {
  const preCommitArgs = ["run", "--config", ".pre-commit-config.yaml", hook, "--files", ...files];
  if (commandExists("pre-commit")) {
    run("pre-commit", preCommitArgs);
  } else {
    run("python3", ["-m", "pre_commit", ...preCommitArgs]);
  }
}

const workflows = workflowFiles();

if (commandExists("actionlint")) {
  run("actionlint", workflows);
} else if (commandExists("pre-commit")) {
  runPreCommitHook("actionlint", workflows);
} else {
  run("go", ["run", `github.com/rhysd/actionlint/cmd/actionlint@v${ACTIONLINT_VERSION}`]);
}

runPreCommitHook("zizmor", workflows);

run("python3", ["scripts/check-composite-action-input-interpolation.py"]);
run("node", ["scripts/check-no-conflict-markers.mjs"]);
