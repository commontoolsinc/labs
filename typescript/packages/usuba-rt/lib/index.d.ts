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
export declare class Runtime {
    #private;
    constructor(library: PendingSourceCode[]);
    defineModule<T>(definition: ModuleDefinition): Promise<PreparedModule<T>>;
}
export declare class PreparedModule<T> {
    #private;
    constructor(instantiate: any);
    instantiate(importables: ImportableMap): Promise<T>;
}
//# sourceMappingURL=index.d.ts.map