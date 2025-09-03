/// <cts-enable />
import { toSchema, Cell, Default, recipe } from "commontools";

// Test basic Default type transformation
interface UserSettings {
  theme: Default<string, "dark">;
  fontSize: Default<number, 16>;
  notifications: Default<boolean, true>;
}

const settingsSchema = toSchema<UserSettings>();

// Test nested Default types
interface AppConfig {
  user: {
    name: string;
    settings: {
      language: Default<string, "en">;
      timezone: Default<string, "UTC">;
    };
  };
  features: {
    darkMode: Default<boolean, false>;
    autoSave: Default<boolean, true>;
  };
}

const appConfigSchema = toSchema<AppConfig>();

// Test Default with arrays
interface ListConfig {
  items: Default<string[], ["item1", "item2"]>;
  selectedIndices: Default<number[], [0]>;
}

const listConfigSchema = toSchema<ListConfig>();

// Test Default with objects
interface ComplexDefault {
  metadata: Default<{ version: number; author: string }, { version: 1, author: "system" }>;
  config: Default<{ enabled: boolean; value: number }, { enabled: true, value: 100 }>;
}

const complexDefaultSchema = toSchema<ComplexDefault>();

// Test Default with Cell types
interface CellDefaults {
  counter: Cell<Default<number, 0>>;
  messages: Cell<Default<string[], []>>;
}

const cellDefaultsSchema = toSchema<CellDefaults>();

// Test optional properties with Default
interface OptionalWithDefaults {
  requiredField: string;
  optionalWithDefault?: Default<string, "default value">;
  nestedOptional?: {
    value?: Default<number, 42>;
  };
}

const optionalDefaultsSchema = toSchema<OptionalWithDefaults>();

// Add a recipe export for ct dev testing
export default recipe("Default Type Test", () => {
  return {
    schema: settingsSchema,
  };
});
