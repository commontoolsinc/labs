import { assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import {
  assessCoverageRunManifest,
  type CoverageRunManifest,
  coverageRunManifestPath,
  readCoverageRunManifest,
  writeCoverageRunManifest,
} from "./coverage-run-manifest.ts";

const COMPLETE_OK: CoverageRunManifest = {
  complete: true,
  success: true,
  unitsPlanned: 36,
  unitsCompleted: 36,
  failedPackages: [],
};

Deno.test("manifest lives beside the profile directory, never inside it", () => {
  assertEquals(
    coverageRunManifestPath("/tmp/cov/raw/local"),
    "/tmp/cov/raw/local.manifest.json",
  );
  // A trailing separator must not change the sidecar's location: `deno
  // coverage` treats everything inside the directory as V8 output.
  assertEquals(
    coverageRunManifestPath(`/tmp/cov/raw/local${path.SEPARATOR}`),
    "/tmp/cov/raw/local.manifest.json",
  );
});

Deno.test("write/read round-trips, and absence reads as undefined", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const profileDir = path.join(dir, "profile");
    await Deno.mkdir(profileDir);
    assertEquals(await readCoverageRunManifest(profileDir), undefined);

    await writeCoverageRunManifest(profileDir, COMPLETE_OK);
    assertEquals(await readCoverageRunManifest(profileDir), COMPLETE_OK);

    // The profile directory itself stays free of the sidecar.
    const entries = [];
    for await (const entry of Deno.readDir(profileDir)) entries.push(entry);
    assertEquals(entries.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("garbage in the manifest reads as undefined", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const profileDir = path.join(dir, "profile");
    await Deno.writeTextFile(coverageRunManifestPath(profileDir), "not json");
    assertEquals(await readCoverageRunManifest(profileDir), undefined);
    await Deno.writeTextFile(coverageRunManifestPath(profileDir), "{}");
    assertEquals(await readCoverageRunManifest(profileDir), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("assessment: a completed passing run is usable", () => {
  assertEquals(assessCoverageRunManifest(COMPLETE_OK), { level: "ok" });
});

Deno.test("assessment: no manifest warns that completion is unrecorded", () => {
  const assessment = assessCoverageRunManifest(undefined);
  assertEquals(assessment.level, "warn");
  assertStringIncludes(
    (assessment as { message: string }).message,
    "fully uncovered",
  );
});

Deno.test("assessment: an unfinished run is refused with its progress", () => {
  const assessment = assessCoverageRunManifest({
    ...COMPLETE_OK,
    complete: false,
    success: false,
    unitsCompleted: 13,
  });
  assertEquals(assessment.level, "refuse");
  const message = (assessment as { message: string }).message;
  assertStringIncludes(message, "never finished");
  assertStringIncludes(message, "13 of 36");
  assertStringIncludes(message, "single package");
});

Deno.test("assessment: a failed run is refused and names the failures", () => {
  const assessment = assessCoverageRunManifest({
    ...COMPLETE_OK,
    success: false,
    unitsCompleted: 13,
    failedPackages: ["identity"],
  });
  assertEquals(assessment.level, "refuse");
  const message = (assessment as { message: string }).message;
  assertStringIncludes(message, "failed: identity");
  assertStringIncludes(message, "stops launching packages");
});
