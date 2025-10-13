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
  CompoundCycleTracker,
  DefaultSchemaSelector,
  IAttestation,
  MapSet,
} from "../src/traverse.ts";
import * as Path from "@std/path";
import data from "./traverse_timing_test_data.json" with { type: "json" };
import {
  addToSelection,
  Cause,
  Entity,
  FactSelection,
  getMatchingFacts,
  loadFactsForDoc,
  redactCommits,
  SchemaContext,
  SchemaSelector,
  Select,
  ServerObjectManager,
  The,
} from "../../memory/space-schema.ts";
import {
  collectClassifications,
  connect,
  FactSelector,
  getLabels,
  SpaceStoreSession,
} from "../../memory/space.ts";
import { Immutable } from "@commontools/utils/types";
import { ContextualFlowControl } from "../src/cfc.ts";
import { deepEqual } from "../src/path-utils.ts";
import {
  getRevision,
  iterate,
  iterateSelector,
  setEmptyObj,
  setRevision,
} from "@commontools/memory/selection";
import { sleep } from "@commontools/utils/sleep";
import { refer } from "@commontools/memory/reference";
import { SelectAllString } from "@commontools/memory/schema";

/**
 * Query used in the list of notes charm
 */
const sampleSelector: SchemaSelector = {
  "of:baedreibl64qzbhgkvpuxbfc657ugjeyidc62hixjybt5dpci2ddkkhs26m": {
    "application/json": {
      "_": {
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
      },
    },
  },
};

// The default query to get the commit+json log for the space
const spaceSelector: SchemaSelector = {
  "did:key:z6MkkGMscCkDFETV5efoTSEybcVfo8muPQUp7qMa3mUGC4mF": {
    "application/commit+json": {
      "_": {
        "path": [],
        "schemaContext": {
          "schema": false,
          "rootSchema": false,
        },
      },
    },
  },
};

// A query that gets the charms list
// The `asCell` property should probably have been omitted.
// The `ifc` property seems improper as well.
const charmsSelector: SchemaSelector = {
  "of:baedreiahv63wxwgaem4hzjkizl4qncfgvca7pj5cvdon7cukumfon3ioye": {
    "application/json": {
      "_": {
        "path": [],
        "schemaContext": {
          "schema": {
            "type": "array",
            "items": {
              "asCell": true,
            },
            "ifc": {
              "classification": [
                "secret",
              ],
            },
          },
          "rootSchema": {
            "type": "array",
            "items": {
              "asCell": true,
            },
            "ifc": {
              "classification": [
                "secret",
              ],
            },
          },
        },
      },
    },
  },
};

/**
 * This is a set of four queries that were captured from a live run.
 * There were more triggered queries, but these were the entries that took
 * more than 100ms each.
 */
