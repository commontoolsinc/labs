# UI component model

Authors: Gordon Brander

## Overview

Context: converge on a default UI component model for LLM-generated UI.

## Goals

### Product goals

- Easy for LLMs to generate
    - Leverages patterns and/or frameworks that are widely present in the training data, or can be learned within a small context window.
- Easy for humans to edit
    - [Maybe it’s not even code?](https://x.com/threepointone/status/1792930000766677034) Or maybe it’s a hybrid of code and plain language?
- Leverages familiar or established patterns for UI development
- Conformable with existing web FE toolchains.

### Technical goals

- Components are **encapsulated** (P1)
    - A component may control its child tree, but not its siblings or parent
- Components have **inputs**, and **output UI** and **events** (P1)
    - Components can be understood as pure-ish functions that receive props and return a view description (we may allow cheats for local component state ala hooks)
    - Components are **black boxes**
    - Components are decoupled and only communicate via input and output channels.
- Component **inputs** and **outputs** are **statically-typed** (P1)
    - E.g. via TypeScript
    - Allows the runtime to enforce data policies on component
- Components have **local state** (P1)
    - State is encapsulated within component
    - Components may pass state down to child components as input
        - E.g. the React **[“lifting state up” pattern](https://legacy.reactjs.org/docs/lifting-state-up.html)**.
    - Local state may be **persisted**.
        - If it isn’t, it is **ephemeral**, and lasts for the lifetime of the component.
- Components are **islands** (P1)
    - Components can be used free-standing, or within a larger component tree.
    - Note: this is in contrast to something like the Elm App Architecture Pattern, where models, views, and update functions are “zippered” together, meaning components are “some assembly required”. This would fall short of this goal without some additional means of making an individual component a free-standing island.
- Components are **composable** (P1)
    - Components can be combined together like lego to create larger components
    - Composing plugins should be as easy as plugging together component inputs, outputs, and events, and arranging a UI tree. It shouldn’t be more complicated than that.
- Components can have **holes**, allowing you to slot in an arbitrary component of the right shape. (P1)
    - Inversion of control for templates.
    - The shape of the hole is determined by the data’s input and output types
    - Example mechanisms
        - [slots](https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_templates_and_slots)
        - [passing down closures that evaluate to components](https://swiftwithmajid.com/2019/11/06/the-power-of-closures-in-swiftui/) 
        - [overridable blocks](https://mustache.github.io/mustache.5.html#Blocks)
- Components have **[high locality of behavior](https://github.com/gordonbrander/generative-ui-playbook?tab=readme-ov-file#llms-work-best-with-high-locality)** (P1)
    - All component behavior is colocated, including structure, style, and behavior
- Components are relatively **small**
    - LLMs will have higher accuracy generating small islands of interactivity vs whole apps
    - Small composable components are easier to understand and debug
- UI **templates** are **pure functions** (P1)
    - Templates take inputs, and output a UI tree and events
    - Templates produce a UI tree that is easy for the runtime to analyze and sanitize (probably a VDOM, probably not raw DOM).
- Components are renderable to web (P1)
    - Other platforms may be supported in future, but web platform is primary

Soft goals:

- UI templates are static (P3)
    - They are compiled once at program start, and produce a static tree with specific “binding points” in the tree, where dynamic values and dynamic lists are rendered.
    - This may have a performance advantage over a totally dynamic VDOM tree, since it would allow us to analyze and enforce policies on the tree once, rather than after every render

### Non-goals

- Separation of concerns. At odds with high locality of behavior.

## Proposal

## Alternatives

### React-style functional components

### Stateless templates

Borrowing ideas from Mustache, Vue, and Svelte, we could separate logic from template. This would make the template a pure function. It would also encourage factoring out the logic into signal transformations.

Key features:

- All domain logic is pulled out of the template and is performed as signal graph transformations outside of the template.
- Signals, values, and callbacks are exported from the “script” portion of the module
- Mustache-style static templates
    - Ordinary values are rendered statically
    - Signals are rendered reactively
    - Callbacks can be used to send messages up from the template

A simple counter example:

```html
<script>
  const [count, setCount] = signal(0)
  export count

  const [clicks, setClicks] = stream()
  export setClicks

  clicks.sink(_ => setCount(count() + 1))
</script>

<template>
  <a onclick="{{setClicks}}">The count is: {{count}}</a>
</template>
```

Under the hood, the system might be doing something like this:

```js
// ...Somewhere in the runtime, invisible to the module...

// Preprocessor somehow gets exports from script block
import * as env from 'module:script'

// Env contains the exported variables. E.g.
// const {setClicks, count} = env

// Template is populated and returns a UI tree with dynamic bindings
// at specific locations in the tree
const vdom = populate(template, env)

// Prune or sanitize as needed
const cleanVdom = sanitize(vdom)

// System manages rendering. Modules never have direct access to DOM
render(dom, cleanVdom)
```

## Open questions

## Prior art

- [Svelt Runes](https://svelte.dev/blog/runes)
- [Vue templates](https://vuejs.org/examples/#hello-world)
- [Mustache](https://mustache.github.io/mustache.5.html)
- [WICG Template Instantiation Proposal](https://github.com/WICG/webcomponents/blob/gh-pages/proposals/Template-Instantiation.md)
    - [Template Instantiation Proposal on CSS Tricks](https://css-tricks.com/apples-proposal-html-template-instantiation/)
- [WICG DOM Parts Proposal](https://github.com/WICG/webcomponents/blob/gh-pages/proposals/DOM-Parts.md)