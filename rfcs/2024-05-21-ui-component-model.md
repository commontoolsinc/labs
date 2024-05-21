# UI component model

Authors: Gordon Brander

## Overview

Context: converge on a default UI component model for LLM-generated UI.

## Goals

Product goals:

- Easy for LLMs to generate
    - Leverages patterns and/or frameworks that are widely present in the training data, or can be learned within a small context window.
- Easy for humans to edit
- Leverages familiar or established patterns for UI development
- Conformable with existing web FE toolchains.

Technical goals:

- Components are encapsulated 
  - A component may control its child tree, but not its siblings or parent
  - Components are black boxes, with inputs and outputs
- Components have inputs, and output UI and events
    - Are pure-ish functions of state (we may allow cheats for local component state ala hooks)
    - Component inputs and outputs are statically-typed
        - E.g. via TypeScript
        - Allows the runtime to enforce data policies on component
- Components have local state
    - State is encapsulated within component
    - Components may pass state down to child components as input
        - E.g. the React “[lifting state up](https://legacy.reactjs.org/docs/lifting-state-up.html)” pattern.
    - Local state may be persisted. If it isn’t, it is ephemeral, and lasts for the lifetime of the component.
- Components are islands
    - Components can be used free-standing, or within a larger component tree.
    - Note: in something like the Elm App Architecture Pattern, Models, Views, and Update functions are “zippered” together, meaning components are “some assembly required”. This would fall short of this goal without some additional means of making an individual component free-standing.
- Components are composable
    - Components can be combined together like lego to create larger components
    - Composition should involve plugging together component inputs, outputs, and events, and arranging UI tree. It shouldn’t be more complicated than that.
- Components can have “holes”, allowing you to slot in an arbitrary component of the right shape.
    - Inversion of control for templates.
    - The shape of the hole is determined by the data input and output types
    - Example mechanisms: [slots](https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_templates_and_slots), [passing down closures that evaluate to components](https://swiftwithmajid.com/2019/11/06/the-power-of-closures-in-swiftui/), [overridable blocks](https://mustache.github.io/mustache.5.html#Blocks), etc.
- Components have [high locality of behavior](https://github.com/gordonbrander/generative-ui-playbook?tab=readme-ov-file#llms-work-best-with-high-locality)
- UI templates are pure functions of state
    - Templates take inputs, and output a UI tree and events
    - Templates produce a UI tree that is easy for the runtime to analyze and sanitize (probably a VDOM, probably not raw DOM).
- Components can be rendered on the web platform

Soft goals:
- UI templates are static
    - They are compiled once at program start, and produce a static tree with specific “binding points” in the tree, where dynamic values and dynamic lists are rendered.
    - This may have a performance advantage over a totally dynamic VDOM tree, since it would allow us to analyze and enforce policies on the tree once, rather than after every render

Non-goals:

- Separation of concerns. At odds with high locality of behavior.

## Proposal



## Open questions

## Prior art

- [Svelt Runes](https://svelte.dev/blog/runes)
- [Vue templates](https://vuejs.org/examples/#hello-world)
- [Mustache](https://mustache.github.io/mustache.5.html)
- [WICG Template Instantiation Proposal](https://github.com/WICG/webcomponents/blob/gh-pages/proposals/Template-Instantiation.md)
    - [Template Instantiation Proposal on CSS Tricks](https://css-tricks.com/apples-proposal-html-template-instantiation/)
- [WICG DOM Parts Proposal](https://github.com/WICG/webcomponents/blob/gh-pages/proposals/DOM-Parts.md)