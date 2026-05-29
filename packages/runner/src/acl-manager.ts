import { ACL, ACLUser, DID } from "@commonfabric/memory/acl";
import { Capability } from "@commonfabric/memory/interface";
import {
  type FabricValue,
  shallowMutableClone,
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

    // `set`/`remove` only write or delete a single top-level entry, so a
    // mutable top-level copy is all that's needed.
    return shallowMutableClone(aclData as FabricValue) as ACL;
  }

  async set(user: ACLUser, capability: Capability): Promise<void> {
    const acl = await this.get();
    acl[user] = capability;
    await this.#write(acl);
  }

  async remove(user: ACLUser): Promise<void> {
    const acl = await this.get();
    delete acl[user];
    await this.#write(acl);
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
