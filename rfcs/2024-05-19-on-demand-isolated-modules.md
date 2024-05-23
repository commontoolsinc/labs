# On-demand Isolated Modules

This document proposes a basic assembly of tools and processes that aims to significantly reduce the time and effort required to experiment with multi-language isolated modules within a host web browser Wasm runtime.

In most cases, the workflow may be reduced to importing a JavaScript module (available with associated TypeScript definitions) using the base64-encoded source file as a module specifier. For example:

```ts
// Example component IDL, common to both components
const witComponentDefinition = `
package example:hello;
world hello {
  export hello: func() -> string;
}`;

// Python implementation
const pythonSourceCode = `
import hello
class Hello(hello.Hello):
    def hello(self) -> str:
        return "Hello, Python!"`;

// JavaScript implementation
const javascriptSourceCode = `
export function hello() {
  return 'Hello, JavaScript!'
}`;

// Base64-encode all sources
const witBase64 = atob(witComponentDefinition);
const pythonBase64 = atob(pythonSourceCode);
const javascriptBase64 = atob(javascriptSourceCode);

// Import the modules:
const { pythonComponent } = await import(
  `/module/on-demand/py/${witComponentDefinition}/${pythonSourceCode}`
);

const { javascriptComponent } = await import(
  `/module/on-demand/js/${witComponentDefinition}/${javascriptSourceCode}`
);

// Prints "Hello, Python!" to the console
console.log(pythonComponent.hello());

// Prints "Hello, JavaScript!" to the console
console.log(javascriptComponent.hello());
```

In the example above, the action of importing each JavaScript module invokes Wasm Component compilation / transpilation and Wasm instantiation behind the scenes, producing "on-demand" isolated Modules with high-level, comprehensively-typed JavaScript interfaces. The interface exported by the on-demand module can be invoked, re-exported and/or incorporated idiomatically into other standard JavaScript modules.

Although the example uses [dynamic import][dynamic-import], the import specifiers should work equally well when used with static imports.

### Goals

- Enable low-friction, browser-based experimentation with isolated components written in multiple languages

#### User stories

_As a library developer, when I design new libraries or frameworks, I want an easy way to experiment with the implications of running code in isolation_

