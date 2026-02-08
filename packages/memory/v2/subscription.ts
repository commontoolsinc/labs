/**
 * Memory v2 Subscription Matching
 *
 * Simplified subscription system for v2. Matches committed facts
 * against active subscriptions using 2-level selectors (entity ID → match).
 * From spec §05 §5.4.
 */

import type { Commit, EntityId, Selector } from "./types.ts";
import type { InvocationId, SubscriptionUpdate } from "./protocol.ts";

/**
 * State for a single active subscription.
 */
export interface SubscriptionState {
  /** Unique subscription identifier (the invocation ID). */
  id: InvocationId;
  /** The selector pattern being watched. */
  selector: Selector;
  /** Target branch. */
  branch: string;
  /** Highest version already sent to this subscriber. */
  lastVersionSent: number;
}

/**
 * Check if a committed fact matches a subscription's selector.
 */
export function matchesFact(
  selector: Selector,
  entityId: EntityId,
): boolean {
  // Wildcard matches everything
  if ("*" in selector) return true;

  // Check if the specific entity is in the selector
  return entityId in selector;
}

/**
 * Filter a commit's facts to those matching a subscription.
 * Returns null if no facts match.
 */
export function filterCommitForSubscription(
  commit: Commit,
  subscription: SubscriptionState,
): SubscriptionUpdate | null {
  // Skip if commit is on a different branch
  if (commit.branch !== subscription.branch) return null;

  // Skip if commit version is not newer than what we already sent
  if (commit.version <= subscription.lastVersionSent) return null;

  // Filter facts that match the subscription's selector
  const matchingFacts = commit.facts.filter((sf) =>
    matchesFact(subscription.selector, sf.fact.id)
  );

  if (matchingFacts.length === 0) return null;

  return {
    commit,
    revisions: matchingFacts,
  };
}

/**
 * A subscription manager that tracks active subscriptions and
 * dispatches updates when commits occur.
 */
export class SubscriptionManager {
  private subscriptions = new Map<InvocationId, SubscriptionState>();
  private listeners = new Map<
    InvocationId,
    (update: SubscriptionUpdate) => void
  >();

  /**
   * Register a new subscription.
   */
  subscribe(
    id: InvocationId,
    selector: Selector,
    branch: string,
    initialVersion: number,
    listener: (update: SubscriptionUpdate) => void,
  ): void {
    this.subscriptions.set(id, {
      id,
      selector,
      branch,
      lastVersionSent: initialVersion,
    });
    this.listeners.set(id, listener);
  }

  /**
   * Remove a subscription.
   */
  unsubscribe(id: InvocationId): boolean {
    this.listeners.delete(id);
    return this.subscriptions.delete(id);
  }

  /**
   * Notify all matching subscriptions about a commit.
   */
  notify(commit: Commit): void {
    for (const [id, sub] of this.subscriptions) {
      const update = filterCommitForSubscription(commit, sub);
      if (update) {
        sub.lastVersionSent = commit.version;
        const listener = this.listeners.get(id);
        if (listener) {
          listener(update);
        }
      }
    }
  }

  /**
   * Check if there are any active subscriptions.
   */
  get hasSubscriptions(): boolean {
    return this.subscriptions.size > 0;
  }

  /**
   * Number of active subscriptions.
   */
  get size(): number {
    return this.subscriptions.size;
  }

  /**
   * Remove all subscriptions.
   */
  clear(): void {
    this.subscriptions.clear();
    this.listeners.clear();
  }
}
