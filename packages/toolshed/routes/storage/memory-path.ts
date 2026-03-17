import * as Path from "@std/path";

export const resolveMemoryV2StoreRootUrl = (
  storeUrl: URL,
  options: { singleFileMode?: boolean } = {},
): URL => {
  const storePath = Path.fromFileUrl(storeUrl);
  const isSingleFile = options.singleFileMode ?? Path.extname(storePath) !== "";
  const rootPath = isSingleFile
    ? Path.join(
      Path.dirname(storePath),
      `${Path.basename(storePath, Path.extname(storePath))}.v2-engine`,
    )
    : Path.join(storePath, "v2-engine");
  return Path.toFileUrl(`${rootPath}/`);
};
