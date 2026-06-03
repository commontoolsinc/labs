# Vendor Fork

Fork based on [https://github.com/jsantell/astral/tree/pierce-selector] branch, implementing
Puppeteer-style pierce selectors, until [https://github.com/lino-levan/astral/pull/166] can be landed
and published.

Additional changes needed for pulling into the Deno workspace:

* Remove `unstable` flag from deno.json
* Remove `compilerOptions` from deno.json
* Remove unstable worker options in WebWorker in Page
  * Challenges mixing unstable flags within workspace, probably achieveable,
    but for now, just removing these options when sandboxing the tests
    (which we do not use)