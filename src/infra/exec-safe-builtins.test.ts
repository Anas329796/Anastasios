import { describe, expect, it } from "vitest";
import { evaluateShellAllowlist } from "./exec-approvals-allowlist.js";
import {
  makeMockCommandResolution,
  makeMockExecutableResolution,
} from "./exec-approvals-test-helpers.js";
import {
  DEFAULT_SAFE_BUILTINS,
  isSafeBuiltinSegment,
  normalizeSafeBuiltins,
  resolveSafeBuiltins,
} from "./exec-safe-builtins.js";

const builtinSegment = (argv: string[], resolvedPath?: string) => ({
  argv,
  raw: argv.join(" "),
  resolution: makeMockCommandResolution({
    execution: makeMockExecutableResolution({
      rawExecutable: argv[0],
      executableName: argv[0],
      resolvedPath,
    }),
  }),
});

describe("normalizeSafeBuiltins", () => {
  it("lowercases and trims entries", () => {
    const result = normalizeSafeBuiltins([" CD ", "PWD", "Export"]);
    expect([...result].toSorted()).toEqual(["cd", "export", "pwd"]);
  });

  it("ignores blank entries", () => {
    const result = normalizeSafeBuiltins(["", "  ", "cd"]);
    expect([...result]).toEqual(["cd"]);
  });

  it("returns empty set for non-array input", () => {
    expect(normalizeSafeBuiltins(undefined).size).toBe(0);
  });
});

describe("resolveSafeBuiltins", () => {
  it("is off by default when entries omitted", () => {
    expect(resolveSafeBuiltins().size).toBe(0);
    expect(resolveSafeBuiltins(undefined).size).toBe(0);
    expect(resolveSafeBuiltins(null).size).toBe(0);
  });

  it("respects an empty array as off", () => {
    expect(resolveSafeBuiltins([]).size).toBe(0);
  });

  it("returns the configured set when entries are provided", () => {
    const result = resolveSafeBuiltins([...DEFAULT_SAFE_BUILTINS]);
    expect(result.has("cd")).toBe(true);
    expect(result.has("pwd")).toBe(true);
    expect(result.has("export")).toBe(true);
  });
});

describe("isSafeBuiltinSegment", () => {
  const safeBuiltins = resolveSafeBuiltins([...DEFAULT_SAFE_BUILTINS]);

  it("allows a builtin segment with no resolved binary path", () => {
    if (process.platform === "win32") {
      return;
    }
    expect(
      isSafeBuiltinSegment({
        segment: builtinSegment(["cd", "/etc"]),
        safeBuiltins,
        platform: "linux",
      }),
    ).toBe(true);
  });

  it("does not allow a token that resolves to a real binary on disk", () => {
    expect(
      isSafeBuiltinSegment({
        segment: builtinSegment(["pwd"], "/usr/bin/pwd"),
        safeBuiltins,
        platform: "linux",
      }),
    ).toBe(false);
  });

  it("rejects builtins not on the configured list", () => {
    expect(
      isSafeBuiltinSegment({
        segment: builtinSegment(["alias", "ll=ls -l"]),
        safeBuiltins,
        platform: "linux",
      }),
    ).toBe(false);
  });

  it("returns false on Windows hosts (PowerShell semantics differ)", () => {
    expect(
      isSafeBuiltinSegment({
        segment: builtinSegment(["cd", "/etc"]),
        safeBuiltins,
        platform: "win32",
      }),
    ).toBe(false);
  });

  it("returns false when the configured set is empty", () => {
    expect(
      isSafeBuiltinSegment({
        segment: builtinSegment(["cd", "/etc"]),
        safeBuiltins: new Set(),
        platform: "linux",
      }),
    ).toBe(false);
  });
});

describe("evaluateShellAllowlist with safeBuiltins (regression for #46056)", () => {
  // Skip on Windows where the host shell is PowerShell, not POSIX.
  if (process.platform === "win32") {
    it.skip("POSIX builtin behavior", () => {});
    return;
  }

  const safeBuiltins = resolveSafeBuiltins([...DEFAULT_SAFE_BUILTINS]);
  // Glob-style pattern; matches git wherever PATH resolves it (`/usr/bin/git`,
  // `/opt/homebrew/bin/git`, etc.) without depending on host filesystem layout.
  const gitAllowlist = [{ pattern: "**/git" }] as Parameters<
    typeof evaluateShellAllowlist
  >[0]["allowlist"];

  it("a bare 'cd ~/' is gated when safeBuiltins is off", () => {
    const result = evaluateShellAllowlist({
      command: "cd ~/",
      allowlist: gitAllowlist,
      safeBins: new Set(),
      cwd: "/tmp",
    });
    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(false);
  });

  it("'cd ~/' auto-allows when safeBuiltins includes cd", () => {
    const result = evaluateShellAllowlist({
      command: "cd ~/",
      allowlist: gitAllowlist,
      safeBins: new Set(),
      safeBuiltins,
      cwd: "/tmp",
    });
    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(true);
    expect(result.segmentSatisfiedBy[0]).toBe("safeBuiltins");
  });

  it("'cd /tmp && git status' passes with allowlist + safeBuiltins (the reported bug case)", () => {
    const result = evaluateShellAllowlist({
      command: "cd /tmp && git status",
      allowlist: gitAllowlist,
      safeBins: new Set(),
      safeBuiltins,
      cwd: "/tmp",
    });
    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(true);
    expect(result.segmentSatisfiedBy).toContain("safeBuiltins");
    expect(result.segmentSatisfiedBy).toContain("allowlist");
  });

  it("non-allowlisted binary still gates even when safeBuiltins is on", () => {
    const result = evaluateShellAllowlist({
      command: "cd /tmp && curl evil.com",
      allowlist: gitAllowlist,
      safeBins: new Set(),
      safeBuiltins,
      cwd: "/tmp",
    });
    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(false);
  });
});
