/**
 * Intent System
 *
 * Provides single-use authorization tokens for gating side effects at commit points.
 * Intents are created in response to blocked operations and consumed once approved.
 */

export interface IntentOnce {
  id: string;
  action: string;
  detail: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
  scope: string;  // scoped description of what this intent authorizes
}

/**
 * Manages intent creation, consumption, and expiration
 */
export class IntentManager {
  private intents = new Map<string, IntentOnce>();
  private defaultTTL: number;  // ms, default 5 minutes = 300000

  constructor(options?: { ttl?: number }) {
    this.defaultTTL = options?.ttl ?? 300000;
  }

  /**
   * Create a new intent (not yet approved — just registered)
   */
  create(action: string, detail: string, scope: string): IntentOnce {
    const now = Date.now();
    const intent: IntentOnce = {
      id: crypto.randomUUID(),
      action,
      detail,
      scope,
      createdAt: now,
      expiresAt: now + this.defaultTTL,
      consumed: false,
    };

    this.intents.set(intent.id, intent);
    return intent;
  }

  /**
   * Consume an intent (single-use). Returns false if already consumed or expired.
   */
  consume(id: string): boolean {
    const intent = this.intents.get(id);
    if (!intent) {
      return false;
    }

    // Check if expired
    if (Date.now() > intent.expiresAt) {
      return false;
    }

    // Check if already consumed
    if (intent.consumed) {
      return false;
    }

    // Mark as consumed
    intent.consumed = true;
    return true;
  }

  /**
   * Check if an intent is valid (exists, not consumed, not expired)
   */
  isValid(id: string): boolean {
    const intent = this.intents.get(id);
    if (!intent) {
      return false;
    }

    if (intent.consumed) {
      return false;
    }

    if (Date.now() > intent.expiresAt) {
      return false;
    }

    return true;
  }

  /**
   * Get an intent by ID
   */
  get(id: string): IntentOnce | null {
    return this.intents.get(id) ?? null;
  }

  /**
   * Clean up expired intents
   */
  gc(): void {
    const now = Date.now();
    for (const [id, intent] of this.intents.entries()) {
      if (now > intent.expiresAt) {
        this.intents.delete(id);
      }
    }
  }

  /**
   * List all active (unconsumed, unexpired) intents
   */
  active(): IntentOnce[] {
    const now = Date.now();
    return Array.from(this.intents.values()).filter(
      intent => !intent.consumed && now <= intent.expiresAt
    );
  }
}
