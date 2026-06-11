import ts from "typescript";
import {
  collectImportSpecifiers,
  type ProgramResolver,
  type Source,
} from "@commonfabric/js-compiler";
import {
  loadVerifiedSourceClosure,
  type SourceDoc,
} from "../compilation-cache/cell-cache.ts";
import type { MemorySpace, Runtime } from "../runtime.ts";
import {
  parseFabricRef,
  pinnedIdentity,
} from "../sandbox/fabric-import-specifier.ts";
import {
  FABRIC_MOUNT_ROOT,
  type FabricMount,
} from "../sandbox/module-record-compiler.ts";

const TARGET = ts.ScriptTarget.ES2023;
const MAX_FABRIC_MOUNTS = 32;

export interface FabricResolutionContext {
  runtime: Runtime;
  space: MemorySpace;
}

export class FabricAwareResolver implements ProgramResolver {
  #mountedFiles = new Map<string, Source>();
  #mountByIdentity = new Map<string, FabricMount>();
  #entrySourceByIdentity = new Map<string, Source>();
  #specifierAliases = new Map<string, string>();

  constructor(
    private readonly inner: ProgramResolver,
    private readonly ctx: FabricResolutionContext,
  ) {}

  main(): Promise<Source> {
    return this.inner.main();
  }

  async resolveSource(identifier: string): Promise<Source | undefined> {
    if (identifier.startsWith(FABRIC_MOUNT_ROOT)) {
      return this.#mountedFiles.get(identifier);
    }

    const ref = parseFabricRef(identifier);
    if (ref === undefined) {
      return await this.inner.resolveSource(identifier);
    }

    if (ref.host !== undefined) {
      throw new Error("cross-host fabric refs not yet supported (M3)");
    }
    if (ref.subpath !== undefined) {
      throw new Error("subpaths not yet supported (M4)");
    }

    const identity = pinnedIdentity(ref);
    if (identity === undefined) {
      throw new Error(
        "fabric ref requires resolution of a mutable pointer — not yet supported (M2)",
      );
    }
    if (ref.space !== undefined && ref.space !== this.ctx.space) {
      throw new Error("cross-space fabric refs not yet supported (M2)");
    }

    const existing = this.#mountByIdentity.get(identity);
    if (existing !== undefined) {
      if (!existing.specifiers.includes(identifier)) {
        existing.specifiers.push(identifier);
      }
      this.#specifierAliases.set(identifier, existing.entryPath);
      return this.#entrySourceByIdentity.get(identity);
    }

    if (this.#mountByIdentity.size >= MAX_FABRIC_MOUNTS) {
      throw new Error("fabric import graph too deep/large");
    }

    const docs = await this.#loadSourceClosure(identity);
    if (docs === undefined) {
      throw new Error(this.#notFoundMessage(identity));
    }
    this.#assertNoRootAbsoluteImports(identity, docs);

    const entryDoc = docs.get(identity);
    if (entryDoc === undefined) {
      throw new Error(this.#notFoundMessage(identity));
    }
    const entryPath = this.#mountPath(identity, entryDoc.filename);
    const mount: FabricMount = {
      entryIdentity: identity,
      entryPath,
      specifiers: [identifier],
    };

    for (const doc of docs.values()) {
      const source: Source = {
        name: this.#mountPath(identity, doc.filename),
        contents: doc.code,
      };
      this.#mountedFiles.set(source.name, source);
      if (source.name === entryPath) {
        this.#entrySourceByIdentity.set(identity, source);
      }
    }

    this.#mountByIdentity.set(identity, mount);
    this.#specifierAliases.set(identifier, entryPath);
    return this.#entrySourceByIdentity.get(identity);
  }

  mounts(): FabricMount[] {
    return [...this.#mountByIdentity.values()].map((mount) => ({
      ...mount,
      specifiers: [...mount.specifiers],
    }));
  }

  specifierAliases(): Map<string, string> {
    return new Map(this.#specifierAliases);
  }

  async #loadSourceClosure(
    identity: string,
  ): Promise<Map<string, SourceDoc> | undefined> {
    const tx = this.ctx.runtime.edit();
    try {
      return await loadVerifiedSourceClosure(
        this.ctx.runtime,
        this.ctx.space,
        identity,
        tx,
      );
    } finally {
      tx.abort?.("fabric source closure read complete");
    }
  }

  #assertNoRootAbsoluteImports(
    identity: string,
    docs: ReadonlyMap<string, SourceDoc>,
  ): void {
    for (const doc of docs.values()) {
      const source = { name: doc.filename, contents: doc.code };
      for (const specifier of collectImportSpecifiers(source, TARGET)) {
        if (specifier.startsWith("/")) {
          throw new Error(
            `imported pattern ${identity} uses root-absolute imports; not supported`,
          );
        }
      }
    }
  }

  #mountPath(identity: string, filename: string): string {
    return `${FABRIC_MOUNT_ROOT}${identity}${filename}`;
  }

  #notFoundMessage(identity: string): string {
    return `source for pattern:${identity} not found in space ${this.ctx.space} (or failed integrity verification)`;
  }
}
