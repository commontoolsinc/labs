import { ACL, ACL_TYPE, ACLUser, DID } from "@commontools/memory/acl";
import { Capability } from "@commontools/memory/interface";
import { Cell, Runtime } from "@commontools/runner";

export class ACLManager {
  #runtime: Runtime;
  #spaceDid: DID;
  constructor(runtime: Runtime, spaceDid: DID) {
    this.#runtime = runtime;
    this.#spaceDid = spaceDid;
  }

  // Returns the `ACL` for this space.
  // Throws if the space failed to initialize an ACL.
  async get(): Promise<ACL> {
    const aclCell = this.#getCell();
    await aclCell.sync();
    const aclData = aclCell.get();
    await this.#runtime.storageManager.synced();

    if (!aclData || Object.keys(aclData).length === 0) {
      throw new Error("No ACL initialized for space.");
    }

    return JSON.parse(JSON.stringify(aclData)) as ACL;
  }

  // Add or update an ACL entry for a DID.
  // Throws if the space failed to initialize an ACL.
  async set(user: ACLUser, capability: Capability): Promise<void> {
    const acl = await this.get();
    acl[user] = capability;
    await this.#write(acl);
  }

  // Remove an ACL entry for a DID
  // Throws if the space failed to initialize an ACL.
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
      type: ACL_TYPE,
    });
  }
}