const queryBatch: SchemaSelector[] = [
  {
    "did:key:z6MkkGMscCkDFETV5efoTSEybcVfo8muPQUp7qMa3mUGC4mF": {
      "application/commit+json": {
        "_": {
          "path": [],
          "schemaContext": {
            "schema": false,
            "rootSchema": false,
          },
        },
      },
    },
    "of:baedreiahv63wxwgaem4hzjkizl4qncfgvca7pj5cvdon7cukumfon3ioye": {
      "application/json": {
        "_": {
          "path": [],
          "schemaContext": {
            "schema": {
              "type": "array",
              "items": {
                "asCell": true,
              },
              "ifc": {
                "classification": [
                  "secret",
                ],
              },
            },
            "rootSchema": {
              "type": "array",
              "items": {
                "asCell": true,
              },
              "ifc": {
                "classification": [
                  "secret",
                ],
              },
            },
          },
        },
      },
    },
  },
  {
    "of:baedreiahv63wxwgaem4hzjkizl4qncfgvca7pj5cvdon7cukumfon3ioye": {
      "application/json": {
        "_": {
          "path": [],
          "schemaContext": {
            "schema": {
              "type": "array",
              "items": {
                "asCell": true,
              },
            },
            "rootSchema": {
              "type": "array",
              "items": {
                "asCell": true,
              },
            },
          },
        },
      },
    },
  },
  {
    "of:baedreibyee7wugohld5chzqxgckibuluga64i6zswmx7zqz67v2xp3mk3u": {
      "application/json": {
        "_": {
          "path": [],
          "schemaContext": {
            "schema": {
              "type": "object",
              "properties": {
                "$TYPE": {
                  "type": "string",
                },
                "argument": {
                  "$schema": "https://json-schema.org/draft/2020-12/schema",
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
                    "charmsList": {
                      "type": "array",
                      "items": {
                        "$ref": "#/$defs/CharmEntry",
                      },
                      "default": [],
                    },
                    "allCharms": {
                      "type": "array",
                      "items": true,
                    },
                    "theme": {
                      "type": "object",
                      "properties": {
                        "accentColor": {
                          "type": "string",
                          "default": "#3b82f6",
                        },
                        "fontFace": {
                          "type": "string",
                          "default": "system-ui, -apple-system, sans-serif",
                        },
                        "borderRadius": {
                          "type": "string",
                          "default": "0.5rem",
                        },
                      },
                      "required": [
                        "accentColor",
                        "fontFace",
                        "borderRadius",
                      ],
                    },
                  },
                  "required": [
                    "selectedCharm",
                    "charmsList",
                    "allCharms",
                  ],
                },
              },
              "required": [
                "$TYPE",
              ],
              "$defs": {
                "CharmEntry": {
                  "type": "object",
                  "properties": {
                    "local_id": {
                      "type": "string",
                    },
                    "charm": true,
                  },
                  "required": [
                    "local_id",
                    "charm",
                  ],
                },
              },
            },
            "rootSchema": {
              "type": "object",
              "properties": {
                "$TYPE": {
                  "type": "string",
                },
                "argument": {
                  "$schema": "https://json-schema.org/draft/2020-12/schema",
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
                    "charmsList": {
                      "type": "array",
                      "items": {
                        "$ref": "#/$defs/CharmEntry",
                      },
                      "default": [],
                    },
                    "allCharms": {
                      "type": "array",
                      "items": true,
                    },
                    "theme": {
                      "type": "object",
                      "properties": {
                        "accentColor": {
                          "type": "string",
                          "default": "#3b82f6",
                        },
                        "fontFace": {
                          "type": "string",
                          "default": "system-ui, -apple-system, sans-serif",
                        },
                        "borderRadius": {
                          "type": "string",
                          "default": "0.5rem",
                        },
                      },
                      "required": [
                        "accentColor",
                        "fontFace",
                        "borderRadius",
                      ],
                    },
                  },
                  "required": [
                    "selectedCharm",
                    "charmsList",
                    "allCharms",
                  ],
                },
              },
              "required": [
                "$TYPE",
              ],
              "$defs": {
                "CharmEntry": {
                  "type": "object",
                  "properties": {
                    "local_id": {
                      "type": "string",
                    },
                    "charm": true,
                  },
                  "required": [
                    "local_id",
                    "charm",
                  ],
                },
              },
            },
          },
        },
      },
    },
  },
  {
    "of:baedreiaonvkt2jjlnav7hj7y6aknizkoxywahej6u4zqswof2jhe6yqtue": {
      "application/json": {
        "_": {
          "path": [],
          "schemaContext": {
            "schema": {
              "type": "object",
              "properties": {
                "$TYPE": {
                  "type": "string",
                },
                "argument": {
                  "$schema": "https://json-schema.org/draft/2020-12/schema",
                  "type": "object",
                  "properties": {
                    "allCharms": {
                      "type": "array",
                      "items": {
                        "$ref": "#/$defs/Charm",
                      },
                      "default": [],
                    },
                  },
                  "required": [
                    "allCharms",
                  ],
                },
              },
              "required": [
                "$TYPE",
              ],
              "$defs": {
                "Charm": {
                  "type": "object",
                  "properties": {
                    "$NAME": {
                      "type": "string",
                    },
                    "$UI": true,
                  },
                  "additionalProperties": true,
                },
              },
            },
            "rootSchema": {
              "type": "object",
              "properties": {
                "$TYPE": {
                  "type": "string",
                },
                "argument": {
                  "$schema": "https://json-schema.org/draft/2020-12/schema",
                  "type": "object",
                  "properties": {
                    "allCharms": {
                      "type": "array",
                      "items": {
                        "$ref": "#/$defs/Charm",
                      },
                      "default": [],
                    },
                  },
                  "required": [
                    "allCharms",
                  ],
                },
              },
              "required": [
                "$TYPE",
              ],
              "$defs": {
                "Charm": {
                  "type": "object",
                  "properties": {
                    "$NAME": {
                      "type": "string",
                    },
                    "$UI": true,
                  },
                  "additionalProperties": true,
                },
              },
            },
          },
        },
      },
    },
  },
];

// Simpler variant of the Revision type that doesn't use merkle refs
type SimpleRevision<Is extends JSONValue = JSONValue> = {
  of: URI;
  the: string;
  cause: string;
  is: Is;
  since: number;
};

