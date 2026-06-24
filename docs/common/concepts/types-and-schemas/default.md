## Defaults

**Use `Default<>` for any field that will be displayed in UI or used in computations.** Without a default, fields are `undefined` at runtime until data is explicitly set—causing errors like `Cannot read properties of undefined` when your pattern tries to render or compute.

Specify default values in schemas:

```typescript
import { Default } from "commonfabric";

interface TodoItem {
  title: string;                      // Required
  done: boolean | Default<false>;      // Defaults to false
  category: string | Default<"Other">; // Defaults to "Other"
}

interface Input {
  items: TodoItem[] | Default<[]>;     // Defaults to empty array
}
```

Use `T | Default<Value>` when the default value is narrower than the runtime type:

```typescript
// Shown at module scope.
interface ProfileInput {
  displayName: string | Default<"">;
  avatarUrl: string | null | Default<null>;
}
```

For object defaults, use `T | Default<Value>` when the default value is a valid
`T`. Use `T | DeepDefault<Value>` when you only want to list part of an object
and have defaults applied recursively to the listed properties:

```typescript
import { DeepDefault } from "commonfabric";

interface Settings {
  theme: string;
  profile: {
    displayName: string;
    email: string;
  };
}

interface SettingsInput {
  settings: Settings | DeepDefault<{
    theme: "light";
    profile: { displayName: "" };
  }>;
}
```

### Writable<> with Default<>

When you need **both** a default value **and** write access (`.push()`, `.set()`, `.get()`), wrap the defaulted type inside `Writable<>`:

```typescript
// Shown at module scope.
import { Default, Writable } from "commonfabric";

interface Board {
  title: string | Default<"My Board">;
  // ❌ Writable<Column[]> - no default, will be undefined at runtime
  // ❌ Column[] | Default<[]> - has default but no .push()/.set() methods
  // ✅ Writable<Column[] | Default<[]>> - has both default AND write methods
  columns: Writable<Column[] | Default<[]>>;
}
```

This is the most common pattern for mutable arrays in schemas.
