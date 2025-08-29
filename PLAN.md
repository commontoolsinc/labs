# Tool Calling Implementation Plan

## Overview
Add tool calling support to the LLM system following AI SDK best practices. Tools will be defined in recipes, passed to the server, and executed client-side through a structured streaming protocol.

## Architecture Summary

The implementation follows AI SDK's client-side tool execution pattern:

1. **Recipe** defines tools with handlers
2. **Runner** extracts tool schemas, executes handlers locally
3. **Server** receives tool schemas (without handlers), uses AI SDK
4. **AI SDK** generates tool calls, streams them to client
5. **Client** receives tool calls, executes handlers, sends results back
6. **Server** receives results, continues conversation with AI SDK

## Phase 1: Type System & API Contracts

### 1.1 Extend LLM Types (`packages/llm/src/types.ts`)

Add tool-related interfaces:

```typescript
export interface LLMTool {
  description: string;
  inputSchema: JSONSchema;
  handler?: (args: any) => any | Promise<any>; // Client-side only
}

export interface LLMToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface LLMToolResult {
  toolCallId: string;
  result: any;
  error?: string;
}
```

Update `LLMMessage` to support tool calls/results:

```typescript
export type LLMMessage = {
  role: "user" | "assistant" | "tool";
  content: LLMContent;
  toolCalls?: LLMToolCall[];
  toolCallId?: string; // for tool result messages
};
```

Add tools to `LLMRequest`:

```typescript
export interface LLMRequest {
  // ... existing fields
  tools?: Record<string, LLMTool>;
}
```

### 1.2 Update API Interface (`packages/api/index.ts`)

Add tools to the built-in params:

```typescript
export interface BuiltInLLMParams {
  // ... existing fields
  tools?: Record<string, LLMTool>;
}
```

### 1.3 Update Server Routes (`packages/toolshed/routes/ai/llm/llm.routes.ts`)

- Add tools field to `LLMRequestSchema`
- Update `MessageSchema` to support tool calls/results
- Add new endpoint for tool result submission: `/api/ai/llm/tool-result`

## Phase 2: Server-Side Implementation

### 2.1 Enhance Generate Text Handler (`packages/toolshed/routes/ai/llm/generateText.ts`)

**Tool Schema Conversion:**
```typescript
const aiSdkTools: Record<string, any> = {};
for (const [name, tool] of Object.entries(params.tools || {})) {
  aiSdkTools[name] = {
    description: tool.description,
    inputSchema: convertJSONSchemaToZod(tool.inputSchema),
    // NO execute function - makes it client-side
  };
}
```

**Enhanced Streaming:**
- Handle tool calls from AI SDK
- Stream tool calls to client using AI SDK's standard format
- Wait for tool results before continuing conversation

**New Tool Result Endpoint:**
```typescript
POST /api/ai/llm/tool-result
{
  toolCallId: string,
  result: any,
  error?: string,
  requestId: string
}
```

### 2.2 AI SDK Integration Changes

- Use AI SDK's client-side tool calling pattern
- Handle `tool-input-start`, `tool-input-delta`, `tool-input-available` messages
- Support conversation continuation after tool execution

## Phase 3: Client-Side Implementation

### 3.1 Enhance LLM Client (`packages/llm/src/client.ts`)

**Tool Call Handling:**
```typescript
private handleToolCallMessage(message: any) {
  // Parse tool call from stream
  // Execute local tool handler
  // Send result back to server
}

async sendToolResult(toolResult: LLMToolResult) {
  // POST to /api/ai/llm/tool-result
}
```

**Enhanced Streaming Protocol:**
- Parse tool-related stream messages
- Coordinate with tool execution

### 3.2 Update LLM Built-in (`packages/runner/src/builtins/llm.ts`)

