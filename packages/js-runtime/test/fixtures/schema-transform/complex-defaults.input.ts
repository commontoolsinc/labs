/// <cts-enable />
import { toSchema, Default } from "@commontools/builder/interface";

// Test array defaults
interface TodoItem {
  title: string;
  done: boolean;
}

interface WithArrayDefaults {
  // Empty array default
  emptyItems: Default<TodoItem[], []>;
  
  // Array with default items
  prefilledItems: Default<string[], ["item1", "item2"]>;
  
  // Nested array default
  matrix: Default<number[][], [[1, 2], [3, 4]]>;
}

// Test object defaults
interface WithObjectDefaults {
  // Object with default values
  config: Default<{ theme: string; count: number }, { theme: "dark", count: 10 }>;
  
  // Nested object default
  user: Default<{
    name: string;
    settings: {
      notifications: boolean;
      email: string;
    };
  }, {
    name: "Anonymous",
    settings: {
      notifications: true,
      email: "user@example.com"
    }
  }>;
}

// Test null/undefined defaults
interface WithNullDefaults {
  nullable: Default<string | null, null>;
  undefinable: Default<string | undefined, undefined>;
}

// Generate schemas
export const arrayDefaultsSchema = toSchema<WithArrayDefaults>();
export const objectDefaultsSchema = toSchema<WithObjectDefaults>();
export const nullDefaultsSchema = toSchema<WithNullDefaults>();