/**
 * OMP internal URI resolution for plannotator.
 *
 * Background: OMP (Oh My Pi) defines a family of internal URI schemes
 * (`local://`, `skill://`, `agent://`, `artifact://`, `rule://`, `memory://`)
 * that resolve to filesystem paths via OMP's `InternalUrlRouter`. The agent's
 * `bash` tool auto-expands these URIs in command strings before exec, but the
 * `!` interactive shortcut, the `/plannotator-annotate` slash command (which
 * runs in-process), and any manual terminal invocation all bypass that
 * expansion. Plannotator therefore resolves the URIs itself.
 *
 * This module is the **pure** resolver. It takes a `sources` bundle of
 * already-resolved absolute roots and returns a resolution result. Two callers
 * populate the bundle from different contexts:
 *
 * - The pi-extension (`apps/pi-extension/index.ts`) reads the session's
 *   artifacts directory directly from `ctx.sessionManager.getArtifactsDir()`
 *   and uses well-known `~/.omp/agent/{skills,rules,memory}` paths.
 *
 * - The standalone CLI (`apps/hook/server/index.ts`) reads env vars set by
 *   OMP (or our `omp-agent-setup` `session_start` extension) and falls back
 *   to filesystem discovery when env is unset.
 *
 * Skill resolution is filesystem-based against a well-known root, not via
 * OMP's `getActiveSkills` registry. Sharing OMP's process-singleton from a
 * separately-resolved import is impractical (Node de-dupes by physical path,
 * and the extension lives outside OMP's global node_modules tree). Practically
 * this means plugin- or extension-provided skill directories — like
 * `~/Projects/superpowers/skills` — are not reachable through `skill://` here;
 * the user falls back to a literal path for those.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export const OMP_URI_SCHEMES = ["local", "skill", "agent", "artifact", "rule", "memory"] as const;
export type OmpUriScheme = (typeof OMP_URI_SCHEMES)[number];

/** Schemes we know about but cannot resolve to a filesystem path. */
export const UNSUPPORTED_OMP_SCHEMES = ["mcp", "pi", "issue", "pr"] as const;

export interface OmpUriSources {
  /** Absolute path to the session's `<artifactsDir>/local` directory. */
  localRoot?: string | null;
  /** Absolute path to the session artifacts directory. */
  artifactsDir?: string | null;
  /** Absolute path to the `skills/` root (typically `~/.omp/agent/skills`). */
  skillsRoot?: string | null;
  /** Absolute path to the `rules/` root (typically `~/.omp/agent/rules`). */
  rulesRoot?: string | null;
  /** Absolute path to the `memory/` root (typically `~/.omp/agent/memory`). */
  memoryRoot?: string | null;
}

export type OmpUriResolution =
  | { kind: "not_a_uri" }
  | { kind: "found"; path: string; scheme: OmpUriScheme }
  | { kind: "unsupported"; scheme: string }
  | { kind: "not_found"; scheme: OmpUriScheme; reason: string };

const OMP_URI_RE = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i;

/** Cheap pre-check — does this look like any OMP URI (supported or not)? */
export function isOmpUri(input: string): boolean {
  const match = OMP_URI_RE.exec(input);
  if (!match) return false;
  const scheme = match[1]!.toLowerCase();
  return (
    (OMP_URI_SCHEMES as readonly string[]).includes(scheme) ||
    (UNSUPPORTED_OMP_SCHEMES as readonly string[]).includes(scheme)
  );
}

interface ParsedUri {
  scheme: string;
  /** Decoded, normalized relative path. Empty string means "the root itself". */
  rest: string;
}

function parseOmpUri(input: string): ParsedUri | null {
  const match = OMP_URI_RE.exec(input);
  if (!match) return null;
  const scheme = match[1]!.toLowerCase();
  const body = match[2] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(body.replaceAll("\\", "/"));
  } catch {
    return null;
  }
  // Strip a leading `/` so `local:///PLAN.md` and `local://PLAN.md` behave the
  // same. Trailing slashes are preserved — callers may care about directories.
  const rest = decoded.startsWith("/") ? decoded.slice(1) : decoded;
  return { scheme, rest };
}

/**
 * Reject traversal segments and absolute components. Mirrors OMP's
 * `validateRelativePath` in `internal-urls/skill-protocol.ts`.
 */
function isSafeRelativePath(rel: string): boolean {
  if (rel === "") return true;
  if (rel.startsWith("/") || rel.startsWith(sep)) return false;
  const parts = rel.split(/[/\\]/);
  for (const part of parts) {
    if (part === "..") return false;
  }
  return true;
}

