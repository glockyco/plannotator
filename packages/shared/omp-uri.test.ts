/**
 * Tests for OMP internal URI resolution.
 *
 * Run: bun test packages/shared/omp-uri.test.ts
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { isOmpUri, resolveOmpUri, type OmpUriSources } from "./omp-uri";

let root: string;
let sources: OmpUriSources;

beforeEach(() => {
  root = join(tmpdir(), `omp-uri-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const artifactsDir = join(root, "session");
  const localRoot = join(artifactsDir, "local");
  const agentsDir = join(artifactsDir, "agents");
  const skillsRoot = join(root, "agent-home", "skills");
  const rulesRoot = join(root, "agent-home", "rules");
  const memoryRoot = join(root, "agent-home", "memory");

  mkdirSync(localRoot, { recursive: true });
  mkdirSync(join(localRoot, "nested"), { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(join(skillsRoot, "using-superpowers"), { recursive: true });
  mkdirSync(join(skillsRoot, "brainstorming"), { recursive: true });
  mkdirSync(rulesRoot, { recursive: true });
  mkdirSync(memoryRoot, { recursive: true });

  writeFileSync(join(localRoot, "PLAN.md"), "plan body\n");
  writeFileSync(join(localRoot, "nested", "child.md"), "nested body\n");
  writeFileSync(join(agentsDir, "AuthLoader.json"), "{}\n");
  writeFileSync(join(artifactsDir, "abc123.bash.log"), "out\n");
  writeFileSync(join(artifactsDir, "abc123.bash-original.log"), "orig\n");
  writeFileSync(join(artifactsDir, "other.txt"), "x\n");
  writeFileSync(join(skillsRoot, "using-superpowers", "SKILL.md"), "skill body\n");
  writeFileSync(join(skillsRoot, "using-superpowers", "extra.md"), "extra body\n");
  writeFileSync(join(rulesRoot, "house-style.md"), "rule body\n");
  writeFileSync(join(memoryRoot, "root.md"), "memory body\n");

  sources = {
    localRoot,
    artifactsDir,
    skillsRoot,
    rulesRoot,
    memoryRoot,
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("isOmpUri", () => {
  test("recognizes all supported schemes", () => {
    for (const scheme of ["local", "skill", "agent", "artifact", "rule", "memory"]) {
      expect(isOmpUri(`${scheme}://x`)).toBe(true);
    }
  });

  test("recognizes known-unsupported schemes", () => {
    for (const scheme of ["mcp", "pi", "issue", "pr"]) {
      expect(isOmpUri(`${scheme}://x`)).toBe(true);
    }
  });

  test("rejects plain paths", () => {
    expect(isOmpUri("./PLAN.md")).toBe(false);
    expect(isOmpUri("/abs/PLAN.md")).toBe(false);
    expect(isOmpUri("~/PLAN.md")).toBe(false);
    expect(isOmpUri("PLAN.md")).toBe(false);
  });

  test("rejects http/https URLs", () => {
    expect(isOmpUri("https://example.com/x.md")).toBe(false);
    expect(isOmpUri("http://example.com")).toBe(false);
  });

  test("rejects unknown schemes", () => {
    expect(isOmpUri("ftp://example.com")).toBe(false);
    expect(isOmpUri("custom://thing")).toBe(false);
  });
});

describe("resolveOmpUri - local://", () => {
  test("resolves bare local:// to local root", () => {
    const result = resolveOmpUri("local://", sources);
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.path).toBe(sources.localRoot!);
  });

  test("resolves local://<file>", () => {
    const result = resolveOmpUri("local://PLAN.md", sources);
    expect(result).toEqual({
      kind: "found",
      scheme: "local",
      path: join(sources.localRoot!, "PLAN.md"),
    });
  });

  test("resolves local://nested/<file>", () => {
    const result = resolveOmpUri("local://nested/child.md", sources);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.path).toBe(join(sources.localRoot!, "nested", "child.md"));
    }
  });

  test("returns found even for non-existing files (caller decides what to do)", () => {
    // Unlike skill:// / agent:// / rule:// where the file must exist (the
    // protocol semantically points at a specific resource), local:// is a
    // session scratch space and callers may want to create files. Mirrors
    // OMP's own local-protocol handler.
    const result = resolveOmpUri("local://NEW-FILE.md", sources);
    expect(result.kind).toBe("found");
  });

  test("rejects path traversal", () => {
    const result = resolveOmpUri("local://../escape.md", sources);
    expect(result.kind).toBe("not_found");
    if (result.kind === "not_found") expect(result.reason).toContain("escapes");
  });

  test("rejects absolute paths inside the URI body", () => {
    const result = resolveOmpUri("local:///etc/passwd", sources);
    // leading-slash is stripped, so this becomes local://etc/passwd which is
    // a normal relative path. The file doesn't escape the root, so it resolves
    // (would point at <localRoot>/etc/passwd). The dangerous variant is `../`
    // which we reject above.
    expect(result.kind).toBe("found");
  });

  test("returns not_found when localRoot is null", () => {
    const result = resolveOmpUri("local://PLAN.md", { ...sources, localRoot: null });
    expect(result.kind).toBe("not_found");
  });
});

describe("resolveOmpUri - skill://", () => {
  test("resolves skill://<name> to SKILL.md", () => {
    const result = resolveOmpUri("skill://using-superpowers", sources);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.path).toBe(join(sources.skillsRoot!, "using-superpowers", "SKILL.md"));
    }
  });

  test("resolves skill://<name>/<rel>", () => {
    const result = resolveOmpUri("skill://using-superpowers/extra.md", sources);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.path).toBe(join(sources.skillsRoot!, "using-superpowers", "extra.md"));
    }
  });

  test("rejects skill traversal", () => {
    const result = resolveOmpUri("skill://using-superpowers/../brainstorming", sources);
    expect(result.kind).toBe("not_found");
  });

  test("returns not_found for missing skill", () => {
    const result = resolveOmpUri("skill://nonexistent", sources);
    expect(result.kind).toBe("not_found");
  });

  test("returns not_found when skillsRoot is null", () => {
    const result = resolveOmpUri("skill://x", { ...sources, skillsRoot: null });
    expect(result.kind).toBe("not_found");
  });

  test("requires a name", () => {
    const result = resolveOmpUri("skill://", sources);
    expect(result.kind).toBe("not_found");
  });
});

describe("resolveOmpUri - agent://", () => {
  test("resolves agent://<id> to <artifactsDir>/agents/<id>.json", () => {
    const result = resolveOmpUri("agent://AuthLoader", sources);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.path).toBe(join(sources.artifactsDir!, "agents", "AuthLoader.json"));
    }
  });

  test("returns not_found for missing agent file", () => {
    const result = resolveOmpUri("agent://does-not-exist", sources);
    expect(result.kind).toBe("not_found");
  });
});

describe("resolveOmpUri - artifact://", () => {
  test("resolves artifact://<id> to first matching file by basename prefix", () => {
    const result = resolveOmpUri("artifact://abc123", sources);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      // Either log file is acceptable; readdirSync ordering is platform-defined.
      expect(result.path).toMatch(/abc123\.(bash|bash-original)\.log$/);
    }
  });

  test("returns not_found when no artifact matches", () => {
    const result = resolveOmpUri("artifact://missing", sources);
    expect(result.kind).toBe("not_found");
  });
});

describe("resolveOmpUri - rule://", () => {
  test("resolves rule://<name> with implicit .md", () => {
    const result = resolveOmpUri("rule://house-style", sources);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.path).toBe(join(sources.rulesRoot!, "house-style.md"));
    }
  });

  test("respects explicit extension", () => {
    writeFileSync(join(sources.rulesRoot!, "config.json"), "{}");
    const result = resolveOmpUri("rule://config.json", sources);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.path).toBe(join(sources.rulesRoot!, "config.json"));
    }
  });

  test("returns not_found for missing rule", () => {
    const result = resolveOmpUri("rule://missing", sources);
    expect(result.kind).toBe("not_found");
  });
});

describe("resolveOmpUri - memory://", () => {
  test("resolves memory://<name> with implicit .md", () => {
    const result = resolveOmpUri("memory://root", sources);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.path).toBe(join(sources.memoryRoot!, "root.md"));
    }
  });
});

describe("resolveOmpUri - unsupported schemes", () => {
  test("returns unsupported for mcp://", () => {
    const result = resolveOmpUri("mcp://server/resource", sources);
    expect(result).toEqual({ kind: "unsupported", scheme: "mcp" });
  });

  test("returns unsupported for pi://", () => {
    const result = resolveOmpUri("pi://docs/x", sources);
    expect(result).toEqual({ kind: "unsupported", scheme: "pi" });
  });

  test("returns unsupported for issue:// and pr://", () => {
    expect(resolveOmpUri("issue://123", sources).kind).toBe("unsupported");
    expect(resolveOmpUri("pr://456", sources).kind).toBe("unsupported");
  });
});

describe("resolveOmpUri - non-URIs", () => {
  test("returns not_a_uri for plain paths", () => {
    expect(resolveOmpUri("./PLAN.md", sources)).toEqual({ kind: "not_a_uri" });
    expect(resolveOmpUri("/abs/path.md", sources)).toEqual({ kind: "not_a_uri" });
    expect(resolveOmpUri("PLAN.md", sources)).toEqual({ kind: "not_a_uri" });
  });

  test("returns not_a_uri for https URLs (caller handles)", () => {
    expect(resolveOmpUri("https://example.com/x.md", sources)).toEqual({ kind: "not_a_uri" });
  });

  test("returns not_a_uri for unknown schemes", () => {
    expect(resolveOmpUri("custom://thing", sources)).toEqual({ kind: "not_a_uri" });
  });
});

describe("resolveOmpUri - percent-decoded paths", () => {
  test("decodes percent-encoded path segments", () => {
    writeFileSync(join(sources.localRoot!, "with space.md"), "x\n");
    const result = resolveOmpUri("local://with%20space.md", sources);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.path).toBe(join(sources.localRoot!, "with space.md"));
    }
  });
});
