/// <cts-enable />
/**
 * Shared type definitions for the contacts pattern family.
 *
 * Extracted to break circular dependencies between contacts.tsx,
 * person.tsx, and family-member.tsx.
 */
import { type Default, NAME, UI, type VNode } from "commontools";

// ============================================================================
// PersonLike - Schelling point for person data (structural type)
// ============================================================================

/**
 * Minimal interface for person-like items.
 * Defined locally in patterns, not in core API - works via duck typing.
 * Any object with { firstName, lastName } satisfies PersonLike.
 */
export interface PersonLike {
  firstName: string;
  lastName: string;
  /** Optional link to same entity in another context (e.g., work vs personal) */
  sameAs?: PersonLike;
}

// ============================================================================
// Person Type - Extends PersonLike with optional contact fields
// ============================================================================

export interface Person extends PersonLike {
  firstName: string;
  lastName: string;
  email: Default<string, "">;
  phone: Default<string, "">;
}

// ============================================================================
// FamilyMember Type - Extends PersonLike with family-specific fields
// ============================================================================

export interface FamilyMember extends PersonLike {
  firstName: string;
  lastName: string;
  relationship: Default<string, "">;
  birthday: Default<string, "">; // ISO date string (YYYY-MM-DD)
  dietaryRestrictions: Default<string[], []>;
}

// ============================================================================
// ContactCharm - What the container stores in its contacts array
// ============================================================================

/**
 * A contact charm has [NAME], [UI], and either person or member data.
 */
export interface ContactCharm {
  [NAME]: string;
  [UI]: VNode;
  person?: Person;
  member?: FamilyMember;
}
