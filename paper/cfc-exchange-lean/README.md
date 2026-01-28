# Exchange-Based Declassification (Draft Paper)

This folder contains a LaTeX draft paper describing the "exchange-based declassification"
idea in the CFC spec and its accompanying Lean4 formalization.

## Build

Any LaTeX engine works. For example:

```sh
cd paper/cfc-exchange-lean
# macOS tip: refresh PATH so /Library/TeX/texbin is available
eval "$(/usr/libexec/path_helper)"
latexmk -pdf paper.tex
```

or:

```sh
cd paper/cfc-exchange-lean
eval "$(/usr/libexec/path_helper)"
pdflatex paper.tex
pdflatex paper.tex
```

## Notes

- This is a draft intended to evolve alongside `docs/specs/cfc/` and the Lean model in `formal/`.
- The paper references files in this repo directly rather than using external bibliography
  tooling; add a `.bib` later if/when we want a publication-quality version.
