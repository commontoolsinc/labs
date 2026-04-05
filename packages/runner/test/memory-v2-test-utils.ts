import type { MemorySpace } from "@commonfabric/memory/interface";
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

export class NotificationRecorder implements IStorageNotification {
  notifications: StorageNotification[] = [];

  next(notification: StorageNotification) {
    this.notifications.push(notification);
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
    const session = await client.mount(space);
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
