# Deprecated Idioms - Migration Task List

This document tracks deprecated idioms found in the patterns directory that need
to be updated to the current API.

## Summary

- **Total files scanned**: 50
- **Files with deprecated idioms**: 21
- **Priority levels**: High (4), Medium (13), Low (4)

## Deprecated APIs to Replace

1. `cell()` → `Writable.of()`
2. `derive()` → `computed()`
3. `lift()` → `computed()` or refactor
4. `handler()` for simple operations → inline handlers
5. `.equals()` method → `Writable.equals(a, b)`
6. Unnecessary `[ID]` usage → use `Writable.equals()` instead for
   finding/removing items

## High Priority Files

### 1. chatbot.tsx

**Priority**: High (core functionality) **Location**:
`packages/patterns/chatbot.tsx`

- **Line 64**: `derive()` → `computed()`
  ```typescript
  const chatLog = derive(() => {
  ```

- **Line 84**: `lift()` → `computed()` or refactor
  ```typescript
  lift(async () => {
  ```

- **Line 123**: Simple `handler()` → inline handler
  ```typescript
  const sendMessage = handler<...>(...)
  ```

### 2. chatbot-list-view.tsx

**Priority**: High (core functionality) **Location**:
`packages/patterns/chatbot-list-view.tsx`

- **Line 32**: `derive()` → `computed()`
  ```typescript
  const chatbots = derive(() => {
  ```

- **Line 45**: Simple `handler()` → inline handler
  ```typescript
  const createChatbot = handler<...>(...)
  ```

### 3. default-app.tsx

**Priority**: High (core functionality) **Location**:
`packages/patterns/default-app.tsx`

- **Line 28**: `cell()` → `Writable.of()`
  ```typescript
  const currentView = cell("home");
  ```

- **Line 56**: `derive()` → `computed()`
  ```typescript
  const viewComponent = derive(() => {
  ```

### 4. omnibox-fab.tsx

**Priority**: High (core functionality) **Location**:
`packages/patterns/omnibox-fab.tsx`

- **Line 19**: `cell()` → `Writable.of()`
  ```typescript
  const isOpen = cell(false);
  ```

- **Line 34**: Simple `handler()` → inline handler
  ```typescript
  const toggleOpen = handler(() => {
  ```

## Medium Priority Files

### 5. todo-list.tsx

**Priority**: Medium **Location**: `packages/patterns/todo-list.tsx`

- **Line 23**: `derive()` → `computed()`
  ```typescript
  const completedCount = derive(() => {
  ```

- **Line 45**: Simple `handler()` → inline handler
  ```typescript
  const addTodo = handler<...>(...)
  ```

- **Line 67**: `.equals()` → `Writable.equals()`
  ```typescript
  if (item.equals(todo)) {
  ```

### 6. shopping-list.tsx

**Priority**: Medium **Location**: `packages/patterns/shopping-list.tsx`

- **Line 18**: `cell()` → `Writable.of()`
  ```typescript
  const items = cell([]);
  ```

- **Line 34**: `derive()` → `computed()`
  ```typescript
  const groupedItems = derive(() => {
  ```

- **Line 56**: Simple `handler()` → inline handler
  ```typescript
  const addItem = handler<...>(...)
  ```

### 7. kanban-board.tsx

**Priority**: Medium **Location**: `packages/patterns/kanban-board.tsx`

- **Line 42**: `derive()` → `computed()`
  ```typescript
  const columnTasks = derive(() => {
  ```

- **Line 78**: Simple `handler()` → inline handler
  ```typescript
  const moveTask = handler<...>(...)
  ```

- **Line 95**: `lift()` → `computed()` or refactor
  ```typescript
  lift(() => {
  ```

### 8. calendar-view.tsx

**Priority**: Medium **Location**: `packages/patterns/calendar-view.tsx`

- **Line 29**: `derive()` → `computed()`
  ```typescript
  const monthEvents = derive(() => {
  ```

- **Line 67**: Simple `handler()` → inline handler
  ```typescript
  const selectDate = handler<...>(...)
  ```

### 9. markdown-editor.tsx

**Priority**: Medium **Location**: `packages/patterns/markdown-editor.tsx`

- **Line 15**: `cell()` → `Writable.of()`
  ```typescript
  const content = cell("");
  ```

- **Line 23**: `derive()` → `computed()`
  ```typescript
  const preview = derive(() => {
  ```

### 10. data-table.tsx

**Priority**: Medium **Location**: `packages/patterns/data-table.tsx`

- **Line 35**: `derive()` → `computed()`
  ```typescript
  const sortedData = derive(() => {
  ```

- **Line 58**: `derive()` → `computed()`
  ```typescript
  const filteredData = derive(() => {
  ```

- **Line 89**: Simple `handler()` → inline handler
  ```typescript
  const setSortColumn = handler<...>(...)
  ```

### 11. form-builder.tsx

**Priority**: Medium **Location**: `packages/patterns/form-builder.tsx`

- **Line 28**: `cell()` → `Writable.of()`
  ```typescript
  const fields = cell([]);
  ```

- **Line 45**: `derive()` → `computed()`
  ```typescript
  const validationErrors = derive(() => {
  ```

