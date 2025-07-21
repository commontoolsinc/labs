# Schema Transformer Test Review

## Current Issues

### 1. **Broken Optional Property Handling**
The `arrays-optional.expected.ts` file shows that optional properties are incorrectly transformed:
```typescript
done?: boolean  // Input
```
Becomes:
```typescript
done: {
  oneOf: [{
    type: "undefined"
  }, {
    type: "any"
  }, {
    type: "any"
  }]
}
```

This suggests the union type handling in the transformer is broken. The code at lines 217-224 of schema.ts is supposed to handle this case but isn't working correctly.

### 2. **Missing Test Coverage**
Two fixtures exist but aren't being tested:
- `type-to-schema.input.ts` / `expected.ts` - Complex test with nested types, dates, arrays
- `recipe-with-types.input.tsx` / `expected.tsx` - Real-world example with inheritance

### 3. **Inconsistent Test Approach**
Most tests use `compareFixtureTransformation` but the "no directive" test uses the compiler directly. This is actually correct since it needs to verify the transformation DOESN'T happen.

## Recommended Test Cases to Add

### Essential TypeScript Types
1. **Union Types** (not just optional)
   ```typescript
   type Status = "active" | "inactive" | "pending";
   type Value = string | number;
   ```

2. **Literal Types**
   ```typescript
   type Direction = "north" | "south" | "east" | "west";
   const PI = 3.14 as const;
   ```

3. **Enum Types**
   ```typescript
   enum Color { Red, Green, Blue }
   enum StringEnum { A = "a", B = "b" }
   ```

4. **Tuple Types**
   ```typescript
   type Point = [number, number];
   type NameAge = [string, number];
   ```

5. **Intersection Types**
   ```typescript
   type A = { a: string };
   type B = { b: number };
   type C = A & B;
   ```

6. **Index Signatures**
   ```typescript
   interface StringMap {
     [key: string]: string;
   }
   ```

7. **Nullable Types**
   ```typescript
   type MaybeString = string | null;
   type MaybeNumber = number | null | undefined;
   ```

### Edge Cases
1. **Empty Interface**
   ```typescript
   interface Empty {}
   ```

2. **Nested Generics**
   ```typescript
   type NestedCell = Cell<Cell<number>>;
   type CellStream = Cell<Stream<string>>;
   ```

3. **Recursive Types** (should probably error)
   ```typescript
   interface TreeNode {
     value: string;
     children: TreeNode[];
   }
   ```

4. **Function Types** (should error or have special handling)
   ```typescript
   interface WithCallback {
     onClick: () => void;
   }
   ```

### Error Cases
1. **Missing Type Arguments**
   ```typescript
   const schema = toSchema(); // No type argument
   ```

2. **Multiple Type Arguments**
   ```typescript
   const schema = toSchema<A, B>(); // Too many
   ```

3. **Invalid Options**
   ```typescript
   const schema = toSchema<User>({ 
     invalidOption: true 
   });
   ```

## Recommendations

1. **Fix the optional property bug first** - The transformer's union handling needs debugging

2. **Add tests for existing fixtures** - `type-to-schema` and `recipe-with-types` should be tested

3. **Create systematic type coverage** - Add fixtures for each TypeScript type category

4. **Add error case tests** - Ensure the transformer fails gracefully

5. **Consider test organization** - Group related tests (e.g., all union type tests together)

6. **Fix the Stream type expected output** - The spreading syntax is awkward and could be cleaner

7. **Document expected behavior** - What should happen with unsupported types like functions?

## Test Priority
1. Fix optional property handling (HIGH - it's broken)
2. Add missing fixture tests (HIGH - they already exist)  
3. Add union/literal type tests (MEDIUM - common use cases)
4. Add enum tests (MEDIUM - common use case)
5. Add edge case tests (LOW - less common)
6. Add error handling tests (LOW - defensive coding)