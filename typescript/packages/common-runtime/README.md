# common-runtime

JavaScript module implementation of [common-runtime].

## Using

See `example.html` on usage.

## Building

Only this documentation, example, and tests can be found in the repository. All of the code is generated from compiling [common-runtime] via [wasm-pack].

Perform the build via nix:

```sh
nix build .#runtime-npm-package
```

[wasm-pack]: https://rustwasm.github.io
[common-runtime]: ./rust/common-runtime