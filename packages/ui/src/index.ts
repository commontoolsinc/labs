/**
 * Common UI Web Components Library
 *
 * Main entry point that provides access to both v1 and v2 components
 */

// Export v1 and v2 as namespaces
export * as v1 from "./v1/index.ts";
export * as v2 from "./v2/index.ts";

// Export v2 as default (new components)
export * from "./v2/index.ts";