function joinWithinRoot(root: string, rel: string): string | null {
  if (!isSafeRelativePath(rel)) return null;
  const resolved = rel === "" ? resolve(root) : resolve(root, rel);
  const normalizedRoot = resolve(root);
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${sep}`)) {
    return null;
  }
  return resolved;
}

function notFound(scheme: OmpUriScheme, reason: string): OmpUriResolution {
  return { kind: "not_found", scheme, reason };
}

function ok(path: string, scheme: OmpUriScheme): OmpUriResolution {
  return { kind: "found", path, scheme };
}

/**
 * Resolve a single OMP URI string. Returns:
 * - `not_a_uri` for non-URI input (caller should fall through to its normal path resolution).
 * - `unsupported` for known-but-non-filesystem schemes (`mcp://`, `pi://`, `issue://`, `pr://`).
 * - `not_found` when the scheme is supported but the required `sources` entry is missing
 *   or the resolved path escapes its root.
 * - `found` with the absolute filesystem path on success.
 */
export function resolveOmpUri(input: string, sources: OmpUriSources): OmpUriResolution {
  const parsed = parseOmpUri(input);
  if (!parsed) return { kind: "not_a_uri" };

  const { scheme, rest } = parsed;

  if ((UNSUPPORTED_OMP_SCHEMES as readonly string[]).includes(scheme)) {
    return { kind: "unsupported", scheme };
  }

  if (!(OMP_URI_SCHEMES as readonly string[]).includes(scheme)) {
    return { kind: "not_a_uri" };
  }

  const knownScheme = scheme as OmpUriScheme;

  switch (knownScheme) {
    case "local":
      return resolveLocal(rest, sources.localRoot);
    case "skill":
      return resolveSkill(rest, sources.skillsRoot);
    case "agent":
      return resolveAgent(rest, sources.artifactsDir);
    case "artifact":
      return resolveArtifact(rest, sources.artifactsDir);
    case "rule":
      return resolveStaticRoot(rest, sources.rulesRoot, "rule", ".md");
    case "memory":
      return resolveStaticRoot(rest, sources.memoryRoot, "memory", ".md");
  }
}

function resolveLocal(rest: string, localRoot: string | null | undefined): OmpUriResolution {
  if (!localRoot) {
    return notFound("local", "session has no local artifacts directory");
  }
  const target = joinWithinRoot(localRoot, rest);
  if (!target) return notFound("local", "path escapes local root");
  return ok(target, "local");
}

function resolveSkill(rest: string, skillsRoot: string | null | undefined): OmpUriResolution {
  if (!skillsRoot) {
    return notFound("skill", "skills root unavailable");
  }
  if (rest === "") {
    return notFound("skill", "skill:// URI requires a skill name");
  }
  // `skill://<name>` -> `<root>/<name>/SKILL.md`
  // `skill://<name>/<rel>` -> `<root>/<name>/<rel>`
  const slash = rest.indexOf("/");
  const name = slash === -1 ? rest : rest.slice(0, slash);
  const relPath = slash === -1 ? "SKILL.md" : rest.slice(slash + 1);
  if (!isSafeRelativePath(name) || name.includes("/") || name.includes("\\")) {
    return notFound("skill", `invalid skill name: ${name}`);
  }
  const target = joinWithinRoot(join(skillsRoot, name), relPath);
  if (!target) return notFound("skill", "path escapes skill root");
  if (!existsSync(target)) {
    return notFound("skill", `skill not found at ${target}`);
  }
  return ok(target, "skill");
}

function resolveAgent(rest: string, artifactsDir: string | null | undefined): OmpUriResolution {
  if (!artifactsDir) return notFound("agent", "session artifacts directory unavailable");
  if (rest === "") return notFound("agent", "agent:// URI requires an id");
  if (!isSafeRelativePath(rest)) return notFound("agent", "path escapes agent root");
  const target = joinWithinRoot(join(artifactsDir, "agents"), `${rest}.json`);
  if (!target) return notFound("agent", "path escapes agent root");
  if (!existsSync(target)) return notFound("agent", `no agent file at ${target}`);
  return ok(target, "agent");
}

function resolveArtifact(rest: string, artifactsDir: string | null | undefined): OmpUriResolution {
  if (!artifactsDir) return notFound("artifact", "session artifacts directory unavailable");
  if (rest === "") return notFound("artifact", "artifact:// URI requires an id");
  if (!isSafeRelativePath(rest)) return notFound("artifact", "path escapes artifact root");
  const safeDir = resolve(artifactsDir);
  let entries: string[];
  try {
    entries = readdirSync(safeDir);
  } catch {
    return notFound("artifact", `artifacts directory unreadable: ${safeDir}`);
  }
  const prefix = `${rest}.`;
  const exactMatch = entries.find((entry) => entry === rest);
  const prefixMatch = entries.find((entry) => entry.startsWith(prefix));
  const chosen = exactMatch ?? prefixMatch;
  if (!chosen) return notFound("artifact", `no artifact matching id "${rest}" in ${safeDir}`);
  const candidate = join(safeDir, chosen);
  try {
    if (!statSync(candidate).isFile()) {
      return notFound("artifact", `${candidate} is not a file`);
    }
  } catch {
    return notFound("artifact", `${candidate} is not accessible`);
  }
  return ok(candidate, "artifact");
}

function resolveStaticRoot(
  rest: string,
  root: string | null | undefined,
  scheme: "rule" | "memory",
  defaultExt: string,
): OmpUriResolution {
  if (!root) return notFound(scheme, `${scheme} root unavailable`);
  if (rest === "") return notFound(scheme, `${scheme}:// URI requires a name`);
  const withExt = /\.[^./\\]+$/.test(rest) ? rest : `${rest}${defaultExt}`;
  const target = joinWithinRoot(root, withExt);
  if (!target) return notFound(scheme, "path escapes root");
  if (!existsSync(target)) return notFound(scheme, `not found at ${target}`);
  return ok(target, scheme);
}