- **Line 78**: Simple `handler()` → inline handler
  ```typescript
  const addField = handler<...>(...)
  ```

### 12. chart-widget.tsx

**Priority**: Medium **Location**: `packages/patterns/chart-widget.tsx`

- **Line 19**: `derive()` → `computed()`
  ```typescript
  const chartData = derive(() => {
  ```

- **Line 45**: `lift()` → `computed()` or refactor
  ```typescript
  lift(() => {
  ```

### 13. notification-center.tsx

**Priority**: Medium **Location**: `packages/patterns/notification-center.tsx`

- **Line 22**: `cell()` → `Writable.of()`
  ```typescript
  const notifications = cell([]);
  ```

- **Line 34**: Simple `handler()` → inline handler
  ```typescript
  const dismissNotification = handler<...>(...)
  ```

- **Line 56**: `.equals()` → `Writable.equals()`
  ```typescript
  if (notif.equals(target)) {
  ```

### 14. search-filter.tsx

**Priority**: Medium **Location**: `packages/patterns/search-filter.tsx`

- **Line 17**: `cell()` → `Writable.of()`
  ```typescript
  const query = cell("");
  ```

- **Line 25**: `derive()` → `computed()`
  ```typescript
  const results = derive(() => {
  ```

### 15. settings-panel.tsx

**Priority**: Medium **Location**: `packages/patterns/settings-panel.tsx`

- **Line 23**: `cell()` → `Writable.of()`
  ```typescript
  const settings = cell({});
  ```

- **Line 45**: Simple `handler()` → inline handler
  ```typescript
  const updateSetting = handler<...>(...)
  ```

### 16. image-gallery.tsx

**Priority**: Medium **Location**: `packages/patterns/image-gallery.tsx`

- **Line 19**: `derive()` → `computed()`
  ```typescript
  const displayedImages = derive(() => {
  ```

- **Line 56**: Simple `handler()` → inline handler
  ```typescript
  const selectImage = handler<...>(...)
  ```

### 17. file-browser.tsx

**Priority**: Medium **Location**: `packages/patterns/file-browser.tsx`

- **Line 28**: `cell()` → `Writable.of()`
  ```typescript
  const currentPath = cell("/");
  ```

- **Line 42**: `derive()` → `computed()`
  ```typescript
  const currentFiles = derive(() => {
  ```

- **Line 78**: `lift()` → `computed()` or refactor
  ```typescript
  lift(() => {
  ```

## Low Priority Files

### 18. theme-switcher.tsx

**Priority**: Low (utility) **Location**: `packages/patterns/theme-switcher.tsx`

- **Line 12**: `cell()` → `Writable.of()`
  ```typescript
  const theme = cell("light");
  ```

- **Line 23**: Simple `handler()` → inline handler
  ```typescript
  const toggleTheme = handler(() => {
  ```

### 19. color-picker.tsx

**Priority**: Low (utility) **Location**: `packages/patterns/color-picker.tsx`

- **Line 15**: `derive()` → `computed()`
  ```typescript
  const rgbValue = derive(() => {
  ```

### 20. progress-tracker.tsx

**Priority**: Low (utility) **Location**:
`packages/patterns/progress-tracker.tsx`

- **Line 18**: `derive()` → `computed()`
  ```typescript
  const percentage = derive(() => {
  ```

- **Line 34**: `[ID]` usage - only needed if items are reordered
  (sorting/shuffling). If just adding/removing without reordering, use
  `Writable.equals()` for finding items instead.
  ```typescript
  [ID]: step.id
  ```

### 21. badge-component.tsx

**Priority**: Low (utility) **Location**:
`packages/patterns/badge-component.tsx`

- **Line 12**: `derive()` → `computed()`
  ```typescript
  const badgeText = derive(() => {
  ```

- **Line 28**: `[ID]` usage - only needed if items are reordered
  (sorting/shuffling). If just adding/removing without reordering, use
  `Writable.equals()` for finding items instead.
  ```typescript
  [ID]: badge.id
  ```

## Migration Strategy

### Phase 1: High Priority (4 files)

Update core functionality patterns first to ensure critical features work with
new API.

### Phase 2: Medium Priority (13 files)

Update commonly used patterns and examples.

### Phase 3: Low Priority (4 files)

Update utility components and less frequently used patterns.

## Update Checklist for Each File

- [ ] Replace `cell()` with `Writable.of()`
- [ ] Replace `derive()` with `computed()`
- [ ] Replace `lift()` with `computed()` or refactor
- [ ] Convert simple `handler()` calls to inline handlers
- [ ] Update pattern input types to use `Writable<T>` for cells used in inline
      handlers
- [ ] Replace `.equals()` with `Writable.equals(a, b)`
- [ ] Review `[ID]` usage - remove if only doing finding/removing (use
      `Writable.equals()` instead). Keep only for item reordering scenarios.
- [ ] Test the updated pattern
- [ ] Verify no TypeScript errors
- [ ] Deploy and verify functionality

## Notes

- When converting to inline handlers, remember to update the pattern input
  interface to declare cells as `Writable<T>`
- For complex handlers with multiple operations or reusable logic, keep using
  `handler()` function
- Use the decision hierarchy: bidirectional binding → inline handlers →
  `handler()` function
- Test each file after updating to ensure functionality is preserved
