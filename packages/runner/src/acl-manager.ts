import {
  type ACL,
  type ACLUser,
  type DID,
  hasConcreteOwner,
  isACL,
} from "@commonfabric/memory/acl";
import type { Capability, URI } from "@commonfabric/memory/interface";
import {
  cloneIfNecessary,
  type FabricValue,
} from "@commonfabric/data-model/fabric-value";
import type { Cell } from "./cell.ts";
import type { Runtime } from "./runtime.ts";

export class ACLManager {
  #runtime: Runtime;
  #spaceDid: DID;

  constructor(runtime: Runtime, spaceDid: DID) {
    this.#runtime = runtime;
    this.#spaceDid = spaceDid;
  }

  async get(): Promise<ACL | null> {
    const aclCell = this.#getCell();
    await aclCell.sync();
    const aclData = aclCell.get();
    await this.#runtime.storageManager.synced();

    return this.#validateStoredACL(aclData);
  }

  #validateStoredACL(aclData: unknown): ACL | null {
    if (aclData === undefined) {
      return null;
    }
    if (!isACL(aclData) || !hasConcreteOwner(aclData)) {
      throw new Error("Stored ACL is malformed or has no concrete OWNER.");
    }

    // Return an immutable, isolated view: `cloneIfNecessary` (frozen by
    // default) identity-passes the already-deep-frozen stored value (zero-copy)
    // and otherwise freezes a clone. Callers that change the ACL (`set` /
    // `remove`) build a fresh object rather than mutating this.
    return cloneIfNecessary(aclData as FabricValue) as ACL;
  }

  async set(user: ACLUser, capability: Capability): Promise<void> {
    await this.get();
    // Initialization authority is enforced by the memory server. This lets a
    // space identity or service DID create the first concrete OWNER through
    // the management API while an ordinary public-compatibility principal is
    // still rejected server-side.
    await this.#write((acl) => ({ ...(acl ?? {}), [user]: capability }));
  }

  async remove(user: ACLUser): Promise<void> {
    const acl = await this.get();
    if (acl === null) {
      throw new Error("No ACL initialized for space.");
    }
    await this.#write((current) => {
      if (current === null) {
        throw new Error("No ACL initialized for space.");
      }
      const { [user]: _removed, ...rest } = current;
      return rest;
    });
  }

  async #write(mutate: (current: ACL | null) => ACL): Promise<void> {
    const result = await this.#runtime.editWithRetry((tx) => {
      // `editWithRetry` reruns this callback after catching up from a
      // conflict. Re-read and derive the replacement in every attempt so a
      // retry merges with the winning ACL instead of replaying a stale,
      // precomputed whole-document value over it.
      const aclCell = this.#getCell().withTx(tx);
      const current = this.#validateStoredACL(aclCell.get());
      aclCell.set(mutate(current));
    });
    if (result.error) {
      const error = new Error(result.error.message, { cause: result.error });
      error.name = result.error.name;
      throw error;
    }
    await this.#runtime.idle();
    await this.#runtime.storageManager.synced();
  }

  #getCell(): Cell<unknown> {
    return this.#runtime.getCellFromLink({
      id: `of:${this.#spaceDid}` as URI,
      path: [],
      space: this.#spaceDid,
    });
  }
}
