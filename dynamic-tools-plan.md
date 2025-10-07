# Dynamic Tool Extraction from Attached Charms - Implementation Plan

**Date:** 2025-10-07
**Goal:** Allow LLMs to access handlers/streams from @-mentioned charms as callable tools

---

## Current State

### ✅ What Works
- Attachments flow from ct-prompt-input → chatbot pattern
- `allAttachments` cell grows with each message
- Attachments rendered as chips in chatbot header
- Mention-type attachments include full charm references

### ❌ What's Missing
- LLM cannot call handlers from attached charms
- Tools are static - defined at recipe creation time
- No way to dynamically expose charm capabilities

---

## Design Decision: Enhance LLMToolSchema

**Key Insight:** Instead of pre-processing charms externally, let `llm-dialog.ts` built-in accept **whole charms** as tool values and introspect them internally.

### Why This Approach?

1. **Better encapsulation** - Tool extraction logic lives with tool execution logic
2. **Access to internals** - Built-in code has full access to Cell/Stream APIs
3. **Simpler external API** - Patterns just pass charm refs, no complex formatting
4. **Consistent behavior** - Same code handles static tools + dynamic charm tools

---

## Architecture

### Current Tool Schema (llm-dialog.ts:61-85)

```typescript
const LLMToolSchema = {
  type: "object",
  properties: {
    description: { type: "string" },
    inputSchema: { type: "object" },
    handler: { asStream: true },      // For handlers
    pattern: { asCell: true },        // For recipes
  },
  required: ["description"],
}
```

### Proposed Enhancement

Add a new `charm` property to `LLMToolSchema`:

```typescript
const LLMToolSchema = {
  type: "object",
  properties: {
    description: { type: "string" },
    inputSchema: { type: "object" },
    handler: { asStream: true },
    pattern: { asCell: true },
    charm: { asCell: true },          // NEW: Accept whole charm
  },
  required: [], // Nothing required - one of handler/pattern/charm must exist
}
```

### Tool Processing Flow

**Location:** `startRequest()` in llm-dialog.ts:414-445

**Current code:**
```typescript
const toolsWithSchemas = Object.fromEntries(
  Object.entries(toolsCell.get() ?? {}).map(([name, tool]) => {
    const pattern = tool.pattern?.get();
    const handler = tool.handler;
    let inputSchema = pattern?.argumentSchema ?? handler?.schema;
    // ... build tool definition
  })
);
```

**Enhanced code:**
```typescript
const toolsWithSchemas = Object.fromEntries(
  Object.entries(toolsCell.get() ?? {}).flatMap(([name, tool]) => {
    // Existing: handler or pattern tool
    if (tool.handler || tool.pattern) {
      const pattern = tool.pattern?.get();
      const handler = tool.handler;
      let inputSchema = pattern?.argumentSchema ?? handler?.schema;
      // ... existing logic
      return [[name, { description, inputSchema }]];
    }

    // NEW: charm tool - extract all handlers
    if (tool.charm) {
      const charm = tool.charm.get();
      const charmName = charm[NAME] || name;
      const handlers = [];

      // Iterate charm's top-level keys
      for (const [key, value] of Object.entries(charm)) {
        // Skip special keys
        if (key.startsWith('$') || [NAME, UI, ID].includes(key)) continue;

        // Check if value is a Stream (has $stream marker or send method)
        if (isStreamValue(value)) {
          const handler = value;
          const inputSchema = handler?.schema || { type: "object" };
          const description = tool.description
            ? `${tool.description} - ${key}`
            : `${key} handler from ${charmName}`;

          handlers.push([
            `${charmName}.${key}`,
            { description, inputSchema, handler }
          ]);
        }
      }

      return handlers;
    }

    logger.warn(`Tool ${name} has no handler, pattern, or charm`);
    return [];
  })
);
```

---

## Implementation Plan

### Phase 1: Enhance LLMToolSchema ✅
**File:** `packages/runner/src/builtins/llm-dialog.ts:61-85`

**Tasks:**
1. Add `charm: { asCell: true }` property to LLMToolSchema
2. Update schema requirements (make description optional when charm provided)
3. Add JSDoc explaining charm-based tools

### Phase 2: Tool Extraction Logic ✅
**File:** `packages/runner/src/builtins/llm-dialog.ts:414-445`

**Tasks:**
1. Detect `tool.charm` in tool processing
2. Iterate charm's keys looking for Streams
3. Generate tool entries for each handler found
4. Use naming convention: `${charmName}.${handlerName}`

**Helper needed:**
```typescript
function isStreamValue(value: unknown): boolean {
  return (
    isObject(value) &&
    ('$stream' in value || 'send' in value)
  );
}
```

### Phase 3: Tool Invocation ✅
**File:** `packages/runner/src/builtins/llm-dialog.ts:168-207`

**Tasks:**
1. Update `invokeToolCall` to handle charm-extracted handlers
2. Store handler reference during extraction phase
3. Invoke using existing handler invocation path

**Challenge:** Need to preserve handler reference from extraction to invocation.

**Solution:** Expand `toolsWithSchemas` to include handler refs:
```typescript
const toolsWithMetadata = Object.fromEntries(
  Object.entries(toolsCell.get() ?? {}).flatMap(([name, tool]) => {
    // ... extraction logic ...
    return [[toolName, {
      description,
      inputSchema,
      _handler: handler  // Keep reference for invocation
    }]];
  })
);
```

