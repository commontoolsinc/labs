import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import type { MIME, URI } from "@commontools/memory/interface";
import * as Changes from "@commontools/memory/changes";
import * as Fact from "@commontools/memory/fact";
import * as MemoryV2Client from "@commontools/memory/v2/client";
import * as MemoryV2Server from "@commontools/memory/v2/server";
import { StorageManager as CutoverStorageManager } from "../src/storage/cache.deno.ts";
import {
  type IStorageNotification,
  type StorageNotification,
} from "../src/storage/interface.ts";
import {
  type Options as V2Options,
  type SessionFactory,
  StorageManager as V2StorageManager,
} from "../src/storage/v2.ts";

const signer = await Identity.fromPassphrase("memory-v2-reconnect-race");
const space = signer.did();
const DOCUMENT_MIME = "application/json" as const;

class NotificationRecorder implements IStorageNotification {
  notifications: StorageNotification[] = [];

  next(notification: StorageNotification) {
    this.notifications.push(notification);
    return { done: false };
  }

  clear(): void {
    this.notifications = [];
  }
}

class SabotagedReconnectTransport implements MemoryV2Client.Transport {
  connectionCount = 0;
  droppedLocalSeqs: number[] = [];
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};
  #connection: ReturnType<MemoryV2Server.Server["connect"]> | null = null;
  #dropResponses = false;
  #dropped = new Set<number>();

  constructor(
    private readonly server: MemoryV2Server.Server,
    private readonly dropOnFirstLocalSeqs: number[] = [],
  ) {}

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  async send(payload: string): Promise<void> {
    const message = JSON.parse(payload) as {
      type?: string;
      commit?: { localSeq?: number };
    };
    const localSeq = message.commit?.localSeq;

    if (
      message.type === "transact" &&
      typeof localSeq === "number" &&
      this.dropOnFirstLocalSeqs.includes(localSeq) &&
      !this.#dropped.has(localSeq)
    ) {
      this.#dropped.add(localSeq);
      this.droppedLocalSeqs.push(localSeq);
      this.#dropResponses = true;
      try {
        await this.connection().receive(payload);
      } finally {
        this.#dropResponses = false;
        this.disconnect();
      }
      return;
    }

    await this.connection().receive(payload);
  }

  async close(): Promise<void> {
    this.disconnect();
  }

  disconnect(): void {
    this.#connection?.close();
    this.#connection = null;
    this.#closeReceiver(new Error("disconnect"));
  }

  private connection(): ReturnType<MemoryV2Server.Server["connect"]> {
    if (this.#connection === null) {
      this.connectionCount++;
      this.#connection = this.server.connect((message) => {
        if (!this.#dropResponses) {
          this.#receiver(JSON.stringify(message));
        }
      });
    }
    return this.#connection;
  }
}

class SingleSessionFactory implements SessionFactory {
  client: MemoryV2Client.Client | null = null;

  constructor(private readonly transport: MemoryV2Client.Transport) {}

  async create(space: string) {
    if (this.client !== null) {
      throw new Error(`Session already created for ${space}`);
    }
    const client = await MemoryV2Client.connect({
      transport: this.transport,
    });
    const session = await client.mount(space);
    this.client = client;
    return { client, session };
  }
}

class RejectThenSucceedTransport implements MemoryV2Client.Transport {
  #receiver: (payload: string) => void = () => {};
  #closeReceiver: (error?: Error) => void = () => {};

  setReceiver(receiver: (payload: string) => void): void {
    this.#receiver = receiver;
  }

  setCloseReceiver(receiver: (error?: Error) => void): void {
    this.#closeReceiver = receiver;
  }

  async send(payload: string): Promise<void> {
    const message = JSON.parse(payload) as {
      type: string;
      requestId?: string;
      commit?: { localSeq?: number };
    };

    switch (message.type) {
      case "hello":
        this.#respond({
          type: "hello.ok",
          protocol: "memory/v2",
        });
        return;
      case "session.open":
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            sessionId: "session:reject-then-succeed",
            serverSeq: 0,
          },
        });
        return;
      case "transact": {
        const localSeq = message.commit?.localSeq ?? -1;
        if (localSeq === 1) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          this.#respond({
            type: "response",
            requestId: message.requestId!,
            error: {
              name: "ConflictError",
              message: "synthetic conflict",
            },
          });
          return;
        }
        this.#respond({
          type: "response",
          requestId: message.requestId!,
          ok: {
            seq: localSeq,
            hash: `commit:${localSeq}`,
            branch: "",
            facts: [{
              hash: `fact:${localSeq}:0`,
              id: `of:doc:${localSeq}`,
              valueRef: `value:${localSeq}:0`,
              parent: null,
              branch: "",
              seq: localSeq,
              commitSeq: localSeq,
              factType: "set",
            }],
          },
        });
        return;
      }
      default:
        throw new Error(`Unhandled scripted message: ${message.type}`);
    }
  }

  async close(): Promise<void> {
    this.#closeReceiver();
  }

  #respond(message: unknown): void {
    this.#receiver(JSON.stringify(message));
  }
}

