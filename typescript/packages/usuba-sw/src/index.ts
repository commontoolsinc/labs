import * as apiClient from '@commontools/usuba-api';
import { polyfill, hash } from './usuba_compat/usuba_compat.component.js';

const SERVICE_WORKER_VERSION = '0.0.1';

self.addEventListener('install', (_event) => {
  console.log(
    `Usuba Service Worker installed (version ${SERVICE_WORKER_VERSION}`
  );
});

const WASI_SHIM_MAP = {
  'wasi:cli/*': '/wasi-shim/cli.js#*',
  'wasi:clocks/*': '/wasi-shim/clocks.js#*',
  'wasi:filesystem/*': '/wasi-shim/filesystem.js#*',
  'wasi:http/*': '/wasi-shim/http.js#*',
  'wasi:io/*': '/wasi-shim/io.js#*',
  'wasi:random/*': '/wasi-shim/random.js#*',
  'wasi:sockets/*': '/wasi-shim/sockets.js#*',
};

const ON_DEMAND_TRANSPILED_MODULES_CACHE_NAME =
  'v1/modules/transpiled/on-demand';
const RUNTIME_TRANSPILED_MODULES_CACHE_NAME = 'v1/modules/transpiled/runtime';

const ON_DEMAND_TRANSPILED_MODULE_DIRNAME = '/module/transpiled/on-demand';
const ON_DEMAND_BUILD_DIRNAME = '/module/on-demand';

const RUNTIME_TRANSPILED_MODULE_DIRNAME = '/module/transpiled/runtime';
const RUNTIME_BUILD_DIRNAME = '/api/v0/module';

/**
 * For a given request, if an item in the specified cache matches a specified
 * URL (which may be different from the request URL), respond from the cache.
 * Otherwise, forward the request.
 */
const respondFromCache = (event: FetchEvent, url: URL, cacheName: string) => {
  event.respondWith(
    (async () => {
      const cache = await caches.open(cacheName);
      const cacheResponse = await cache.match(url);

      if (cacheResponse) {
        return cacheResponse;
      } else {
        return fetch(event.request);
      }
    })()
  );
};

/**
 * Perform the steps to build a Module, first by invoking the Build Server
 * and then by transpiling the resulting Wasm Component. Returns the artifacts
 * of a successful transpilation.
 */
