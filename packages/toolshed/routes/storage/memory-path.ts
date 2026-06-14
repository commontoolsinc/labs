import * as Path from "@std/path";

export const resolveMemoryEngineStoreRootUrl = (
  storeUrl: URL,
  options: { singleFileMode?: boolean } = {},
): URL => {
  const storePath = Path.fromFileUrl(storeUrl);
  const isSingleFile = options.singleFileMode ?? Path.extname(storePath) !== "";
  const rootPath = isSingleFile
    ? Path.join(
      Path.dirname(storePath),
      `${Path.basename(storePath, Path.extname(storePath))}.engine-v3`,
    )
    : Path.join(storePath, "engine-v3");
  return Path.toFileUrl(`${rootPath}/`);
};
