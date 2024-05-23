# Runtime Library Registration

This document proposes a mechanism for easily defining arbitrarily shaped Standard Libraries in the Runtime environment where isolated Modules are executing.

The definition mechanics enable the same conceptual Runtime to offer different access to the Standard Library across different Modules, and also across different instantiations of the same Module.

For example:

```ts
// A WIT definition for our Standard Library
const commonLoggingWit = `
package common:logging;

interface logger {
  log: func(message: string);
}

world logging {
  import logger;
  export logger;
}`;

// A WIT definition for a Module
const moduleWit = `
package example:hello;

world hello  {
  import common:logging/logger;
  export hello: func() -> string;
}`;

// Source code that implements the Module's interface
const moduleSourceCode = `
import { logger } from 'common:logging';

export function hello() {
  logger.log('Hello, Runtime!');
}`;

// A Runtime embodies the Standard Library definition...
const runtime = new Runtime([commonLogWit]);

// ..and prepares On-demand Modules without instantiating them
const preparedModule = await runtime.defineModule({
  contentType: 'text/javascript',
  wit, // The Module's WIT definition
  sourceCode, //
});

// Logging is allowed:
let { hello } = await preparedModule.instantiate({
  "common/logging": () => {
    logger: {
      log: (message: string) => console.log(message)
    }
  }
});

hello(); // "Hello, Runtime!" appears in the console

// Logging is allowed (but ignored):
const { hello } = await preparedModule.instantiate({
  "common/logging": () => {
    logger: {
      log: (message: string) => {
        // Empty implementation
      }
    }
  }
});

hello(); // Nothing appears in the console

// Logging is disallowed (and throws):
const { hello } = await preparedModule.instantiate({
  "common/logging": () => {
    logger: {
      log: () => throw "Not allowed"
    }
  }
});

hello(); // An exception is thrown

```

### Goals

- Enable quick iteration on speculative [Standard Library] interfaces
- Enable experimentation with different means of constraining Module [Capabilities]
- Suggest the future ergonomics of binding Modules to a Standard Library

#### User stories

_As a library author, when I design the shape of a library, I want to test it against real code so that I can validate the ergonomics of my designs_

_As a library author, when I design libraries for untrusted code, I want to experiment with different modes of sandbox enforcement so that I can understand their implications for library consumers_

### Non-goals

- Support Wasm runtimes other than those that are commonly available in web browsers
- Time-or-space optimal binding semantics between Modules and Standard Libraries
- Establish a security boundary for managing the execution of untrusted code
- Integrate a scheme for policy enforcement on data passed into and out of components
- Define a protocol for communication across isolated components
- Define a protocol for trustworthy remote invocation of components

## Background

This document builds on [On-demand Isolated Modules] and assumes the reader is familiar with its contents.

### Standard Libraries

Standard Libraries are implementations of common patterns and useful features that are not already expressed by elemental language constructs, typically provided by the language toolchain or runtime environment of a program.

### Capabilities

In this document, we use Capabilities to refer to what a Runtime allows or disallows a guest Module to do (insofar as the Runtime itself may have a capability within its host context).

## Runtime

A `Runtime` embodies:

- A [Standard Library] interface, defined as WIT
- A REST client for producing [On-demand Isolated Modules]

Its main interface enables the user to [Prepare a Module] for future instantiation.

### Prepare a Module

The `Runtime` performs the following steps to Prepare a Module:

1. Perform the same steps described in [On-demand Isolated Modules] to produce polyfilled Module artifacts, including the Standard Library WIT in the call to [`POST /api/v0/module`]
   - The [`POST /api/v0/module`] API of the Build Server will be expanded to accept supplementary WIT definitions in the request body and incorporate them when producing a Wasm Component
2. Prepare compiled [Wasm Modules] from each of the Module artifacts
3. Move the prepared artifacts to a `PreparedModule` and return it to the caller

## Prepared Module

A `PreparedModule` embodies:

- Polyfill artifacts consisting of [Wasm Modules] and JavaScript bindings
- A reference to the `Runtime` that created it

Its main interface enables the user to [Instantiate a Module] with a just-in-time [Standard Library]. The product of successful instantiation is always an implementation of the interface defined by the Module's WIT.

### Instantiate a Module

We refer to these types while describing this process:

```ts
type Api = {
  [index: string]: any;
};

type ApiResolver = Api | Promise<Api>;

type Library = {
  [index: string]: ApiResolver;
};
```

The caller must provide the `PreparedModule` with a `Library`. Then, the `PreparedModule` performs the following steps to Instantiate a Module:

1. Resolve every `ApiResolver` to an `Api`
2. Let `mappings` be a record that maps strings
3. For each import needed by the source Wasm Component:
   1. Let `import` be the specifier of the import
   2. If the `import` is a key in `Library`:
      1. Let `apiModule` be a JavaScript module that returns the counterpart resolved `Api`
      2. Let `specifier` be the module specifier of `apiModule`
      3. Add a mapping from the `import` to `specifier` to `mappings`
4. Instantiate the Wasm Component and return the JavaScript bindings for its interface to the caller

[On-demand Isolated Modules]: ./2024-05-19-on-demand-isolated-modules.md
[Standard Library]: #standard-libraries
[Standard Libraries]: #standard-libraries
[Capabilities]: #capabilities
[Prepare a Module]: #prepare-a-module
[Wasm Module]: https://developer.mozilla.org/en-US/docs/WebAssembly/JavaScript_interface/Module
[Wasm Modules]: https://developer.mozilla.org/en-US/docs/WebAssembly/JavaScript_interface/Module

[Instantiate a Module]: [#instantiate-a-module]
[`POST /api/v0/module`]: ./2024-05-19-on-demand-isolated-modules.md#post-apiv0module
