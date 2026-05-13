import { isWindowsPlatform, type ExecCommandSegment } from "./exec-approvals-analysis.js";
import { resolveExecutionTargetResolution } from "./exec-command-resolution.js";

// POSIX shell builtins users may configure under `tools.exec.safeBuiltins`. This is the
// closed supported set — anything outside this list is silently dropped at normalization
// time so a misconfiguration like `safeBuiltins: ["eval"]` cannot bypass approval for
// code-evaluating builtins. To extend the supported surface, add a name here and document
// the rationale.
//
// Members:
//   :, true, false — no-ops / status returns
//   pwd            — reads cwd, does not change it
//   cd, export, unset — mutate cwd/env before later segments run; opt-in only because the
//     allowlist evaluator resolves each segment against the original cwd/env, so auto-
//     allowing them can approve a different executable than the one the shell eventually
//     runs. Users who understand this trade-off can enable them explicitly via config.
//
// Notably excluded:
//   eval, source, .       — evaluate arbitrary shell code; auto-allowing them defeats
//                           the entire allowlist by letting the configured-as-safe builtin
//                           run a different non-safe binary.
//   echo, printf          — shell-builtin variants differ across shells; the `/usr/bin/`
//                           binaries can be allowlisted via `safeBins` if needed.
//   any non-listed name   — including future shell extensions like aliases or functions;
//                           must be added to this set with explicit review first.
export const SUPPORTED_SAFE_BUILTINS: ReadonlySet<string> = new Set([
  ":",
  "cd",
  "export",
  "false",
  "pwd",
  "true",
  "unset",
]);

// Conservative default: stateless, no shell-state mutation. Users opting into the wider
// supported set (`cd`, `export`, `unset`) take on the cwd/env-mutation trade-off documented
// above and in `docs/tools/exec-approvals-advanced.md`.
export const DEFAULT_SAFE_BUILTINS: readonly string[] = [":", "false", "pwd", "true"];

export function normalizeSafeBuiltins(entries?: readonly string[]): Set<string> {
  if (!Array.isArray(entries)) {
    return new Set();
  }
  const normalized = entries
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0 && SUPPORTED_SAFE_BUILTINS.has(entry));
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
