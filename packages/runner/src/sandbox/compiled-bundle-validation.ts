import type { JsScript } from "@commonfabric/js-compiler";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { getLogger } from "@commonfabric/utils/logger";
import {
  BundlePreflightError,
  preflightParsedCompiledBundle,
} from "./bundle-preflight.ts";
import {
  CompiledJsParseError,
  parseCompiledBundleSource,
} from "./compiled-js-parser.ts";
import { verifyParsedCompiledBundleModuleFactoriesWithParser } from "./compiled-bundle-verifier.ts";

const logger = getLogger("compiled-bundle-validation");

export class CompiledBundleValidator {
  private readonly verifiedBundleHashes = new Set<string>();

  clear(): void {
    this.verifiedBundleHashes.clear();
  }

  verify(jsScript: JsScript, fallbackFilename: string): void {
    const bundleHash = hashOf(jsScript.js).toString();
    if (this.verifiedBundleHashes.has(bundleHash)) {
      return;
    }

    const filename = jsScript.filename ?? fallbackFilename;
    logger.timeStart("verify");
    try {
      logger.timeStart("verify", "parseBundle");
      const parsedBundle = (() => {
        try {
          return parseCompiledBundleSource(jsScript.js);
        } catch (error) {
          if (error instanceof CompiledJsParseError) {
            throw new BundlePreflightError(`${filename}: ${error.message}`);
          }
          throw error;
        } finally {
          logger.timeEnd("verify", "parseBundle");
        }
      })();

      logger.timeStart("verify", "preflight");
      try {
        preflightParsedCompiledBundle(jsScript.js, parsedBundle, filename);
      } finally {
        logger.timeEnd("verify", "preflight");
      }

      logger.timeStart("verify", "moduleFactories");
      try {
        verifyParsedCompiledBundleModuleFactoriesWithParser(
          jsScript.js,
          parsedBundle,
          filename,
        );
      } finally {
        logger.timeEnd("verify", "moduleFactories");
      }

      this.verifiedBundleHashes.add(bundleHash);
    } finally {
      logger.timeEnd("verify");
    }
  }
}
