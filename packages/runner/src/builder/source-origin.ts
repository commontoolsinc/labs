export interface ImplementationSourceOrigin {
  readonly bundleLocation?: string;
  readonly sourceLocation?: string;
}

const implementationSourceOriginMarker = Symbol("implementationSourceOrigin");

type SourceOriginAnnotated = {
  [implementationSourceOriginMarker]?: ImplementationSourceOrigin;
};

export function attachImplementationSourceOrigin(
  implementation: unknown,
  origin: ImplementationSourceOrigin,
): void {
  if (
    !implementation ||
    (typeof implementation !== "function" && typeof implementation !== "object")
  ) {
    return;
  }
  Object.defineProperty(
    implementation as SourceOriginAnnotated,
    implementationSourceOriginMarker,
    {
      value: origin,
      configurable: true,
      enumerable: false,
      writable: false,
    },
  );
}

export function getImplementationSourceOrigin(
  implementation: unknown,
): ImplementationSourceOrigin | undefined {
  if (
    !implementation ||
    (typeof implementation !== "function" && typeof implementation !== "object")
  ) {
    return undefined;
  }
  return (implementation as SourceOriginAnnotated)[
    implementationSourceOriginMarker
  ];
}

export function formatImplementationSourceOrigin(
  origin: ImplementationSourceOrigin | undefined,
): string | undefined {
  if (!origin) return undefined;
  return origin.sourceLocation ?? origin.bundleLocation;
}
