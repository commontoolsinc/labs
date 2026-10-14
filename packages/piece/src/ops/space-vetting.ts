/**
 * Vetting a shared space as its user, before the host acts on it: that the
 * user may write there, that the space is the kind it is taken for, and that
 * its root is the one its genesis commit reserves. Share intake and visits to
 * standalone rooms use this contract. Container visits share the access and
 * own-root checks. Vetting reads the access list, kind, and root, and loads
 * and runs none of the space's code.
 */

import type { DID } from "@commonfabric/identity";
import { type ACL, hasConcreteOwner, isACL } from "@commonfabric/memory/acl";
import {
  ACLManager,
  type Cell,
  inSpaceRootCause,
  isCell,
  type Runtime,
} from "@commonfabric/runner";
import { accessRefused } from "./space-access.ts";

/** Why a space fails vetting. */
export type SpaceRefusal =
  | "recipient-access-refused"
  | "space-kind-undeclared"
  | "space-kind-mismatch"
  | "space-root-missing"
  | "space-root-misplaced";

/**
 * Vets `space` as `identity`, for a space of `kind`, returning its root, or
 * the reason it is refused. A space passes when:
 *
 * - the identity can open it, holding `WRITE` or `OWNER` there, through an
 *   entry of its own or the grant to every principal (`"*"`);
 * - it declares `kind` as its own kind, as `Runtime.spaceKind()` reads it from
 *   the space's genesis commit, which is its creator's claim;
 * - it has a root, and the root is the document at the address the space's
 *   genesis commit reserves for an `inSpace(..., { root: true })` root, the
 *   address `inSpaceRootCause()` derives in the space, so that a root a member
 *   with `WRITE` has linked in place of that one is refused.
 *
 * `admits`, when given, is asked first, of the space's access list as stored,
 * which reads as `undefined` when it is malformed or names no concrete owner
 * and so grants nobody anything; a refusal it returns is the space's.
 *
 * @throws When reading the space's access list or root fails other than by a
 *   refusal of access, or when the host cannot tell the space's kind.
 */
export async function vetSpace<Refusal extends string = never>(
  runtime: Runtime,
  space: DID,
  identity: DID,
  kind: string,
  admits?: (acl: ACL | undefined) => Refusal | undefined,
): Promise<SpaceRefusal | Refusal | Cell<unknown>> {
  const writable = await readWritableSpace(runtime, space, identity, admits);
  if (typeof writable === "string") return writable;
  const { root } = writable;
  // An access list naming a concrete owner was written by the space's genesis
  // commit or after it, so the kind read here is the one the space keeps.
  const declared = await runtime.spaceKind(space);
  if (declared === undefined) return "space-kind-undeclared";
  if (declared !== kind) return "space-kind-mismatch";
  if (!isOwnRoot(root, space)) return "space-root-missing";
  if (!root.equalLinks(runtime.getCell(space, inSpaceRootCause(space)))) {
    return "space-root-misplaced";
  }
  return root;
}

/**
 * Returns a writable space's own document root, with no constraint on its
 * declared kind or root reservation. Access failures use the same refusals
 * as `vetSpace()`.
 */
export async function vetWritableSpaceRoot(
  runtime: Runtime,
  space: DID,
  identity: DID,
): Promise<SpaceRefusal | Cell<unknown>> {
  const writable = await readWritableSpace(runtime, space, identity);
  if (typeof writable === "string") return writable;
  return isOwnRoot(writable.root, space) ? writable.root : "space-root-missing";
}

/** Reads a space's root and requires the identity's write access to it. */
async function readWritableSpace<Refusal extends string = never>(
  runtime: Runtime,
  space: DID,
  identity: DID,
  admits?: (acl: ACL | undefined) => Refusal | undefined,
): Promise<SpaceRefusal | Refusal | { root: unknown }> {
  let stored;
  let root;
  try {
    stored = await new ACLManager(runtime, space).getStored();
    root = await runtime.getSpaceCell(space).key("defaultPattern").pull();
  } catch (error) {
    if (accessRefused(runtime, space)) return "recipient-access-refused";
    throw error;
  }
  if (accessRefused(runtime, space)) return "recipient-access-refused";
  const acl = isACL(stored) && hasConcreteOwner(stored) ? stored : undefined;
  const refusal = admits?.(acl);
  if (refusal !== undefined) return refusal;
  if (!isWriter(acl?.[identity] ?? acl?.["*"])) {
    return "recipient-access-refused";
  }
  return { root };
}

/** Whether a space's root pointer names a document of that same space. */
function isOwnRoot(root: unknown, space: DID): root is Cell<unknown> {
  // A pointer into another space can read as the space cell's own
  // `defaultPattern` key, which the empty-path check refuses.
  return isCell(root) && root.space === space &&
    root.getAsNormalizedFullLink().path.length === 0;
}

/** Whether an access-list grant lets its holder write. */
export function isWriter(grant: unknown): boolean {
  return grant === "WRITE" || grant === "OWNER";
}
