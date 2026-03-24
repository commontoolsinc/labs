import { expect } from "@std/expect";
import type { Signer } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { createBuilder } from "../../src/builder/factory.ts";
import type { JSONSchema, Pattern } from "../../src/builder/types.ts";
import type { Cell } from "../../src/cell.ts";
import { canonicalizeStoragePath } from "../../src/cfc/canonical-activity.ts";
import { internalVerifierReadAnnotations } from "../../src/cfc/internal-markers.ts";
import { setPatternEnvironment } from "../../src/env.ts";
import { prepareBoundaryCommit } from "../../src/cfc/prepare-engine.ts";
import { prepareCfcCommitIfNeeded } from "../../src/cfc/prepare-shim.ts";
import { resolveLink } from "../../src/link-resolution.ts";
import {
  cfcLabelsAddress,
  normalizePersistedLabels,
  type PersistedPathLabels,
  resolveObservationLabel,
} from "../../src/cfc/shared.ts";
import type { NormalizedFullLink } from "../../src/link-types.ts";
import { Runtime, type RuntimeOptions } from "../../src/runtime.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  Labels,
  MediaType,
  MemorySpace,
  URI,
} from "../../src/storage/interface.ts";

type PrepareMode = "none" | "cfc" | "boundary";

type HarnessOptions = {
  signer: Signer;
  apiUrl: URL;
  disablePullMode?: boolean;
  patternEnvironment?: RuntimeOptions["patternEnvironment"];
  runtimeOptions?: Omit<RuntimeOptions, "apiUrl" | "storageManager">;
};

type RunPatternOptions<TInputs extends Record<string, unknown>> = {
  id: string;
  pattern: Pattern;
  inputs: TInputs;
  outputSchema?: JSONSchema;
  initialOutput?: unknown;
  prepare?: PrepareMode;
};

type SettledPullOptions = {
  attempts?: number;
  delayMs?: number;
};

type SeedLabeledValueOptions<T> = {
  id: string;
  value: T;
  labels: Labels;
  schema?: JSONSchema;
};

