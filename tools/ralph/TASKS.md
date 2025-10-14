# Ralph Task List

A running checklist of tasks. New items include brief implementation notes for a
future Ralph pass.

Tasks marked with [UI] mean they should add/remove/modify the UI of the pattern.
UI tasks should wire up the functionality and call the appropriate handlers.

- [] Create a counter
  - [] Add [UI] buttons for incrementing counter
    - **Test with Playwright**: click increment 3 times, verify counter shows 3,
      click decrement once, verify counter shows 2
    - **State**: The displayed count matches the pattern's `count` output field
  - [] Create multiple counters
    - [] Add [UI] buttons to create multiple counters
      - **Test with Playwright**: create 3 counters, test each one
      - **State**: Each counter maintains its own value in the pattern's
        `counters` array
- [] Create a shopping list
  - [] Create [UI] for shopping list
    - **Test with Playwright**: add "milk" and "bread", make sure you see both,
      remove "bread", verify only "milk" remains
    - **State**: The list shows all items from pattern's `items` array with
      correct `completed` status
- [] Lunch voter - list of destinations (just a string) (dedup)
  - [] [UI] for adding list of destination (just a string) and displaying it
    - **UI must**: Show an editable list with add/remove buttons for
      destinations
    - **Test with Playwright**: Deploy pattern, add at least 2 destinations via
      UI, verify they appear in the list, remove one destination, verify it's
      removed from both UI and charm output
    - **State**: The displayed list matches the pattern's `destinations` output
      field