**Tool Handler Management:**
```typescript
const handleToolCall = async (toolCall: LLMToolCall) => {
  const tool = tools[toolCall.name];
  if (tool?.handler) {
    try {
      const result = await tool.handler(toolCall.arguments);
      await client.sendToolResult({
        toolCallId: toolCall.id,
        result,
      });
    } catch (error) {
      await client.sendToolResult({
        toolCallId: toolCall.id,
        result: null,
        error: error.message,
      });
    }
  }
};
```

**Enhanced State Management:**
- Track tool execution state
- Handle multiple concurrent tool calls
- Manage conversation history with tool calls/results

## Phase 4: User-Facing API

### 4.1 Recipe Integration (`packages/patterns/chat.tsx`)

Update example to demonstrate tool usage:

```typescript
const askQuestion = async ({ question }: { question: string }) => {
  // Example tool handler
  return `You asked: ${question}`;
};

const llmResponse = llm({
  messages: chat,
  tools: {
    askQuestion: {
      description: "Ask the LLM a question",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string" }
        },
        required: ["question"]
      },
      handler: askQuestion,
    },
  },
});
```

### 4.2 Builder Integration (`packages/runner/src/builder/built-in.ts`)

Ensure tool types are properly exposed in the TypeScript definitions.

## Phase 5: Enhanced Features

### 5.1 Error Handling

**Tool Execution Errors:**
- Handler throws exception → send error in tool result
- Invalid tool calls → graceful degradation
- Network failures → retry logic

**Error Types:**
```typescript
export class ToolExecutionError extends Error {
  constructor(
    public toolCallId: string,
    public toolName: string,
    message: string,
    public cause?: Error
  ) {
    super(message);
  }
}
```

### 5.2 Tool Result Display (Future Enhancement)

- UI components for showing tool calls in progress
- Display tool results in conversation
- Error states and retry mechanisms

### 5.3 Advanced Features

- **Multi-step tool calls:** Support tools that call other tools
- **Tool validation:** Runtime validation of tool inputs/outputs
- **Tool permissions:** Security model for tool access
- **Tool streaming:** Stream tool results as they're generated

## Phase 6: Testing & Documentation

### 6.1 Testing Strategy

**Unit Tests:**
- Tool schema conversion
- Tool call parsing
- Error handling scenarios

**Integration Tests:**
- Full tool calling flow
- Multiple tools in single conversation
- Tool execution errors
- Network failure scenarios

**Example Test Cases:**
```typescript
describe('Tool Calling', () => {
  test('basic tool call execution', async () => {
    const mathTool = {
      description: 'Perform math operations',
      inputSchema: { /* schema */ },
      handler: ({ a, b }) => a + b
    };
    
    const response = await llm({
      messages: ['What is 5 + 3?'],
      tools: { math: mathTool }
    });
    
    expect(response.result).toContain('8');
  });
});
```

### 6.2 Documentation

**API Documentation:**
- Tool definition format
- Handler function signature
- Error handling patterns

**Developer Guide:**
- Creating custom tools
- Best practices for tool design
- Security considerations

**Example Recipes:**
- Math calculator with tools
- Weather app with API calls
- File operations with tools

## Implementation Order & Dependencies

### Phase 1: Foundation (Types & Contracts)
**Dependencies:** None  
**Duration:** 1-2 days  
**Critical Path:** Yes - Everything depends on these types

### Phase 2: Server Implementation 
**Dependencies:** Phase 1  
**Duration:** 2-3 days  
**Critical Path:** Yes - Client needs server endpoints

### Phase 3: Client Implementation
**Dependencies:** Phase 1, Phase 2  
**Duration:** 2-3 days  
**Critical Path:** Yes - Core functionality

### Phase 4: User-Facing API
**Dependencies:** Phase 1, Phase 3  
**Duration:** 1 day  
**Critical Path:** No - Can be done in parallel with Phase 5

### Phase 5: Enhanced Features
**Dependencies:** Phase 3  
**Duration:** 2-3 days  
**Critical Path:** No - Polish features

