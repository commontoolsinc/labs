
## CTS (CommonTools TypeScript)

TypeScript types are automatically processed at runtime. Enable with:

```typescript
/// <cts-enable />
import { pattern, UI, NAME } from "commontools";
```

CTS provides:
- Runtime type validation
- Automatic schema generation (for `generateObject<T>`)
- Serialization support
