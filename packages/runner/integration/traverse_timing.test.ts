import { JSONObject } from "@commontools/api";
import {
  JSONValue,
  MemorySpace,
  SchemaPathSelector,
  URI,
} from "../src/storage/interface.ts";
import {
  BaseMemoryAddress,
  BaseObjectManager,
  IAttestation,
  SchemaObjectTraverser,
} from "../src/traverse.ts";
import * as Path from "@std/path";
import data from "./traverse_timing_test_data.json" with { type: "json" };
import { ServerObjectManager } from "../../memory/space-schema.ts";
import { connect, SpaceStoreSession } from "../../memory/space.ts";

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

// Helper to avoid typing out this template everywhere
abstract class TestObjectManager
  extends BaseObjectManager<BaseMemoryAddress, JSONValue | undefined> {
}

class TestServerObjectManager extends ServerObjectManager {
  constructor(
    session: SpaceStoreSession<MemorySpace>,
    providedClassifications: Set<string>,
  ) {
    super(session, providedClassifications);
  }

  override load(address: BaseMemoryAddress): IAttestation | null {
    const rv = super.load(address);
    if (rv === null) {
      console.log("Missing", this.toKey(address));
    }
    return rv;
  }

  resetTraverseState() {
    this.readValues.clear();
    this.writeValues.clear();
  }
}

// In-memory object manager for testing
class MemoryObjectManager extends TestObjectManager {
  // Cache our read labels, and any docs we can't read
  public missingDocs = new Map<string, BaseMemoryAddress>();
  public store = new Map<string, SimpleRevision>();
  public stringStore = new Map<string, string>();
  public useStringStore = true;
  constructor(data: unknown) {
    super();
    this.init(data);
  }

  getReadDocs(): Iterable<IAttestation> {
    return this.readValues.values();
  }

  getMissingDocs(): Iterable<BaseMemoryAddress> {
    return this.missingDocs.values();
  }

  // This replicates the JSON.parse/stringify that happens
  private loadFromStringStore(key: string): SimpleRevision | undefined {
    const entry = this.stringStore.get(key);
    return entry ? (JSON.parse(entry) as SimpleRevision) : undefined;
  }

  // This is more direct acccess to the objects
  private loadFromObjStore(key: string): SimpleRevision | undefined {
    return this.store.get(key);
  }

  private loadFromStore(key: string): SimpleRevision | undefined {
    return (this.useStringStore
      ? this.loadFromStringStore(key)
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

  private init(data: unknown) {
    for (
      const [uri, attrs] of Object.entries(data as Record<string, unknown>)
    ) {
      const [[type, caused]] = Object.entries(attrs as Record<string, unknown>);
      const [[_, revision]] = Object.entries(caused as Record<string, unknown>);
      const address: BaseMemoryAddress = { id: uri as URI, type: type };
      this.store.set(this.toKey(address), revision as SimpleRevision);
      this.stringStore.set(this.toKey(address), JSON.stringify(revision));
    }
  }

  resetTraverseState() {
    this.readValues.clear();
    this.missingDocs.clear();
  }
}

// Main test function
function runTest(objectManager: TestObjectManager) {
  const traverser = new SchemaObjectTraverser(objectManager, selector);
  const doc = objectManager.load(docAddress)!;
  const factValue: IAttestation = {
    address: { ...doc.address, path: [...doc.address.path, "value"] },
    value: (doc.value as JSONObject).value,
  };
  traverser.traverse(factValue);
  if (objectManager instanceof MemoryObjectManager) {
    console.log(
      [...(objectManager as MemoryObjectManager).getReadDocs()].length,
      "docs read",
    );
  } else if (objectManager instanceof TestServerObjectManager) {
    console.log(
      [...(objectManager as TestServerObjectManager).getReadDocs()].length,
      "docs read",
    );
  }
}

async function getObjectManager(useDb: boolean): Promise<TestObjectManager> {
  if (useDb) {
    // SQLite based object manager
    const spaceDID = "did:key:z6MkkGMscCkDFETV5efoTSEybcVfo8muPQUp7qMa3mUGC4mF";
    const dbURL = new URL(
      //`../toolshed/cache/memory/${spaceDID}.sqlite`,
      `../runner/integration/${spaceDID}.sqlite`,
      Path.toFileUrl(`${Deno.cwd()}/`),
    );
    const result = await connect({ url: dbURL });
    const replica = result.ok!;
    return new TestServerObjectManager(replica, new Set());
  } else {
    return new MemoryObjectManager(data);
  }
}

const objectManager = await getObjectManager(true);

function timeFunction(name: string, fn: () => void) {
  const start = performance.now();
  fn();
  const end = performance.now();
  console.log(name, "took", end - start, "ms");
}

const n = 100;
timeFunction(`traverseLoop${n}`, () => {
  for (let i = 0; i < n; i++) {
    runTest(objectManager);
    if (objectManager instanceof MemoryObjectManager) {
      objectManager.resetTraverseState();
    } else if (objectManager instanceof TestServerObjectManager) {
      objectManager.resetTraverseState();
    }
  }
});

console.log("\nDone");
Deno.exit(0);
