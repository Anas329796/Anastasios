import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveShellProfilePathCandidates } from "./completion-runtime.js";

/**
 * Regression tests for #63069: shell completion profile-path resolution
 * must honor `$ZDOTDIR` (zsh) and `$XDG_CONFIG_HOME` (fish), and bash
 * must consider both `.bashrc` and `.bash_profile` so `isCompletionInstalled`
 * and `installCompletion` agree on the file the shell actually reads.
 */
describe("resolveShellProfilePathCandidates (#63069)", () => {
  const fakeHome = (): string => "/home/example";

  it("uses $ZDOTDIR/.zshrc when ZDOTDIR is set, falling back to $HOME/.zshrc", () => {
    const candidates = resolveShellProfilePathCandidates(
      "zsh",
      { HOME: "/home/example", ZDOTDIR: "/home/example/.config/zsh" },
      fakeHome,
    );
    expect(candidates).toStrictEqual([
      path.join("/home/example/.config/zsh", ".zshrc"),
      path.join("/home/example", ".zshrc"),
    ]);
  });

  it("falls back to $HOME/.zshrc when ZDOTDIR is unset", () => {
    const candidates = resolveShellProfilePathCandidates(
      "zsh",
      { HOME: "/home/example" },
      fakeHome,
    );
    expect(candidates).toStrictEqual([path.join("/home/example", ".zshrc")]);
  });

  it("treats whitespace-only ZDOTDIR as unset", () => {
    const candidates = resolveShellProfilePathCandidates(
      "zsh",
      { HOME: "/home/example", ZDOTDIR: "   " },
      fakeHome,
    );
    expect(candidates).toStrictEqual([path.join("/home/example", ".zshrc")]);
  });

  it("uses $XDG_CONFIG_HOME/fish/config.fish when XDG_CONFIG_HOME is set", () => {
    const candidates = resolveShellProfilePathCandidates(
      "fish",
      { HOME: "/home/example", XDG_CONFIG_HOME: "/home/example/.alt-config" },
      fakeHome,
    );
    expect(candidates).toStrictEqual([
      path.join("/home/example/.alt-config", "fish", "config.fish"),
      path.join("/home/example", ".config", "fish", "config.fish"),
    ]);
  });

  it("falls back to $HOME/.config/fish/config.fish when XDG_CONFIG_HOME is unset", () => {
    const candidates = resolveShellProfilePathCandidates(
      "fish",
      { HOME: "/home/example" },
      fakeHome,
    );
    expect(candidates).toStrictEqual([
      path.join("/home/example", ".config", "fish", "config.fish"),
    ]);
  });

  it("returns .bashrc then .bash_profile for bash (macOS fallback)", () => {
    const candidates = resolveShellProfilePathCandidates(
      "bash",
      { HOME: "/home/example" },
      fakeHome,
    );
    expect(candidates).toStrictEqual([
      path.join("/home/example", ".bashrc"),
      path.join("/home/example", ".bash_profile"),
    ]);
  });

  it("falls back to os.homedir() when env.HOME is unset", () => {
    const candidates = resolveShellProfilePathCandidates("zsh", {}, fakeHome);
    expect(candidates).toStrictEqual([path.join("/home/example", ".zshrc")]);
  });
});

describe("isCompletionInstalled honors $ZDOTDIR / $XDG_CONFIG_HOME / bash fallback (#63069)", () => {
  const originalHome = process.env.HOME;
  const originalZdotdir = process.env.ZDOTDIR;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  let tmpDir = "";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-profile-"));
    process.env.HOME = tmpDir;
    delete process.env.ZDOTDIR;
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalZdotdir === undefined) {
      delete process.env.ZDOTDIR;
    } else {
      process.env.ZDOTDIR = originalZdotdir;
    }
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reads $ZDOTDIR/.zshrc when both that and $HOME/.zshrc would exist (priority)", async () => {
    const zdotdir = path.join(tmpDir, ".config", "zsh");
    await fs.mkdir(zdotdir, { recursive: true });
    const zdotdirZshrc = path.join(zdotdir, ".zshrc");
    const homeZshrc = path.join(tmpDir, ".zshrc");
    // Only the ZDOTDIR file has the OpenClaw marker; HOME/.zshrc is empty.
    await fs.writeFile(zdotdirZshrc, "# OpenClaw Completion\nsource /some/cache\n", "utf-8");
    await fs.writeFile(homeZshrc, "", "utf-8");
    process.env.ZDOTDIR = zdotdir;
    const { isCompletionInstalled } = await import("./completion-runtime.js");
    expect(await isCompletionInstalled("zsh")).toBe(true);
  });

  it("returns true when bash completion is installed in .bash_profile only (macOS)", async () => {
    const bashProfile = path.join(tmpDir, ".bash_profile");
    await fs.writeFile(bashProfile, "# OpenClaw Completion\nsource /some/cache\n", "utf-8");
    // .bashrc deliberately absent
    const { isCompletionInstalled } = await import("./completion-runtime.js");
    expect(await isCompletionInstalled("bash")).toBe(true);
  });

  it("returns true when fish completion is in $XDG_CONFIG_HOME/fish/config.fish", async () => {
    const xdg = path.join(tmpDir, "xdg-config");
    const fishDir = path.join(xdg, "fish");
    await fs.mkdir(fishDir, { recursive: true });
    const fishConfig = path.join(fishDir, "config.fish");
    await fs.writeFile(fishConfig, "# OpenClaw Completion\nsource /some/cache\n", "utf-8");
    process.env.XDG_CONFIG_HOME = xdg;
    const { isCompletionInstalled } = await import("./completion-runtime.js");
    expect(await isCompletionInstalled("fish")).toBe(true);
  });

  it("returns false when no profile candidate exists", async () => {
    // Empty tmpDir, no .zshrc, no $ZDOTDIR
    const { isCompletionInstalled } = await import("./completion-runtime.js");
    expect(await isCompletionInstalled("zsh")).toBe(false);
  });
});
