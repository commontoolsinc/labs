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
  - **Keywords**: handler, map, array operations, get/set, ct-button

- array-in-cell-with-remove-editable.tsx: Editable list with add, remove, and
  update operations
  - **Data types**: array of objects (text strings)
  - **Keywords**: handler, map, array operations, ct-input, ct-button,
    onct-change

- aside.tsx: Full-screen layout demonstration with header, footer, and sidebars
  - **Data types**: none (layout only)
  - **Keywords**: ct-screen, ct-autolayout, slots (left/right/header/footer),
    tabNames

- system/backlinks-index.tsx: Backlinks computation system for bi-directional
  references between charms
  - **Data types**: array of objects (MentionableCharm with mentioned/backlinks
    arrays)
  - **Keywords**: lift, array operations, backlinks, mentionable pattern,
    OpaqueRef

- charm-ref-in-cell.tsx: Storing and navigating to charm references within cells
  - **Data types**: object containing charm reference
  - **Keywords**: lift, cell, navigateTo, ifElse, derive, isInitialized flag

- charms-ref-in-cell.tsx: Managing an array of charm references with navigation
  - **Data types**: array of charm objects
  - **Keywords**: lift, cell, navigateTo, array operations, isInitialized flag,
    map

- chatbot-list-view.tsx: Chat application with sidebar list of chat sessions
  - **Data types**: array of objects (CharmEntry with ID and charm), selected
    charm object
  - **Keywords**: lift, handler, navigateTo, ct-select, ct-render,
    ct-autolayout, wish, [ID]

- chatbot.tsx: Full-featured chatbot with LLM integration and attachments
  - **Data types**: array of LLM messages, array of attachments (objects), array
    of charms
  - **Keywords**: llmDialog, handler, derive, wish, ct-chat, ct-prompt-input,
    ct-select, Stream, generateObject

- cheeseboard.tsx: Fetch and display pizza schedule from web
  - **Data types**: array of tuples (date/pizza strings), web response object
  - **Keywords**: fetchData, lift, string parsing, map

- system/common-tools.tsx: Reusable tool recipes and handlers for LLM
  integration
  - **Data types**: array of list items (objects), API response objects
  - **Keywords**: handler, recipe as tool, fetchData, derive, ifElse

- counter.tsx: Basic counter with increment/decrement operations
  - **Data types**: number
  - **Keywords**: handler, str template, derive (via pure function), ct-button,
    Stream

- examples/ct-checkbox-cell.tsx: Checkbox component with bidirectional binding
  - **Data types**: boolean
  - **Keywords**: ct-checkbox, $checked (bidirectional binding), handler
    (optional), ifElse, onct-change

- ct-checkbox-handler.tsx: Checkbox with explicit handler for state changes
  - **Data types**: boolean
  - **Keywords**: ct-checkbox, handler, checked property, onct-change, ifElse

- examples/ct-render.tsx: Rendering sub-recipes with ct-render component
  - **Data types**: number (counter value)
  - **Keywords**: ct-render, $cell, nested recipes, recipe composition, handler

- ct-select.tsx: Dropdown select component with various value types
  - **Data types**: string, number
  - **Keywords**: ct-select, $value (bidirectional binding), items (label/value
    objects)

- examples/ct-tags.tsx: Tags input component
  - **Data types**: array of strings
  - **Keywords**: ct-tags, handler, onct-change, array of strings

- system/default-app.tsx: Default application with charm management and
  navigation
  - **Data types**: array of charms (MentionableCharm objects)
  - **Keywords**: wish, derive, navigateTo, handler, ct-table, ct-button,
    multiple recipe instantiation

- dice.tsx: Dice roller with random number generation
  - **Data types**: number
  - **Keywords**: handler, random values, ct-button, Stream

- fetch-data.tsx: GitHub repository data fetcher
  - **Data types**: complex API response object, string (URL)
  - **Keywords**: fetchData, lift, derive, ct-input, $value, string parsing

- instantiate-recipe.tsx: Factory pattern for creating counter instances
  - **Data types**: number, charm references
  - **Keywords**: navigateTo, handler, recipe instantiation, factory pattern

- linkedlist-in-cell.tsx: Linked list data structure implementation
  - **Data types**: linked list object (recursive structure with value/next)
  - **Keywords**: cell, derive, handler, custom data structure, recursive
    structure

- system/link-tool.tsx: Tool for creating data links between charm cells
  - **Data types**: string (source path), string (target path)
  - **Keywords**: link built-in, handler, charm navigation, cell linking, path
    parsing

- list-operations.tsx: Advanced array operations with ID-based tracking
  - **Data types**: array of objects with [ID] property
  - **Keywords**: [ID], derive, lift, filter, map, concat, reduce, handler,
    array operations, get/set

- examples/llm.tsx: Simple LLM question/answer interface
  - **Data types**: string (question), LLM response content, array of messages
  - **Keywords**: llm, cell, derive, handler, ct-message-input, onct-send

- nested-counter.tsx: Counter with nested sub-counter instances
  - **Data types**: number
  - **Keywords**: nested recipes, recipe composition, passing cells, str
    template, handler

- notes/note.tsx: Note-taking app with backlinks and mentions
  - **Data types**: string (title/content), array of charms
    (mentioned/backlinks)
  - **Keywords**: wish, handler, navigateTo, ct-code-editor, $mentionable,
    $mentioned, backlinks, cell

- output_schema.tsx: Demonstrates explicit output schema typing
  - **Data types**: number, VNode
  - **Keywords**: handler, output schema, type safety, ct-button
