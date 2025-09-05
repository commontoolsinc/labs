# CT-859: Full Implementation Plan - Vercel AI SDK Message Format

## Current State Analysis
The current implementation uses a hybrid approach where:
- Tool calls are attached to assistant messages as `toolCalls` array
- Tool results are attached to the same assistant message as `toolResults` array  
- Messages are temporarily converted in `generateText.ts` by appending tool results as text

## Target State (Vercel AI SDK v4+ Format)
According to the Vercel AI SDK documentation:
- **Assistant messages** contain `content` that can include `ToolCallPart` objects
- **Tool messages** have `role: "tool"` and contain `ToolResultPart` objects
- Clean separation between tool calls and results

## Implementation Plan

### 1. Update Type Definitions
**Files to modify:**
- `packages/api/index.ts`
- `packages/llm/src/types.ts`

**Changes:**
```typescript
// New content types matching Vercel AI SDK
export interface BuiltInLLMToolCallPart {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  args: Record<string, any>;
}

export interface BuiltInLLMToolResultPart {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  result: any;
  error?: string;
}

export interface BuiltInLLMTextPart {
  type: 'text';
  text: string;
}

// Update message content to support arrays
export type BuiltInLLMContent = 
  | string 
  | Array<BuiltInLLMTextPart | BuiltInLLMToolCallPart | BuiltInLLMToolResultPart>;

// Remove toolCalls and toolResults from message type
export type BuiltInLLMMessage = {
  role: "user" | "assistant" | "tool";
  content: BuiltInLLMContent;
  // Remove: toolCalls?, toolResults?
};
```

### 2. Update llm-dialog.ts Message Construction
**File:** `packages/runner/src/builtins/llm-dialog.ts`

**Changes:**
- When LLM returns tool calls, create assistant message with tool-call content parts
- Create separate tool messages with tool-result content parts
- Structure like:

```typescript
// Assistant message with tool calls
{
  role: "assistant",
  content: [
    { type: "text", text: "Let me search for that..." },
    { type: "tool-call", toolCallId: "call_1", toolName: "search_web", args: {...} }
  ]
}

// Tool result message
{
  role: "tool",
  content: [
    { type: "tool-result", toolCallId: "call_1", toolName: "search_web", result: {...} }
  ]
}
```

### 3. Update generateText.ts Message Processing
**File:** `packages/toolshed/routes/ai/llm/generateText.ts`

**Changes:**
- Convert incoming messages to CoreMessage format properly
- Handle assistant messages with tool-call content parts
- Convert tool messages to proper format for Vercel AI SDK
- Remove the temporary text-appending workaround

```typescript
const messages = params.messages.map((message) => {
  if (message.role === "assistant" && Array.isArray(message.content)) {
    // Extract tool calls from content array
    const toolCalls = message.content
      .filter(part => part.type === 'tool-call')
      .map(part => ({
        type: 'tool-call',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        args: part.args
      }));
    // Return formatted assistant message
  }
  
  if (message.role === "tool" && Array.isArray(message.content)) {
    // Format tool message for Vercel AI SDK
    return {
      role: 'tool',
      content: message.content.map(part => ({
        type: 'tool-result',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        result: part.result
      }))
    };
  }
  
  // Handle other message types
});
```

### 4. Update UI Component for Tool Messages
**File:** `packages/ui/src/v2/components/ct-chat-message/ct-chat-message.ts`

**Changes:**
- Add support for `role="tool"`
- Parse content arrays properly
- Display tool results distinctly from assistant messages
- Add styling for tool messages

```typescript
// Add to properties
role: { type: String, reflect: true }, // now includes "tool"

// Render logic
if (this.role === 'tool' && Array.isArray(this.content)) {
  // Render tool results
  const toolResults = this.content.filter(p => p.type === 'tool-result');
  // Display each result with proper formatting
}
```

### 5. Update LLM Response Handling
**File:** `packages/runner/src/builtins/llm-dialog.ts` (lines 220-280)

**Changes:**
- Parse LLM response to extract tool calls
- Create assistant message with tool-call content parts
- Execute tools and create separate tool messages
- Properly accumulate messages for continuation

## Migration Strategy

1. **Phase 1**: Update type definitions to support both old and new formats
2. **Phase 2**: Modify llm-dialog.ts to create proper message structure
3. **Phase 3**: Update generateText.ts to handle new format
4. **Phase 4**: Update UI to display tool messages
5. **Phase 5**: Remove backward compatibility code

## Testing Plan

1. Test single tool call works with new format
2. Test multiple sequential tool calls (search → read)
3. Test error handling in tool execution
4. Verify UI displays all message types correctly
5. Test with different LLM providers (Anthropic, OpenAI, Groq)

## Benefits

- **Standards Compliance**: Aligns with Vercel AI SDK v4+ specification
- **Cleaner Architecture**: Separates concerns between tool calls and results
- **Better Debugging**: Tool results are clearly separated in conversation history
- **Future-Proof**: Compatible with upcoming Vercel AI SDK features
- **Improved UI**: Users can see distinct tool result messages

## Current Progress

### Completed
- ✅ Added `read_webpage` tool to chat-tools.tsx
- ✅ Implemented basic chained tool calls support (recursive mainLogic)
- ✅ Modified generateText.ts to preserve tool results (temporary solution)

### TODO
- [ ] Update type definitions to match Vercel AI SDK format
- [ ] Refactor llm-dialog.ts to create proper message structure
- [ ] Update generateText.ts to handle new message format
- [ ] Update ct-chat-message component to render tool messages
- [ ] Remove temporary workarounds
- [ ] Comprehensive testing

## Key Files

1. **Type Definitions**
   - `/packages/api/index.ts` - BuiltInLLMMessage types
   - `/packages/llm/src/types.ts` - LLMMessage types

2. **Core Logic**
   - `/packages/runner/src/builtins/llm-dialog.ts` - Message handling and tool execution
   - `/packages/toolshed/routes/ai/llm/generateText.ts` - Vercel AI SDK integration

3. **UI Components**
   - `/packages/ui/src/v2/components/ct-chat-message/ct-chat-message.ts` - Message rendering
   - `/packages/patterns/chat-tools.tsx` - Tool definitions

4. **API Endpoints**
   - `/packages/toolshed/routes/agent-tools/web-search/` - Web search tool
   - `/packages/toolshed/routes/agent-tools/web-read/` - Web content reader tool

## Notes

The current implementation works but doesn't follow Vercel AI SDK standards. The full implementation will:
- Properly separate tool calls and results into different messages
- Use the standard `role: "tool"` for tool result messages
- Support the content array format with typed parts
- Enable better debugging and cleaner conversation history