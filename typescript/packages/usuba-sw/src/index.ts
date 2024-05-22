import * as apiClient from './openapi-client/services.gen';
import { polyfill } from './usuba_compat/usuba_compat.component.js';

self.addEventListener('install', (_event) => {
  console.log('Usuba Service Worker installed');
});

self.addEventListener('fetch', async (event: FetchEvent) => {
  if (event.request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(event.request.url);

  if (requestUrl.pathname.startsWith('/module/transpiled')) {
    console.log('Pulling generated artifact from cache...');
    event.respondWith(
      (async () => {
        const cache = await caches.open('v0/modules/transpiled');
        const cacheResponse = await cache.match(requestUrl);
        if (cacheResponse) {
          return cacheResponse;
        } else {
          return fetch(event.request);
        }
      })()
    );
  } else if (requestUrl.pathname.startsWith('/module/on-demand')) {
    console.log('On-demand module generation detected...');
    requestUrl.pathname.split('/').slice(2);

    const [ext, witBase64, sourceCodeBase64] = requestUrl.pathname
      .split('/')
      .slice(3);

    console.log('Attempting to parse on-demand path fragment...');

    if (ext && witBase64 && sourceCodeBase64) {
      const wit = atob(witBase64);
      const sourceCode = atob(sourceCodeBase64);

      console.log('File extension:', ext);
      console.log('WIT:\n', wit);
      console.log('Source Code:\n', sourceCode);

      const witFile = new File([new Blob([wit])], 'module.wit');
      const sourceCodeFile = new File(
        [new Blob([sourceCode])],
        `module.${ext}`
      );

      event.respondWith(
        (async () => {
          const moduleId = (
            await apiClient.buildModule({
              formData: {
                files: [witFile, sourceCodeFile],
              },
            })
          ).id;

          const moduleBytes = new Uint8Array(
            await (
              await apiClient.retrieveModule({
                id: moduleId,
              })
            ).arrayBuffer()
          );
          const cache = await caches.open('v0/modules/transpiled');
          const fileSlug = `module-${moduleId.slice(0, 6)}`;

          const entrypointModule = `/module/transpiled/${fileSlug}.js`;
          const maybeHotUrl = new URL(entrypointModule, requestUrl.origin);

          if (!(await cache.match(maybeHotUrl))) {
            const {
              files,
              imports: _imports,
              exports: _exports,
            } = polyfill(moduleBytes, {
              name: fileSlug,
              mappings: Object.entries({
                'wasi:cli/*': '/wasi-shim/cli.js#*',
                'wasi:clocks/*': '/wasi-shim/clocks.js#*',
                'wasi:filesystem/*': '/wasi-shim/filesystem.js#*',
                'wasi:http/*': '/wasi-shim/http.js#*',
                'wasi:io/*': '/wasi-shim/io.js#*',
                'wasi:random/*': '/wasi-shim/random.js#*',
                'wasi:sockets/*': '/wasi-shim/sockets.js#*',
              }),
            });

            for (const [filename, bytes] of files) {
              console.log('Caching artifact:', filename);
              const blob = new Blob([bytes], {
                type: filename.endsWith('.wasm')
                  ? 'application/wasm'
                  : 'text/javascript',
              });
              const url = new URL(
                `/module/transpiled/${filename}`,
                requestUrl.origin
              );

              await cache.put(url, new Response(blob));
            }
          }

          const wrapperModule = `export * from '/module/transpiled/${fileSlug}.js'`;
          const blob = new Blob([wrapperModule], { type: 'text/javascript' });

          return new Response(blob);
        })()
      );
    }
  }
});

/*
          

          
*/
