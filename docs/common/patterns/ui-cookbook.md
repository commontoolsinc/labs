# UI Cookbook

This page is intentionally small. It captures a few pattern-facing layout and
composition defaults that agents can reuse while the broader styling guidance
is still under construction.

## 1. Detail Screen

Use when the pattern focuses on one primary record or object.

Principles:

- outer `cf-screen`
- one centered or padded content column
- clear title/header region
- grouped sections rather than one uninterrupted form

```tsx
<cf-screen title="Details">
  <cf-vscroll style="flex: 1;">
    <cf-vstack gap="4" style="padding: 1rem;">
      <cf-card>
        <cf-vstack slot="content" gap="3">
          <cf-heading level="2">Primary details</cf-heading>
          {/* key fields */}
        </cf-vstack>
      </cf-card>

      <cf-card>
        <cf-vstack slot="content" gap="3">
          <cf-heading level="3">Secondary section</cf-heading>
          {/* related fields */}
        </cf-vstack>
      </cf-card>
    </cf-vstack>
  </cf-vscroll>
</cf-screen>
```

## 2. Form Layout

Use when the user is editing a set of fields with a clear save/submit path.

Principles:

- keep labels, inputs, and help text aligned consistently
- group related inputs into short vertical sections
- keep primary actions together and easy to find

```tsx
<cf-screen title="Edit">
  <cf-vstack gap="4" style="padding: 1rem;">
    <cf-card>
      <cf-vstack slot="content" gap="3">
        <cf-vgroup gap="1">
          <cf-label for="name">Name</cf-label>
          <cf-input id="name" $value={name} />
        </cf-vgroup>

        <cf-vgroup gap="1">
          <cf-label for="notes">Notes</cf-label>
          <cf-textarea id="notes" $value={notes} rows="5" />
        </cf-vgroup>
      </cf-vstack>
    </cf-card>

    <cf-hstack gap="3" justify="end">
      <cf-button variant="outline">Cancel</cf-button>
      <cf-button>Save</cf-button>
    </cf-hstack>
  </cf-vstack>
</cf-screen>
```

## 3. List With Cards

Use when the user is scanning or managing a set of related items.

Principles:

- list header explains what the set is
- each row/card exposes the most important fields first
- secondary actions stay visually subordinate

```tsx
<cf-screen title="Items">
  <cf-vstack gap="4" style="padding: 1rem;">
    <cf-hstack justify="between" align="center">
      <cf-heading level="2">Recent items</cf-heading>
      <cf-button variant="outline">Add item</cf-button>
    </cf-hstack>

    <cf-vstack gap="3">
      {items.map((item) => (
        <cf-card>
          <cf-hstack slot="content" justify="between" align="start" gap="3">
            <cf-vstack gap="1">
              <cf-heading level="3">{item.title}</cf-heading>
              <cf-label>{item.subtitle}</cf-label>
            </cf-vstack>
            <cf-button variant="ghost">Open</cf-button>
          </cf-hstack>
        </cf-card>
      ))}
    </cf-vstack>
  </cf-vstack>
</cf-screen>
```

## 4. Empty State

Use when the first-run or zero-data state matters.

Principles:

- explain what is missing
- say what the user can do next
- keep the call to action nearby

```tsx
<cf-card>
  <cf-vstack slot="content" gap="3" align="center">
    <cf-heading level="3">No items yet</cf-heading>
    <cf-label>Add your first item to get started.</cf-label>
    <cf-button>Create item</cf-button>
  </cf-vstack>
</cf-card>
```

## Working Rule

These examples are intentionally conservative. Prefer a small number of calm,
well-grouped layout primitives over bespoke decorative structure unless the
pattern genuinely needs something more expressive.
