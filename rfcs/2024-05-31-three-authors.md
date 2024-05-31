# Three Software Authors

This document proposes three conceptual authors of code, each making a distinctive contribution to the software ecosystem that grows around a Runtime and Build Server.

### Goals

- Define three relevant user archetypes for the humans who produce Common software

#### User stories

_As a Common employee, when I author users stories or other documents that incorporate the concept of a user who authors software, I want to reference specific user archetypes so that my audience has a shared definition for the users and workflows I'm referencing._

### Non-goals

- Define the full scope of user archetypes for the humans who produce Common software
- Define the full scope of user archetypes with adjacency to Common software

## Background

This document builds on [On-demand Isolated Modules] and [Runtime Library Registration] and assumes the reader is familiar with the contents of those documents

## The Standard Library Author

### Runtime IDL

The Standard Library Author defines an IDL that describes how Modules may communicate within and throughout a Runtime.

### Runtime Bindings

The Standard Library Author implements the IDL by producing bindings for different Runtime contexts e.g., Rust/Wasm, Browser/Wasm, Browser/SES, etc.

The Standard Library Author's code runs inside a sandbox.

## The Framework Author

### Broad Audience

The Framework Author produces software libraries or frameworks that target a programming language ecosystem. Their work may be incorporated into Common software.

### Common Audience

The Framework Author may produce libraries or frameworks (or features thereof) that are specifically intended for incorporation into Common software. These artifacts directly acknowledge and interact with the IDL defined by [The Standard Library Author].

The Framework Author's code runs inside a sandbox.

## The Module Author

The Module Author produces the distinctive business logic of a Common Module. Their code uses the IDL defined by [The Standard Library Author] to effect real IO within and throughout a Runtime.

The Module Author may incorporate libraries or frameworks produced by [The Framework Author] into their code.

The Module Author's code runs inside a sandbox.

## Example

[The Standard Library Author] defines a generalized notion of a Common Module in [WIT]:

```wit
package common:module@0.0.1;

interface module {
  resource body {
    run: func();
  }

  create: func() -> body;
}

world common {
  import common:data/types@0.0.1;
  import common:io/state@0.0.1;

  export module;
}
```

[The Framework Author] creates a higher-level abstraction that implements an ergonomic abstraction for producing a Common Module in JavaScript:

```ts
export const createModule = (implementation) => {
  class Body {
    run() {
      implementation();
    }
  }
  return {
    Body,
    create: () => new Body(),
  };
};
```

[The Module Author] uses the abstraction when creating a Common Module in JavaScript:

```ts
import { read, write } from 'common:io/state@0.0.1';
import { createModule } from '@frameworkauthor/library';

export const module = createModule(() => {
  const fooReference = read('foo');
  const foo = fooReference.deref();

  write('foo', {
    tag: 'string',
    val: foo.var + 'bar',
  });
});
```

[The Module Author]: #the-module-author
[The Framework Author]: #the-framework-author
[The Standard Library Author]: #the-standard-library-author
[On-demand Isolated Modules]: ./2024-05-19-on-demand-isolated-modules.md
[Runtime Library Registration]: ./2024-05-23-runtime-library-registration.md
[WIT]: https://github.com/WebAssembly/component-model/blob/main/design/mvp/WIT.md