### Phase 6: Testing & Documentation
**Dependencies:** All phases  
**Duration:** 2-3 days  
**Critical Path:** No - Can be done incrementally

**Total Estimated Duration:** 10-15 days

## Key Design Decisions & Rationale

### 1. Client-Side Tool Execution
**Decision:** Execute tools in the recipe/runner environment  
**Rationale:** 
- Security: Prevents arbitrary code execution on server
- Flexibility: Tools can access local state and APIs
- AI SDK Compatibility: Follows recommended pattern

### 2. Streaming Protocol Extension
**Decision:** Extend existing streaming for tool coordination  
**Rationale:**
- Consistency: Reuses existing infrastructure
- Performance: No additional connection overhead
- AI SDK Native: Uses their standard tool streaming format

### 3. JSONSchema for Tool Definitions
**Decision:** Use JSONSchema for tool input validation  
**Rationale:**
- Consistency: Already used throughout the codebase
- Validation: Runtime input validation
- AI SDK Compatibility: Easy conversion to Zod

### 4. Async Tool Handlers
**Decision:** Support both sync and async tool handlers  
**Rationale:**
- Flexibility: Supports both simple and complex tools
- Real-world Usage: Many tools need async operations (API calls, file I/O)
- Future Proof: Enables streaming tool results

## Security Considerations

### Tool Handler Isolation
- Tools run in recipe sandbox environment
- No direct server access from tool handlers
- Input/output validation on both ends

### Input Validation
- Server validates tool schemas before sending to AI SDK
- Client validates tool inputs before execution
- Runtime type checking for tool results

### Error Information Leakage
- Sanitize error messages before sending to server
- Don't expose internal system information in tool errors
- Log detailed errors locally, send generic messages

## Performance Considerations

### Tool Execution Overhead
- Minimize serialization between client/server
- Cache tool schemas to avoid repeated validation
- Support tool execution timeouts

### Streaming Optimization
- Batch tool results when multiple tools execute
- Stream tool execution progress for long-running tools
- Implement connection keepalive during tool execution

### Memory Management
- Clean up tool execution state after completion
- Limit concurrent tool executions
- Implement tool result size limits

## Files to Create/Modify

### New Files
- `PLAN.md` (this file)
- Tests for tool calling functionality

### Modified Files

#### Core Types
- `packages/llm/src/types.ts` - Add tool interfaces
- `packages/api/index.ts` - Add tools to built-in params

#### Server Implementation  
- `packages/toolshed/routes/ai/llm/generateText.ts` - Tool call handling
- `packages/toolshed/routes/ai/llm/llm.routes.ts` - API schema updates
- `packages/toolshed/routes/ai/llm/llm.handlers.ts` - New tool result endpoint

#### Client Implementation
- `packages/llm/src/client.ts` - Tool call streaming and results
- `packages/runner/src/builtins/llm.ts` - Tool execution logic

#### User Interface
- `packages/patterns/chat.tsx` - Tool usage example
- `packages/runner/src/builder/built-in.ts` - Type exports

## Success Criteria

### Functional Requirements
✅ Tools can be defined in recipes with handlers  
✅ Tool calls are generated by AI SDK and executed client-side  
✅ Tool results are integrated back into conversation  
✅ Multiple tools can be used in single conversation  
✅ Streaming continues to work with tool calls  
✅ Error handling works for tool failures  

### Non-Functional Requirements  
✅ Performance impact < 10% for non-tool conversations  
✅ Tool execution latency < 2 seconds for simple tools  
✅ Memory usage growth < 50MB during tool execution  
✅ 95% test coverage for tool calling code paths  

### User Experience Requirements
✅ Tool calls are visible in conversation UI  
✅ Tool execution progress is indicated  
✅ Tool errors are displayed clearly  
✅ Tool definitions are easy to write  

This plan ensures we deliver a robust, secure, and performant tool calling system that follows AI SDK best practices while meeting the specific needs of the CommonTools architecture.