class TestStorageManager extends V2StorageManager {
  static create(options: V2Options, sessionFactory: SessionFactory) {
    return new TestStorageManager(options, sessionFactory);
  }

  private constructor(options: V2Options, sessionFactory: SessionFactory) {
    super(options, sessionFactory);
  }
}

const waitFor = async (
  predicate: () => boolean,
  timeout = 500,
): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const notificationChanges = (
  notifications: StorageNotification[],
  type: StorageNotification["type"],
) =>
  notifications
    .filter((notification) => notification.type === type)
    .flatMap((notification) =>
      "changes" in notification ? [...notification.changes] : []
    );

const getObjectValue = (
  provider: { get(uri: URI): { value: unknown } | undefined },
  uri: URI,
): Record<string, unknown> | undefined => {
  const value = provider.get(uri)?.value;
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
};

Deno.test("memory v2 runner does not integrate its own replayed commit after reconnect", async () => {
  const server = new MemoryV2Server.Server({
    store: new URL(`memory://runner-v2-own-replay-${crypto.randomUUID()}`),
  });
  const transport = new SabotagedReconnectTransport(server, [1]);
  const sessionFactory = new SingleSessionFactory(transport);
  const storageManager = TestStorageManager.create({
    as: signer,
    address: new URL("memory://runner-v2-own-replay"),
    memoryVersion: "v2",
  }, sessionFactory);
  const notifications = new NotificationRecorder();
  const writerClient = await MemoryV2Client.connect({
    transport: MemoryV2Client.loopback(server),
  });
  const writer = await writerClient.mount(space);
  const provider = storageManager.open(space);
  const localUri = `of:memory-v2-local-${crypto.randomUUID()}` as URI;
  const remoteUri = `of:memory-v2-remote-${crypto.randomUUID()}` as URI;

  storageManager.subscribe(notifications);

  try {
    await provider.sync(localUri);
    await provider.sync(remoteUri);
    await storageManager.synced();
    notifications.clear();

    const localSend = provider.send([{
      uri: localUri,
      value: { value: { local: 1 } },
    }]);

    await waitFor(() => transport.droppedLocalSeqs.includes(1));

    await writer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: remoteUri,
        value: {
          value: { remote: 7 },
        },
      }],
    });

    assertEquals(await localSend, { ok: {} });
    await waitFor(() => getObjectValue(provider, remoteUri)?.remote === 7);

    const commitChanges = notificationChanges(notifications.notifications, "commit");
    const integrateChanges = notificationChanges(
      notifications.notifications,
      "integrate",
    );

    assert(commitChanges.some((change) =>
      change.address.id === localUri &&
      JSON.stringify(change.after) === JSON.stringify({ value: { local: 1 } })
    ));
    assertEquals(
      integrateChanges.some((change) => change.address.id === localUri),
      false,
    );
    assertEquals(
      integrateChanges.some((change) =>
        change.address.id === remoteUri &&
        JSON.stringify(change.after) === JSON.stringify({
          value: { remote: 7 },
        })
      ),
      true,
    );
    assertEquals(provider.get(localUri), { value: { local: 1 } });
    assertEquals(provider.get(remoteUri), { value: { remote: 7 } });
    assertEquals(transport.connectionCount >= 2, true);
  } finally {
    await writerClient.close();
    await storageManager.close();
    await server.close();
  }
});

Deno.test("memory v2 runner deduplicates replayed stacked commits while integrating remote updates", async () => {
  const server = new MemoryV2Server.Server({
    store: new URL(`memory://runner-v2-stacked-replay-${crypto.randomUUID()}`),
  });
  const transport = new SabotagedReconnectTransport(server, [1]);
  const sessionFactory = new SingleSessionFactory(transport);
  const storageManager = TestStorageManager.create({
    as: signer,
    address: new URL("memory://runner-v2-stacked-replay"),
    memoryVersion: "v2",
  }, sessionFactory);
  const notifications = new NotificationRecorder();
  const writerClient = await MemoryV2Client.connect({
    transport: MemoryV2Client.loopback(server),
  });
  const writer = await writerClient.mount(space);
  const provider = storageManager.open(space);
  const localUri = `of:memory-v2-stacked-local-${crypto.randomUUID()}` as URI;
  const remoteUri = `of:memory-v2-stacked-remote-${crypto.randomUUID()}` as URI;

  storageManager.subscribe(notifications);

  try {
    await provider.sync(localUri);
    await provider.sync(remoteUri);
    await storageManager.synced();
    notifications.clear();

    const first = provider.send([{
      uri: localUri,
      value: { value: { local: 1 } },
    }]);

    await waitFor(() => transport.droppedLocalSeqs.includes(1));

    const second = provider.send([{
      uri: localUri,
      value: { value: { local: 2 } },
    }]);

    await writer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: remoteUri,
        value: {
          value: { remote: 9 },
        },
      }],
    });

    assertEquals(await first, { ok: {} });
    assertEquals(await second, { ok: {} });
    await waitFor(() => getObjectValue(provider, localUri)?.local === 2);
    await waitFor(() => getObjectValue(provider, remoteUri)?.remote === 9);

    const notificationTypes = notifications.notifications.map((notification) =>
      notification.type
    );
    const integrateChanges = notificationChanges(
      notifications.notifications,
      "integrate",
    );

    assertEquals(notificationTypes, ["commit", "commit", "integrate"]);
    assertEquals(
      integrateChanges.some((change) => change.address.id === localUri),
      false,
    );
    assertEquals(
      integrateChanges.some((change) =>
        change.address.id === remoteUri &&
        JSON.stringify(change.after) === JSON.stringify({
          value: { remote: 9 },
        })
      ),
      true,
    );
    assertEquals(provider.get(localUri), { value: { local: 2 } });
    assertEquals(provider.get(remoteUri), { value: { remote: 9 } });
  } finally {
    await writerClient.close();
    await storageManager.close();
    await server.close();
  }
});

