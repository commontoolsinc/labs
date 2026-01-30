import type { HoistedDeclaration, SourcePosition } from "./hoisting-context.ts";

/**
 * Represents a mapping from generated code position to original source position.
 */
export interface SourceMapping {
  /** Position in the generated code */
  readonly generated: SourcePosition;
  /** Position in the original source code */
  readonly original: SourcePosition;
  /** Optional name hint for the mapping */
  readonly name?: string;
}

/**
 * SourceMapTracker tracks the relationship between hoisted declarations
 * and their original positions in the source code.
 *
 * This enables proper error reporting and debugging by mapping stack traces
 * from the generated code back to the original source.
 *
 * Phase 1 Implementation:
 * - Tracks positions for hoisted declarations
 * - Provides simple lookup from hoisted name to original position
 *
 * Phase 2 (future):
 * - Full source map generation compatible with standard formats
 * - Integration with error mapping in runner
 *
 * @example
 * ```typescript
 * const tracker = new SourceMapTracker();
 *
 * // Track a hoisted declaration
 * tracker.trackHoistedDeclaration(hoistedDecl, generatedPosition);
 *
 * // Later, when an error occurs, lookup original position
 * const original = tracker.getOriginalPosition("__lift_0");
 * ```
 */
export class SourceMapTracker {
  private readonly mappings: Map<string, SourceMapping> = new Map();
  private readonly hoistedDeclarations: Map<string, HoistedDeclaration> =
    new Map();

  /**
   * Track a hoisted declaration with its generated position.
   *
   * @param declaration - The hoisted declaration
   * @param generatedPosition - The position in the generated output
   */
  trackHoistedDeclaration(
    declaration: HoistedDeclaration,
    generatedPosition: SourcePosition,
  ): void {
    this.hoistedDeclarations.set(declaration.name, declaration);
    this.mappings.set(declaration.name, {
      generated: generatedPosition,
      original: declaration.originalPosition,
      name: declaration.name,
    });
  }

  /**
   * Get the original source position for a hoisted declaration name.
   *
   * @param name - The generated name (e.g., "__lift_0")
   * @returns The original source position, or undefined if not found
   */
  getOriginalPosition(name: string): SourcePosition | undefined {
    const mapping = this.mappings.get(name);
    return mapping?.original;
  }

  /**
   * Get the hoisted declaration by name.
   *
   * @param name - The generated name
   * @returns The hoisted declaration, or undefined if not found
   */
  getHoistedDeclaration(name: string): HoistedDeclaration | undefined {
    return this.hoistedDeclarations.get(name);
  }

  /**
   * Get all mappings for debugging or serialization.
   *
   * @returns All source mappings
   */
  getAllMappings(): readonly SourceMapping[] {
    return Array.from(this.mappings.values());
  }

  /**
   * Check if a name corresponds to a hoisted declaration.
   *
   * @param name - The name to check
   * @returns True if the name is a hoisted declaration
   */
  isHoistedName(name: string): boolean {
    return this.hoistedDeclarations.has(name);
  }

  /**
   * Serialize the source map data for storage or transmission.
   *
   * @returns A JSON-serializable representation of the source map
   */
  serialize(): SerializedSourceMap {
    const mappings: SerializedMapping[] = [];

    for (const [name, mapping] of this.mappings) {
      mappings.push({
        name,
        generated: mapping.generated,
        original: mapping.original,
      });
    }

    return { version: 1, mappings };
  }

  /**
   * Restore a source map tracker from serialized data.
   *
   * @param data - The serialized source map data
   * @returns A new SourceMapTracker with the restored mappings
   */
  static deserialize(data: SerializedSourceMap): SourceMapTracker {
    const tracker = new SourceMapTracker();

    for (const mapping of data.mappings) {
      tracker.mappings.set(mapping.name, {
        generated: mapping.generated,
        original: mapping.original,
        name: mapping.name,
      });
    }

    return tracker;
  }
}

/**
 * Serialized source map format for storage/transmission.
 */
export interface SerializedSourceMap {
  /** Version of the serialization format */
  readonly version: 1;
  /** Array of serialized mappings */
  readonly mappings: readonly SerializedMapping[];
}

/**
 * A single serialized mapping.
 */
export interface SerializedMapping {
  /** The hoisted declaration name */
  readonly name: string;
  /** Position in generated code */
  readonly generated: SourcePosition;
  /** Position in original source */
  readonly original: SourcePosition;
}

/**
 * Utility to detect if an identifier in generated code is a hoisted declaration
 * by checking the naming pattern.
 *
 * @param identifier - The identifier to check
 * @returns True if it matches the hoisted naming pattern
 */
export function isHoistedIdentifierPattern(identifier: string): boolean {
  return /^__(?:lift|handler|derive)_\d+$/.test(identifier);
}

/**
 * Extract the type from a hoisted identifier name.
 *
 * @param identifier - The hoisted identifier (e.g., "__lift_0")
 * @returns The type ("lift", "handler", or "derive"), or undefined if not a valid pattern
 */
export function extractHoistedType(
  identifier: string,
): "lift" | "handler" | "derive" | undefined {
  const match = identifier.match(/^__(lift|handler|derive)_\d+$/);
  return match?.[1] as "lift" | "handler" | "derive" | undefined;
}
