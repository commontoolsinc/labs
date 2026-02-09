import {
  IStorageNotificationSink,
  IStorageNotificationSource,
  StorageNotification,
} from "./interface.ts";

export const create = () => new StorageNotificationRelay();

/**
 * Storage notification relay that can be used by consumers to subscribe to
 * storage notifications and by storage to broadcast them to all subscribers.
 */
class StorageNotificationRelay
  implements IStorageNotificationSource, IStorageNotificationSink {
  #subscribers: Set<IStorageNotificationSink>;
  constructor(subscribers: Set<IStorageNotificationSink> = new Set()) {
    this.#subscribers = subscribers;
  }
  subscribe(sink: IStorageNotificationSink): void {
    this.#subscribers.add(sink);
  }
  next(notification: StorageNotification) {
    for (const subscriber of this.#subscribers) {
      try {
        if (subscriber.next(notification)?.done) {
          this.#subscribers.delete(subscriber);
        }
      } catch (error) {
        console.error(`Storage notification relay threw an error: ${error}`);
      }
    }
    return { done: false };
  }
}
