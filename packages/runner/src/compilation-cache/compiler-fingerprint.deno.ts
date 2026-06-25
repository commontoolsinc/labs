import { walk } from "@std/fs";
import { join, relative } from "@std/path";
import { hashStringOf } from "@commonfabric/data-model/value-hash";

/**
 * Build-time fingerprint of the inputs that shape the compiler's emitted bytes.
 *
 * The durable compile cache keys compiled documents by
 * `compileCache:<version>/<identity>`, where `<identity>` is a Merkle hash of a
 * module's authored source plus its imports' identities. That identity
 * deliberately does NOT cover the compiler, transformer, schema-generator, or
 * the root compiler options, so the `<version>` axis is the only thing that
 * invalidates the compiled set when any of those change. This module computes
 * that version as a content hash of the compiler inputs, so it moves
 * automatically instead of being bumped by hand.
 *
 * Deno-only: it walks and reads the source tree. It is imported solely by the
 * binary build (`tasks/build-binaries.ts`) and tests — never by the browser-
 * reachable runtime, which reads the baked/sentinel value from
 * `compile-cache-version.ts`.
 */

/**
 * Repo-relative inputs hashed into the fingerprint: the source that determines
 * the compiler's emitted bytes, plus the lockfile and root compiler options.
 * Directory inputs are hashed whole, so the version also moves when a test,
 * fixture, or doc under them changes, and the whole-file `deno.lock` moves it on
 * any dependency bump. The result over-invalidates rather than under-
 * invalidates: a redundant recompile, never a stale read.
 *
 *  - `packages/ts-transformers` — the CF transformer pipeline, including the
 *    `SchemaGeneratorTransformer` that bakes schemas into the emitted bytes;
 *  - `packages/js-compiler` — the TypeScript-to-JS compiler driver;
 *  - `packages/schema-generator` — schema emission consumed by the pipeline;
 *  - `packages/api` — the pattern-facing types (`Default`, `Cell`, ...) the
 *    schema-generator lowers into the baked schemas, so a type change there
 *    changes emitted bytes;
 *  - `deno.json` — the root compiler options (jsx / jsxImportSource);
 *  - `deno.lock` — pins the TypeScript version the compiler runs.
 */
export const COMPILE_FINGERPRINT_INPUTS: readonly string[] = [
  "packages/ts-transformers",
  "packages/js-compiler",
  "packages/schema-generator",
  "packages/api",
  "deno.json",
  "deno.lock",
];

/** Cache-key namespace prefix kept ahead of the fingerprint, for legibility. */
export const VERSION_NAMESPACE = "cf/esm-compile";

/**
 * The `<version>` used when running from source (dev / tests), where the
 * compiler source is on disk but the binary fingerprint has not been baked in.
 * Stable, so from-source runs key their cache consistently across sessions; its
 * own namespace keeps it from ever colliding with a baked `<fingerprint>`.
 */
export const SOURCE_SENTINEL = "source";

/** Full from-source version string (`cf/esm-compile/source`). */
export const SENTINEL_VERSION = `${VERSION_NAMESPACE}/${SOURCE_SENTINEL}`;

const FINGERPRINT_TAG = "cf/compile-fingerprint/v1";

/** Length of the base64url fingerprint kept in the key (96 bits). */
const FINGERPRINT_LENGTH = 16;

interface FingerprintFile {
  /** Path relative to the repo root, with forward slashes. */
  readonly path: string;
  /** File contents with line endings normalized to `\n`. */
  readonly content: string;
}

/**
 * Compute the compiler-input fingerprint: a stable hash over every file under
 * {@link COMPILE_FINGERPRINT_INPUTS}, resolved against `repoRoot`. Directory
 * inputs are walked recursively; file inputs are hashed directly. Files are
 * sorted by their repo-relative path and line endings normalized, so the value
 * is independent of walk order and CRLF/LF differences. A missing input throws.
 */
export async function computeCompilerFingerprint(
  repoRoot: string,
  inputs: readonly string[] = COMPILE_FINGERPRINT_INPUTS,
): Promise<string> {
  const files: FingerprintFile[] = [];
  for (const input of inputs) {
    const abs = join(repoRoot, input);
    const info = await Deno.stat(abs);
    if (info.isDirectory) {
      for await (
        const entry of walk(abs, {
          includeDirs: false,
          includeFiles: true,
          followSymlinks: false,
          skip: [/(^|[\\/])\.DS_Store$/],
        })
      ) {
        files.push({
          path: relPosix(repoRoot, entry.path),
          content: await readNormalized(entry.path),
        });
      }
    } else {
      files.push({
        path: relPosix(repoRoot, abs),
        content: await readNormalized(abs),
      });
    }
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const digest = hashStringOf({
    v: FINGERPRINT_TAG,
    files: files.map((file) => [file.path, file.content]),
  });
  return digest.slice(0, FINGERPRINT_LENGTH);
}

/** The full `cf/esm-compile/<fingerprint>` version string for `repoRoot`. */
export async function computeCompilerVersion(
  repoRoot: string,
  inputs: readonly string[] = COMPILE_FINGERPRINT_INPUTS,
): Promise<string> {
  const fingerprint = await computeCompilerFingerprint(repoRoot, inputs);
  return `${VERSION_NAMESPACE}/${fingerprint}`;
}

/**
 * Render the full text of `compile-cache-version.ts` for a given version. The
 * binary build writes this with the baked version before `deno compile`; the
 * committed file holds the rendering for {@link SENTINEL_VERSION}. Output is
 * `deno fmt`-clean so the committed file and the rendering stay byte-identical.
 */
export function renderVersionModule(version: string): string {
  return `// Generated by tasks/build-binaries.ts; do not edit by hand.
//
// Version axis of the durable compile cache: the \`<version>\` segment of
// \`compileCache:<version>/<identity>\` keys. The committed value is the
// from-source sentinel; the binary build overwrites it with a hash of the
// compiler inputs before \`deno compile\`, then restores the sentinel. See
// compiler-fingerprint.deno.ts for the fingerprint and input set.
export const COMPILE_CACHE_RUNTIME_VERSION = ${JSON.stringify(version)};
`;
}

function relPosix(root: string, abs: string): string {
  return relative(root, abs).replaceAll("\\", "/");
}

async function readNormalized(path: string): Promise<string> {
  const text = await Deno.readTextFile(path);
  return text.replace(/\r\n/g, "\n");
}
