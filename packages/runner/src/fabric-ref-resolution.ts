import { isRecord } from "@commonfabric/utils/types";
import type { Cell } from "./cell.ts";
import type { Runtime } from "./runtime.ts";
import type { MemorySpace } from "./storage/interface.ts";
import type { URI } from "./sigil-types.ts";
import { fromURI } from "./uri-utils.ts";
import {
  type FabricRef,
  formatFabricRef,
} from "./sandbox/fabric-import-specifier.ts";
import {
  resolveSlugTargetCell,
  SlugResolutionError,
} from "./slug-resolution.ts";
import { getPatternId, getPatternIdentityRef } from "./runner.ts";
import type { PatternMeta } from "./pattern-manager.ts";

const DID_RE = /^did:[a-z0-9]+:.+$/;

export interface FabricChaseResult {
  entryIdentity: string;
  /** Human-readable hops for errors/tooling. */
  chain: string[];
}

export async function resolveFabricRefToIdentity(
  runtime: Runtime,
  compilingSpace: MemorySpace,
  ref: FabricRef,
): Promise<FabricChaseResult> {
  const specifier = formatFabricRef(ref);
  const refSpace = resolveRefSpace(ref.space, compilingSpace);

  if (ref.ref.kind === "uri" && ref.ref.scheme === "pattern") {
    return done(ref.ref.hash, [`pattern:${ref.ref.hash}`]);
  }

  const chain: string[] = [];
  let cell: Cell<unknown>;
  if (ref.ref.kind === "slug") {
    chain.push(`slug:${ref.ref.slug}`);
    try {
      cell = await resolveSlugTargetCell(runtime, refSpace, ref.ref.slug);
    } catch (cause) {
      if (cause instanceof SlugResolutionError) {
        throw new Error(`${cause.message} (chain: ${formatChain(chain)})`, {
          cause,
        });
      }
      throw cause;
    }
  } else {
    const patternId = `of:fid1:${ref.ref.hash}` as URI;
    chain.push(`of:${patternId}`);
    cell = runtime.getCellFromEntityId(
      refSpace,
      { "/": fromURI(patternId) },
    );
    await cell.sync();
  }

  return await resolveCellToIdentity(runtime, specifier, cell, chain);
}

function resolveRefSpace(
  refSpace: string | undefined,
  compilingSpace: MemorySpace,
): MemorySpace {
  if (refSpace === undefined) return compilingSpace;
  if (DID_RE.test(refSpace)) return refSpace as MemorySpace;
  throw new Error(
    "space names require name→DID resolution (open question 2); use a DID",
  );
}

async function resolveCellToIdentity(
  runtime: Runtime,
  specifier: string,
  cell: Cell<unknown>,
  chain: string[],
): Promise<FabricChaseResult> {
  const link = cell.getAsNormalizedFullLink();
  const cellSpace = link.space;
  const identityRef = getPatternIdentityRef(cell);
  const patternId = getPatternId(cell);

  if (identityRef !== undefined || patternId !== undefined) {
    chain.push(`piece:${link.id}`);
    if (identityRef !== undefined) {
      chain.push(`patternIdentity:${identityRef.identity}`);
      return done(identityRef.identity, chain);
    }

    const meta = await runtime.patternManager.loadPatternMeta(
      patternId!,
      cellSpace,
    );
    chain.push(`patternMeta:${patternId}`);
    return patternMetaToIdentity(specifier, meta, chain);
  }

  const directMeta = patternMetaFromCell(cell);
  if (directMeta !== undefined) {
    chain.push(`patternMeta:${link.id}`);
    return patternMetaToIdentity(specifier, directMeta, chain);
  }

  throw new Error(
    `${specifier} does not resolve to a pattern (chain: ${formatChain(chain)})`,
  );
}

function patternMetaToIdentity(
  specifier: string,
  meta: PatternMeta,
  chain: string[],
): FabricChaseResult {
  if (typeof meta.entryIdentity !== "string" || meta.entryIdentity === "") {
    throw new Error(
      `pattern meta for ${specifier} has no entryIdentity (legacy pattern; re-deploy it) (chain: ${
        formatChain(chain)
      })`,
    );
  }
  return done(meta.entryIdentity, chain);
}

function patternMetaFromCell(cell: Cell<unknown>): PatternMeta | undefined {
  const raw = cell.get();
  if (
    isRecord(raw) &&
    ("program" in raw || "entryIdentity" in raw)
  ) {
    return raw as PatternMeta;
  }
  return undefined;
}

function done(entryIdentity: string, chain: string[]): FabricChaseResult {
  return {
    entryIdentity,
    chain: [...chain, `entryIdentity:${entryIdentity}`],
  };
}

function formatChain(chain: readonly string[]): string {
  return chain.join(" -> ");
}
