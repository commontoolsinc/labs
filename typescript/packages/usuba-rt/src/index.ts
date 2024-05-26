import * as apiClient from '@commontools/usuba-api';

export type SourceCode = string | Uint8Array;
export type PendingSourceCode = SourceCode | Promise<SourceCode>;

export type ContentType = 'text/javascript';

export type ContentTypeFileExtensions = {
  [C in ContentType]: string;
};

export interface ModuleDefinition {
  contentType: ContentType;
  wit: PendingSourceCode;
  sourceCode: PendingSourceCode;
}

export type Import = {
  [index: string]: any;
};

export type ImportMap = {
  [index: string]: Import;
};

export type Importable = string | Import | Promise<Import>;

export type ImportableMap = {
  [index: string]: Importable;
};

const FILE_EXTENSIONS: ContentTypeFileExtensions = {
  'text/javascript': 'js',
};

/**
 * A Runtime embodies:
 *
 * - A Standard Library interface, defined as WIT
 * - A REST client for producing On-demand Isolated Modules
 *
 * Its main interface enables the user to Prepare a Module for future
 * instantiation.
 *
 * When constructing a Runtime, the provided library may be a mix of actual WIT
 * definitions or promises that resolve to WIT definitions.
 */
export class Runtime {
  #library: Promise<File[]>;

  constructor(library: PendingSourceCode[]) {
    this.#library = Promise.all(library).then((library) =>
      library.map(
        (item, index) =>
          new File(
            [new Blob([item], { type: 'text/plain' })],
            `library-${index}.wit`
          )
      )
    );
  }

  /**
   * Prepares a module for instantiation by converting the provided source
   * definition to a Wasm Component, and then subsequently polyfilling it for
   * browser-based Core Wasm. The resulting prepared module can be instantiated
   * by providing it with a working implementation of the library associated
   * with the runtime that defined it.
   *
   * @param definition The essential details of the module being defined
   * @returns A promise that resolves to the prepared
   */
  async defineModule<T>(
    definition: ModuleDefinition
  ): Promise<PreparedModule<T>> {
    const [library, wit, sourceCode] = await Promise.all([
      this.#library,
      definition.wit,
      definition.sourceCode,
    ]);

    const { id } = await apiClient.buildModule({
      formData: {
        library,
        module: [
          new File([new Blob([wit], { type: 'text/plain' })], 'module.wit'),
          new File(
            [new Blob([sourceCode], { type: definition.contentType })],
            `module.${FILE_EXTENSIONS[definition.contentType]}`
          ),
        ],
      },
    });

    const { instantiate } = await import(
      /* @vite-ignore */ `/module/transpiled/runtime/${id}.js`
    );

    return new PreparedModule(
      instantiate as (imports: ImportMap) => Promise<T>
    );
  }
}

/**
 * A PreparedModule embodies:
 *
 * - Polyfill artifacts consisting of Wasm Modules and JavaScript bindings
 * - Association to the Runtime that created it through its Standard Library
 *
 * Its main interface enables the user to Instantiate a Module with a
 * just-in-time Standard Library. The product of successful instantiation is
 * always an implementation of the interface defined by the Module's WIT.
 */
export class PreparedModule<T> {
  #instantiate: (imports: ImportMap) => Promise<T>;

  constructor(instantiate: any) {
    this.#instantiate = instantiate;
  }

  /**
   * Instantiates a prepared module, yielding a promise that resolves to the
   * module's API (as defined in its WIT).
   *
   * In order to instantiate the prepared module, you must provide it with a
   * mapping of module specifiers to concrete implementations. These will be
   * used to populate the "library" associated with the prepared module's
   * runtime. Only the imports that are made use of by the code in the prepared
   * module need to be specified.
   *
   * This method uses different techniques to resolve a concrete library
   * implemenetation depending on the value type in the provided mapping:
   *
   * - string: the value will be treated as a module specifier, and will be
   *   resolved using a dynamic import
   * - promise: the value will be the resolved value of the promise
   * - all other types are treated as a candidate implementation of the library
   *
   * @param importables A mapping of library imports to their eventual
   * implementations
   * @returns A promise that resolves to the instantiated module's API
   */
  async instantiate(importables: ImportableMap): Promise<T> {
    const importedEntries = (await Promise.all(
      Object.entries(importables).map(async ([key, importable]) => {
        if (typeof importable == 'string') {
          importable = import(/* @vite-ignore */ importable) as Promise<Import>;
        }

        return [key, await importable];
      })
    )) as [string, Import][];

    const imports = importedEntries.reduce((map, [key, imported]) => {
      map[key] = imported;
      return map;
    }, {} as ImportMap);

    return await this.#instantiate(imports);
  }
}