_As an app developer, when I tell an LLM to generate a chunk of code in my (or the LLM's) language of choice, I want an easy way to integrate the code in my web app_

### Non-goals

- Implement a mechanism to provide a pre-defined, custom "standard library" to components (this will be the subject of a future RFC)
- Prescribe specific userspace APIs or capabilities that will be available to components
- Establish a security boundary for managing the execution of untrusted code
- Integrate a scheme for policy enforcement on data passed into and out of components
- Define a protocol for communication across isolated components
- Define a protocol for trustworthy remote invocation of components

## Background

### Wasm

[Web Assembly (Wasm)][wasm] presents a tantelizing substrate for browser-based isolated components. In 2024, it is possible to run programs written in many languages (C, Rust, JavaScript, Java and Python to name just a few) within the Wasm runtime that is available in all major web browsers. Furthermore, [Wasm Components][wasm-components] provide a common IDL ([WIT][wit]) and ABI for connecting Wasm originating from different language toolchains. [The Bytecode Alliance][bytecode-alliance] hosts a number of tools that enable polyfill-like workflows while Wasm Components are still nascent.

#### Core Wasm and Wasm Components

Wasm runtimes in web browsers all implement [Core Wasm], which may be thought of as the minimum viable API for Wasm to be a useful construct.

[Wasm Components][wasm-components] constitute an ABI defined on top of [Core Wasm], as part of ongoing [WASI] development efforts. Native support for Wasm Components is available in some Wasm runtimes, but it is not as ubiquitous as [Core Wasm].

### Modules

Modules are our domain jargon for a self-contained unit of code suitable for variable runtime environments. In our jargon, a [Wasm Component][wasm-components] may be thought of as a special case of a Module.

For the purposes of reasoning about what may or may not be part of a Module's interface: anything that can be expressed in a [WIT][wit] definition is considered a candidate (this means you can express anything you want, probably).

### Isolation

The techniques in this document are centered on making Modules out of [Wasm][wasm]. Therefor, when the term isolation is used, it mainly refers to the properties enabled by the Wasm runtime insofar as we may access it in a web browser. In a typical case, a Wasm module:

- Will have its own, unshared buffer of memory
- May only import objects, capabilities and metadata from "outside" the runtime when they are explicitly provided by its host
- Must be invoked explicitly by its host

Wasm provides a reasonable, basic substrate for Module isolation. But, it's important to note that this isolation does not constitute a security boundary. It is easy to accidentally grant more capabilities than intended to a Wasm module when providing it access to host APIs (especially within a web browser host). And, vulnerabilities such as [Specter][specter] and [Rowhammer][rowhammer] are theoretically possible to exploit from a Wasm module.

## Tools

### Code transformation

The primary code transformation tools that we will make use of are produced and maintained by the [Bytecode Alliance][bytecode-alliance]. They include the following:

- [`js-component-bindgen`][js-component-bindgen]: A transpiler that converts any valid [Wasm Component][wasm-components] to browser-compatible Core Wasm + TypeScript definitions + JavaScript bindings
- [`ComponentizeJS`][componentize-js]: Compiles a SpiderMonkey-derived JS VM and inlines target JavaScript to produce a Wasm Component
- [`componentize-py`][componentize-py]: Compiles target Python to produce a Wasm Component
- [`cargo component`][cargo-component]: A `cargo` subcommand for building Wasm Components from Rust

### Build Server

We will create a Build Server. The Build Server is responsible transforming received WIT component definitions and source code and serving valid [Wasm Components][wasm-components] derived from those inputs.

The Build Server provides a REST API domain in service of this responsibility.

#### POST /api/v0/module

Accepts `multipart/form-data` requests.

For the first version, the body is expected to contain two files:

- A WIT component definition
- A single source code file that implements the suggested component interface

To handle a valid request, the Build Server must:

1. Perform steps to compile the inputs into a valid [Wasm Component][wasm-components] (varies by language)
   - The filename of the source code in the `multipart/form-data` body will be referenced to determine which language toolchain applies
2. Calculate the BLAKE3 hash of the resulting Wasm Component
3. Store the Wasm so that it may be looked up by its hash in a future request

The Build Server then responds with:

```ts
{
  error: null|string, // User-actionable API errors, if any
  id: null|string     // The hash of the Wasm Component, if it was built successfully
}
```

In the future, we may expand on this API to support many WIT definitions and source files in a single request (including support for many languages in one collection of files).

#### GET /api/v0/module/:id

This API serves [Wasm Components][wasm-components] that were successfully built by earlier requests to [POST /api/v0/component](#post-apiv0component).

The `id` should be set to the `id` value in the response from an earlier invocation of [POST /api/v0/component](#post-apiv0component).

The response has `Content-Type: application/wasm` and the body is an octet stream of the prepared [Wasm Component][wasm-components].

## Assembly

With the [Build Server](#build-server) in place - enabled by the [code transformation](#code-transformation) toolchains that are available today and maintained by the [Bytecode Alliance][bytecode-alliance] - we have the basic ingredients needed to assemble a low-friction workflow.

Web browsers do not currently support [Wasm Components][wasm-components]. Fortunately, Wasm Components can be expressed in terms of Core Wasm, so it is possible to polyfill support for Wasm Components in web browsers.

The [js-component-bindgen] Rust crate provides an API for transforming any valid Wasm Component into browser-compatible Core Wasm, including corresponding TypeScript definitions and high-level JavaScript bindings that export the component's API (as described in its [WIT][wit] definition). Conveniently, the [js-component-bindgen] crate can also be compiled to Wasm and run in a web browser.

### Service Worker

We will create a [Service Worker] that wraps up the capabilities of [js-component-bindgen] in order to polyfill transparent, on-demand support for [Wasm Components][wasm-components] in a web browser.

The Service Worker intercepts `GET` requests to a well-known local path. For the purposes of this document, we'll say that the matching path looks like `/module/on-demand/:ext/:wit/:source_code`. When a request is made to that path, the Service Worker performs the following steps:

1. Resolve the [WIT][wit] component definition by base64-decoding the `wit` part of the path
2. Resolve the component source code by base64-decoding the `source_code` part of the path
3. Prepare a `multipart/form-data` request body that includes two files:
   1. `component.wit`: The resolved WIT component definition
   2. `component.$EXT`: The resolved source file, where `$EXT` is replaced with the `ext` part of the path
4. Make a request to [`POST /api/v0/module`](#post-apiv0component) on a running [Build Server](#build-server) using the prepared request body
5. Make a request for the prepared [Wasm Component][wasm-components] using [`GET /api/v0/module/:id`](#get-apiv0componentid) on a running Build Server
6. Invoke the [`transpile`][js-component-bindgen-transpile] API provided by [js-component-bindgen] and cache the returned files at the appropriate paths
7. Create a wrapper ESM that imports the cached artifacts and re-exports the component API
8. Respond to the intercepted request with the generated wrapper module

## PAQ

**Why have two separate REST APIs for module building and retrieval?**

We may build a component once but request it many times.

**Why not just serve polyfilled Wasm Components from the Build Server?**

Wasm Components in their raw form are portable. When we polyfill the component, we generate binary artifacts that target a specific platform (distinguished mainly by the properties of its Wasm runtime). Therefor, the number of artifacts that must be produced to support a single target is multiplied by the number of targets we are interested in supporting.

Additionally, once polyfilled the Wasm Component effectively consists of many files (the basic Hello World becomes 5 essential files, or 23 if you include all the TypeScript definition files). This makes them cumbersome to deliver as compared to a single Wasm Component.

**JavaScript Wasm Components inline a whole JS VM. Won't this take up a lot of space in cache?**

Yes. Each instance of the JS VM equals about 8MB of Wasm. There are strategies we might explore that may enable code-sharing under certain circumstances. But, for now this problem will remain unaddressed.

## Milestones

- Create the [Build Server](#build-server)
- Create the [Service Worker](#service-worker)
- Vend Build Server and Service Worker together in a turnkey NPM/Cargo-installable package

[wasm]: https://webassembly.org/
[bytecode-alliance]: https://bytecodealliance.org/
[wasm-components]: https://component-model.bytecodealliance.org/
[wit]: https://github.com/WebAssembly/component-model/blob/main/design/mvp/WIT.md
[dynamic-import]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/import
[specter]: https://en.wikipedia.org/wiki/Spectre_(security_vulnerability)
[rowhammer]: https://en.wikipedia.org/wiki/Row_hammer
[js-component-bindgen]: https://github.com/bytecodealliance/jco/tree/main/crates/js-component-bindgen
[componentize-js]: https://github.com/bytecodealliance/ComponentizeJS
[componentize-py]: https://github.com/bytecodealliance/componentize-py
[cargo-component]: https://github.com/bytecodealliance/cargo-component
[Service Worker]: https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API
[js-component-bindgen-transpile]: https://docs.rs/js-component-bindgen/latest/js_component_bindgen/fn.transpile.html
[Core Wasm]: https://www.w3.org/TR/wasm-core-1/
[WASI]: https://wasi.dev/
