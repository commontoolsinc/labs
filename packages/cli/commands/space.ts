// `cf space` — operator commands over a whole space store.
//
// Today this is the rehearsal-clone workflow from
// docs/plans/space-clone-rehearsal.md: make a writable copy of a real space,
// run a migration against it, judge the result, reset, repeat.
//
// Why this is NOT under `cf inspect`: inspect's contract is that it is
// read-only — "it explains, it never reproduces or replays" — and that boundary
// is what makes it trustworthy. A clone exists precisely to be written to, so
// it gets its own noun.
//
// Acquiring the snapshot stays manual for production, by design: the dump
// endpoint is hard-off there (see memory-dump-policy.ts) and a whole-space dump
// is a confidentiality decision, not an ergonomics one. `--from` therefore takes
// a file an operator already has (typically `VACUUM INTO` server-side, then
// scp), or an https URL (the S3 hop the July rehearsal used to share one
// snapshot across operators).

import { Command, ValidationError } from "@cliffy/command";
import {
  clonePaths,
  createClone,
  openSpace,
  readManifest,
  resetClone,
  resolveSpace,
  verifyClone,
} from "@commonfabric/state-inspector";
import { contentFingerprint } from "@commonfabric/state-inspector";
import { hasJsonArgument } from "../lib/json-output.ts";

function out(json: boolean, data: unknown, render: () => void): void {
  if (json) console.log(JSON.stringify(data, null, 2));
  else render();
}

/**
 * Store directories a clone must never be written into: whatever the
 * environment says a local server is serving. Explicit paths, not a guess about
 * what looks like production.
 */
function liveStoreDirs(): string[] {
  const dirs: string[] = [];
  const memoryDir = Deno.env.get("MEMORY_DIR");
  if (memoryDir) {
    dirs.push(
      memoryDir.startsWith("file://") ? fromFileUrl(memoryDir) : memoryDir,
    );
  }
  const dbPath = Deno.env.get("DB_PATH");
  if (dbPath) dirs.push(dbPath.replace(/\/[^/]*$/, ""));
  // The toolshed's default when neither is set is `./cache/memory/` relative to
  // its working directory; a clone landing there would be served unintentionally.
  dirs.push(`${Deno.cwd()}/cache/memory`);
  return dirs;
}

function fromFileUrl(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    return url;
  }
}

/** Download a remote snapshot to a temp file so `--from` can take a URL. */
async function fetchSnapshot(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok || response.body === null) {
    throw new Error(`could not download ${url}: HTTP ${response.status}`);
  }
  const dir = await Deno.makeTempDir({ prefix: "cf-space-clone-" });
  const path = `${dir}/snapshot.sqlite`;
  using file = await Deno.open(path, { write: true, create: true });
  await response.body.pipeTo(file.writable);
  return path;
}

