import { JSONObject, JSONValue } from "@commontools/api";
import { MIME } from "@commontools/memory/interface";
import { SchemaPathSelector, URI } from "../src/storage/interface.ts";
import {
  BaseMemoryAddress,
  BaseObjectManager,
  IAttestation,
  SchemaObjectTraverser,
} from "../src/traverse.ts";

import data from "./traverse_timing_test_data.json" with { type: "json" };

const docAddress: BaseMemoryAddress = {
  id: "of:baedreibl64qzbhgkvpuxbfc657ugjeyidc62hixjybt5dpci2ddkkhs26m",
  type: "application/json",
};

const selector: SchemaPathSelector = {
  "path": [],
  "schemaContext": {
    "schema": {
      "type": "object",
      "properties": {
        "selectedCharm": {
          "type": "object",
          "properties": {
            "charm": true,
          },
          "required": [
            "charm",
          ],
          "default": {},
        },
      },
      "required": [
        "selectedCharm",
      ],
    },
    "rootSchema": {
      "type": "object",
      "properties": {
        "selectedCharm": {
          "type": "object",
          "properties": {
            "charm": true,
          },
          "required": [
            "charm",
          ],
          "default": {},
        },
      },
      "required": [
        "selectedCharm",
      ],
    },
  },
};

type SimpleRevision<Is extends JSONValue = JSONValue> = {
  of: URI;
  the: string;
  cause: string;
  is: Is;
  since: number;
};

class TestObjectManager
  extends BaseObjectManager<BaseMemoryAddress, JSONValue | undefined> {
  // Cache our read labels, and any docs we can't read
  public missingDocs = new Map<string, BaseMemoryAddress>();
  public store = new Map<string, SimpleRevision>();
  public dbStore = new Map<string, string>();
  public useStringStore = true;
  constructor() {
    super();
  }

  getReadDocs(): Iterable<IAttestation> {
    return this.readValues.values();
  }

  getMissingDocs(): Iterable<BaseMemoryAddress> {
    return this.missingDocs.values();
  }

  // This replicates the JSON.parse/stringify that happens
  private loadFromDbStore(key: string): SimpleRevision | undefined {
    const entry = this.dbStore.get(key);
    return entry ? (JSON.parse(entry) as SimpleRevision) : undefined;
  }

  // This is more direct acccess to the objects
  private loadFromObjStore(key: string): SimpleRevision | undefined {
    return this.store.get(key);
  }

  private loadFromStore(key: string): SimpleRevision | undefined {
    return (this.useStringStore
      ? this.loadFromDbStore(key)
      : this.loadFromObjStore(key));
  }

  // Returns null if there is no matching fact
  override load(address: BaseMemoryAddress): IAttestation | null {
    // Normally, we won't have data links, but in this dataset, we do.
    // Decode that here, just so we can follow the links (which are missing,
    // because I captured the data returned from the server, and the server
    // didn't decode these data links).
    if (address.id.startsWith("data:application/json")) {
      const [_prefix, encoded] = address.id.split(",", 2);
      const value = JSON.parse(decodeURIComponent(encoded));
      const valueEntry = {
        address: { ...address, path: ["value"] },
        value: value as (JSONObject | undefined),
      };
      return valueEntry;
    }
    const key = this.toKey(address);
    if (this.readValues.has(key)) {
      return this.readValues.get(key)!;
    }
    // we should only have one match
    const storeValue = this.loadFromStore(key);
    if (storeValue !== undefined) {
      const rv = { address: { path: [], ...address }, value: storeValue?.is };
      this.readValues.set(key, rv);
      return rv;
    } else {
      if (!this.missingDocs.has(key)) {
        this.missingDocs.set(key, address);
      }
    }
    return null;
  }

  init(data: unknown) {
    for (
      const [uri, attrs] of Object.entries(data as Record<string, unknown>)
    ) {
      const [[type, caused]] = Object.entries(attrs as Record<string, unknown>);
      const [[_, revision]] = Object.entries(caused as Record<string, unknown>);
      const address: BaseMemoryAddress = { id: uri as URI, type: type as MIME };
      this.store.set(this.toKey(address), revision as SimpleRevision);
      this.dbStore.set(this.toKey(address), JSON.stringify(revision));
    }
  }

  resetTraverseState() {
    this.readValues.clear();
    this.missingDocs.clear();
  }
}

const objectManager = new TestObjectManager();
function initTest(objectManager: TestObjectManager, data: unknown) {
  objectManager.init(data);
}

// Main test function
function runTest(objectManager: TestObjectManager) {
  objectManager.resetTraverseState();
  const traverser = new SchemaObjectTraverser(objectManager, selector);
  const doc = objectManager.load(docAddress)!;
  const factValue: IAttestation = {
    address: { ...doc.address, path: [...doc.address.path, "value"] },
    value: (doc.value as JSONObject).value,
  };
  traverser.traverse(factValue);
}

function timeFunction(name: string, fn: () => void) {
  const start = performance.now();
  fn();
  const end = performance.now();
  console.log(name, "took", end - start, "ms");
}

Deno.test({
  name: "traverse timing test",
  fn: () => {
    timeFunction("initTest", () => {
      initTest(objectManager, data);
    });

    const n = 100;
    timeFunction(`traverseLoop${n}`, () => {
      for (let i = 0; i < n; i++) {
        runTest(objectManager);
        if (i === 0) {
          console.log("missing docs:", objectManager.getMissingDocs());
        }
      }
    });

    console.log("\nDone");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
