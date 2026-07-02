import { PieceController, PiecesController } from "@commonfabric/piece/ops";
import { createCompileByteCache } from "@commonfabric/test-support/compile-byte-cache";

export { PieceController, PiecesController };

type InitializePiecesControllerOptions = Parameters<
  typeof PiecesController.initialize
>[0];

export const moduleByteCache = createCompileByteCache();

export function initializePiecesController(
  options: Omit<InitializePiecesControllerOptions, "moduleByteCache">,
): Promise<PiecesController> {
  return PiecesController.initialize({
    ...options,
    moduleByteCache,
  });
}
