import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSessionStore } from "./store-load.js";

function makeValidStore(...sessionIds: string[]): Record<string, unknown> {
  const store: Record<string, unknown> = {};
  for (const id of sessionIds) {
    store[id] = { sessionId: id, updatedAt: Date.now() };
  }
  return store;
}

function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "session-recovery-"));
}

function setOlderThan(filePath: string, secondsAgo: number): void {
  const now = Date.now() / 1000;
  const target = now - secondsAgo;
  fs.utimesSync(filePath, new Date(target * 1000), new Date(target * 1000));
}

function setNowMtime(filePath: string): void {
  const now = new Date();
  fs.utimesSync(filePath, now, now);
}

function getFileMode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

describe("session store load recovery", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty when main file is missing even if .bak exists", () => {
    const bakPath = `${storePath}.bak`;
    writeJson(bakPath, makeValidStore("bak-session"));
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toHaveLength(0);
  });

  it("recovers 3 entries from .bak when main file is zero bytes", () => {
    fs.writeFileSync(storePath, "", "utf-8");
    writeJson(`${storePath}.bak`, makeValidStore("s1", "s2", "s3"));
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toHaveLength(3);
    if (process.platform !== "win32") {
      expect(getFileMode(storePath)).toBe(0o600);
    }
  });

  it("recovers from .bak when main file has malformed JSON", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    writeJson(`${storePath}.bak`, makeValidStore("bak-session"));
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toHaveLength(1);
  });

  it("recovers from stale legacy tmp when main is malformed", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    const tmpFile = path.join(tmpDir, `sessions.json.${crypto.randomUUID()}.tmp`);
    writeJson(tmpFile, makeValidStore("tmp1", "tmp2"));
    setOlderThan(tmpFile, 15);
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toHaveLength(2);
  });

  it("recovers from stale fs-safe tmp when main is malformed", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    const fsSafeTmp = path.join(tmpDir, ".fs-safe-replace.12345.abcdef-1234.tmp");
    writeJson(fsSafeTmp, makeValidStore("fs-safe-1", "fs-safe-2"));
    setOlderThan(fsSafeTmp, 15);
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toHaveLength(2);
  });

  it("does not recover from .bak when main file is valid empty object", () => {
    writeJson(storePath, {});
    writeJson(`${storePath}.bak`, makeValidStore("bak-session"));
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toHaveLength(0);
  });

  it("does not recover from .bak or tmp when main file contains valid []", () => {
    writeJson(storePath, []);
    writeJson(`${storePath}.bak`, makeValidStore("bak-session"));
    const staleTmp = path.join(tmpDir, ".fs-safe-replace.88888.stale-0008.tmp");
    writeJson(staleTmp, makeValidStore("stale-session"));
    setOlderThan(staleTmp, 15);
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toHaveLength(0);
    expect(store["bak-session"]).toBeUndefined();
    expect(store["stale-session"]).toBeUndefined();
  });

  it("recovers from stale fs-safe tmp preferred over fresh legacy tmp", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    const fsSafeTmp = path.join(tmpDir, ".fs-safe-replace.12345.abcdef-1234.tmp");
    writeJson(fsSafeTmp, makeValidStore("fs-safe"));
    setOlderThan(fsSafeTmp, 15);
    const freshLegacyTmp = path.join(tmpDir, `sessions.json.${crypto.randomUUID()}.tmp`);
    writeJson(freshLegacyTmp, makeValidStore("fresh"));
    setNowMtime(freshLegacyTmp);
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store["fs-safe"]).toBeDefined();
    expect(store["fresh"]).toBeUndefined();
  });

  it("prefers newest stale tmp when multiple valid candidates exist", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    const olderTmp = path.join(tmpDir, ".fs-safe-replace.66666.older-0006.tmp");
    writeJson(olderTmp, makeValidStore("older-session"));
    setOlderThan(olderTmp, 60);
    const newerTmp = path.join(tmpDir, ".fs-safe-replace.77777.newer-0007.tmp");
    writeJson(newerTmp, makeValidStore("newer-session"));
    setOlderThan(newerTmp, 15);
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store["newer-session"]).toBeDefined();
    expect(store["older-session"]).toBeUndefined();
    expect(Object.keys(store)).toHaveLength(1);
  });

  it("ignores fresh temp artifacts (< 10s old) to avoid racing active writers", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    const freshTmp = path.join(tmpDir, ".fs-safe-replace.99999.fresh-race.tmp");
    writeJson(freshTmp, makeValidStore("fresh-only"));
    setNowMtime(freshTmp);
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toHaveLength(0);
  });

  it("skips empty {} tmp candidate and continues to next valid candidate", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    const emptyTmp = path.join(tmpDir, ".fs-safe-replace.11111.empty-0001.tmp");
    writeJson(emptyTmp, {});
    setOlderThan(emptyTmp, 30);
    const validTmp = path.join(tmpDir, ".fs-safe-replace.22222.valid-0002.tmp");
    writeJson(validTmp, makeValidStore("recovered"));
    setOlderThan(validTmp, 15);
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store["recovered"]).toBeDefined();
    expect(Object.keys(store)).toHaveLength(1);
  });

  it("skips unrelated json tmp (no sessionId entries) and continues scanning", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    const unrelatedTmp = path.join(tmpDir, ".fs-safe-replace.33333.unrelated-0003.tmp");
    writeJson(unrelatedTmp, { version: 1, config: { foo: "bar" } });
    setOlderThan(unrelatedTmp, 30);
    const validTmp = path.join(tmpDir, ".fs-safe-replace.44444.valid-0004.tmp");
    writeJson(validTmp, makeValidStore("recovered"));
    setOlderThan(validTmp, 15);
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store["recovered"]).toBeDefined();
    expect(Object.keys(store)).toHaveLength(1);
  });

  it("skips unrelated .bak (no sessionId entries) and falls through to stale tmp", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    writeJson(`${storePath}.bak`, { version: 1, config: { foo: "bar" } });
    const validTmp = path.join(tmpDir, ".fs-safe-replace.55555.valid-0005.tmp");
    writeJson(validTmp, makeValidStore("from-tmp"));
    setOlderThan(validTmp, 15);
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store["from-tmp"]).toBeDefined();
    expect(Object.keys(store)).toHaveLength(1);
  });

  it("self-heals main file after recovery from .bak", () => {
    fs.writeFileSync(storePath, "{bad json", "utf-8");
    writeJson(`${storePath}.bak`, makeValidStore("heal-session"));
    loadSessionStore(storePath, { skipCache: true });
    const healedRaw = fs.readFileSync(storePath, "utf-8");
    const healedParsed = JSON.parse(healedRaw);
    expect(healedParsed["heal-session"]).toBeDefined();
  });
});
