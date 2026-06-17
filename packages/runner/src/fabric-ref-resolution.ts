import type { Cell } from "./cell.ts";
import type { Runtime } from "./runtime.ts";
import type { MemorySpace } from "./storage/interface.ts";
import type { URI } from "./sigil-types.ts";
import { fromURI } from "./uri-utils.ts";
import { entityIdFrom } from "./create-ref.ts";
import {
  type FabricRef,
  formatFabricRef,
} from "./sandbox/fabric-import-specifier.ts";
import {
  resolveSlugTargetCell,
  SlugResolutionError,
} from "./slug-resolution.ts";
import { getPatternIdentityRef } from "./runner.ts";

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
      entityIdFrom(fromURI(patternId)),
    );
    await cell.sync();
  }

  return await resolveCellToIdentity(specifier, cell, chain);
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

function resolveCellToIdentity(
  specifier: string,
  cell: Cell<unknown>,
  chain: string[],
): Promise<FabricChaseResult> {
  const link = cell.getAsNormalizedFullLink();
  const identityRef = getPatternIdentityRef(cell);

  if (identityRef !== undefined) {
    chain.push(`piece:${link.id}`);
    chain.push(`patternIdentity:${identityRef.identity}`);
    return Promise.resolve(done(identityRef.identity, chain));
  }

  throw new Error(
    `${specifier} does not resolve to a pattern (chain: ${formatChain(chain)})`,
  );
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
