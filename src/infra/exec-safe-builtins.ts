import { isWindowsPlatform, type ExecCommandSegment } from "./exec-approvals-analysis.js";
import { resolveExecutionTargetResolution } from "./exec-command-resolution.js";

// POSIX shell builtins that cannot execute external code on their own and do not mutate
// shell state (cwd or env) that the allowlist evaluator observes. These are safe to
// auto-allow when the user has opted in via `tools.exec.safeBuiltins`:
//   :, true, false — no-ops / status returns
//   pwd            — reads cwd, does not change it
//
// Notably excluded from this default set:
//   cd, export, unset — these mutate cwd/env before later segments run; the allowlist
//     evaluator resolves each segment against the original cwd/env, so auto-allowing them
//     can approve a different executable than the one the shell eventually runs. Users who
//     understand this trade-off can add them explicitly via config.
//   echo, printf, eval, source, . — eval/source/. evaluate code; echo/printf differ across
//     shells and are often available as /usr/bin/echo via safeBins.
export const DEFAULT_SAFE_BUILTINS: readonly string[] = [":", "false", "pwd", "true"];

export function normalizeSafeBuiltins(entries?: readonly string[]): Set<string> {
  if (!Array.isArray(entries)) {
    return new Set();
  }
  const normalized = entries
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return new Set(normalized);
}

// Off by default. The caller passes an explicit array (often DEFAULT_SAFE_BUILTINS) to
// enable. This mirrors the conservative "opt-in" stance from the bug report and keeps the
// approval gate's behavior unchanged for users who don't configure safeBuiltins.
export function resolveSafeBuiltins(entries?: readonly string[] | null): Set<string> {
  if (entries === undefined || entries === null) {
    return new Set();
  }
  return normalizeSafeBuiltins(entries);
}

export function isSafeBuiltinSegment(params: {
  segment: ExecCommandSegment;
  safeBuiltins: ReadonlySet<string>;
  platform?: string | null;
}): boolean {
  // Builtin semantics here are POSIX shell. On Windows the host shell is PowerShell, where
  // these tokens have different meaning (cd is an alias to Set-Location, etc.) — defer.
  if (isWindowsPlatform(params.platform ?? process.platform)) {
    return false;
  }
  if (params.safeBuiltins.size === 0) {
    return false;
  }
  // True builtins resolve to no filesystem path. If a resolved binary exists with the same
  // name (e.g. /usr/bin/pwd), defer to safeBins/allowlist rather than auto-allow here.
  const resolution = resolveExecutionTargetResolution(params.segment.resolution);
  if (resolution?.resolvedPath) {
    return false;
  }
  const head = params.segment.argv[0]?.trim().toLowerCase();
  if (!head) {
    return false;
  }
  return params.safeBuiltins.has(head);
}