Deno.test("memory v2 runner can retry immediately after a conflict revert", async () => {
  const storageManager = CutoverStorageManager.emulate({
    as: signer,
    memoryVersion: "v2",
  });
  const notifications = new NotificationRecorder();
  const provider = storageManager.open(space);
  const uri = `of:memory-v2-retry-after-revert-${crypto.randomUUID()}` as URI;
  const address = { id: uri, type: DOCUMENT_MIME as MIME };

  storageManager.subscribe(notifications);

  const commitWithSeq = (seq: number, value: number) =>
    (provider.replica as any).commit({
      facts: [Fact.assert({
        the: DOCUMENT_MIME,
        of: uri,
        is: { version: value },
      })],
      claims: [],
    }, {
      journal: {
        activity() {
          return [{
            read: {
              space,
              id: uri,
              type: DOCUMENT_MIME,
              path: [],
              meta: { seq },
            },
          }];
        },
      },
    });

  try {
    await provider.sync(uri);
    await storageManager.session().mount(space).transact({
      changes: Changes.from([Fact.assert({
        the: DOCUMENT_MIME,
        of: uri,
        is: { version: 1 },
      })]),
    });
    await waitFor(() => getObjectValue(provider, uri)?.version === 1);

    await storageManager.session().mount(space).transact({
      changes: Changes.from([Fact.assert({
        the: DOCUMENT_MIME,
        of: uri,
        is: { version: 3 },
      })]),
    });
    await waitFor(() => getObjectValue(provider, uri)?.version === 3);
    notifications.clear();

    const stale = await commitWithSeq(1, 2);
    assert("error" in stale);
    assertEquals(provider.get(uri), { value: { version: 3 } });

    const currentSeq = (provider.replica.get(address) as { since?: number } | undefined)
      ?.since;
    assert(typeof currentSeq === "number");

    const retry = await commitWithSeq(currentSeq, 4);
    assertEquals(retry, { ok: {} });
    assertEquals(provider.get(uri), { value: { version: 4 } });

    const revertNotifications = notifications.notifications.filter((notification) =>
      notification.type === "revert"
    );
    const commitNotifications = notifications.notifications.filter((notification) =>
      notification.type === "commit"
    );

    assertEquals(revertNotifications.length, 1);
    assertEquals(commitNotifications.length >= 2, true);
  } finally {
    await storageManager.close();
  }
});

Deno.test("memory v2 runner keeps later independent pending commits after an earlier conflict", async () => {
  const transport = new RejectThenSucceedTransport();
  const sessionFactory = new SingleSessionFactory(transport);
  const storageManager = TestStorageManager.create({
    as: signer,
    address: new URL("memory://runner-v2-reject-then-succeed"),
    memoryVersion: "v2",
  }, sessionFactory);
  const notifications = new NotificationRecorder();
  const provider = storageManager.open(space);
  const rejectedUri = `of:memory-v2-rejected-${crypto.randomUUID()}` as URI;
  const confirmedUri = `of:memory-v2-confirmed-${crypto.randomUUID()}` as URI;

  storageManager.subscribe(notifications);

  try {
    const rejected = provider.send([{
      uri: rejectedUri,
      value: { value: { rejected: 1 } },
    }]);
    const confirmed = provider.send([{
      uri: confirmedUri,
      value: { value: { confirmed: 2 } },
    }]);

    const rejectedResult = await rejected;
    const confirmedResult = await confirmed;
    await storageManager.synced();

    assertEquals(rejectedResult.error?.name, "ConflictError");
    assertEquals(confirmedResult, { ok: {} });
    assertEquals(provider.get(rejectedUri), undefined);
    assertEquals(provider.get(confirmedUri), { value: { confirmed: 2 } });

    const revertChanges = notificationChanges(
      notifications.notifications,
      "revert",
    );
    assertEquals(
      revertChanges.some((change) => change.address.id === rejectedUri),
      true,
    );
    assertEquals(
      revertChanges.some((change) => change.address.id === confirmedUri),
      false,
    );
  } finally {
    await storageManager.close();
  }
});
