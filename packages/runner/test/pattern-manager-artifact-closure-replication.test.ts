import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { linkRefPayload } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  loadVerifiedSourceClosure,
} from "../src/compilation-cache/cell-cache.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import type { CommitError } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase(
  "artifact closure replication",
);
const sourceSpace = signer.did();
const destinationSpace = (await Identity.fromPassphrase(
  "artifact closure replication destination",
)).did();
const retryDestinationSpace = (await Identity.fromPassphrase(
  "artifact closure replication retry destination",
)).did();
const parallelDestinationSpace = (await Identity.fromPassphrase(
  "artifact closure replication parallel destination",
)).did();

function dependencyProgram(value: number): RuntimeProgram {
  return {
    main: "/dependency.tsx",
    files: [{
      name: "/dependency.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        `export const offset = ${value};`,
        "export default pattern<{ value: number }>(({ value }) => ({ value: value + offset }));",
      ].join("\n"),
    }],
  };
}

function importerProgram(dependencyIdentity: string): RuntimeProgram {
  return {
    main: "/importer.tsx",
    files: [{
      name: "/importer.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        `import dependency, { offset } from "cf:pattern:${dependencyIdentity}";`,
        "export default pattern<{ value: number }>(({ value }) => ({",
        "  result: value + offset,",
        "  child: dependency({ value }),",
        "}));",
      ].join("\n"),
    }],
  };
}

interface StoredImport {
  importer: Awaited<ReturnType<Runtime["patternManager"]["compilePattern"]>>;
  importerIdentity: string;
  dependencyIdentity: string;
}

async function storeImportedFactory(runtime: Runtime): Promise<StoredImport> {
  const dependency = await runtime.patternManager.compilePattern(
    dependencyProgram(10),
    { space: sourceSpace },
  );
  const dependencyIdentity = runtime.patternManager.getArtifactEntryRef(
    dependency,
  )!.identity;
  const importer = await runtime.patternManager.compilePattern(
    importerProgram(dependencyIdentity),
    { space: sourceSpace },
  );
  const importerIdentity = runtime.patternManager.getArtifactEntryRef(
    importer,
  )!.identity;
  await runtime.storageManager.synced();
  return { importer, importerIdentity, dependencyIdentity };
}

