import {
  IStorageNotification,
  IStorageNotificationCapability,
  IStorageSubscription,
  IStorageSubscriptionCapability,
  StorageNotification,
} from "./interface.ts";

export const createStorageNotificationRelay = () =>
  new StorageNotificationRelay();
export const create = createStorageNotificationRelay;

/**
 * Storage subscription that can be used by consumers to subscribe to storage
 * notifications and by storage to broadcast them to all subscribers.
 */
export class StorageNotificationRelay
  implements
    IStorageNotificationCapability,
    IStorageSubscriptionCapability,
    IStorageNotification,
    IStorageSubscription {
  #subscribers: Set<IStorageNotification>;
  constructor(subscribers: Set<IStorageNotification> = new Set()) {
    this.#subscribers = subscribers;
  }
  subscribe(subscription: IStorageNotification): void {
    this.#subscribers.add(subscription);
  }
  next(notification: StorageNotification) {
    for (const subscriber of this.#subscribers) {
      try {
        if (subscriber.next(notification)?.done) {
          this.#subscribers.delete(subscriber);
        }
      } catch (error) {
        console.error(`Storage subscription throw an error: ${error}`);
      }
    }
    return { done: false };
  }
}

export { StorageNotificationRelay as StorageSubscription };