// Placeholder cause for interacting with server bits that expect a cause ref
const dummyCause = refer({}).toString();

// Helper to avoid typing out this template everywhere
abstract class TestObjectManager
  extends BaseObjectManager<BaseMemoryAddress, JSONValue | undefined> {
  abstract resetTraverseState(): void;
  abstract getReadDocs(): Iterable<IAttestation>;
  // fake details
  abstract getDetails(
    address: BaseMemoryAddress,
  ): { cause: Cause; since: number } | undefined;
  abstract getMatchingFacts(
    factSelector: FactSelector,
  ): Iterable<IAttestation & { cause: string; since: number }>;
}

interface ITestObjectManager {
  resetTraverseState(): void;
  getReadDocs(): Iterable<IAttestation>;
}

class TestServerObjectManager extends ServerObjectManager
  implements ITestObjectManager {
  public localSession;
  constructor(
    session: SpaceStoreSession<MemorySpace>,
    providedClassifications: Set<string>,
  ) {
    super(session, providedClassifications);
    this.localSession = session;
  }

  override load(address: BaseMemoryAddress): IAttestation | null {
    const rv = super.load(address);
    return rv;
  }

  resetTraverseState() {
    this.readValues.clear();
    this.writeValues.clear();
  }

  getMatchingFacts(
    factSelector: FactSelector,
  ): Iterable<IAttestation & { cause: string; since: number }> {
    return [...getMatchingFacts(this.localSession, factSelector)].map(
      (entry) => {
        return { ...entry, cause: entry.cause.toString() };
      },
    );
  }
}