describe("PatternManager artifact-closure replication", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  const extraRuntimes: Runtime[] = [];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    while (extraRuntimes.length > 0) {
      await extraRuntimes.pop()!.dispose();
    }
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("awaits a complete by-value copy while links keep source provenance", async () => {
    const { importer, importerIdentity, dependencyIdentity } =
      await storeImportedFactory(runtime);

    expect(() => runtime.getImmutableCell(destinationSpace, importer)).toThrow(
      `is not available in space ${destinationSpace}`,
    );

    const sourceDocument = runtime.getImmutableCell(sourceSpace, importer);
    const tx = runtime.edit();
    const destinationHolder = runtime.getCell(
      destinationSpace,
      "linked factory holder",
      undefined,
      tx,
    );
    const sourceLink = sourceDocument.getAsLink({ base: destinationHolder });
    expect(linkRefPayload(sourceLink).space).toBe(sourceSpace);
    destinationHolder.setRaw(sourceLink);
    expect((await tx.commit()).error).toBeUndefined();
    expect(
      runtime.patternManager.isArtifactAvailableInSpace(
        importerIdentity,
        destinationSpace,
      ),
    ).toBe(false);

    await runtime.patternManager.ensureArtifactClosureInSpace(
      importerIdentity,
      sourceSpace,
      destinationSpace,
    );

    expect(
      runtime.patternManager.isArtifactAvailableInSpace(
        importerIdentity,
        destinationSpace,
      ),
    ).toBe(true);
    expect(
      runtime.patternManager.isArtifactAvailableInSpace(
        dependencyIdentity,
        destinationSpace,
      ),
    ).toBe(true);
    expect(() => runtime.getImmutableCell(destinationSpace, importer)).not
      .toThrow();
    expect(linkRefPayload(sourceLink).space).toBe(sourceSpace);

    const coldRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    extraRuntimes.push(coldRuntime);
    const cold = await coldRuntime.patternManager.loadPatternByIdentity(
      importerIdentity,
      "default",
      destinationSpace,
    );
    expect(cold).toBeDefined();
    expect(
      coldRuntime.patternManager.artifactFromIdentitySync(
        dependencyIdentity,
        "default",
      ),
    ).toBeDefined();
  });

  it("same-space calls verify the whole closure without writing", async () => {
    const { importerIdentity, dependencyIdentity } = await storeImportedFactory(
      runtime,
    );
    const coldRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    extraRuntimes.push(coldRuntime);
    coldRuntime.editWithRetry = (() => {
      throw new Error("same-space verification must not write");
    }) as typeof coldRuntime.editWithRetry;

    await coldRuntime.patternManager.ensureArtifactClosureInSpace(
      importerIdentity,
      sourceSpace,
      sourceSpace,
    );

    expect(
      coldRuntime.patternManager.isArtifactAvailableInSpace(
        importerIdentity,
        sourceSpace,
      ),
    ).toBe(true);
    expect(
      coldRuntime.patternManager.isArtifactAvailableInSpace(
        dependencyIdentity,
        sourceSpace,
      ),
    ).toBe(true);
  });

  it("keeps a source-first partial copy unavailable and retries after failure", async () => {
    const { importerIdentity, dependencyIdentity } = await storeImportedFactory(
      runtime,
    );
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    const failure = {
      name: "StorageTransactionAborted" as const,
      message: "forced compiled-closure replication failure",
      reason: "synthetic artifact-closure replication failure",
    } satisfies CommitError;
    let writes = 0;
    runtime.editWithRetry = ((edit, maxRetries) => {
      writes++;
      if (writes === 2) return Promise.resolve({ error: failure });
      return originalEditWithRetry(edit, maxRetries);
    }) as typeof runtime.editWithRetry;

    try {
      await expect(
        runtime.patternManager.ensureArtifactClosureInSpace(
          importerIdentity,
          sourceSpace,
          retryDestinationSpace,
        ),
      ).rejects.toThrow("forced compiled-closure replication failure");
    } finally {
      runtime.editWithRetry = originalEditWithRetry;
    }

    const readTx = runtime.edit();
    try {
      const copiedSource = await loadVerifiedSourceClosure(
        runtime,
        retryDestinationSpace,
        importerIdentity,
        readTx,
      );
      expect(copiedSource?.has(importerIdentity)).toBe(true);
      const copiedDependencySource = await loadVerifiedSourceClosure(
        runtime,
        retryDestinationSpace,
        dependencyIdentity,
        readTx,
      );
      expect(copiedDependencySource?.has(dependencyIdentity)).toBe(true);
    } finally {
      readTx.abort?.("source-first replication assertion complete");
    }
    expect(
      runtime.patternManager.isArtifactAvailableInSpace(
        importerIdentity,
        retryDestinationSpace,
      ),
    ).toBe(false);
    expect(
      runtime.patternManager.isArtifactAvailableInSpace(
        dependencyIdentity,
        retryDestinationSpace,
      ),
    ).toBe(false);

    await runtime.patternManager.ensureArtifactClosureInSpace(
      importerIdentity,
      sourceSpace,
      retryDestinationSpace,
    );
    expect(
      runtime.patternManager.isArtifactAvailableInSpace(
        importerIdentity,
        retryDestinationSpace,
      ),
    ).toBe(true);
    expect(
      runtime.patternManager.isArtifactAvailableInSpace(
        dependencyIdentity,
        retryDestinationSpace,
      ),
    ).toBe(true);
  });

  it("deduplicates parallel copies into one source-first write sequence", async () => {
    const { importerIdentity } = await storeImportedFactory(runtime);
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    let writes = 0;
    let releaseFirstWrite!: () => void;
    const firstWriteReleased = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let markFirstWriteEntered!: () => void;
    const firstWriteEntered = new Promise<void>((resolve) => {
      markFirstWriteEntered = resolve;
    });
    runtime.editWithRetry = (async (edit, maxRetries) => {
      writes++;
      if (writes === 1) {
        markFirstWriteEntered();
        await firstWriteReleased;
      }
      return await originalEditWithRetry(edit, maxRetries);
    }) as typeof runtime.editWithRetry;

    try {
      const first = runtime.patternManager.ensureArtifactClosureInSpace(
        importerIdentity,
        sourceSpace,
        parallelDestinationSpace,
      );
      await firstWriteEntered;
      const second = runtime.patternManager.ensureArtifactClosureInSpace(
        importerIdentity,
        sourceSpace,
        parallelDestinationSpace,
      );
      releaseFirstWrite();
      await Promise.all([first, second]);
    } finally {
      runtime.editWithRetry = originalEditWithRetry;
    }

    expect(writes).toBe(2);
  });
});
