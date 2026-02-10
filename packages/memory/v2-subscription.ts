/**
 * Memory v2 Subscription Manager
 *
 * Tracks active subscriptions and matches incoming commits against
 * subscription selectors to produce update notifications.
 *
 * @see spec 04-protocol.md §4.3.3
 * @module v2-subscription
 */

import type { Commit, EntityId, StoredFact } from "./v2-types.ts";
import type { InvocationId, Selector } from "./v2-protocol.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Subscription {
  id: InvocationId;
  select: Selector;
  since: number;
  branch: string;
}

export interface SubscriptionUpdate {
  subscriptionId: InvocationId;
  commit: Commit;
  revisions: StoredFact[];
}

// ---------------------------------------------------------------------------
// Subscription Manager
// ---------------------------------------------------------------------------

export class SubscriptionManager {
  private subscriptions = new Map<InvocationId, Subscription>();

  /**
   * Register a new subscription. Returns any existing subscription with
   * the same ID (for idempotent re-subscribe).
   */
  add(sub: Subscription): Subscription | undefined {
    const existing = this.subscriptions.get(sub.id);
    this.subscriptions.set(sub.id, sub);
    return existing;
  }

  /**
   * Remove a subscription by its invocation ID.
   * Returns true if the subscription existed and was removed.
   */
  remove(id: InvocationId): boolean {
    return this.subscriptions.delete(id);
  }

  /**
   * Get a subscription by its invocation ID.
   */
  get(id: InvocationId): Subscription | undefined {
    return this.subscriptions.get(id);
  }

  /**
   * Return the number of active subscriptions.
   */
  get size(): number {
    return this.subscriptions.size;
  }

  /**
   * Match a commit against all active subscriptions and produce updates.
   *
   * For each subscription whose selector matches any of the commit's facts,
   * produces a SubscriptionUpdate with the matching revisions. Also advances
   * the subscription's `since` watermark to the commit's version.
   */
  match(commit: Commit): SubscriptionUpdate[] {
    const updates: SubscriptionUpdate[] = [];

    for (const sub of this.subscriptions.values()) {
      // Branch filter: subscription must match the commit's branch
      if (sub.branch !== commit.branch) continue;

      // Version watermark: skip commits already seen
      if (commit.version <= sub.since) continue;

      // Match facts against the subscription selector
      const matching = matchFacts(sub.select, commit.facts);
      if (matching.length === 0) continue;

      // Advance the watermark
      sub.since = commit.version;

      updates.push({
        subscriptionId: sub.id,
        commit,
        revisions: matching,
      });
    }

    return updates;
  }

  /**
   * Remove all subscriptions. Used on session cleanup.
   */
  clear(): void {
    this.subscriptions.clear();
  }

  /**
   * List all active subscriptions (for debugging/inspection).
   */
  list(): Subscription[] {
    return Array.from(this.subscriptions.values());
  }
}

// ---------------------------------------------------------------------------
// Selector matching
// ---------------------------------------------------------------------------

/**
 * Match stored facts against a selector.
 *
 * A selector is a map of entity ID patterns to match specs:
 * - A specific entity ID matches only that entity.
 * - `"*"` matches all entities.
 * - EntityMatch may include a `parent` filter (not applied here for simplicity).
 */
function matchFacts(select: Selector, facts: StoredFact[]): StoredFact[] {
  const hasWildcard = "*" in select;
  const specificIds = new Set(
    Object.keys(select).filter((k) => k !== "*"),
  );

  if (hasWildcard && specificIds.size === 0) {
    // Wildcard-only: all facts match
    return facts;
  }

  return facts.filter((sf) => {
    const entityId = extractEntityId(sf);
    if (!entityId) return false;

    if (hasWildcard) return true;
    return specificIds.has(entityId);
  });
}

/**
 * Extract the entity ID from a StoredFact.
 */
function extractEntityId(sf: StoredFact): EntityId | undefined {
  if (!sf.fact) return undefined;
  if ("id" in sf.fact) return sf.fact.id;
  return undefined;
}
