/**
 * Pins delivery of a session effect that arrives before the first watch
 * response. The scripted transport exercises the memory client wire boundary,
 * the watch view, and the runner replica's schema-document arrival validator.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchemaObj } from "@commonfabric/api";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model/schema-hash";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import {
  type EntityDocument,
  type SessionSync,
  type SessionSyncUpsert,
} from "@commonfabric/memory/v2";
import type { IStorageProvider } from "../src/storage/interface.ts";
import {
  ScriptedSessionTransport,
  type ScriptedTransportMessage,
  SingleSessionFactory,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";

type TestProvider = IStorageProvider & {
  get(uri: URI): EntityDocument | undefined;
};

const upsert = (
  id: URI,
  seq: number,
  document: SessionSyncUpsert["doc"],
): SessionSyncUpsert => ({
  branch: "",
  id,
  seq,
  doc: document,
});

const sync = (
  fromSeq: number,
  toSeq: number,
  upserts: SessionSyncUpsert[],
): SessionSync => ({
  type: "sync",
  fromSeq,
  toSeq,
  upserts,
  removes: [],
});

class PreWatchEffectTransport extends ScriptedSessionTransport {
  watchResponseSent = false;
  effectSentBeforeWatchResponse = false;

  constructor(
    space: MemorySpace,
    private readonly schemaId: URI,
    private readonly schema: JSONSchemaObj,
    private readonly referrerId: URI,
  ) {
    super({
      name: "pre-watch-effect",
      sessionId: "session:pre-watch-effect",
      space,
    });
  }

  protected override ackServerSeq(): number {
    return 2;
  }

  protected override handle(message: ScriptedTransportMessage): void {
    if (message.type !== "session.watch.add") {
      throw new Error(`Unhandled scripted message: ${message.type}`);
    }

    this.effectSentBeforeWatchResponse = !this.watchResponseSent;
    this.emitSync(sync(0, 1, [
      upsert(this.schemaId, 1, { value: this.schema }),
    ]));

    this.watchResponseSent = true;
    this.respond({
      type: "response",
      requestId: message.requestId!,
      ok: {
        serverSeq: 2,
        sync: sync(1, 2, [
          upsert(this.referrerId, 2, {
            value: {
              carried: {
                "/": {
                  "link@1": {
                    id: "of:pre-watch-effect-target",
                    path: [],
                    schema: { $ref: this.schemaId },
                  },
                },
              },
            },
          }),
        ]),
      },
    });
  }
}

describe("memory-v2-pre-watch-effect", () => {
  it("stores a schema effect received before the first watch response", async () => {
    const signer = await Identity.fromPassphrase("memory-v2-pre-watch-effect");
    const space = signer.did();
    const schema: JSONSchemaObj = {
      type: "object",
      properties: {
        name: { type: "string" },
      },
    };
    const schemaHash = internSchemaAsTaggedHashString(schema);
    const schemaId = `cid:${schemaHash}` as URI;
    const referrerId = "of:pre-watch-effect-referrer" as URI;
    const transport = new PreWatchEffectTransport(
      space,
      schemaId,
      schema,
      referrerId,
    );
    const storageManager = TestStorageManager.create({
      as: signer,
      memoryHost: new URL("memory://runner-v2-pre-watch-effect"),
    }, new SingleSessionFactory(transport));
    const provider = storageManager.open(space) as TestProvider;

    try {
      const result = await provider.sync(referrerId, {
        path: [],
        schema: false,
      });

      expect(result.error).toBeUndefined();
      expect(transport.effectSentBeforeWatchResponse).toBe(true);
      expect(provider.get(schemaId)?.value).toEqual(schema);
      expect(provider.get(referrerId)?.value).toBeDefined();
    } finally {
      await storageManager.close();
    }
  });
});
