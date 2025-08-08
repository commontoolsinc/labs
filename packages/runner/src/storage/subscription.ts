import {
  IStorageSubscription,
  IStorageSubscriptionCapability,
  StorageNotification,
} from "./interface.ts";

export const create = () => new StorageSubscription();

/**
 * Storage subscription that can be used by consumers to subscribe to storage
 * notifications and by storage to broadcast them to all subscribers.
 */
class StorageSubscription
  implements IStorageSubscriptionCapability, IStorageSubscription {
  #subscribers: Set<IStorageSubscription>;
  constructor(subscribers: Set<IStorageSubscription> = new Set()) {
    this.#subscribers = subscribers;
  }
  subscribe(subscription: IStorageSubscription): void {
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