const bytes = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`;

export const space = new Command()
  .name("space")
  .description(
    "Whole-space operator commands: rehearsal clones of a space store.",
  )
  .default("help")
  .error((error, command) => {
    if (hasJsonArgument(command.getMainCommand().getRawArgs())) throw error;
  })
  .globalOption("--json", "Output machine-readable JSON.")
  /* space clone */
  .command(
    "clone <space:string>",
    "Build a writable rehearsal clone of a space store from a snapshot.",
  )
  // `--from`/`--to` are required in substance but NOT declared `required`:
  // cliffy appends required options to the usage line, which would break the
  // repo invariant that a command's usage ends with its positional arguments
  // (see main-command.test.ts). Validating here also gives a more actionable
  // message than cliffy's generic one.
  .option(
    "--from <source:string>",
    "Snapshot to clone: a .sqlite path, or an https URL to download.",
  )
  .option("--to <dir:string>", "Destination clone directory.")
  .action(async (options, spaceDid) => {
    if (!options.from) {
      throw new ValidationError(
        "--from is required: a .sqlite snapshot path, or an https URL. " +
          "For production, take one server-side with `VACUUM INTO` and copy " +
          "it down — the dump endpoint is deliberately off there.",
      );
    }
    if (!options.to) {
      throw new ValidationError(
        "--to is required: the directory to build the clone in. It must be " +
          "outside any store a local server is serving.",
      );
    }
    const source = /^https?:\/\//.test(options.from)
      ? await fetchSnapshot(options.from)
      : options.from;

    const targetDir = options.to;
    const manifest = await createClone({
      source,
      space: spaceDid,
      targetDir,
      forbiddenDirs: liveStoreDirs(),
    });
    const paths = clonePaths(targetDir, spaceDid);

    out(!!options.json, { manifest, paths }, () => {
      console.log(
        `cloned ${spaceDid}\n` +
          `  snapshot   ${
            bytes(manifest.snapshotBytes)
          }  ${manifest.snapshotHash}\n` +
          `  counts     ${manifest.counts.commits} commits, ` +
          `${manifest.counts.revisions} revisions, ` +
          `${manifest.counts.entities} entities\n` +
          `  content    ${manifest.fingerprint.hash}\n` +
          `             ${manifest.fingerprint.entities} entities fingerprinted, ` +
          `${manifest.fingerprint.excludedGenerated} generated cells excluded\n` +
          `  working    ${paths.workingPath}\n\n` +
          `serve it (NOT the live store — note the port offset):\n` +
          `  MEMORY_DIR="file://${targetDir}/" ./scripts/start-local-dev.sh --port-offset 10\n\n` +
          `then, per attempt:\n` +
          `  cf space verify ${targetDir}\n` +
          `  cf space reset  ${targetDir}`,
      );
    });
  })
  /* space verify */
  .command(
    "verify <dir:string>",
    "Check a clone against its manifest: baseline intact, content unchanged.",
  )
  .action(async (options, dir) => {
    const result = await verifyClone(dir);
    out(!!options.json, result, () => {
      const { counts, fingerprint } = result;
      console.log(
        `baseline   ${result.baselineIntact ? "intact" : "CORRUPTED"}\n` +
          `content    ${fingerprint.match ? "unchanged" : "CHANGED"}\n` +
          `           manifest ${fingerprint.manifest}\n` +
          `           working  ${fingerprint.working}\n` +
          `commits    ${counts.manifest.commits} → ${counts.working.commits}\n` +
          `revisions  ${counts.manifest.revisions} → ${counts.working.revisions}\n` +
          `entities   ${counts.manifest.entities} → ${counts.working.entities}\n\n` +
          (result.ok
            ? "OK — durable content survived. Growing counts are expected: a " +
              "migration writes."
            : result.baselineIntact
            ? "CONTENT CHANGED — run `cf space fingerprint <dir>/engine-v3/" +
              "<did>.sqlite --per-entity` against the working copy and the " +
              "pristine baseline to see which entities moved."
            : "BASELINE CORRUPTED — the pristine snapshot no longer matches " +
              "the manifest; do not reset to it."),
      );
    });
    // A failed verification is a RESULT, not a usage error: the report above is
    // the output a script or an operator reads. Exit nonzero so a rehearsal
    // script can gate on it, without cliffy appending usage help.
    if (!result.ok) Deno.exit(1);
  })
  /* space reset */
  .command(
    "reset <dir:string>",
    "Restore the working copy from the pristine snapshot, discarding the attempt.",
  )
  .action(async (options, dir) => {
    const before = await readManifest(dir);
    await resetClone(dir);
    const after = await verifyClone(dir);
    out(!!options.json, { manifest: before, verify: after }, () => {
      console.log(
        `reset ${before.space} to its baseline (${before.createdAt})\n` +
          `  commits back to ${after.counts.working.commits}\n` +
          `  content  ${
            after.fingerprint.match ? "matches baseline" : "STILL DIFFERS"
          }`,
      );
    });
    if (!after.ok) Deno.exit(1);
  })
  /* space fingerprint */
  .command(
    "fingerprint <space:string>",
    "Content fingerprint of a store — the durable-content half of `verify`, " +
      "runnable against any space (a clone, a snapshot, or a local store).",
  )
  .option(
    "--include-generated",
    "Include compiler-generated internal cells. They rotate on every pattern " +
      "update by design, so this answers 'what moved at all?', not 'did " +
      "content survive?'.",
  )
  .option("--per-entity", "List every entity hash, not just the roll-up.")
  .action(async (options, token) => {
    const db = openSpace(await resolveSpace(token));
    try {
      const report = contentFingerprint(db, {
        includeGenerated: options.includeGenerated,
      });
      out(!!options.json, report, () => {
        console.log(
          `${report.hash}\n` +
            `${report.entities} entities fingerprinted, ` +
            `${report.excludedGenerated} generated cells excluded`,
        );
        if (report.ambiguous.length > 0) {
          console.log(
            `\nnote: ${report.ambiguous.length} id(s) are generated in one ` +
              `manifest and named in another; counted as generated.`,
          );
        }
        if (report.unhashable.length > 0) {
          console.log(
            `\nnote: ${report.unhashable.length} entit(ies) could not be ` +
              `hashed and are absent from the roll-up:`,
          );
          for (const u of report.unhashable.slice(0, 10)) {
            console.log(`  ${u.id}: ${u.reason}`);
          }
        }
        if (options.perEntity) {
          for (const e of report.perEntity) {
            console.log(
              `${e.hash ?? "(no value)"}\t${e.kind}\t${e.id}\t(${e.scope})`,
            );
          }
        }
      });
    } finally {
      db.close();
    }
  });
