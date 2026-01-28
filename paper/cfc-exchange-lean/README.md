# Contextual Flow Control (CFC) Paper (Draft)

This folder contains a LaTeX draft paper reorganizing the CFC spec into a more traditional
paper structure, including the "exchange-based declassification" idea and its accompanying
Lean4 formalization.

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
- Bibliography lives in `paper/cfc-exchange-lean/references.bib` and is built automatically by
  `latexmk` (BibTeX).
