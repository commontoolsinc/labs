/// <cts-enable />
/**
 * Building Blocks - Shared Type Definitions
 *
 * This module defines the irreducible core types for a personal productivity
 * and CRM system. These types support GTD, PARA, Eisenhower matrix, and
 * relationship tracking patterns.
 *
 * Design Principles:
 * - Normalized references (IDs, not nested objects)
 * - Status as primary filter (actionability-first)
 * - Orthogonal priority dimensions (urgency ≠ importance)
 * - Flexible contexts (user-defined strings)
 * - Timestamps everywhere for sorting/filtering
 */

import { Default } from "commontools";

// =============================================================================
// ENUMS & CONSTANTS
// =============================================================================

/** Task actionability states (GTD-derived) */
export type TaskStatus =
  | "inbox" // Unprocessed - needs clarification
  | "next" // Actionable now - ready to do
  | "waiting" // Blocked on external (person/event)
  | "someday" // Deferred - not now, maybe later
  | "done" // Completed
  | "archived"; // Removed from active view

/** Project lifecycle states */
export type ProjectStatus =
  | "active" // Currently being worked
  | "on-hold" // Paused intentionally
  | "someday" // Future consideration
  | "done" // Outcome achieved
  | "archived"; // Abandoned/cancelled

/** Goal achievement states */
export type GoalStatus =
  | "active" // In progress
  | "achieved" // Successfully completed
  | "abandoned" // Intentionally stopped
  | "archived"; // Removed from view

/** Priority levels (applies to both urgency and importance) */
export type Priority = "low" | "normal" | "high" | "critical";

/** Energy/focus required */
export type EnergyLevel = "low" | "medium" | "high";

/** Place types */
export type PlaceType = "physical" | "virtual" | "hybrid";

// =============================================================================
// RECURRENCE
// =============================================================================

/** Recurrence rule for repeating tasks/events */
export interface RecurrenceRule {
  frequency: "daily" | "weekly" | "monthly" | "yearly";
  interval?: number; // Every N periods (default: 1)
  daysOfWeek?: number[]; // For weekly: 0=Sun, 6=Sat
  dayOfMonth?: number; // For monthly
  endDate?: string; // ISO date when recurrence stops
  regenerateOnComplete?: boolean; // After completion vs on schedule
}

// =============================================================================
// CONTACT SUPPORT TYPES
// =============================================================================

/** Contact method for a person */
export interface ContactMethod {
  type: string; // "email", "phone", "linkedin", etc.
  value: string;
  label?: string; // "work", "personal"
  isPrimary?: Default<boolean, false>;
}

/** Important date for a person */
export interface ImportantDate {
  date: string; // MM-DD or YYYY-MM-DD
  label: string; // "Birthday", "Anniversary"
  isRecurring: Default<boolean, true>;
}

/** Relationship between two persons */
export interface PersonRelationship {
  personId: string; // Related person's ID
  label: string; // "spouse", "manager", "friend"
}

// =============================================================================
// GOAL SUPPORT TYPES
// =============================================================================

/** Key result for OKR-style goals */
export interface KeyResult {
  title: string; // "Run 3x per week"
  targetValue?: number;
  currentValue?: number;
  unit?: string; // "times", "miles", "%"
}

// =============================================================================
// CORE BUILDING BLOCK TYPES
// =============================================================================

/**
 * Role - Ongoing responsibility domain (PARA)
 *
 * Roles are perpetual domains with no endpoint. They answer:
 * "What hats do I wear? What standards must I maintain?"
 *
 * Examples: Parent, Employee, Friend, Homeowner, Hobbyist
 */
export interface Role {
  id: string;
  title: string;
  description?: string;
  icon?: string; // Emoji or icon identifier
  color?: string; // Hex color for UI grouping

  createdAt: number; // Unix timestamp
  modifiedAt: number;

  // Roles don't complete - they can only be hidden
  isActive: Default<boolean, true>;

  // Hierarchy (roles can nest)
  parentRoleId?: string;
}

/**
 * Place - Physical or virtual location
 *
 * Provides context for tasks and interactions.
 * Enables location-based filtering.
 */
export interface Place {
  id: string;
  name: string;
  type: Default<PlaceType, "physical">;

  // Physical location
  address?: string;
  coordinates?: { lat: number; lng: number };

  // Virtual location
  url?: string;

  // Context
  description?: string;
  availableContexts?: string[]; // What @contexts apply here

  createdAt: number;
  modifiedAt: number;
  isActive: Default<boolean, true>;
}

/**
 * Thing - Generic entity/resource
 *
 * Flexible type for objects, documents, accounts, or any
 * "noun" that isn't a person or place.
 */
export interface Thing {
  id: string;
  name: string;

  type?: string; // "document", "account", "tool", etc.
  category?: string; // Grouping within type

  description?: string;
  url?: string; // Link if applicable

  // Ownership/association
  ownerPersonId?: string;
  locationPlaceId?: string;

  createdAt: number;
  modifiedAt: number;
  isActive: Default<boolean, true>;

  // Flexible key-value attributes
  attributes?: Record<string, string | number | boolean>;
}

/**
 * Person - Contact entity for CRM
 *
 * The fundamental building block for relationship tracking.
 * Supports personal CRM patterns.
 */
export interface Person {
  id: string;

  // Identity
  name: string;
  nickname?: string;
  pronouns?: string;

