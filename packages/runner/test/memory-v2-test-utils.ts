import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import type { SessionOpenAuthMetadata } from "@commonfabric/memory/v2";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import type {
  IStorageNotification,
  StorageNotification,
} from "../src/storage/interface.ts";
import {
  type Options as V2Options,
  type SessionFactory,
  StorageManager as V2StorageManager,
} from "../src/storage/v2.ts";

export const TEST_SESSION_OPEN_AUDIENCE =
  "did:key:z6Mk-runner-memory-v2-test-audience";
export const TEST_SESSION_OPEN_PRINCIPAL =
  "did:key:z6Mk-runner-memory-v2-test-principal";
export const TEST_SESSION_OPEN_CHALLENGE = {
  value: "challenge:runner-memory-v2-test",
  expiresAt: 1_000_000,
} as const;
export const testSessionOpenAuthMetadata = (
  challengeId: string,
): SessionOpenAuthMetadata => ({
  audience: TEST_SESSION_OPEN_AUDIENCE,
  challenge: {
    value: `challenge:runner-memory-v2-test:${challengeId}`,
    expiresAt: 1_000_000,
  },
});
export const TEST_HELLO_SESSION_OPEN: SessionOpenAuthMetadata = {
  audience: TEST_SESSION_OPEN_AUDIENCE,
  challenge: TEST_SESSION_OPEN_CHALLENGE,
};
export const TEST_MEMORY_SERVER_AUTH = {
  authorizeSessionOpen: () => TEST_SESSION_OPEN_PRINCIPAL,
  sessionOpenAuth: {
    audience: TEST_SESSION_OPEN_AUDIENCE,
  },
} as const;

export const testSessionOpenAuthFactory: MemoryV2Client.SessionOpenAuthFactory =
  (
    _space,
    _session,
    context,
  ) => ({
    invocation: {
      aud: context.audience,
      challenge: context.challenge.value,
    },
    authorization: {},
  });

export function testPrincipalSessionOpenAuthFactory(
  signer?: Signer,
): MemoryV2Client.SessionOpenAuthFactory {
  return (
    _space,
    _session,
    context,
  ) => ({
    invocation: {
      aud: context.audience,
      challenge: context.challenge.value,
    },
    authorization: {
      principal: signer?.did(),
    },
  });
}

export class NotificationRecorder implements IStorageNotification {
  notifications: StorageNotification[] = [];
  onNotification?: (notification: StorageNotification) => void;

  next(notification: StorageNotification) {
    this.notifications.push(notification);
    this.onNotification?.(notification);
    return { done: false };
  }

  clear(): void {
    this.notifications = [];
  }
}

export class SingleSessionFactory implements SessionFactory {
  client: MemoryV2Client.Client | null = null;

  constructor(private readonly transport: MemoryV2Client.Transport) {}

  async create(space: MemorySpace) {
    if (this.client !== null) {
      throw new Error(`Session already created for ${space}`);
    }
    const client = await MemoryV2Client.connect({
      transport: this.transport,
    });
    const session = await client.mount(space, {}, testSessionOpenAuthFactory);
    this.client = client;
    return { client, session };
  }
}

export class TestStorageManager extends V2StorageManager {
  static create(options: V2Options, sessionFactory: SessionFactory) {
    return new TestStorageManager(options, sessionFactory);
  }

  private constructor(options: V2Options, sessionFactory: SessionFactory) {
    super(options, sessionFactory);
  }
}
