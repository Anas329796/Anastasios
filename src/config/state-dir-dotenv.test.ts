import path from "node:path";
import { describe, expect, it } from "vitest";
import { readStateDirDotEnvVarsFromStateDir } from "./state-dir-dotenv.js";
import { withTempHome, writeStateDirDotEnv } from "./test-helpers.js";

const FIXTURE = "REDACTED-FIXTURE";

describe("readStateDirDotEnvVarsFromStateDir", () => {
  it("retains operator-curated override-only keys placed in ~/.openclaw/.env", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      await writeStateDirDotEnv(
        [
          `GH_TOKEN=${FIXTURE}-gh`,
          `GITHUB_TOKEN=${FIXTURE}-github`,
          `AWS_ACCESS_KEY_ID=${FIXTURE}-aws-akid`,
          `NPM_TOKEN=${FIXTURE}-npm`,
          `SSH_AUTH_SOCK=${FIXTURE}-ssh-sock`,
          `DATABASE_URL=${FIXTURE}-db-url`,
          "",
        ].join("\n"),
        { stateDir },
      );

      const parsed = readStateDirDotEnvVarsFromStateDir(stateDir);

      expect(parsed.GH_TOKEN).toBe(`${FIXTURE}-gh`);
      expect(parsed.GITHUB_TOKEN).toBe(`${FIXTURE}-github`);
      expect(parsed.AWS_ACCESS_KEY_ID).toBe(`${FIXTURE}-aws-akid`);
      expect(parsed.NPM_TOKEN).toBe(`${FIXTURE}-npm`);
      expect(parsed.SSH_AUTH_SOCK).toBe(`${FIXTURE}-ssh-sock`);
      expect(parsed.DATABASE_URL).toBe(`${FIXTURE}-db-url`);
    });
  });

  it("still strips truly everywhere-dangerous keys from ~/.openclaw/.env", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      await writeStateDirDotEnv(
        [
          "LD_PRELOAD=/tmp/evil.so",
          "NODE_OPTIONS=--require /tmp/evil.js",
          "BASH_ENV=/tmp/evil.sh",
          "DYLD_LIBRARY_PATH=/tmp/evil-lib",
          "DYLD_INSERT_LIBRARIES=/tmp/evil-insert",
          "GIT_DIR=/tmp/evil-git",
          // Surviving sentinel proves the parser still ran.
          `SAFE_KEY=${FIXTURE}-safe`,
          "",
        ].join("\n"),
        { stateDir },
      );

      const parsed = readStateDirDotEnvVarsFromStateDir(stateDir);

      expect(parsed.LD_PRELOAD).toBeUndefined();
      expect(parsed.NODE_OPTIONS).toBeUndefined();
      expect(parsed.BASH_ENV).toBeUndefined();
      expect(parsed.DYLD_LIBRARY_PATH).toBeUndefined();
      expect(parsed.DYLD_INSERT_LIBRARIES).toBeUndefined();
      expect(parsed.GIT_DIR).toBeUndefined();
      expect(parsed.SAFE_KEY).toBe(`${FIXTURE}-safe`);
    });
  });

  it("skips empty values and ignores unknown safe keys", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      await writeStateDirDotEnv(
        ["EMPTY_KEY=", "WHITESPACE_KEY=   ", `MY_CUSTOM_KEY=${FIXTURE}-custom`, ""].join("\n"),
        { stateDir },
      );

      const parsed = readStateDirDotEnvVarsFromStateDir(stateDir);

      expect(parsed.EMPTY_KEY).toBeUndefined();
      expect(parsed.WHITESPACE_KEY).toBeUndefined();
      expect(parsed.MY_CUSTOM_KEY).toBe(`${FIXTURE}-custom`);
    });
  });
});
