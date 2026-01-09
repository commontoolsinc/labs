A `Page` (historically known as a `Charm`) is an instance of a `Pattern` bound to specific cells.

Here's a diagram of how cells are typically connected within a `Charm`:

We often call the main result cell the "charm".

```mermaid
flowchart TD
        A["Result Cell"]
        A --source--> B["Process Cell"]
        B --value.resultRef--> A
        B --value.spell--> C["Recipe Cell"]
        D@{ shape: procs, label: "Data Cells"} --source--> B
```