// In-memory object manager for testing
class MemoryObjectManager extends TestObjectManager
  implements ITestObjectManager {
  // Cache our read labels, and any docs we can't read
  public missingDocs = new Map<string, BaseMemoryAddress>();
  public store = new Map<string, SimpleRevision>();
  public stringStore = new Map<string, string>();
  constructor(data: unknown, private useStringStore: boolean) {
    super();
    this.init(data);
  }

  getReadDocs(): Iterable<IAttestation> {
    return this.readValues.values();
  }

  getMissingDocs(): Iterable<BaseMemoryAddress> {
    return this.missingDocs.values();
  }

  // Primitive implementation of getMatchingFacts that just checks of/the key
  // This doesn't support wildcards or cause/since
  getMatchingFacts(
    factSelector: FactSelector,
  ): Iterable<IAttestation & { cause: string; since: number }> {
    const fact = this.loadFromStore(
      this.toKey({ id: factSelector.of as URI, type: factSelector.the }),
    );
    const results = [];
    if (fact !== undefined) {
      results.push({
        address: { id: fact.of, type: fact.the, path: [] },
        value: fact.is,
        cause: fact.cause,
        since: fact.since,
      });
    }
    return results;
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

  getDetails(
    address: BaseMemoryAddress,
  ): { cause: Cause; since: number } | undefined {
    return { cause: dummyCause, since: 100 };
  }
}

// Main test function
function runTest(
  objectManager: TestObjectManager,
  selectSchema: Select<Entity, Select<The, Select<Cause, SchemaPathSelector>>>,
) {
  // Track any docs loaded while traversing the factSelection
  const manager = objectManager;
  const session = (objectManager as any).localSession as SpaceStoreSession;
  // while loading dependent docs, we want to avoid cycles
  const tracker = new CompoundCycleTracker<
    Immutable<JSONValue>,
    SchemaContext | undefined
  >();
  const cfc = new ContextualFlowControl();
  const schemaTracker = new MapSet<string, SchemaPathSelector>(deepEqual);
  const providedClassifications = new Set<string>(["public", "secret"]);

  const includedFacts: FactSelection = {}; // we'll store all the raw facts we accesed here
  // First, collect all the potentially relevant facts (without dereferencing pointers)
  for (
    const selectorEntry of iterateSelector(selectSchema, DefaultSchemaSelector)
  ) {
    const factSelector = {
      of: selectorEntry.of,
      the: selectorEntry.the,
      cause: selectorEntry.cause,
      since: undefined,
    };
    const matchingFacts = manager.getMatchingFacts(factSelector);
    for (const entry of matchingFacts) {
      // The top level facts we accessed should be included
      addToSelection(includedFacts, entry, entry.cause, entry.since);

      // Then filter the facts by the associated schemas, which will dereference
      // pointers as we walk through the structure.
      loadFactsForDoc(
        manager,
        entry,
        selectorEntry.value,
        tracker,
        cfc,
        schemaTracker,
      );
    }
  }
  for (const included of manager.getReadDocs()) {
    const details = manager.getDetails(included.address)!;
    addToSelection(includedFacts, included, details.cause, details.since);
  }

  // We want to collect the classification tags on our included facts
  const labelFacts = getLabels(session, includedFacts);
  const requiredClassifications = collectClassifications(labelFacts);
  if (!requiredClassifications.isSubsetOf(providedClassifications)) {
    throw new Error("Insufficient access");
  }

  // We want to include all the labels for the selected entities as well,
  // since the client may want to change the label, and they'll want the
  // original with a cause for that to be valid.
  // We sort them first, so the client will just see the latest included label
  const sortedLabelFacts = [...iterate(labelFacts)].sort((a, b) =>
    a.value.since - b.value.since
  );
  for (const entry of sortedLabelFacts) {
    setRevision(includedFacts, entry.of, entry.the, entry.cause, entry.value);
  }

  // We may have included the application/commit+json of the space in the query
  // If so, we should redact that based on available classifications.
  // Our result will contain at most one revision of that doc.
  redactCommits(includedFacts, session);

  // Any entities referenced in our selectSchema must be returned in the response
  // I'm not sure this is the best behavior, but it matches the schema-free query code.
  // Our returned stub objects will not have a cause.
  // TODO(@ubik2) See if I can remove this
  for (
    const factSelector of iterateSelector(selectSchema, DefaultSchemaSelector)
  ) {
    if (
      factSelector.of !== SelectAllString &&
      factSelector.the !== SelectAllString &&
      !getRevision(includedFacts, factSelector.of, factSelector.the)
    ) {
      setEmptyObj(includedFacts, factSelector.of, factSelector.the);
    }
  }
  // const doc = objectManager.load(docAddress)!;
  // const factValue: IAttestation = {
  //   address: { ...doc.address, path: [...doc.address.path, "value"] },
  //   value: (doc.value as JSONObject).value,
  // };
  // traverser.traverse(factValue);
  //console.log([...objectManager.getReadDocs()].length, "docs read");
}

async function getObjectManager(
  mode: "sqlite" | "mem.obj" | "mem.str",
): Promise<TestObjectManager> {
  if (mode === "sqlite") {
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
  } else if (mode === "mem.obj") {
    return new MemoryObjectManager(data, false);
  } else if (mode === "mem.str") {
    return new MemoryObjectManager(data, true);
  } else {
    throw new Error(`Unknown mode ${mode}`);
  }
}

const objectManager = await getObjectManager("sqlite");
//const queryBatch = [charmsSelector];
//const queryBatch = [sampleSelector];
//const queryBatch = [{ ...spaceSelector, ...charmsSelector }];

function timeFunction(name: string, fn: () => void) {
  const start = performance.now();
  fn();
  const end = performance.now();
  console.log(name, "took", end - start, "ms");
}

//await sleep(10000);

const n = 100;
timeFunction(`traverseLoop${n}`, () => {
  const session = (objectManager as any).localSession as SpaceStoreSession;
  for (let i = 0; i < n; i++) {
    for (const schemaSelector of queryBatch) {
      objectManager.resetTraverseState();
      session.store.transaction(() => {
        runTest(objectManager, schemaSelector);
      })();
    }
  }
});
console.log([...objectManager.getReadDocs()].length, "docs read");
//console.log([...objectManager.getReadDocs()].map((v) => v.address.id));
console.log("\nDone");

// Utility function used when generating data json from db contents
function mergeItem(
  obj: Select<Entity, Select<The, Select<string, JSONValue | undefined>>>,
  item: IAttestation,
) {
  const facts = [
    ...objectManager.getMatchingFacts({
      of: item.address.id,
      the: item.address.type,
      cause: "_",
      since: undefined,
    }),
  ];
  if (facts.length > 0) {
    const fact = facts[0];
    obj[item.address.id] = {
      [item.address.type]: {
        [fact.cause]: fact.value ? { is: fact.value } : {},
      },
    };
  }
  return obj;
}
// Generate data json from the sqlite database
// The commit+json record won't be included, because it doesn't have a value
// field, so traversal will skip it. We add it manually.
// const objData = [...objectManager.getReadDocs()].reduce(
//   mergeItem,
//   {} as Select<Entity, Select<The, Select<string, JSONValue | undefined>>>,
// );
// console.log(JSON.stringify(objData, null, 2));
// await sleep(3000); // wait for any pending writes

//await sleep(30000);

Deno.exit(0);
