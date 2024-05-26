import * as apiClient from '@commontools/usuba-api';
const FILE_EXTENSIONS = {
    'text/javascript': 'js',
};
export class Runtime {
    #library;
    constructor(library) {
        this.#library = Promise.all(library).then((library) => library.map((item, index) => new File([new Blob([item], { type: 'text/plain' })], `library-${index}.wit`)));
    }
    async defineModule(definition) {
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
                    new File([new Blob([sourceCode], { type: definition.contentType })], `module.${FILE_EXTENSIONS[definition.contentType]}`),
                ],
            },
        });
        const { instantiate } = await import(
        /* @vite-ignore */ `/module/transpiled/runtime/${id}.js`);
        return new PreparedModule(instantiate);
    }
}
export class PreparedModule {
    #instantiate;
    constructor(instantiate) {
        this.#instantiate = instantiate;
    }
    async instantiate(importables) {
        const importedEntries = (await Promise.all(Object.entries(importables).map(async ([key, importable]) => {
            if (typeof importable == 'string') {
                importable = import(/* @vite-ignore */ importable);
            }
            return [key, await importable];
        })));
        const imports = importedEntries.reduce((map, [key, imported]) => {
            map[key] = imported;
            return map;
        }, {});
        return await this.#instantiate(imports);
    }
}
//# sourceMappingURL=index.js.map