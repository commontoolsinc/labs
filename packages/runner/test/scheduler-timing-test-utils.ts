import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { toMemorySpaceAddress } from "../src/link-utils.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { Action } from "../src/scheduler.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

export {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  Runtime,
  signer,
  space,
  StorageManager,
  toMemorySpaceAddress,
};
export type { Action, IExtendedStorageTransaction };
