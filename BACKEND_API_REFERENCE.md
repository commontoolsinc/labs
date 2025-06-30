# Backend API Reference

## Table of Contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [AI Services](#ai-services)
4. [Storage Services](#storage-services)
5. [Identity Services](#identity-services)
6. [Health & Monitoring](#health--monitoring)
7. [Error Handling](#error-handling)
8. [Rate Limiting](#rate-limiting)
9. [WebSocket APIs](#websocket-apis)

## Overview

The Toolshed backend provides a comprehensive set of HTTP APIs for AI services, storage, identity management, and more. All APIs are RESTful and return JSON responses.

### Base URLs
- **Development**: `http://localhost:8000`
- **Production**: `https://toolshed.commontools.dev`

### API Versioning
All APIs are versioned and follow the pattern `/api/{service}/{version}/` where applicable.

### Content Types
- Request bodies should use `Content-Type: application/json`
- Responses return `Content-Type: application/json` unless otherwise specified
- File uploads may use `multipart/form-data`

## Authentication

### Identity-Based Authentication

The system uses identity-based authentication with DID (Decentralized Identifier) keys.

```typescript
// Headers for authenticated requests
{
  "Authorization": "Bearer <did:key:...>",
  "Content-Type": "application/json"
}
```

### Getting Identity Information

**GET** `/api/whoami/`

Returns information about the current authenticated user.

```typescript
// Response
{
  "identity": "did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi",
  "spaces": ["space1", "space2"],
  "permissions": ["read", "write"]
}
```

## AI Services

### Large Language Models (LLM)

#### Get Available Models

**GET** `/api/ai/llm/models`

Retrieve information about available LLM models and their capabilities.

**Query Parameters:**
```typescript
interface GetModelsQuery {
  search?: string;      // Filter models by name
  capability?: string;  // Filter by capability (e.g., "images", "streaming")
  task?: string;       // Filter by task type
}
```

**Response:**
```typescript
type ModelsResponse = Record<string, {
  name: string;
  capabilities: {
    contextWindow: number;
    maxOutputTokens: number;
    streaming: boolean;
    systemPrompt: boolean;
    systemPromptWithImages?: boolean;
    stopSequences: boolean;
    prefill: boolean;
    images: boolean;
  };
  aliases: string[];
}>;
```

**Example:**
```bash
curl "https://toolshed.commontools.dev/api/ai/llm/models?capability=images"
```

```json
{
  "claude-3-5-sonnet": {
    "name": "claude-3-5-sonnet",
    "capabilities": {
      "contextWindow": 200000,
      "maxOutputTokens": 8192,
      "images": true,
      "prefill": true,
      "systemPrompt": true,
      "stopSequences": true,
      "streaming": true
    },
    "aliases": [
      "anthropic:claude-3-5-sonnet-latest",
      "claude-3-5-sonnet"
    ]
  }
}
```

#### Generate Text

**POST** `/api/ai/llm`

Generate text using a language model.

**Request Body:**
```typescript
interface LLMRequest {
  messages: LLMMessage[];
  system?: string;          // System prompt
  model?: string;           // Model identifier
  maxTokens?: number;       // Maximum tokens to generate
  stop?: string;            // Stop sequence
  stream?: boolean;         // Enable streaming response
  mode?: "json";           // Response format mode
  metadata?: Record<string, any>; // Additional metadata
  cache?: boolean;          // Enable response caching (default: true)
}

interface LLMMessage {
  role: "user" | "assistant";
  content: string | LLMTypedContent[];
}

interface LLMTypedContent {
  type: "text" | "image";
  data: string; // Text content or base64 image data
}
```

**Response (Non-streaming):**
```typescript
{
  type: "json",
  body: {
    role: "assistant",
    content: string
  }
}
```

**Response (Streaming):**
```typescript
{
  type: "stream",
  body: ReadableStream<string> // Newline-separated text chunks
}
```

**Examples:**

Basic text generation:
```bash
curl -X POST "https://toolshed.commontools.dev/api/ai/llm" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-sonnet",
    "messages": [
      {
        "role": "user",
        "content": "What is the capital of France?"
      }
    ]
  }'
```

With system prompt and streaming:
```bash
curl -X POST "https://toolshed.commontools.dev/api/ai/llm" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-sonnet",
    "system": "You are a helpful assistant that responds in a pirate voice.",
    "stream": true,
    "messages": [
      {
        "role": "user",
        "content": "Tell me about the weather"
      }
    ]
  }'
```

Multi-modal with image:
```bash
curl -X POST "https://toolshed.commontools.dev/api/ai/llm" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-sonnet",
    "messages": [
      {
        "role": "user",
        "content": [
          {
            "type": "text",
            "data": "What do you see in this image?"
          },
          {
            "type": "image",
            "data": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ..."
          }
        ]
      }
    ]
  }'
```

#### Generate Structured Objects

**POST** `/api/ai/llm/generateObject`

Generate structured data objects using a language model with JSON schema validation.

**Request Body:**
```typescript
interface GenerateObjectRequest {
  prompt: string;           // Generation prompt
  schema: JSONSchema;       // JSON schema for validation
  system?: string;          // System prompt
  cache?: boolean;          // Enable caching (default: true)
  maxTokens?: number;       // Maximum tokens
  model?: string;           // Model identifier
  metadata?: Record<string, any>; // Additional metadata
}
```

**Response:**
```typescript
interface GenerateObjectResponse {
  object: any;    // Generated object matching schema
  id?: string;    // Generation ID for tracking
}
```

**Example:**
```bash
curl -X POST "https://toolshed.commontools.dev/api/ai/llm/generateObject" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Generate a user profile for a software developer",
    "schema": {
      "type": "object",
      "properties": {
        "name": { "type": "string" },
        "age": { "type": "number", "minimum": 18 },
        "skills": {
          "type": "array",
          "items": { "type": "string" }
        },
        "experience": { "type": "number" }
      },
      "required": ["name", "age", "skills"]
    }
  }'
```

```json
{
  "object": {
    "name": "Alex Chen",
    "age": 28,
    "skills": ["JavaScript", "Python", "React", "Node.js"],
    "experience": 5
  },
  "id": "gen_abc123"
}
```

#### Submit Feedback

**POST** `/api/ai/llm/feedback`

Submit feedback on LLM responses for quality improvement.

**Request Body:**
```typescript
interface FeedbackRequest {
  span_id: string;                    // Response ID to provide feedback on
  name?: string;                      // Feedback category name
  annotator_kind?: "HUMAN" | "LLM";   // Source of feedback
  result: {
    label?: string;      // Feedback label (e.g., "correct", "incorrect")
    score?: number;      // Numeric score (0-1 or 1-5, etc.)
    explanation?: string; // Detailed feedback explanation
  };
  metadata?: Record<string, unknown>; // Additional context
}
```

**Response:**
```typescript
{
  success: boolean;
}
```

**Example:**
```bash
curl -X POST "https://toolshed.commontools.dev/api/ai/llm/feedback" \
  -H "Content-Type: application/json" \
  -d '{
    "span_id": "67f6740bbe1ddc3f",
    "name": "correctness",
    "annotator_kind": "HUMAN",
    "result": {
      "label": "correct",
      "score": 1,
      "explanation": "The response accurately answered my question"
    }
  }'
```

### Image Generation

**POST** `/api/ai/img/generate`

Generate images using AI models.

**Request Body:**
```typescript
interface ImageGenerateRequest {
  prompt: string;
  model?: string;
  width?: number;
  height?: number;
  steps?: number;
  guidance?: number;
  seed?: number;
}
```

**Response:**
```typescript
interface ImageGenerateResponse {
  images: Array<{
    url: string;
    width: number;
    height: number;
  }>;
  metadata: {
    model: string;
    prompt: string;
    seed: number;
  };
}
```

### Voice Services

#### Transcribe Audio

**POST** `/api/ai/voice/transcribe`

Transcribe audio files to text.

**Request:** Multipart form data with audio file

**Response:**
```typescript
interface TranscribeResponse {
  text: string;
  confidence: number;
  language?: string;
  duration: number;
}
```

**Example:**
```bash
curl -X POST "https://toolshed.commontools.dev/api/ai/voice/transcribe" \
  -F "audio=@recording.wav"
```

#### Text-to-Speech

**POST** `/api/ai/voice/synthesize`

Convert text to speech audio.

**Request Body:**
```typescript
interface SynthesizeRequest {
  text: string;
  voice?: string;
  speed?: number;
  pitch?: number;
  format?: "wav" | "mp3" | "ogg";
}
```

**Response:** Audio file (binary data)

### Web Reading

**POST** `/api/ai/webreader/extract`

Extract and summarize content from web pages.

**Request Body:**
```typescript
interface WebReaderRequest {
  url: string;
  format?: "text" | "markdown" | "summary";
  maxLength?: number;
}
```

**Response:**
```typescript
interface WebReaderResponse {
  content: string;
  title: string;
  url: string;
  metadata: {
    wordCount: number;
    readingTime: number;
    author?: string;
    publishDate?: string;
  };
}
```

### Spell Management

#### List Spells

**GET** `/api/ai/spell/`

List available spells (computational units).

**Response:**
```typescript
interface SpellsResponse {
  spells: Array<{
    id: string;
    name: string;
    description: string;
    inputSchema: JSONSchema;
    outputSchema: JSONSchema;
    version: string;
  }>;
}
```

#### Execute Spell

**POST** `/api/ai/spell/{spellId}/execute`

Execute a specific spell with input data.

**Request Body:**
```typescript
interface SpellExecuteRequest {
  input: any; // Must match spell's input schema
  options?: {
    timeout?: number;
    priority?: "low" | "normal" | "high";
  };
}
```

**Response:**
```typescript
interface SpellExecuteResponse {
  output: any; // Matches spell's output schema
  executionTime: number;
  spellId: string;
  version: string;
}
```

## Storage Services

### Memory Storage

The memory storage system provides persistent, transactional storage using a fact-based data model.

#### Transact Facts

**PATCH** `/api/storage/memory`

Assert or retract facts in memory spaces.

**Request Body:**
```typescript
type MemoryPatch = {
  [space: string]: {
    assert?: {
      the: string;    // Fact type (usually "application/json")
      of: string;     // Entity identifier
      is: JSONValue;  // Value to store
      cause: Reference<Fact>; // Causal reference
    };
    retract?: {
      the: string;
      of: string;
      cause: Reference<Fact>;
    };
  };
};
```

**Response:**
```typescript
type MemoryResponse = 
  | { ok: {} }
  | { error: { conflict: any } };
```

**Example:**
```bash
curl -X PATCH "https://toolshed.commontools.dev/api/storage/memory" \
  -H "Content-Type: application/json" \
  -d '{
    "did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi": {
      "assert": {
        "the": "application/json",
        "of": "user:123",
        "is": {
          "name": "Alice",
          "email": "alice@example.com"
        },
        "cause": {
          "/": "baedreiayyshoe2moi4rexyuxp2ag7a22sfymkytfph345g6dmfqtoesabm"
        }
      }
    }
  }'
```

#### Query Facts

**GET** `/api/storage/memory/{space}`

Query facts from a memory space.

**Query Parameters:**
```typescript
interface MemoryQuery {
  the?: string;     // Filter by fact type
  of?: string;      // Filter by entity
  limit?: number;   // Limit results
  offset?: number;  // Pagination offset
}
```

**Response:**
```typescript
interface MemoryQueryResponse {
  facts: Fact[];
  total: number;
  hasMore: boolean;
}
```

### Blob Storage

#### Upload Blob

**POST** `/api/storage/blobs`

Upload binary data (files, images, etc.).

**Request:** Multipart form data

**Response:**
```typescript
interface BlobUploadResponse {
  id: string;
  url: string;
  size: number;
  contentType: string;
  checksum: string;
}
```

#### Get Blob

**GET** `/api/storage/blobs/{blobId}`

Retrieve uploaded blob data.

**Response:** Binary data with appropriate content-type header

#### Delete Blob

**DELETE** `/api/storage/blobs/{blobId}`

Delete a blob from storage.

**Response:**
```typescript
{ success: boolean }
```

## Identity Services

### Create Identity

**POST** `/api/identity/create`

Create a new decentralized identity.

**Request Body:**
```typescript
interface CreateIdentityRequest {
  passphrase?: string; // Optional passphrase for key derivation
  keyType?: "ed25519" | "secp256k1";
}
```

**Response:**
```typescript
interface CreateIdentityResponse {
  identity: string; // DID key
  publicKey: string;
  keyType: string;
}
```

### Sign Data

**POST** `/api/identity/sign`

Sign data with an identity key.

**Request Body:**
```typescript
interface SignRequest {
  data: string;     // Data to sign (base64 encoded)
  identity: string; // DID key
}
```

**Response:**
```typescript
interface SignResponse {
  signature: string; // Base64 encoded signature
  algorithm: string;
}
```

### Verify Signature

**POST** `/api/identity/verify`

Verify a signature against data and identity.

**Request Body:**
```typescript
interface VerifyRequest {
  data: string;      // Original data (base64 encoded)
  signature: string; // Signature to verify (base64 encoded)
  identity: string;  // DID key of signer
}
```

**Response:**
```typescript
interface VerifyResponse {
  valid: boolean;
  identity: string;
}
```

## Health & Monitoring

### Health Check

**GET** `/api/health`

Basic health check endpoint.

**Response:**
```typescript
interface HealthResponse {
  status: "ok" | "degraded" | "down";
  timestamp: string;
  version: string;
  uptime: number;
}
```

### Detailed Health

**GET** `/api/health/detailed`

Detailed system health information.

**Response:**
```typescript
interface DetailedHealthResponse {
  status: "ok" | "degraded" | "down";
  services: {
    [serviceName: string]: {
      status: "ok" | "degraded" | "down";
      responseTime?: number;
      lastCheck: string;
      error?: string;
    };
  };
  resources: {
    memory: {
      used: number;
      total: number;
      percentage: number;
    };
    cpu: {
      usage: number;
    };
    disk: {
      used: number;
      total: number;
      percentage: number;
    };
  };
}
```

### Metrics

**GET** `/api/health/metrics`

Prometheus-compatible metrics endpoint.

**Response:** Prometheus text format

## Error Handling

### Standard Error Format

All API errors follow a consistent format:

```typescript
interface APIError {
  error: {
    code: string;        // Machine-readable error code
    message: string;     // Human-readable error message
    details?: any;       // Additional error context
    requestId?: string;  // Request ID for tracking
  };
}
```

### Common Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `INVALID_REQUEST` | 400 | Request validation failed |
| `UNAUTHORIZED` | 401 | Authentication required |
| `FORBIDDEN` | 403 | Insufficient permissions |
| `NOT_FOUND` | 404 | Resource not found |
| `CONFLICT` | 409 | Resource conflict (e.g., CAS failure) |
| `RATE_LIMITED` | 429 | Rate limit exceeded |
| `INTERNAL_ERROR` | 500 | Internal server error |
| `SERVICE_UNAVAILABLE` | 503 | Service temporarily unavailable |

### Error Examples

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Missing required field: 'messages'",
    "details": {
      "field": "messages",
      "expected": "array",
      "received": "undefined"
    },
    "requestId": "req_abc123"
  }
}
```

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Rate limit exceeded. Try again in 60 seconds.",
    "details": {
      "limit": 100,
      "window": "1h",
      "retryAfter": 60
    }
  }
}
```

## Rate Limiting

### Rate Limit Headers

All API responses include rate limiting headers:

```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 999
X-RateLimit-Reset: 1640995200
X-RateLimit-Window: 3600
```

### Rate Limits by Endpoint

| Endpoint Pattern | Limit | Window |
|------------------|-------|--------|
| `/api/ai/llm` | 100 requests | 1 hour |
| `/api/ai/llm/generateObject` | 50 requests | 1 hour |
| `/api/storage/*` | 1000 requests | 1 hour |
| `/api/identity/*` | 10 requests | 1 minute |
| `/api/health/*` | Unlimited | - |

## WebSocket APIs

### Memory Subscriptions

Connect to real-time memory updates via WebSocket.

**Endpoint:** `wss://toolshed.commontools.dev/api/storage/memory/ws`

#### Subscribe to Changes

Send a watch message to subscribe to memory changes:

```typescript
interface WatchMessage {
  watch: {
    [space: string]: {
      the: string; // Fact type to watch
      of: string;  // Entity to watch
    };
  };
}
```

#### Unsubscribe from Changes

```typescript
interface UnwatchMessage {
  unwatch: {
    [space: string]: {
      the: string;
      of: string;
    };
  };
}
```

#### Receive Notifications

```typescript
interface NotificationMessage {
  [space: string]: Fact | Unclaimed;
}
```

**Example:**
```javascript
const ws = new WebSocket('wss://toolshed.commontools.dev/api/storage/memory/ws');

// Subscribe to user changes
ws.send(JSON.stringify({
  watch: {
    "my-space": {
      the: "application/json",
      of: "user:123"
    }
  }
}));

// Handle notifications
ws.onmessage = (event) => {
  const notification = JSON.parse(event.data);
  console.log('Memory update:', notification);
};
```

### Real-time AI Streaming

Some AI endpoints support WebSocket streaming for real-time results.

**Endpoint:** `wss://toolshed.commontools.dev/api/ai/llm/stream`

Send LLM requests and receive streaming responses in real-time.

---

This backend API reference provides comprehensive documentation for all available endpoints, request/response formats, and usage examples. For the most current information, refer to the interactive API documentation at `https://toolshed.commontools.dev/reference`.