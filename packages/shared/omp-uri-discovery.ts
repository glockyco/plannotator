/**
 * Build {@link OmpUriSources} for the **standalone** plannotator CLI.
 *
 * The CLI runs in its own process and can't reach `ctx.sessionManager`. Source
 * paths come from two layers:
 *
 * 1. **Environment variables** (primary): `OMP_LOCAL_DIR`, `OMP_SESSION_DIR`,
 *    `OMP_AGENT_DIR`, `PI_CODING_AGENT_DIR`. Either set explicitly by the user
 *    or injected by our `omp-agent-setup` `session_start` extension. Always
 *    deterministic when present.
 *
 * 2. **Filesystem discovery** (fallback): locate the newest session directory
 *    under `<agentDir>/sessions/<encodedCwd>/` mirroring OMP's own
 *    `getDefaultSessionDirName` encoding. Reasonable for the common case where
 *    one OMP session per cwd is open; ambiguous when several sessions overlap.
 *    Use env vars to remove that ambiguity.
 */

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { OmpUriSources } from "./omp-uri";

export interface BuildOmpUriSourcesOptions {
  /** Override `process.cwd()`. */
  cwd?: string;
  /** Override `process.env`. Useful in tests to set explicit OMP_* values. */
  env?: NodeJS.ProcessEnv;
  /** Override `os.homedir()` (test-only). */
  home?: string;
  /** Override `os.tmpdir()` (test-only). */
  tmp?: string;
}

/**
 * Resolve a complete {@link OmpUriSources} bundle. Env vars win when set; the
 * filesystem discovery path fills in anything missing.
 */
export function buildOmpUriSources(opts: BuildOmpUriSourcesOptions = {}): OmpUriSources {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const tmp = opts.tmp ?? tmpdir();

  const agentDir =
    env.OMP_AGENT_DIR ?? env.PI_CODING_AGENT_DIR ?? join(home, ".omp", "agent");

  let artifactsDir = env.OMP_SESSION_DIR ?? null;
  if (!artifactsDir) {
    artifactsDir = discoverNewestSessionDir(agentDir, cwd, { home, tmp });
  }

  const localRoot =
    env.OMP_LOCAL_DIR ?? (artifactsDir ? join(artifactsDir, "local") : null);

  return {
    artifactsDir,
    localRoot,
    skillsRoot: join(agentDir, "skills"),
    rulesRoot: join(agentDir, "rules"),
    memoryRoot: join(agentDir, "memory"),
  };
}

/**
 * Locate the newest session directory under `<agentDir>/sessions/<encodedCwd>/`.
 * Returns `null` if no matching dir exists. "Newest" is by `mtimeMs`.
 */
export function discoverNewestSessionDir(
  agentDir: string,
  cwd: string,
  opts: { home?: string; tmp?: string } = {},
): string | null {
  const encoded = encodeCwdSessionDirName(cwd, opts);
  const sessionsRoot = join(agentDir, "sessions", encoded);
  if (!existsSync(sessionsRoot)) return null;
  let entries: string[];
  try {
    entries = readdirSync(sessionsRoot);
  } catch {
    return null;
  }
  let newest: { path: string; mtimeMs: number } | null = null;
  for (const entry of entries) {
    const candidate = join(sessionsRoot, entry);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(candidate);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    if (!newest || stat.mtimeMs > newest.mtimeMs) {
      newest = { path: candidate, mtimeMs: stat.mtimeMs };
    }
  }
  return newest?.path ?? null;
}

/**
 * Encode a cwd into OMP's session-directory naming scheme. Mirrors
 * `getDefaultSessionDirName` in pi-coding-agent
 * `src/session/session-manager.ts`:
 *
 * - Home-relative: `-<relative-with-/-and-:-replaced-by->`. E.g.
 *   `~/Projects/foo` ⟶ `-Projects-foo`.
 * - tmpdir-relative: `-tmp-<relative>`.
 * - Other absolute paths: legacy `--<encoded>--` form.
 */
export function encodeCwdSessionDirName(
  cwd: string,
  opts: { home?: string; tmp?: string } = {},
): string {
  const canonical = resolveEquivalent(resolve(cwd));
  const home = resolveEquivalent(opts.home ?? homedir());
  const tmp = resolveEquivalent(opts.tmp ?? tmpdir());
  if (pathIsWithin(home, canonical)) {
    return encodeRelative("-", home, canonical);
  }
  if (pathIsWithin(tmp, canonical)) {
    return encodeRelative("-tmp", tmp, canonical);
  }
  return `--${canonical.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function resolveEquivalent(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function pathIsWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function encodeRelative(prefix: string, root: string, cwd: string): string {
  const rel = relative(root, cwd).replace(/[/\\:]/g, "-");
  if (!rel) return prefix;
  return prefix.endsWith("-") ? `${prefix}${rel}` : `${prefix}-${rel}`;
}
