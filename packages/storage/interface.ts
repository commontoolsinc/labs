// Public types for the new storage backend will live here.
// Implementations will follow the design described in docs/specs/storage/*.

export interface StorageProviderInfo {
  name: string;
  version: string;
}

export interface StorageProvider {
  readonly info: StorageProviderInfo;
}
