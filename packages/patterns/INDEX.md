# Common Patterns

Prefix the URLs with `https://raw.githubusercontent.com/commontoolsinc/labs/refs/heads/main/packages/patterns/`

## `counter.tsx`

A simple counter demo.

### Input Schema

```ts
interface RecipeInput {
  value?: number;
}
```

### Result Schema

```ts
interface RecipeOutput {
  value?: number;
  increment: Stream<void>;
  decrement: Stream<void>;
}
```

## `chatbot.tsx`

A chatbot demo.

### Input Schema

```ts
type ChatInput = {
  messages?: Cell<Default<Array<BuiltInLLMMessage>, []>>;
  tools?: any;
  theme?: any;
  system?: string;
};
```

### Result Schema

```ts
type ChatOutput = {
  messages: Array<BuiltInLLMMessage>;
  pending: boolean | undefined;
  addMessage: Stream<BuiltInLLMMessage>;
  clearChat: Stream<void>;
  cancelGeneration: Stream<void>;
  title?: string;
  attachments: Array<PromptAttachment>;
  tools: any;
  ui: {
    chatLog: VNode;
    promptInput: VNode;
    attachmentsAndTools: VNode;
  };
};
```

## `note.tsx`

A note demo.

### Input Schema

```ts
type NoteInput = {
  title?: string;
  content?: string;
};
```

### Result Schema

```ts
type NoteOutput = {
  mentioned: Default<Array<MentionableCharm>, []>;
  backlinks: MentionableCharm[];

  /** The content of the note */
  content?: string;
  grep: Stream<{ query: string }>;
  translate: Stream<{ language: string }>;
  editContent: Stream<{ detail: { value: string } }>;
};
```
