# ct-engine 

JavaScript module implementation of [ct-engine].

## Using

See `example.html` on usage.

## Building

Only this documentation, example, and tests can be found in the repository. All of the code is generated from compiling [ct-engine] via [wasm-pack].

Perform the build via nix:

```sh
nix build .#engine-web
```

[wasm-pack]: https://rustwasm.github.io
[ct-engine]: ./rust/ct-engine
