import { ED25519Signer } from "../principal.ts";

export const alice =
  ED25519Signer.fromString<"did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi">(
    "MgCZT5vOnYZoVAeyjnzuJIVY9J4LNtJ+f8Js0cTPuKUpFne0BVEDJjEu6quFIU8yp91/TY/+MYK8GvlKoTDnqOCovCVM=",
  );

export const bob =
  ED25519Signer.fromString<"did:key:z6MkffDZCkCTWreg8868fG1FGFogcJj5X6PY93pPcWDn9bob">(
    "MgCYbj5AJfVvdrjkjNCxB3iAUwx7RQHVQ7H1sKyHy46Iose0BEevXgL1V73PD9snOCIoONgb+yQ9sycYchQC8kygR4qY=",
  );

export const mallory =
  ED25519Signer.fromString<"did:key:z6MktafZTREjJkvV5mfJxcLpNBoVPwDLhTuMg9ng7dY4zMAL">(
    "MgCYtH0AvYxiQwBG6+ZXcwlXywq9tI50G2mCAUJbwrrahkO0B0elFYkl3Ulf3Q3A/EvcVY0utb4etiSE8e6pi4H0FEmU=",
  );

export const space =
  ED25519Signer.fromString<"did:key:z6MkrZ1r5XBFZjBU34qyD8fueMbMRkKw17BZaq2ivKFjnz2z">(
    "MgCYKXoHVy7Vk4/QjcEGi+MCqjntUiasxXJ8uJKY0qh11e+0Bs8WsdqGK7xothgrDzzWD0ME7ynPjz2okXDh8537lId8=",
  );
