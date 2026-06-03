We use `._js` extensions here, otherwise Deno typechecks these files during compilation.
In the `iframe-bootstrap._js` case, an iframes import map resolves the imports, a different
environment than our Deno workspace. A translation layer is handled such that requesting
assets can be done without the strange file extension.

This could be remedied by the closing of https://github.com/denoland/deno/issues/27505