  // Primary contact
  email?: string;
  phone?: string;
  contactMethods?: ContactMethod[];

  // Relationship context
  relationshipType?: string; // "friend", "family", "colleague"
  organization?: string;
  role?: string; // Job title

  // CRM metadata
  createdAt: number;
  modifiedAt: number;
  lastContactAt?: number;
  contactFrequencyDays?: number; // Goal: touch base every N days

  // Personal context
  birthday?: string; // MM-DD or YYYY-MM-DD
  notes?: string;
  interests?: string[];

  // Rich data
  importantDates?: ImportantDate[];
  relationships?: PersonRelationship[];

  isActive: Default<boolean, true>;
}

/**
 * Project - Multi-task container with outcome (GTD/PARA)
 *
 * A project is any outcome requiring more than one task.
 * It's a container, not a big task.
 *
 * Key distinction: Projects have completion states.
 */
export interface Project {
  id: string;
  title: string; // Desired outcome: "Kitchen renovated"
  description?: string;

  status: Default<ProjectStatus, "active">;

  createdAt: number;
  modifiedAt: number;
  completedAt?: number;
  targetDate?: string; // Soft goal, not hard deadline

  // Hierarchy
  roleId?: string; // Parent role
  parentProjectId?: string; // For sub-projects

  // Progress (computed from tasks, cached)
  taskCount?: number;
  completedTaskCount?: number;

  // Stakeholders
  stakeholderIds?: string[];
}

/**
 * Task - Atomic action (GTD Next Action)
 *
 * A task is a single, concrete action that can be done in one session.
 * This is the fundamental unit of work.
 *
 * The status field is the PRIMARY filter - it determines which
 * "list" the task appears on in GTD terms.
 */
export interface Task {
  id: string;
  title: string; // Verb phrase: "Call Mom about birthday"
  description?: string;

  // Actionability State (PRIMARY FILTER)
  status: Default<TaskStatus, "inbox">;

  // Temporal Attributes
  createdAt: number;
  modifiedAt: number;
  completedAt?: number;
  dueAt?: string; // Hard deadline (ISO date)
  scheduledFor?: string; // When to work on it
  deferUntil?: string; // Don't show until this date

  // Priority (orthogonal dimensions - Eisenhower)
  urgency?: Default<Priority, "normal">;
  importance?: Default<Priority, "normal">;
  energy?: Default<EnergyLevel, "medium">;
  estimatedMinutes?: number;

  // Contexts (GTD filtering) - user-defined strings
  contexts?: string[]; // @home, @computer, @5min, @low-energy

  // Relationships (normalized references)
  projectId?: string; // Parent project
  roleId?: string; // Responsibility domain (if no project)
  blockedByIds?: string[]; // Can't start until these complete
  delegatedToId?: string; // Person (makes this "waiting")
  aboutIds?: string[]; // Related persons/places/things

  // Recurrence
  recurrence?: RecurrenceRule;
  recurrenceParentId?: string; // Original recurring task
}

/**
 * Interaction - Touchpoint log for CRM
 *
 * Records engagement with people, places, or things.
 * This is the "memory" of relationships.
 */
export interface Interaction {
  id: string;

  occurredAt: number; // When it happened
  type: string; // "call", "email", "meeting", "message"

  // What happened
  summary?: string;
  notes?: string;

  // Who/what was involved
  personIds?: string[];
  placeId?: string;
  thingIds?: string[];

  // Related work
  taskId?: string;
  projectId?: string;

  // Follow-up
  followUpTaskId?: string;

  createdAt: number;
  modifiedAt: number;
  isActive: Default<boolean, true>;
}

/**
 * Goal - OKR-style objective (optional layer)
 *
 * Higher-level outcomes that provide direction.
 * Goals roll up: Task → Project → Goal → Role
 */
export interface Goal {
  id: string;
  title: string; // Qualitative: "Improve fitness"
  description?: string;

  status: Default<GoalStatus, "active">;

  startDate?: string;
  targetDate?: string;

  // Hierarchy
  roleId?: string;
  parentGoalId?: string;

  // Metrics
  keyResults?: KeyResult[];

  createdAt: number;
  modifiedAt: number;
  completedAt?: number;
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/** Generate a unique ID */
export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

/** Get current timestamp */
export function now(): number {
  return Date.now();
}

/** Format date as ISO string (YYYY-MM-DD) */
export function toISODate(date: Date): string {
  return date.toISOString().split("T")[0];
}

/** Check if a task is actionable (can be worked on now) */
export function isActionable(task: Task): boolean {
  if (task.status !== "next") return false;
  if (task.deferUntil) {
    const defer = new Date(task.deferUntil);
    if (defer > new Date()) return false;
  }
  if (task.blockedByIds && task.blockedByIds.length > 0) return false;
  return true;
}

/** Check if a task is overdue */
export function isOverdue(task: Task): boolean {
  if (!task.dueAt || task.status === "done") return false;
  return new Date(task.dueAt) < new Date();
}

/** Get Eisenhower quadrant for a task */
export function getQuadrant(
  task: Task
): "do" | "schedule" | "delegate" | "eliminate" {
  const urgent = task.urgency === "high" || task.urgency === "critical";
  const important = task.importance === "high" || task.importance === "critical";

  if (urgent && important) return "do";
  if (!urgent && important) return "schedule";
  if (urgent && !important) return "delegate";
  return "eliminate";
}