const buildModule = async (
  slug: string,
  module: File[],
  library: File[],
  instantiation: 'automatic' | 'manual' = 'automatic'
): Promise<ReturnType<typeof polyfill>> => {
  const moduleId = (
    await apiClient.buildModule({
      formData: {
        library,
        module,
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

  return polyfill(moduleBytes, {
    name: slug,
    mappings: Object.entries(WASI_SHIM_MAP),
    instantiation,
  });
};

/**
 * Cache build artifacts, and generate / cache an entrypoint "wrapper"
 * that re-exports the transpiled Wasm Component.
 */
const shrinkWrap = async (
  entrypointUrl: URL,
  wrapperModule: string,
  files: [string, Uint8Array][],
  cacheName: string,
  dirName: string
): Promise<Response> => {
  const cache = await caches.open(cacheName);

  for (const [filename, bytes] of files) {
    console.log('Caching artifact:', filename);

    const blob = new Blob([bytes], {
      type: filename.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
    });

    const nextUrl = new URL(`${dirName}/${filename}`, entrypointUrl.origin);
    await cache.put(nextUrl, new Response(blob));
  }

  const blob = new Blob([wrapperModule], { type: 'text/javascript' });
  const response = new Response(blob);

  await cache.put(entrypointUrl, response.clone());

  return response;
};

/**
 * The on-demand build flow is distinguished in two ways:
 *
 * 1. The flow starts with a GET request and yields an importable module
 * 2. Module instantiation is automatic (its imports aren't configurable)
 */
const buildOnDemandModule = (event: FetchEvent, url: URL) => {
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
        const cache = await caches.open(
          ON_DEMAND_TRANSPILED_MODULES_CACHE_NAME
        );
        const moduleShortId = polyfilledModuleId.slice(0, 6);
        const moduleSlug = `module-${moduleShortId}`;

        const entrypointModule = `${ON_DEMAND_TRANSPILED_MODULE_DIRNAME}/${moduleSlug}-wrapper.js`;
        const entrypointUrl = new URL(entrypointModule, url.origin);

        const cacheItem = await cache.match(entrypointUrl);

        if (typeof cacheItem != 'undefined') {
          console.log('Polyfilled on-demand module found in cache!');
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

        const {
          files,
          imports: _imports,
          exports: _exports,
        } = await buildModule(
          moduleSlug,
          [witFile, sourceCodeFile],
          [],
          'automatic'
        );

        const wrapperModule = `export * from '${ON_DEMAND_TRANSPILED_MODULE_DIRNAME}/${moduleSlug}.js'`;

        return await shrinkWrap(
          entrypointUrl,
          wrapperModule,
          files,
          ON_DEMAND_TRANSPILED_MODULES_CACHE_NAME,
          ON_DEMAND_TRANSPILED_MODULE_DIRNAME
        );
      } else {
        return new Response(new Blob([], { type: 'text/html' }), {
          status: 404,
        });
      }
    })()
  );
};

/**
 * A Runtime Module is built when the Service Worker intercepts an API request
 * to the Build Server. The Wasm Component (produced by the Build Server) is
 * transpiled and cached locally, and a derived Module ID is given to the caller
 * (not the original Wasm Component ID). This allows the caller to provide an
 * arbitrary number of input files with an initial POST, and then instantiate
 * the Runtime Module "just in time" using a secondary import.
 *
 * Instantiation of a Runtime Module is manual, which means that it allows for
 * imports to be configured at instantiation time. But, it also means that a
 * Runtime Module cannot be imported transparently the way an On-demand Module
 * can. Instead, the result of importing a Runtime Module is an `instantiate`
 * function that yields the actual module.
 */
const buildRuntimeModule = (event: FetchEvent, url: URL) => {
  event.respondWith(
    (async () => {
      const formData = await event.request.formData();
      const moduleFiles = formData.getAll('module') as File[];
      const libraryFiles = formData.getAll('library') as File[];

      const allFiles = moduleFiles.concat(libraryFiles);

      const runtimeModuleId = hash(
        new Uint8Array(
          await new Blob(
            await Promise.all(allFiles.map((file) => file.arrayBuffer()))
          ).arrayBuffer()
        )
      );

      const cache = await caches.open(RUNTIME_TRANSPILED_MODULES_CACHE_NAME);
      const moduleShortId = runtimeModuleId.slice(0, 6);
      const moduleSlug = `module-${moduleShortId}`;

      const buildResultPath = `${RUNTIME_TRANSPILED_MODULE_DIRNAME}/result-${moduleSlug}.json`;
      const buildResultUrl = new URL(buildResultPath, url.origin);

      const cacheItem = await cache.match(buildResultUrl);

      if (typeof cacheItem != 'undefined') {
        console.log('Polyfilled runtime module build result found in cache!');
        return cacheItem;
      }

      const {
        files,
        imports: _imports,
        exports: _exports,
      } = await buildModule(moduleSlug, moduleFiles, libraryFiles, 'manual');

      const wasiShimImports = [];

      for (const specifier of Object.values(WASI_SHIM_MAP)) {
        const trimmedSpecifier = specifier.split('#').shift();
        wasiShimImports.push(`'${trimmedSpecifier}': import('${specifier}')`);
      }

      // const wrapperModule = `export * from '${ON_DEMAND_TRANSPILED_MODULE_DIRNAME}/${moduleSlug}.js'`;
      const wrapperModule = `import {instantiate as innerInstantiate} from '${RUNTIME_TRANSPILED_MODULE_DIRNAME}/${moduleSlug}.js';

const wasiShimImportPromises = {
  ${wasiShimImports.join(',\n  ')}
};

const wasiShimImports = Promise.all(
  Object.entries(wasiShimImportPromises)
    .map(([specifier, importPromise]) =>
      importPromise.then((importResult) => [specifier, importResult])
    )
);

export const instantiate = async (imports) => {
  const resolvedWasiShimImports = await wasiShimImports;

  for (const [name, shimImport] of resolvedWasiShimImports) {
    if (typeof imports[name] == 'undefined') {
      imports[name] = shimImport;
    }
  }

  const getCoreModule = async (name) => fetch('${RUNTIME_TRANSPILED_MODULE_DIRNAME}/' + name).then(WebAssembly.compileStreaming);
  console.log('Instantiating with:', imports);
  return innerInstantiate(getCoreModule, imports);
};`;

      await shrinkWrap(
        new URL(
          `${RUNTIME_TRANSPILED_MODULE_DIRNAME}/${runtimeModuleId}.js`,
          url.origin
        ),
        wrapperModule,
        files,
        RUNTIME_TRANSPILED_MODULES_CACHE_NAME,
        RUNTIME_TRANSPILED_MODULE_DIRNAME
      );

      const response = new Response(
        new Blob([JSON.stringify({ id: runtimeModuleId })], {
          type: 'application/json',
        })
      );

      await cache.put(buildResultUrl, response.clone());

      return response;
    })()
  );
};

self.addEventListener('fetch', async (event: FetchEvent) => {
  const requestUrl = new URL(event.request.url);

  switch (event.request.method) {
    case 'GET':
      if (requestUrl.pathname.startsWith(ON_DEMAND_TRANSPILED_MODULE_DIRNAME)) {
        respondFromCache(
          event,
          requestUrl,
          ON_DEMAND_TRANSPILED_MODULES_CACHE_NAME
        );
      } else if (
        requestUrl.pathname.startsWith(RUNTIME_TRANSPILED_MODULE_DIRNAME)
      ) {
        respondFromCache(
          event,
          requestUrl,
          RUNTIME_TRANSPILED_MODULES_CACHE_NAME
        );
      } else if (requestUrl.pathname.startsWith(ON_DEMAND_BUILD_DIRNAME)) {
        buildOnDemandModule(event, requestUrl);
      }
      break;
    case 'POST':
      if (requestUrl.pathname.startsWith(RUNTIME_BUILD_DIRNAME)) {
        buildRuntimeModule(event, requestUrl);
      }
      break;
    default:
      break;
  }
});
