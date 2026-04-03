# Pattern Index

This index catalogs all patterns in this directory, organized alphabetically.
Each entry includes a brief summary, the data types used, and relevant
keywords/features.

## Patterns

- array-in-cell-ast-nocomponents.tsx: Simple list with add functionality using
  array in cell
  - **Data types**: array of objects (text strings)
  - **Keywords**: handler, map, array operations, common-send-message

- array-in-cell-with-remove-ast-nocomponents.tsx: List with add and remove
  operations on array
  - **Data types**: array of objects (text strings)
  - **Keywords**: handler, map, array operations, get/set, cf-button

- array-in-cell-with-remove-editable.tsx: Editable list with add, remove, and
  update operations
  - **Data types**: array of objects (text strings)
  - **Keywords**: handler, map, array operations, cf-input, cf-button,
    oncf-change

- aside.tsx: Full-screen layout demonstration with header, footer, and sidebars
  - **Data types**: none (layout only)
  - **Keywords**: cf-screen, cf-autolayout, slots (left/right/header/footer),
    tabNames

- system/backlinks-index.tsx: Backlinks computation system for bi-directional
  references between pieces
  - **Data types**: array of objects (MentionableCharm with mentioned/backlinks
    arrays)
  - **Keywords**: lift, array operations, backlinks, mentionable pattern,
    OpaqueRef

- piece-ref-in-cell.tsx: Storing and navigating to piece references within cells
  - **Data types**: object containing piece reference
  - **Keywords**: lift, cell, navigateTo, ifElse, derive, isInitialized flag

- pieces-ref-in-cell.tsx: Managing an array of piece references with navigation
  - **Data types**: array of piece objects
  - **Keywords**: lift, cell, navigateTo, array operations, isInitialized flag,
    map

- chatbot-list-view.tsx: Chat application with sidebar list of chat sessions
  - **Data types**: array of objects (CharmEntry with ID and piece), selected
    piece object
  - **Keywords**: lift, handler, navigateTo, cf-select, cf-render,
    cf-autolayout, wish, [ID]

- chatbot.tsx: Full-featured chatbot with LLM integration and attachments
  - **Data types**: array of LLM messages, array of attachments (objects), array
    of pieces
  - **Keywords**: llmDialog, handler, derive, wish, cf-chat, cf-prompt-input,
    cf-select, Stream, generateObject

- cheeseboard.tsx: Fetch and display pizza schedule from web
  - **Data types**: array of tuples (date/pizza strings), web response object
  - **Keywords**: fetchData, lift, string parsing, map

- system/common-fabric.tsx: Reusable tool patterns and handlers for LLM
  integration
  - **Data types**: array of list items (objects), API response objects
  - **Keywords**: handler, pattern as tool, fetchData, derive, ifElse

- counter.tsx: Basic counter with increment/decrement operations
  - **Data types**: number
  - **Keywords**: handler, str template, derive (via pure function), cf-button,
    Stream

- examples/cf-checkbox-cell.tsx: Checkbox component with bidirectional binding
  - **Data types**: boolean
  - **Keywords**: cf-checkbox, $checked (bidirectional binding), handler
    (optional), ifElse, oncf-change

- cf-checkbox-handler.tsx: Checkbox with explicit handler for state changes
  - **Data types**: boolean
  - **Keywords**: cf-checkbox, handler, checked property, oncf-change, ifElse

- examples/cf-render.tsx: Rendering sub-patterns with cf-render component
  - **Data types**: number (counter value)
  - **Keywords**: cf-render, $cell, nested patterns, pattern composition,
    handler

- cf-select.tsx: Dropdown select component with various value types
  - **Data types**: string, number
  - **Keywords**: cf-select, $value (bidirectional binding), items (label/value
    objects)

- examples/cf-tags.tsx: Tags input component
  - **Data types**: array of strings
  - **Keywords**: cf-tags, handler, oncf-change, array of strings

- system/default-app.tsx: Default application with piece management and
  navigation
  - **Data types**: array of pieces (MentionableCharm objects)
  - **Keywords**: wish, derive, navigateTo, handler, cf-table, cf-button,
    multiple pattern instantiation

- dice.tsx: Dice roller with random number generation
  - **Data types**: number
  - **Keywords**: handler, random values, cf-button, Stream

- fetch-data.tsx: GitHub repository data fetcher
  - **Data types**: complex API response object, string (URL)
  - **Keywords**: fetchData, lift, derive, cf-input, $value, string parsing

- instantiate-pattern.tsx: Factory pattern for creating counter instances
  - **Data types**: number, piece references
  - **Keywords**: navigateTo, handler, pattern instantiation, factory pattern

- linkedlist-in-cell.tsx: Linked list data structure implementation
  - **Data types**: linked list object (recursive structure with value/next)
  - **Keywords**: cell, derive, handler, custom data structure, recursive
    structure

- system/link-tool.tsx: Tool for creating data links between piece cells
  - **Data types**: string (source path), string (target path)
  - **Keywords**: link built-in, handler, piece navigation, cell linking, path
    parsing

- list-operations.tsx: Advanced array operations with ID-based tracking
  - **Data types**: array of objects with [ID] property
  - **Keywords**: [ID], derive, lift, filter, map, concat, reduce, handler,
    array operations, get/set

- examples/llm.tsx: Simple LLM question/answer interface
  - **Data types**: string (question), LLM response content, array of messages
  - **Keywords**: llm, cell, derive, handler, cf-message-input, oncf-send

- nested-counter.tsx: Counter with nested sub-counter instances
  - **Data types**: number
  - **Keywords**: nested patterns, pattern composition, passing cells, str
    template, handler

- notes/note.tsx: Note-taking app with backlinks and mentions
  - **Data types**: string (title/content), array of pieces
    (mentioned/backlinks)
  - **Keywords**: wish, handler, navigateTo, cf-code-editor, $mentionable,
    $mentioned, backlinks, cell

- output_schema.tsx: Demonstrates explicit output schema typing
  - **Data types**: number, VNode
  - **Keywords**: handler, output schema, type safety, cf-button
