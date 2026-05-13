/**
 * Tests for OMP URI source discovery used by the standalone plannotator CLI.
 *
 * Run: bun test packages/shared/omp-uri-discovery.test.ts
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  buildOmpUriSources,
  discoverNewestSessionDir,
  encodeCwdSessionDirName,
} from "./omp-uri-discovery";

let root: string;
let fakeHome: string;
let fakeTmp: string;
let agentDir: string;

beforeEach(() => {
  root = join(
    tmpdir(),
    `omp-uri-discovery-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fakeHome = join(root, "home");
  fakeTmp = join(root, "tmp");
  agentDir = join(fakeHome, ".omp", "agent");
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(fakeTmp, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("encodeCwdSessionDirName", () => {
  test("encodes a home-relative cwd with leading dash", () => {
    const cwd = join(fakeHome, "Projects", "ancient-kingdoms-mods");
    mkdirSync(cwd, { recursive: true });
    expect(encodeCwdSessionDirName(cwd, { home: fakeHome, tmp: fakeTmp })).toBe(
      "-Projects-ancient-kingdoms-mods",
    );
  });

  test("encodes the home root itself as a bare dash", () => {
    expect(encodeCwdSessionDirName(fakeHome, { home: fakeHome, tmp: fakeTmp })).toBe("-");
  });

  test("encodes a tmpdir-relative cwd with -tmp prefix", () => {
    const cwd = join(fakeTmp, "scratch", "x");
    mkdirSync(cwd, { recursive: true });
    expect(encodeCwdSessionDirName(cwd, { home: fakeHome, tmp: fakeTmp })).toBe(
      "-tmp-scratch-x",
    );
  });

  test("encodes a non-home, non-tmp absolute path with legacy --<encoded>-- form", () => {
    // Create a path that's outside both fakeHome and fakeTmp.
    const cwd = join(root, "elsewhere", "var", "log");
    mkdirSync(cwd, { recursive: true });
    const encoded = encodeCwdSessionDirName(cwd, { home: fakeHome, tmp: fakeTmp });
    expect(encoded.startsWith("--")).toBe(true);
    expect(encoded.endsWith("--")).toBe(true);
    expect(encoded).toContain("elsewhere-var-log");
  });
});

describe("discoverNewestSessionDir", () => {
  test("returns null when no sessions exist", () => {
    const cwd = join(fakeHome, "Projects", "foo");
    mkdirSync(cwd, { recursive: true });
    expect(discoverNewestSessionDir(agentDir, cwd, { home: fakeHome, tmp: fakeTmp })).toBeNull();
  });

  test("returns the single matching session dir", () => {
    const cwd = join(fakeHome, "Projects", "foo");
    mkdirSync(cwd, { recursive: true });
    const sessionDir = join(agentDir, "sessions", "-Projects-foo", "2026-01-01_abc");
    mkdirSync(sessionDir, { recursive: true });
    expect(discoverNewestSessionDir(agentDir, cwd, { home: fakeHome, tmp: fakeTmp })).toBe(
      sessionDir,
    );
  });

  test("returns the newest session when multiple exist", () => {
    const cwd = join(fakeHome, "Projects", "foo");
    mkdirSync(cwd, { recursive: true });
    const older = join(agentDir, "sessions", "-Projects-foo", "2026-01-01_old");
    const newer = join(agentDir, "sessions", "-Projects-foo", "2026-06-01_new");
    mkdirSync(older, { recursive: true });
    mkdirSync(newer, { recursive: true });
    // Force mtimes so the test is deterministic regardless of FS timestamp granularity.
    utimesSync(older, new Date("2026-01-01"), new Date("2026-01-01"));
    utimesSync(newer, new Date("2026-06-01"), new Date("2026-06-01"));
    expect(discoverNewestSessionDir(agentDir, cwd, { home: fakeHome, tmp: fakeTmp })).toBe(
      newer,
    );
  });

  test("ignores non-directory entries", () => {
    const cwd = join(fakeHome, "Projects", "foo");
    mkdirSync(cwd, { recursive: true });
    const sessionsParent = join(agentDir, "sessions", "-Projects-foo");
    mkdirSync(sessionsParent, { recursive: true });
    writeFileSync(join(sessionsParent, "stray-file.txt"), "ignore me");
    const sessionDir = join(sessionsParent, "real-session");
    mkdirSync(sessionDir, { recursive: true });
    expect(discoverNewestSessionDir(agentDir, cwd, { home: fakeHome, tmp: fakeTmp })).toBe(
      sessionDir,
    );
  });
});

describe("buildOmpUriSources", () => {
  test("env vars take precedence over discovery", () => {
    const cwd = join(fakeHome, "Projects", "foo");
    mkdirSync(cwd, { recursive: true });
    // Create a session dir that would be discovered…
    const discoveredSession = join(agentDir, "sessions", "-Projects-foo", "01_old");
    mkdirSync(join(discoveredSession, "local"), { recursive: true });
    // …but pass explicit env that should win.
    const explicitSessionDir = join(root, "explicit-session");
    const explicitLocal = join(root, "explicit-local");
    mkdirSync(explicitSessionDir, { recursive: true });
    mkdirSync(explicitLocal, { recursive: true });

    const sources = buildOmpUriSources({
      cwd,
      home: fakeHome,
      tmp: fakeTmp,
      env: {
        OMP_AGENT_DIR: agentDir,
        OMP_SESSION_DIR: explicitSessionDir,
        OMP_LOCAL_DIR: explicitLocal,
      },
    });

    expect(sources.artifactsDir).toBe(explicitSessionDir);
    expect(sources.localRoot).toBe(explicitLocal);
    expect(sources.skillsRoot).toBe(join(agentDir, "skills"));
    expect(sources.rulesRoot).toBe(join(agentDir, "rules"));
    expect(sources.memoryRoot).toBe(join(agentDir, "memory"));
  });

  test("falls back to discovery when env is missing", () => {
    const cwd = join(fakeHome, "Projects", "foo");
    mkdirSync(cwd, { recursive: true });
    const sessionDir = join(agentDir, "sessions", "-Projects-foo", "2026-01-01_abc");
    mkdirSync(join(sessionDir, "local"), { recursive: true });

    const sources = buildOmpUriSources({
      cwd,
      home: fakeHome,
      tmp: fakeTmp,
      env: { OMP_AGENT_DIR: agentDir },
    });

    expect(sources.artifactsDir).toBe(sessionDir);
    expect(sources.localRoot).toBe(join(sessionDir, "local"));
  });

  test("derives localRoot from artifactsDir when only OMP_SESSION_DIR is set", () => {
    const cwd = join(fakeHome, "Projects", "foo");
    mkdirSync(cwd, { recursive: true });
    const explicit = join(root, "session");
    mkdirSync(explicit, { recursive: true });

    const sources = buildOmpUriSources({
      cwd,
      home: fakeHome,
      tmp: fakeTmp,
      env: { OMP_AGENT_DIR: agentDir, OMP_SESSION_DIR: explicit },
    });

    expect(sources.artifactsDir).toBe(explicit);
    expect(sources.localRoot).toBe(join(explicit, "local"));
  });

  test("returns null artifactsDir/localRoot when nothing matches", () => {
    const cwd = join(fakeHome, "Projects", "nonexistent");
    mkdirSync(cwd, { recursive: true });

    const sources = buildOmpUriSources({
      cwd,
      home: fakeHome,
      tmp: fakeTmp,
      env: { OMP_AGENT_DIR: agentDir },
    });

    expect(sources.artifactsDir).toBeNull();
    expect(sources.localRoot).toBeNull();
    // Static roots are always set regardless of session presence.
    expect(sources.skillsRoot).toBe(join(agentDir, "skills"));
  });

  test("PI_CODING_AGENT_DIR is a recognized agentDir fallback", () => {
    const cwd = join(fakeHome, "Projects", "foo");
    mkdirSync(cwd, { recursive: true });
    const altAgent = join(root, "alt-agent");
    mkdirSync(altAgent, { recursive: true });

    const sources = buildOmpUriSources({
      cwd,
      home: fakeHome,
      tmp: fakeTmp,
      env: { PI_CODING_AGENT_DIR: altAgent },
    });

    expect(sources.skillsRoot).toBe(join(altAgent, "skills"));
  });
});
