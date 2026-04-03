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
// Address & SocialProfile - Structured sub-types
// ============================================================================

export interface Address {
  label: Default<string, "">; // "Home", "Work", etc.
  street: Default<string, "">;
  city: Default<string, "">;
  state: Default<string, "">;
  zip: Default<string, "">;
  country: Default<string, "">;
}

export interface SocialProfile {
  platform: Default<string, "">; // "LinkedIn", "Twitter", etc.
  url: Default<string, "">;
}

// ============================================================================
// Birthday - Structured date with optional year
// ============================================================================

export interface Birthday {
  month: Default<number, 0>; // 1-12, 0 = unset
  day: Default<number, 0>; // 1-31, 0 = unset
  year: Default<number, 0>; // 4-digit year, 0 = unknown
}

// ============================================================================
// Person Type - Extends PersonLike with optional contact fields
// ============================================================================

export interface Person extends PersonLike {
  firstName: string;
  lastName: string;
  // Name extensions
  middleName: Default<string, "">;
  nickname: Default<string, "">; // preferred name / what they go by
  prefix: Default<string, "">; // Dr., Mr., Prof.
  suffix: Default<string, "">; // Jr., III, Ph.D.
  // Identity metadata
  pronouns: Default<string, "">; // freeform: "he/him", "they/them"
  birthday: Default<Birthday, { month: 0; day: 0; year: 0 }>;
  photo: Default<string, "">; // URL or data reference
  // Contact fields
  email: Default<string, "">;
  phone: Default<string, "">;
  notes: Default<string, "">;
  tags: Default<string[], []>;
  addresses: Default<Address[], []>;
  socialProfiles: Default<SocialProfile[], []>;
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
  notes: Default<string, "">;
  tags: Default<string[], []>;
  allergies: Default<string[], []>;
  giftIdeas: Default<string[], []>;
}

// ============================================================================
// ContactPiece - What the container stores in its contacts array
// ============================================================================

/**
 * A contact piece has [NAME], [UI], and either person or member data.
 */
export interface ContactPiece {
  [NAME]: string;
  [UI]: VNode;
  person?: Person;
  member?: FamilyMember;
}

// ============================================================================
// ContactGroup - Manual grouping of contacts
// ============================================================================

export interface ContactGroup {
  name: string;
  contactIndices: Default<number[], []>; // indices into contacts[]
}

// Default export required by ct check infrastructure
export default undefined;
