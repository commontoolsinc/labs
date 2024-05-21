# Minimal UI component set

Authors: Gordon Brander

## Overview

Context: defining a minimal set of components for LLM-generated UI.

## Goals

- A minimal set of components to start
- Expressive, allows for somewhat open-ended use-cases
- Works well with LLM generation
- Allows for user input, especially text input, buttons.
- Declarative use-case-specific components, rather than fine-grained visual styling.
    - The system may display these components in different ways depending on the context, for example on small screens, large screens, via audio, etc.
    - The web started this way and gradually excavated more control over style and behavior. We should follow this path too. Starting with declarative components means:
        - Components can automatically adapt to context.
        - API surface area is minimal to start, meaning easy to learn, easy to implement, easy to evolve.
        - Side-steps many issues with malicious software by keeping things simple.
        - [Lower-level mechanisms can be excavated over time](https://github.com/gordonbrander/generative-ui-playbook?tab=readme-ov-file#excavating-fine-grained-mechanisms). The system co-evolves with actual ecosystem needs.
- Design can be evolved over time to:
    - Expand feature set
    - Excavate lower-level features
- Optimized for small UI islands. Micro-components.
    - The kind of UI components used by Discord bots, under social media posts, etc.
- Likely to use mostly “mobile-friendly” layouts.

Non-goals:

- Exposing full HTML support
- CSS or other styling support
- Complex layout features
- Separation of concerns
- Turing-complete scripting in views

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

### Collection components

- `<list>` - a  collection of items. Display style is contextual. May render as a scrolling list, or a series of items with a “more” button, etc.
- `<gallery>` - a collection of images or other content. Display style is contextual, and depends upon number of child components and screen space. Think the media gallery component in Discord or Twitter. May render as several images side-by-side, or as a regular grid for additional elements.

### Navigation components

- `<nav-view>` - multi-step hierarchical flows (think sliding panels in iOS). Handles navigation state and associated controls.
    - `<nav-link title="">`
        - Attributes
            - `title` - the text of the link
        - Children - the default slot is treated as the content for the associated panel.
- `<tab-view>` - manages a collection of tabs. Display style is contextual. May render as a horizontal series of tab, or a sidebar of tabs, etc. Handles tab state internally.
    - `<tab-item title="">`
        - Attributes
            - `title` - the title of the tab
        - Children - the default slot is treated as the content for the associated panel.

Speculative:

- `<miniapp presented="$bool">` - wrapping a component set in this tag tells the system to display the components as a mini-app. This might be displayed as a mostly full-screen, or sheet-based interaction, depending upon context.

### Input components

- `<button>`
- `<textfield>`
- `<rich-textfield>` - can wait
- `<input type="text">`
- `<input type="search">`
    - `<datalist id="">` - can be combined with text or search inputs to provide  simple type-ahead search.
- Date input
- Slider with label
- Checkbox with label

### Display components

- `<text>`
    - Attributes
        - `style`
            - `style="body"` - the primary body style
            - `style="secondary"` - the secondary body style
            - `style="footnote"` - a footnote style
            - `style="heading"` - a heading style
        - `markup`
            - `markup="plaintext"` / no attribute. No special markup rendering (default).
            - `markup="markdown"` Provides markdown rendering. LLMs are great at rendering Markdown. Makes sense to lean into this.

## Open questions

- Can we get an LLM to reliably use these components?

## Prior art

### SwiftUI

The above component set is heavily inspired by SwiftUI’s approach to the problem.

Resources:

- [SwiftUI developer reference](https://developer.apple.com/documentation/swiftui/)

A quick tour of SwiftUI’s core component set...

Layout components:

- `VStack` - flexbox-like layout with column flex direction
- `HStack` - flexbox-like layout with row flex direction
- `ZStack` - a z-index stacking element 
- `Spacer` - an element that fills available space (flex grow/flex shrink)

This ends up being sufficiently expressive to build just about any UI. In addition, SwiftUI offers a few specialized layout components:

- `LazyVStack` - a lazy vertical flexbox-like layout for virtual scrolling
- `LazyHStack` - a lazy horizontal flexbox-like layout for virtual scrolling
- `Grid` / `GridRow` - a table-like grid layout
- `List` - a list of items with default styling appropriate to the platform

Navigation components:

- `NavigationView` / `NavigationStack` - manages sliding panels
    - `NavigationLink` - activates navigation panels
- `sheet` (view modifier) - places a set of views within a modal sheet

Input components:

- `TextField` - a text input component, similar to `<input type="text">`.
    - Includes a label
    - Supports a handful of rendering styles
- `TextEditor` - a text input component, similar to `<textarea>`.
- `Button` - a button component
    - Supports a handful of rendering styles

Display components:

- `Text` - renders text
    - Can be configured to render markdown
    - Can also take attributed text strings for programmable rich text

There are many more components, but this covers most of what you’ll use on a day-to-day basis.

**Typography**: rather than being designed around visual styles, typography in iOS is designed, by default, around a [set of declarative roles](
https://developer.apple.com/design/human-interface-guidelines/typography#Large-Default):

- Body
- Footnote
- Callout
- Title
- etc

This allows the system to adapt text automatically to different form factors (phone, iPad, watch, etc). Text styles can also be manually configured (font, color, etc), but these APIs are not the default, and you are encouraged to use the semantic roles instead.

**[SwiftUI Views](https://developer.apple.com/documentation/swiftui/view)**: views in SwiftUI are struct constructor functions. SwiftUI structs have many of the familiar features of classes, including methods. View structs may hold component state.

```swift
HStack {
    Text("Hello-world")
    Spacer()
}
``` 

Views leverage a Swift syntax sugar: when the last argument is a closure, you can put the closure’s curly brackets on the outside of the function call, and omit the parenthesis, if there are no other arguments. So, the above de-sugars to:

```swift
HStack(content: {
    Text("Hello-world")
    Spacer()
})
```

In a web context you could use classes or factory functions toward a similar purpose. For example, [Spellcaster](https://github.com/gordonbrander/spellcaster) uses a combination of Hyperscript, Signals, and simple constructor functions to offer React-like / SwiftUI-like components:

```JavaScript
import {signal} from 'spellcaster/spellcaster.js'
import {tags, text} from 'spellcaster/hyperscript.js'
const {div, button} = tags

const Counter = () => {
  const [count, setCount] = signal(0)

  return div(
    {className: 'counter'},
    [
      div({className: 'counter-text'}, text(count)),
      button(
        {
          className: 'counter-button',
          onclick: () => setCount(count() + 1)
        },
        text('Increment')
      )
    ]
  )
}

document.body.append(Counter())
```

Signals may either be local (constructed within the function), or external (passed down as props).

### AMP

AMP is a blessed set of declarative components that have tightly-controlled composability and feature customization. Sites that publish AMP pages may have those components displayed within Google search results.

One practical thing we might learn from / potentially borrow from AMP is this notion of restricted declarative component sets.

When components are sufficiently declarative, they can be customized for display by the system in multiple contexts, and we are able to side-step a number of malicious 3P software challenges, such as cross-site scripting attacks, etc.

Depending upon our goals, this is one tool we have in our toolbelt.

### Others

- [Svelt Runes](https://svelte.dev/blog/runes)
- [Vue templates](https://vuejs.org/examples/#hello-world)
- [Mustache](https://mustache.github.io/mustache.5.html)
- [WICG Template Instantiation Proposal](https://github.com/WICG/webcomponents/blob/gh-pages/proposals/Template-Instantiation.md)
    - [Template Instantiation Proposal on CSS Tricks](https://css-tricks.com/apples-proposal-html-template-instantiation/)
- [WICG DOM Parts Proposal](https://github.com/WICG/webcomponents/blob/gh-pages/proposals/DOM-Parts.md)