type WriteCellValueOptions<T> = {
  id: string;
  value: T;
  schema?: JSONSchema;
  labels?: Labels;
  prepare?: PrepareMode;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createCfcPatternTestHarness(
  options: HarnessOptions,
): CfcPatternTestHarness {
  return new CfcPatternTestHarness(options);
}

export class CfcPatternTestHarness {
  readonly space: MemorySpace;
  readonly storageManager: ReturnType<typeof StorageManager.emulate>;
  readonly pattern: ReturnType<typeof createBuilder>["commontools"]["pattern"];
  readonly byRef: ReturnType<typeof createBuilder>["commontools"]["byRef"];
  readonly lift: ReturnType<typeof createBuilder>["commontools"]["lift"];
  readonly handler: ReturnType<typeof createBuilder>["commontools"]["handler"];

  runtime: Runtime;

  #apiUrl: URL;
  #disablePullMode: boolean;
  #originalFetch?: typeof globalThis.fetch;
  #patternEnvironment?: RuntimeOptions["patternEnvironment"];
  #runtimeOptions: Omit<RuntimeOptions, "apiUrl" | "storageManager">;

  constructor(options: HarnessOptions) {
    this.space = options.signer.did();
    this.storageManager = StorageManager.emulate({ as: options.signer });
    this.#apiUrl = options.apiUrl;
    this.#disablePullMode = options.disablePullMode ?? true;
    this.#patternEnvironment = options.patternEnvironment;
    this.#runtimeOptions = options.runtimeOptions ?? {};

    const { commontools } = createBuilder();
    this.pattern = commontools.pattern;
    this.byRef = commontools.byRef;
    this.lift = commontools.lift;
    this.handler = commontools.handler;

    this.runtime = this.#createRuntime();
  }

  #createRuntime(): Runtime {
    if (this.#patternEnvironment) {
      setPatternEnvironment(this.#patternEnvironment);
    }

    const runtime = new Runtime({
      storageManager: this.storageManager,
      apiUrl: this.#apiUrl,
      ...this.#runtimeOptions,
    });
    if (this.#disablePullMode) {
      runtime.scheduler.disablePullMode();
    }
    return runtime;
  }

  async dispose(): Promise<void> {
    this.restoreFetch();
    await this.runtime.dispose();
  }

  async restart(): Promise<void> {
    this.runtime.runner.stopAll();
    this.runtime.moduleRegistry.clear();
    await this.runtime.scheduler.idle();
    this.runtime.scheduler.dispose();
    this.runtime.harness.dispose();
    this.runtime = this.#createRuntime();
  }

  async withCommittedEdit<T>(
    edit: (tx: IExtendedStorageTransaction) => Promise<T> | T,
    options: { prepare?: PrepareMode } = {},
  ): Promise<T> {
    const tx = this.runtime.edit();
    try {
      const value = await edit(tx);
      await this.#prepare(tx, options.prepare ?? "none");
      const committed = await tx.commit();
      expect(committed.error).toBeUndefined();
      return value;
    } catch (error) {
      await tx.abort(error);
      throw error;
    }
  }

  getCell<T>(
    id: string,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
  ) {
    return this.runtime.getCell<T>(this.space, id, schema, tx);
  }

  getCellFromEntityId<T>(
    entityId: `${string}:${string}`,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
  ) {
    return this.runtime.getCellFromEntityId<T>(
      this.space,
      entityId,
      [],
      schema,
      tx,
    );
  }

  getCellFromLink<T>(
    link: NormalizedFullLink,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
  ) {
    return this.runtime.getCellFromLink<T>(link, schema, tx);
  }

  seedLabeledValue<T>(
    options: SeedLabeledValueOptions<T>,
  ) {
    return this.writeCellValue({
      ...options,
      prepare: "cfc",
    });
  }

  async writeCellValue<T>(
    options: WriteCellValueOptions<T>,
  ) {
    await this.withCommittedEdit((tx) => {
      const cell = this.getCell<T>(options.id, options.schema, tx);
      cell.set(options.value as never);
      if (options.labels) {
        tx.writeOrThrow(
          cfcLabelsAddress({
            space: this.space,
            id: cell.getAsNormalizedFullLink().id,
            type: "application/json",
          }),
          { "/": { label: options.labels } } as never,
        );
      }
    }, { prepare: options.prepare ?? "none" });
    return this.getCell<T>(options.id, options.schema);
  }

  async writeDocumentValue(
    address: IMemorySpaceAddress,
    value: unknown,
    options: { prepare?: PrepareMode } = {},
  ): Promise<void> {
    await this.withCommittedEdit((tx) => {
      tx.writeOrThrow(address, value as never);
    }, options);
  }

  async readLabels(
    idOrLink: string | { id: string } | NormalizedFullLink,
  ): Promise<PersistedPathLabels> {
    const id = typeof idOrLink === "string" ? idOrLink : idOrLink.id;
    const tx = this.runtime.edit();
    const raw = tx.readOrThrow(
      cfcLabelsAddress({
        space: this.space,
        id: id as URI,
        type: "application/json",
      }),
    );
    await tx.abort("label-inspection-complete");
    return normalizePersistedLabels(raw);
  }

  async readObservationLabel(
    idOrLink: string | { id: string } | NormalizedFullLink,
    path = "/",
    op: "shape" | "value" | "enumerate" | "count" | "followRef" = "value",
  ): Promise<Labels | undefined> {
    return resolveObservationLabel(
      await this.readLabels(idOrLink),
      path,
      op,
    );
  }

  async readEffectiveLabel<T>(
    cell: Cell<T>,
    schema?: JSONSchema,
  ): Promise<Labels | undefined> {
    const tx = this.runtime.edit();
    try {
      const resolved = resolveLink(
        this.runtime,
        tx,
        cell.withTx(tx).asSchema(schema).getAsNormalizedFullLink(),
      );
      const labelsByPath = normalizePersistedLabels(
        tx.readOrThrow(
          cfcLabelsAddress({
            space: resolved.space as MemorySpace,
            id: resolved.id as URI,
            type: resolved.type as MediaType,
          }),
          {
            cfc: internalVerifierReadAnnotations,
          },
        ),
      );
      return resolveObservationLabel(
        labelsByPath,
        canonicalizeStoragePath(resolved.path),
        "value",
      );
    } finally {
      await tx.abort("effective-label-inspection-complete");
    }
  }

  async runPattern<TInputs extends Record<string, unknown>>(
    options: RunPatternOptions<TInputs>,
  ) {
    const tx = this.runtime.edit();
    const outputCell = this.getCell(
      options.id,
      options.outputSchema,
      tx,
    );
    if (options.initialOutput !== undefined) {
      outputCell.set(options.initialOutput);
    }
    const result = this.runtime.run(
      tx,
      options.pattern,
      options.inputs,
      outputCell,
    );
    await this.#prepare(tx, options.prepare ?? "cfc");
    const committed = await tx.commit();
    expect(committed.error).toBeUndefined();
    const value = await result.pull();
    return {
      outputCell,
      outputLink: outputCell.getAsNormalizedFullLink(),
      result,
      value,
    };
  }

  async pullSettledResult<T>(
    resultCell: { pull: () => Promise<T>; get: () => T },
    options: SettledPullOptions = {},
  ): Promise<T> {
    const attempts = options.attempts ?? 8;
    const delayMs = options.delayMs ?? 50;
    let sawPendingTrue = false;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const value = await resultCell.pull();
      if (
        value &&
        typeof value === "object" &&
        "pending" in value &&
        (value as { pending?: unknown }).pending === true
      ) {
        sawPendingTrue = true;
      }
      if (this.#isSettled(value, sawPendingTrue)) {
        return value;
      }
      await delay(delayMs);
    }
    return resultCell.get();
  }

  async #prepare(
    tx: IExtendedStorageTransaction,
    prepare: PrepareMode,
  ): Promise<void> {
    switch (prepare) {
      case "none":
        return;
      case "cfc":
        await prepareCfcCommitIfNeeded(tx);
        return;
      case "boundary":
        await prepareBoundaryCommit(tx);
        return;
    }
  }

  #isSettled(value: unknown, sawPendingTrue: boolean): boolean {
    if (!value || typeof value !== "object" || !("pending" in value)) {
      return true;
    }
    const pending = (value as { pending?: unknown }).pending;
    if (pending !== false) {
      return false;
    }
    const settledObject = value as {
      pending?: unknown;
      result?: unknown;
      error?: unknown;
    };
    return sawPendingTrue || settledObject.result !== undefined ||
      settledObject.error !== undefined;
  }

  stubFetch(fetchImpl: typeof globalThis.fetch): void {
    if (this.#originalFetch === undefined) {
      this.#originalFetch = globalThis.fetch;
    }
    globalThis.fetch = fetchImpl;
  }

  restoreFetch(): void {
    if (this.#originalFetch !== undefined) {
      globalThis.fetch = this.#originalFetch;
      this.#originalFetch = undefined;
    }
  }
}