### Phase 4: Update Chatbot Pattern ✅
**File:** `packages/patterns/chatbot.tsx:155-160`

**Tasks:**
1. Derive tools from attachments
2. Create charm-tool entries
3. Merge with static tools

**New code:**
```typescript
const dynamicTools = derive(allAttachments, (attachments) => {
  const tools: Record<string, any> = {};

  for (const attachment of attachments) {
    if (attachment.type === "mention" && attachment.charm) {
      const charmName = attachment.charm[NAME] || "Charm";
      tools[charmName] = {
        charm: attachment.charm,
        description: `Handlers from ${charmName}`
      };
    }
  }

  return tools;
});

const mergedTools = derive([tools, dynamicTools], (static, dynamic) => ({
  ...static,
  ...dynamic
}));

llmDialog({
  system: "You are a helpful assistant with some tools.",
  messages,
  tools: mergedTools,  // Now includes charm tools!
  model,
});
```

---

## Open Questions & Decisions

### 1. Tool Naming Convention
**Question:** How should extracted handlers be named?

**Options:**
- `${charmName}.${handlerName}` ← **RECOMMENDED**
- `${handlerName}` (risk of collisions)
- `charm_${charmName}_${handlerName}`

**Decision:** Use dot notation for clarity and namespace separation.

### 2. Description Handling
**Question:** How to generate descriptions for auto-extracted handlers?

**Options:**
- Use handler schema description if available
- Generate from handler name: `"${key} handler from ${charmName}"`
- Allow charm-level description prefix

**Decision:** Prioritize schema description, fallback to generated description.

### 3. Handler Schema Extraction
**Question:** How to get `inputSchema` from Stream/handler?

**Current:** Handlers have `.schema` property (from research)

**Validation needed:** Confirm all handlers expose schema, or provide fallback.

### 4. Cell Reading (Future)
**Question:** Should we also expose cells as read-only tools?

**Decision:** Phase 2 feature. Start with Streams only.

### 5. Duplicate Handler Names
**Question:** What if multiple charms have the same handler name?

**Solution:** Dot notation (`charm1.addNote` vs `charm2.addNote`) naturally prevents collisions.

---

## Testing Strategy

### Unit Tests
**File:** `packages/runner/src/builtins/llm-dialog.test.ts` (create if missing)

Test cases:
1. Charm with single handler extracts correctly
2. Charm with multiple handlers extracts all
3. Charm with no handlers extracts nothing
4. Tool naming follows convention
5. Handler invocation works for charm-extracted tools

### Integration Tests
**File:** `packages/patterns/chatbot.test.tsx` (create if missing)

Test cases:
1. @-mention charm → tools appear in llmDialog
2. LLM calls charm handler → handler executes
3. Handler result flows back to conversation
4. Multiple mentions → multiple tool sets

### Manual Testing
1. Create test charm with simple handler (e.g., `addNote`)
2. @-mention charm in chatbot
3. Ask LLM to use the handler
4. Verify handler executes and result appears in chat

---

## Success Criteria

- [ ] LLMToolSchema accepts `charm` property
- [ ] llm-dialog extracts handlers from charm tools
- [ ] Extracted tools appear in LLM's tool list
- [ ] LLM can successfully invoke charm handlers
- [ ] Handler results flow back to conversation
- [ ] Multiple charms can be mentioned simultaneously
- [ ] Tool naming prevents collisions

---

## Implementation Notes

### Stream Detection
From `packages/runner/src/builder/types.ts:8`:
```typescript
export function isStreamValue(value: unknown): boolean {
  // Check for $stream marker OR send method
}
```

This utility should be used for reliable Stream detection.

### Handler Schema Access
From research - handlers expose `.schema` property directly.
Verify this in implementation phase.

### Metadata Preservation
Challenge: `toolsWithSchemas` only sends description + inputSchema to LLM.
Need to preserve handler reference for invocation phase.

**Solution:** Create parallel structure or expand metadata.

---

## Future Enhancements (Not in Scope)

1. **Cell Reading Tools** - Expose cells as read-only getters
2. **Recursive Charm Introspection** - Handle nested charms
3. **Tool Filtering** - Allow charms to mark handlers as private
4. **Schema Inference** - Generate schemas from handler signatures
5. **Tool Categories** - Group tools by charm/category in UI

---

## Migration & Backwards Compatibility

### Existing Code
All existing tools continue to work - we're adding a new path, not changing existing ones.

### New Code
Patterns can gradually adopt charm-based tools:
```typescript
// Old style - still works
tools: {
  myHandler: { handler: myStream, description: "..." }
}

// New style - charm-based
tools: {
  MyCharm: { charm: charmRef, description: "..." }
}
```

---

## References

- `packages/runner/src/builtins/llm-dialog.ts` - LLM dialog built-in
- `packages/api/index.ts` - Public API types (Stream, Cell, Handler)
- `packages/patterns/chatbot.tsx` - Current chatbot implementation
- `/Users/ben/code/labs/snapshot.md` - Attachments feature implementation

---

## Next Steps

1. **Review this plan** - Ensure design aligns with architecture
2. **Prototype extraction** - Test Stream detection in llm-dialog
3. **Implement in phases** - Start with simple single-handler case
4. **Test thoroughly** - Both unit and integration tests
5. **Document** - Update public API docs for charm-based tools
