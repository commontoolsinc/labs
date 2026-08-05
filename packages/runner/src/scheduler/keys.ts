import {
  resolveScopeKey,
  type ScopeKeyIdentity,
} from "@commonfabric/memory/v2";
import type { IMemorySpaceAddress } from "../storage/interface.ts";
import type { SpaceScopeAndURI } from "./types.ts";

/**
 * The dependency-graph node key: one node per scope INSTANCE of a document
 * (scopes.md §7 M2; key-vocabulary.md §1 site 1). The middle segment is
 * the shared scope_key vocabulary — never the scope NAME — so dirtiness
 * matches storage's exact-scope_key reader matching instead of collapsing
 * every principal's instances onto one node.
 *
 * `identity` is the acting identity the scoped address resolves against.
 * It arrives WITH the work — in the OFF arm every key is built from the
 * runtime's own authenticated session (`Runtime.scopeKeyIdentity`), which
 * is what keeps this re-keying OFF-arm neutral: at cardinality 1 the
 * re-keyed string partitions state exactly as the scope-NAME string did
 * (key-vocabulary.md §2).
 *
 * This is also the composite `${space}/${scope_key}/${id}` constructor for
 * every map that shares the format (the storage manager's pending-load
 * keys cross-match these strings in `collectPendingLoadParkKeys`).
 */
export function entityKey(
  address: Pick<IMemorySpaceAddress, "space" | "id" | "scope">,
  identity: ScopeKeyIdentity,
): SpaceScopeAndURI {
  return `${address.space}/${
    resolveScopeKey(address.scope, identity)
  }/${address.id}`;
}
