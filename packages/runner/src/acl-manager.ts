import { ACL, ACLUser, DID } from "@commonfabric/memory/acl";
import { Capability } from "@commonfabric/memory/interface";
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

  async get(): Promise<ACL> {
    const aclCell = this.#getCell();
    await aclCell.sync();
    const aclData = aclCell.get();
    await this.#runtime.storageManager.synced();

    if (!aclData || Object.keys(aclData).length === 0) {
      throw new Error("No ACL initialized for space.");
    }

    // Return an immutable, isolated view: `cloneIfNecessary` (frozen by
    // default) identity-passes the already-deep-frozen stored value (zero-copy)
    // and otherwise freezes a clone. Callers that change the ACL (`set` /
    // `remove`) build a fresh object rather than mutating this.
    return cloneIfNecessary(aclData as FabricValue) as ACL;
  }

  async set(user: ACLUser, capability: Capability): Promise<void> {
    const acl = await this.get();
    await this.#write({ ...acl, [user]: capability });
  }

  async remove(user: ACLUser): Promise<void> {
    const { [user]: _removed, ...rest } = await this.get();
    await this.#write(rest);
  }

  async #write(acl: ACL): Promise<void> {
    await this.#runtime.editWithRetry((tx) => {
      this.#getCell().withTx(tx).set(acl);
    });
    await this.#runtime.idle();
    await this.#runtime.storageManager.synced();
  }

  #getCell(): Cell<unknown> {
    return this.#runtime.getCellFromLink({
      id: this.#spaceDid,
      path: [],
      space: this.#spaceDid,
    });
  }
}
