import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assertSpyCall, assertSpyCalls, spy } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { Entity } from "@commonfabric/memory/interface";
import { storedCfcMetadataAppliesToPath } from "../src/cfc/metadata.ts";
import { Runtime } from "../src/runtime.ts";
import {
  ignoreReadForScheduling,
  txToReactivityLog,
} from "../src/scheduler.ts";
import { toMemorySpaceAddress } from "../src/link-utils.ts";
import type { Action, EventHandler } from "../src/scheduler.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

export {
  afterEach,
  assertSpyCall,
  assertSpyCalls,
  beforeEach,
  describe,
  expect,
  ignoreReadForScheduling,
  it,
  Runtime,
  signer,
  space,
  spy,
  StorageManager,
  storedCfcMetadataAppliesToPath,
  toMemorySpaceAddress,
  txToReactivityLog,
};
export type { Action, Entity, EventHandler, IExtendedStorageTransaction };
