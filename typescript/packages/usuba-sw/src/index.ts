import * as apiClient from './openapi-client/services.gen';
import { polyfill, hash } from './usuba_compat/usuba_compat.component.js';

self.addEventListener('install', (_event) => {
  console.log('Usuba Service Worker installed');
});

const TRANSPILED_MODULES_CACHE_NAME = 'v1/modules/transpiled';

const respondFromCache = (event: FetchEvent, url: URL) => {
  event.respondWith(
    (async () => {
      const cache = await caches.open(TRANSPILED_MODULES_CACHE_NAME);
      const cacheResponse = await cache.match(url);

      if (cacheResponse) {
        return cacheResponse;
      } else {
        return fetch(event.request);
      }
    })()
  );
};

const buildModule = (event: FetchEvent, url: URL) => {
  event.respondWith(
    (async () => {
      console.log('On-demand module generation detected...');
      url.pathname.split('/').slice(2);

      const [ext, witBase64, sourceCodeBase64] = url.pathname
        .split('/')
        .slice(3);

      console.log('Attempting to parse on-demand path fragment...');

      if (ext && witBase64 && sourceCodeBase64) {
        const encoder = new TextEncoder();
        const polyfilledModuleId = hash(
          encoder.encode(`${witBase64}.${sourceCodeBase64}`)
        );
        const cache = await caches.open(TRANSPILED_MODULES_CACHE_NAME);
        const moduleShortId = polyfilledModuleId.slice(0, 6);
        const moduleSlug = `module-${moduleShortId}`;

        const entrypointModule = `/module/tra'v1/modules/transpiled'nspiled/${moduleSlug}-wrapper.js`;
        const entrypointUrl = new URL(entrypointModule, url.origin);

        const cacheItem = await cache.match(entrypointUrl);

        if (typeof cacheItem != 'undefined') {
          console.log('Polyfilled module found in cache!');
          return cacheItem;
        }

        console.log("Nothing found in cache; we'll do it live!");

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

        const moduleId = (
          await apiClient.buildModule({
            formData: {
              library: [],
              module: [witFile, sourceCodeFile],
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

        const {
          files,
          imports: _imports,
          exports: _exports,
        } = polyfill(moduleBytes, {
          name: moduleSlug,
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

          const nextUrl = new URL(`/module/transpiled/${filename}`, url.origin);
          await cache.put(nextUrl, new Response(blob));
        }

        const wrapperModule = `export * from '/module/transpiled/${moduleSlug}.js'`;
        const blob = new Blob([wrapperModule], { type: 'text/javascript' });
        const response = new Response(blob);

        await cache.put(entrypointUrl, response.clone());

        return response;
      } else {
        return new Response(new Blob([], { type: 'text/html' }), {
          status: 404,
        });
      }
    })()
  );
};

self.addEventListener('fetch', async (event: FetchEvent) => {
  if (event.request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(event.request.url);

  if (requestUrl.pathname.startsWith('/module/transpiled')) {
    respondFromCache(event, requestUrl);
  } else if (requestUrl.pathname.startsWith('/module/on-demand')) {
    buildModule(event, requestUrl);
  }
});

/*
          

          
*/
