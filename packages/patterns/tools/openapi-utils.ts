/**
 * Shared utilities for the OpenAPI importer-generation pipeline.
 *
 * @module
 */

/**
 * Convert a kebab-case or snake_case slug to PascalCase.
 *
 * @example toPascalCase("my-api")   // "MyApi"
 * @example toPascalCase("my_api")   // "MyApi"
 */
export function toPascalCase(slug: string): string {
  return slug
    .split(/[-_]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}
