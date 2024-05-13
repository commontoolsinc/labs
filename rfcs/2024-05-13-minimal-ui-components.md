# Minimal UI component set

Authors: Gordon Brander

## Overview

Context: defining a minimal set of components for LLM-generated UI.

## Goals

- A minimal set of components to start
- Expressive, allows for somewhat open-ended use-cases
- Works well with LLM generation
- Allows for user input, especially text input, buttons.
- Designed around semantic (use-case-specific) components, rather than fine-grained visual styling.
    - The system may display these components in different ways depending on the context, for example on small screens, large screens, via audio, etc.
    - The web started this way as well, and 
- Can be evolved over time to:
    - Expand feature set
    - Excavate lower-level features
- Optimized for small UI islands. Micro-components.
    - The kind of UI components used by Discord bots, under social media posts, etc.
- Likely to use mostly “mobile-like” layouts.

Non-goals:

- Exposing full HTML support
- CSS or other styling support
- Complex layout features
- Separation of concerns
- Turing complete scripting in views

## Proposal

### Layout components

We’re not aiming to expose generalized layout features. Instead, we want to handle everything with either flexbox semantics, or more complex task-specific layout components that have semantic slots.

- `<hstack>` - flexbox with row flex direction.
    - Attributes
        - `gap` - creates a gap between items. Defaults to a standard gap size.
- `<vstack>` - flexbox with column flex direction.
    - Attributes
        - `gap` - creates a gap between items.  Defaults to a standard gap size.
- `<spacer>` - an empty element with aggressive flex grow and flex shrink to allow it to fill additional available space.

Elements inside flex layout elements are centered by default. Spacer can be used to cause them to fill available space.

### Collections

- `<list>` - a  collection of items. Display style is contextual. May render as a scrolling list, or a series of items with a “more” button, etc.
- `<gallery>` - a collection of images or other content. Display style is contextual, and depends upon number of child components and screen space. Think the media gallery component in Discord or Twitter. May render as several images side-by-side, or as a regular grid for additional elements.

### Navigation

- `<nav-stack>` - multi-step hierarchical flows (think sliding panels in iOS). Handles navigation state and associated controls.
    - `<nav-link title="">`
        - Attributes
            - `title` - the text of the link
        - Default slot - the children of this element are treated as the content for the panel that it activates.
- `<tabs>`

### Input components

- `<button>`
- `<input>`
- `<textfield>`
- `<rich-textfield>` - can wait
- `<input type="text">`
- `<input type="search">`
    - `<datalist id="">` - can be combined with text or search inputs to provide  simple type-ahead search.
- `<input type="range">` = slider

### Display components

- `<text>`
    - Attributes
        - `markup`
            - `markup="plaintext"` / no attribute. No special markup rendering (default).
            - `markup="markdown"` Provides markdown rendering. LLMs are great at rendering Markdown. Makes sense to lean into this.

## Open questions

- Can we get an LLM to reliably use these components?

## Prior art

### SwiftUI



### AMP