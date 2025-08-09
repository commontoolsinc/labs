// Query engine (schema IR + evaluator) - production path
// This code is based on the prototype in demo-code/query, adapted to live under src/query.
// It keeps the same in-memory Storage interface for now; a SQLite adapter can be added later.

export * from "./path.ts";
export * from "./types.ts";
export * from "./ir.ts";
export * from "./sqlite_storage.ts";
export * from "./eval.ts";
export * from "./subs.ts";
export * from "./change_processor.ts";
export * from "./delivery.ts";

