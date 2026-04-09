
## CTS (Common Fabric TypeScript)

TypeScript types are automatically processed at runtime. CTS transforms are
enabled by default:

```typescript
import { pattern, UI, NAME } from "commonfabric";
```

CTS provides:
- Runtime type validation
- Automatic schema generation (for `generateObject<T>`)
- Serialization support

Use `/// <cf-disable-transform />` on the first non-empty line only when you
need to opt out of CTS transforms for a file.
