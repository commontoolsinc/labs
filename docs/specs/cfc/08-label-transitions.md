# 8. Label Transition Rules

Labels propagate through computations at runtime. The transition rules depend on how data flows—handlers may transform, filter, or pass through values unchanged.

## 8.1 Overview

When a computation (handler, action, or transformation) executes, labels must transition from inputs to outputs. The transition depends on how data flows:

| Flow Type | Confidentiality | Integrity |
|-----------|-----------------|-----------|
| **Pass-through** (reference) | Preserved | Preserved |
| **Projection** (field access) | Inherited | Scoped to projection |
| **Exact copy** (same value) | Inherited | Preserved (content-addressed) |
| **Combination** (join inputs) | Concatenate clauses (CNF) | Intersection (weaker) |
| **Transformation** (compute) | Inherited from inputs | New from transformer |

---

## 8.2 Pass-Through via References

When output contains a reference to input data rather than the data itself, the label is not copied—it remains attached to the referenced data.

### 8.2.1 Reference Preservation

```typescript
interface Handler<I, O> {
  input: I;
  output: O;
}

// If output contains a Reference to input data:
handler.output.selectedItem = handler.input.items[selectedIndex];
// The output contains a Reference, not a copy
// Label follows the reference - no transition needed
```

### 8.2.2 Schema Annotation for References

In JSON Schema, indicate that an output field is a reference to input:

```json
{
  "type": "object",
  "properties": {
    "input": {
      "type": "object",
      "properties": {
        "emails": {
          "type": "array",
          "items": { "$ref": "#/$defs/Email" }
        }
      }
    },
    "output": {
      "type": "object",
      "properties": {
        "selectedEmail": {
          "$ref": "#/$defs/Email",
          "ifc": {
            "passThrough": {
              "from": "/input/emails/items"
            }
          }
        }
      }
    }
  }
}
```

The `passThrough.from` annotation indicates:
- This output has the **same label** as the data at the specified input path
- No label transformation occurs

**Runtime representation**: The output may be either:
1. **A link** to the original item (in sigil link format, e.g., `{ "/": { "link@1": { "id": "bafy...", ... } } }`), or
2. **A copy** of the original value

Either representation is valid—what matters is that the label is preserved unchanged. Links are more efficient (no duplication) and make provenance explicit; copies may be needed when the output format requires inline data.

---

## 8.3 Projection Semantics

Extracting a field from structured data is a **projection**. Projections have special integrity semantics.

### 8.3.1 Confidentiality in Projections

Confidentiality is inherited: accessing a field does not reduce confidentiality.

```typescript
const email = { subject: "...", body: "...", recipients: [...] };
// Label: { confidentiality: [User(Alice), Ctx.Email(Alice)] }

const subject = email.subject;
// Label: { confidentiality: [User(Alice), Ctx.Email(Alice)] }
// Confidentiality unchanged
```

### 8.3.2 Integrity in Projections

Integrity may be preserved as a **scoped projection**:

```typescript
const measurement = { lat: 37.77, long: -122.41 };
// Integrity: { GPSMeasurement: { valueRef: refer(measurement), device: "..." } }

const lat = measurement.lat;
// Integrity: {
//   GPSMeasurement: {
//     valueRef: refer(measurement),
//     device: "...",
//     projection: "/lat"  // Scoped to this field
//   }
// }
```

The scoped integrity indicates:
- This value came from a valid GPS measurement
- It is specifically the `/lat` component
- It cannot be combined with `/long` from a different measurement and claim full GPS integrity

Runtime helper (used by propagation):

```typescript
// Scope integrity atoms to a particular projection path.
//
// This preserves all other atom fields (including any existing `valueRef` binding) and
// only adds/overrides the `projection` field.
function scopeIntegrity(
  integrity: IntegrityAtom[],
  projectionPath: string
): IntegrityAtom[] {
  return integrity.map(atom => ({
    ...atom,
    scope: { ...atom.scope, projection: projectionPath }
  }));
}
```

### 8.3.3 Schema Annotation for Projections

```json
{
  "output": {
    "properties": {
      "latitude": {
        "type": "number",
        "ifc": {
          "projection": {
            "from": "/input/measurement",
            "path": "/lat"
          }
        }
      }
    }
  }
}
```

### 8.3.4 Safe Recomposition of Projections (Same Source)

Scoped projection integrity is designed to achieve two goals:

1. **Prevent unsafe recomposition**: a handler must not be able to mix `/lat` from one GPS
   measurement with `/long` from a different measurement and still claim “valid GPS
   measurement”.
2. **Allow safe recomposition**: if `/lat` and `/long` both come from the **same** source
   measurement, the runtime SHOULD be able to restore the integrity of the whole measurement
   (e.g. for an output object `{ lat, long }`).

To support this, treat `valueRef` as a binding to the original structured value (the source
measurement) and treat `projection` as a binding to a specific field.

The runtime can implement safe recomposition as a *checked* transition:

```typescript
// Helper: scope each integrity atom to a (sourceRef, path) pair.
function scopeIntegrityFrom(
  integrity: IntegrityAtom[],
  sourceRef: Reference,
  projectionPath: string
): IntegrityAtom[] {
  return integrity.map(atom => ({
    ...atom,
    scope: { ...atom.scope, valueRef: sourceRef, projection: projectionPath }
  }));
}

// Helper: does `integrity` contain "baseAtom scoped to (sourceRef, projectionPath)"?
function hasScopedIntegrity(
  integrity: IntegrityAtom[],
  baseType: string,
  sourceRef: Reference,
  projectionPath: string
): boolean {
  return integrity.some(a =>
    a.type === baseType &&
    a.scope?.valueRef?.equals(sourceRef) &&
    a.scope?.projection === projectionPath
  );
}

// Runtime verification for a recomposed object built from multiple projections.
//
// - `sourcePath` points to the input structured value.
// - `parts` enumerates which output paths claim to be projections of which source paths.
//
// This checks two things:
// (A) each output part value is an exact copy of the corresponding source field, and
// (B) each output part label contains the expected scoped integrity evidence.
function verifyRecomposeProjections(
  handler: Handler,
  inputLabels: Map<string, Label>,
  outputLabels: Map<string, Label>,
  outputValue: unknown,
  sourcePath: string,
  baseIntegrityType: string,
  parts: Array<{ outputPath: string; projectionPath: string }>
): boolean {
  const sourceValue = getValueAtPath(handler.input, sourcePath);
  const sourceRef = refer(sourceValue);

  for (const part of parts) {
    const expectedFieldValue = getValueAtPath(sourceValue, part.projectionPath);
    const outPartValue = getValueAtPath(outputValue, part.outputPath);

    // (A) Ensure the handler really output the source field value.
    if (!refer(expectedFieldValue).equals(refer(outPartValue))) return false;

    // (B) Ensure the output part label carries the correct scoped integrity.
    const partLabel = outputLabels.get(part.outputPath)!;
    if (!hasScopedIntegrity(partLabel.integrity, baseIntegrityType, sourceRef, part.projectionPath)) {
      return false;
    }
  }

  return true;
}

// Checked recomposition transition:
// - reject if verification fails,
// - otherwise: join confidentiality and meet integrity across the parts,
//   then *add back* the whole-object integrity scoped to the common source.
//
// Note: flow-path confidentiality (`pcConfidentiality`, Section 8.9.1) is appended by the
// main propagation algorithm just like for other transitions.
function recomposeFromProjections(
  partLabels: Label[],
  sourceRef: Reference,
  baseIntegrityType: string
): Label {
  const out: Label = combineLabels(partLabels);
  out.integrity = [
    ...out.integrity,
    { type: baseIntegrityType, scope: { valueRef: sourceRef, projection: "/" } }
  ];
  return out;
}
```

---

## 8.4 Exact Copy Verification

When the schema declares that an output should be an exact copy of an input, the runtime verifies this claim via content-addressing. This is **not automatic**—the schema must declare the expectation.

### 8.4.1 Schema Declaration

```json
{
  "output": {
    "properties": {
      "confirmedEmail": {
        "type": "string",
        "format": "email",
        "ifc": {
          "exactCopyOf": "/input/emailAddress"
        }
      }
    }
  }
}
```

### 8.4.2 Runtime Verification

When `exactCopyOf` is declared, the runtime verifies:

```typescript
function verifyExactCopy(
  inputPath: string,
  outputPath: string,
  handler: Handler
): { valid: boolean; preservedIntegrity?: IntegrityAtom[] } {
  const inputValue = getValueAtPath(handler.input, inputPath);
  const outputValue = getValueAtPath(handler.output, outputPath);

  if (refer(inputValue).equals(refer(outputValue))) {
    // Claim verified - preserve integrity
    return {
      valid: true,
      preservedIntegrity: getIntegrityAtPath(handler.inputLabels, inputPath)
    };
  }

  // Claim violated - this is an error
  return { valid: false };
}
```

If verification fails, the handler output is rejected—the schema made a promise it didn't keep.

### 8.4.3 When to Use Exact Copy

Use `exactCopyOf` when:
- Echoing user input for confirmation
- Passing through a value unchanged
- Selecting an item from a list without modification

---

## 8.5 Collection Transitions

Collections (arrays, sets) have special transition semantics beyond individual values.

### 8.5.1 Collection Constraint Types

| Constraint | Meaning | Integrity Implication |
|------------|---------|----------------------|
| `subsetOf` | All output members come from input | Each member preserves its integrity |
| `permutationOf` | Same members, possibly reordered | Full collection integrity preserved |
| `lengthPreserved` | Output length equals input length | Structural integrity preserved |
| `filteredFrom` | Subset via predicate | Members preserve integrity, collection loses "complete" integrity |

### 8.5.2 Subset Constraint

Output array contains only elements from input array (selection):

```json
{
  "output": {
    "properties": {
      "selectedEmails": {
        "type": "array",
        "items": { "$ref": "#/$defs/Email" },
        "ifc": {
          "collection": {
            "subsetOf": "/input/emails",
            "memberIntegrity": "preserved"
          }
        }
      }
    }
  }
}
```

Runtime verification:

```typescript
function verifySubset(
  inputPath: string,
  outputPath: string,
  handler: Handler
): boolean {
  const inputSet = new Set(
    getValueAtPath(handler.input, inputPath).map(v => refer(v).toString())
  );
  const outputArray = getValueAtPath(handler.output, outputPath);

  return outputArray.every(item =>
    inputSet.has(refer(item).toString())
  );
}
```

Each output member inherits the integrity of its matching input member.

### 8.5.3 Permutation Constraint

Output is a reordering of input (same members, different order):

```json
{
  "output": {
    "properties": {
      "sortedItems": {
        "type": "array",
        "ifc": {
          "collection": {
            "permutationOf": "/input/items"
          }
        }
      }
    }
  }
}
```

Runtime verification:

```typescript
function verifyPermutation(
  inputPath: string,
  outputPath: string,
  handler: Handler
): boolean {
  const inputRefs = getValueAtPath(handler.input, inputPath)
    .map(v => refer(v).toString())
    .sort();
  const outputRefs = getValueAtPath(handler.output, outputPath)
    .map(v => refer(v).toString())
    .sort();

  return inputRefs.length === outputRefs.length &&
    inputRefs.every((ref, i) => ref === outputRefs[i]);
}
```

Permutation preserves:
- Individual member integrity
- Collection-level integrity (e.g., "complete list of X")
- Length invariants

### 8.5.4 Length Preservation

Output has same length as input:

```json
{
  "output": {
    "properties": {
      "mappedValues": {
        "type": "array",
        "ifc": {
          "collection": {
            "sourceCollection": "/input/items",
            "lengthPreserved": true
          }
        }
      }
    }
  }
}
```

This is weaker than permutation—items may be transformed, but count is preserved. Useful for map operations.

Runtime verification:

```typescript
function verifyLengthPreserved(
  inputPath: string,
  outputPath: string,
  handler: Handler
): boolean {
  const inputArray = getValueAtPath(handler.input, inputPath);
  const outputArray = getValueAtPath(handler.output, outputPath);

  if (!Array.isArray(inputArray) || !Array.isArray(outputArray)) return false;
  return inputArray.length === outputArray.length;
}
```

### 8.5.5 Filtered Subset

Output is a subset determined by a predicate:

```json
{
  "output": {
    "properties": {
      "activeUsers": {
        "type": "array",
        "ifc": {
          "collection": {
            "filteredFrom": "/input/users",
            "predicate": "isActive"
          }
        }
      }
    }
  }
}
```

Integrity implications:
- Each member preserves its individual integrity
- Collection loses "completeness" integrity (it's no longer "all users")
- Gains filter integrity: `FilteredBy({ predicate: "isActive", source: refer(input.users) })`

Runtime verification:

```typescript
// Filtered-from is a particular kind of subset: the runtime can verify it with the same
// membership check as `subsetOf`. The runtime generally cannot verify the *semantics* of
// the predicate (it is just a name), only the membership relationship.
function verifyFilteredFrom(
  inputPath: string,
  outputPath: string,
  handler: Handler
): boolean {
  return verifySubset(inputPath, outputPath, handler);
}
```

### 8.5.6 Collection Integrity Atoms

Collections may carry integrity about the collection itself (not just members):

```typescript
interface CollectionIntegrity {
  // The collection is complete (no filtering occurred)
  type: "CompleteCollection";
  source: Reference;  // Original collection reference
}

interface FilteredCollectionIntegrity {
  type: "FilteredFrom";
  source: Reference;
  predicate: string;
  // Does NOT claim completeness
}

interface PermutedCollectionIntegrity {
  type: "PermutationOf";
  source: Reference;
  // Claims same members, different order
}
```

#### 8.5.6.1 Membership Confidentiality vs Member Confidentiality

Collections have **two distinct confidentiality dimensions**:

1. **Member confidentiality**: The confidentiality of each individual item in the collection
2. **Membership confidentiality**: The confidentiality of *which items are in the collection*

These are tracked separately because:
- Individual items may be PUBLIC, but their **inclusion** in a particular collection may be confidential
- A filtered collection inherits confidentiality from the filtering criteria

**Example**: Secret search results

```typescript
// Individual products may be public catalog items
const allProducts: Product[] = /* public catalog */;

// But filtering by a secret query taints the MEMBERSHIP
const secretQuery = /* user's private search */;
const matchingProducts = allProducts.filter(p => matches(p, secretQuery));

// matchingProducts has:
// - Member confidentiality: PUBLIC (products are public)
// - Membership confidentiality: tainted by secretQuery
//
// Therefore matchingProducts.length is also tainted by secretQuery
```

```typescript
// Conceptual model:
// - The collection *container* has a label describing membership/selection.
// - Each element retains its own label (content + integrity).
//
// Concrete representation in this spec:
// - The array value at path `/items` carries membership confidentiality.
// - The array elements at `/items/*` carry member confidentiality.
//
// This uses the existing per-path labeling machinery (Section 4.6.3 and Section 8.9):
// the container path label and item path labels are distinct.
```

### 8.5.6.2 Runtime Label Propagation for Collections

The per-path labeling model implies the runtime must propagate **two** kinds of labels for an array:

- the **container label** (membership confidentiality) at the array path (e.g. `/items`)
- the **member labels** (content + integrity) at element paths (conceptually `/items/*`)

The following pseudocode shows a concrete, schema-driven approach for the main collection constraints.

```typescript
// Helper: remove collection-level integrity claims that are no longer justified after selection/filtering.
function stripCollectionIntegrity(integ: IntegrityAtom[]): IntegrityAtom[] {
  return integ.filter(a =>
    a.type !== "CompleteCollection" &&
    a.type !== "FilteredFrom" &&
    a.type !== "PermutationOf" &&
    a.type !== "LengthPreserved"
  );
}

// Helper: build a lookup table from element reference -> element label for an input collection.
function indexMemberLabels(
  members: unknown[],
  memberLabels: Label[]
): Map<string, Label> {
  const m = new Map<string, Label>();
  members.forEach((v, i) => m.set(refer(v).toString(), memberLabels[i]));
  return m;
}

function verifySubsetByRefs(inputMembers: unknown[], outputMembers: unknown[]): boolean {
  const inputSet = new Set(inputMembers.map(v => refer(v).toString()));
  return outputMembers.every(v => inputSet.has(refer(v).toString()));
}

function verifyPermutationByRefs(inputMembers: unknown[], outputMembers: unknown[]): boolean {
  const inRefs = inputMembers.map(v => refer(v).toString()).sort();
  const outRefs = outputMembers.map(v => refer(v).toString()).sort();
  if (inRefs.length !== outRefs.length) return false;
  return inRefs.every((r, i) => r === outRefs[i]);
}

// Subset/filtered/permutation propagate by *preserving member labels*:
// the output elements are references to input elements, so their labels are re-used.
//
// The container label is (also) tainted by flow-path confidentiality because the *membership decision*
// (which elements were chosen / in what order) can be confidential.
//
// In this spec, that taint is represented by appending `pcConfidentiality` to the *container path* label
// in the main propagation algorithm (8.9.1). Reads of members join prefix labels (4.6.3), so accesses
// to `/items/0` are implicitly tainted by the label on `/items`.
function propagateCollectionConstraint(
  kind: "subset" | "filtered" | "permutation",
  inputContainerLabel: Label,
  inputMembers: unknown[],
  inputMemberLabels: Label[],
  outputMembers: unknown[],
  opts: {
    sourceRef: Reference;
    predicate?: string;
    selectionIntegrity?: SelectionDecisionIntegrity;
    addedCollectionIntegrity?: IntegrityAtom[];
  }
): { outputContainerLabel: Label; outputMemberLabels: Label[] } {
  // Build membership lookup for label reuse.
  const inputByRef = indexMemberLabels(inputMembers, inputMemberLabels);

  // Checked constraints: violations reject handler output.
  if (kind === "subset" || kind === "filtered") {
    // filteredFrom is verified as subset-of; predicate semantics are not verified here.
    if (!verifySubsetByRefs(inputMembers, outputMembers)) {
      throw new Error("IFC collection subset/filtered violation");
    }
  }
  if (kind === "permutation") {
    if (!verifyPermutationByRefs(inputMembers, outputMembers)) {
      throw new Error("IFC collection permutation violation");
    }
  }

  // Container label: membership confidentiality is tainted by PC, but *via the container path label*
  // (Section 4.6.3), not by rewriting each member label.
  //
  // Concretely: this helper returns a container label *without* PC; the runtime's main propagation
  // algorithm (8.9.1) appends `pcConfidentiality` to the container path label after it is derived.
  const outContainer: Label = {
    confidentiality: [...inputContainerLabel.confidentiality],
    integrity: inputContainerLabel.integrity
  };

  // Constraint-specific container integrity updates.
  if (kind === "subset") {
    outContainer.integrity = stripCollectionIntegrity(outContainer.integrity);
  } else if (kind === "filtered") {
    outContainer.integrity = [
      ...stripCollectionIntegrity(outContainer.integrity),
      { type: "FilteredFrom", source: opts.sourceRef, predicate: opts.predicate! }
    ];
  } else if (kind === "permutation") {
    outContainer.integrity = [
      ...outContainer.integrity,
      { type: "PermutationOf", source: opts.sourceRef }
    ];
  }

  // Attach optional selection-decision integrity and other container integrity atoms.
  if (opts.selectionIntegrity) {
    outContainer.integrity = [...outContainer.integrity, opts.selectionIntegrity];
  }
  if (opts.addedCollectionIntegrity?.length) {
    outContainer.integrity = [...outContainer.integrity, ...opts.addedCollectionIntegrity];
  }

  // Member labels: preserved by reference.
  const outMemberLabels = outputMembers.map(v => {
    const lbl = inputByRef.get(refer(v).toString());
    if (!lbl) throw new Error("IFC member label lookup failed (bad subset/permutation)");
    return lbl;
  });

  return { outputContainerLabel: outContainer, outputMemberLabels: outMemberLabels };
}

// Length-preserved (map-like) differs: members may be transformed, so member labels are derived
// by the per-element transition rules (e.g. `deriveTransformationLabel`).
//
// The checked property is only: output length equals input length.
function propagateLengthPreserved(
  inputContainerLabel: Label,
  inputMembers: unknown[],
  outputMembers: unknown[],
  outputMemberLabels: Label[],
  sourceRef: Reference,
  opts?: {
    selectionIntegrity?: SelectionDecisionIntegrity;
    addedCollectionIntegrity?: IntegrityAtom[];
  }
): { outputContainerLabel: Label; outputMemberLabels: Label[] } {
  if (inputMembers.length !== outputMembers.length) {
    throw new Error("IFC lengthPreserved violation");
  }

  const extra: IntegrityAtom[] = [];
  if (opts?.selectionIntegrity) extra.push(opts.selectionIntegrity);
  if (opts?.addedCollectionIntegrity?.length) extra.push(...opts.addedCollectionIntegrity);

  return {
    outputContainerLabel: {
      confidentiality: [...inputContainerLabel.confidentiality],
      integrity: [
        ...stripCollectionIntegrity(inputContainerLabel.integrity),
        { type: "LengthPreserved", source: sourceRef }
        , ...extra
      ]
    },
    outputMemberLabels
  };
}
```

**Implications**:
- `collection.length` inherits `membershipConfidentiality`
- Iterating over members exposes membership (iteration order is tainted)
- `collection.includes(item)` returns a value tainted by membership confidentiality
- Mapping over items produces a new collection with the same membership confidentiality

### 8.5.7 Selection-Decision Integrity

The order and selection of items in a collection has **different taint** from the individual items themselves. This is **selection-decision integrity**—it tracks whether the ranking/selection criteria align with user interests.

**The problem**: A malicious recommender could rank items to manipulate user behavior (e.g., placing sponsored content first without disclosure, or ranking search results to serve the recommender's interests rather than the user's).

**Solution**: Selection-decision integrity is represented as **integrity atoms** (not a separate label field). These atoms track:
1. What criteria influenced the selection/ordering
2. Whether those criteria align with user interests
3. Whether appropriate disclosure was made

```typescript
interface SelectionDecisionIntegrity {
  type: "SelectionDecision";

  // What criteria influenced selection/ordering
  criteria: SelectionCriteria[];

  // Whether user was informed of selection criteria
  disclosed: boolean;

  // Evidence of user acknowledgment (if required)
  userAcknowledgment?: {
    timestamp: number;
    snapshotDigest: string;  // UI showing disclosure
  };
}

type SelectionCriteria =
  | { kind: "user-specified"; description: string }     // User chose sort order
  | { kind: "relevance"; algorithm: string }            // Algorithmic relevance
  | { kind: "commercial"; sponsor?: string }            // Paid placement
  | { kind: "platform-interest"; description: string }  // Platform's interests
  | { kind: "unknown" };                                // Opaque/untrusted

// Selection can clear some confidentiality taint IF criteria align with user
interface SelectionDeclassificationRule {
  // Required: selection criteria must be user-aligned or disclosed
  requiredIntegrity: [
    { type: "SelectionDecision", criteria: { kind: "user-specified" } }
  ] | [
    { type: "SelectionDecision", disclosed: true },
    { type: "UserAcknowledged", scope: "selection-criteria" }
  ];

  // Effect: selection decision taint can be cleared
  clears: "selection-decision-confidentiality";
}
```

Runtime minting + declassification pseudocode:

```typescript
// Represent the *confidentiality taint* of selection decisions as a dedicated confidentiality atom.
//
// Intuition: even if individual members are public, the membership/order can leak something
// about the ranking/selection criteria (e.g. a private query).
//
// In the unified label representation, this is simply another confidentiality clause.
type SelectionDecisionConf = { type: "SelectionDecisionConf"; source: Reference };

// Add selection-decision confidentiality taint to a collection container label.
function taintSelectionDecisionConf(
  container: Label,
  source: Reference
): Label {
  return {
    ...container,
    confidentiality: [
      ...container.confidentiality,
      [{ type: "SelectionDecisionConf", source } as any] // as any: atom union elided in pseudocode
    ]
  };
}

// Decide whether selection-decision taint may be cleared.
//
// This is intentionally shaped like robust declassification:
// - it requires integrity evidence (selection decision integrity),
// - and it requires being in a trusted runtime/control scope (Section 3.4 / 3.8.6).
function canClearSelectionDecisionConf(
  pcIntegrity: IntegrityAtom[],
  containerIntegrity: IntegrityAtom[],
  rule: SelectionDeclassificationRule
): boolean {
  const trusted = pcIntegrity.some(a => a.type === "TrustedScope");
  if (!trusted) return false;

  // Case 1: user-specified criteria.
  const userSpecified = containerIntegrity.some(a =>
    a.type === "SelectionDecision" &&
    a.criteria?.some((c: any) => c.kind === "user-specified")
  );
  if (userSpecified) return true;

  // Case 2: disclosed + acknowledged.
  const disclosed = containerIntegrity.some(a =>
    a.type === "SelectionDecision" && a.disclosed === true
  );
  const acknowledged = containerIntegrity.some(a =>
    a.type === "UserAcknowledged" && a.scope === "selection-criteria"
  );
  return disclosed && acknowledged;
}

// Clear selection-decision confidentiality by *removing* the corresponding clause.
//
// This clears only the selection-decision taint; other confidentiality clauses (including PC)
// remain in place.
function clearSelectionDecisionConf(
  container: Label,
  source: Reference
): Label {
  return {
    ...container,
    confidentiality: container.confidentiality.filter(clause =>
      !clause.some((a: any) => a.type === "SelectionDecisionConf" && a.source.equals(source))
    )
  };
}
```

**Contextual Integrity mapping**: This implements CI's transmission principles for ranking and recommendation scenarios:

- **Sender**: The system/algorithm producing the ranking
- **Recipient**: The user viewing the ranked list
- **Information type**: The selection criteria and their influence
- **Transmission principle**: Selection must serve user interests OR be disclosed

**Example: Search results**

```typescript
// Untrusted search results - selection decision is opaque
const results = searchEngine.search(query);
// results.selectionIntegrity = { type: "SelectionDecision", criteria: [{ kind: "unknown" }] }

// User sorts by date - selection decision becomes user-specified
const sorted = results.sortBy("date", "descending");
// sorted.selectionIntegrity = {
//   type: "SelectionDecision",
//   criteria: [{ kind: "user-specified", description: "date descending" }],
//   disclosed: true
// }

// User selects from sorted list - selection integrity preserved
const selected = userSelect(sorted);
// selected preserves member integrity AND has user-specified selection integrity
```

**Example: Sponsored content with disclosure**

```json
{
  "ifc": {
    "collection": {
      "subsetOf": "/input/searchResults",
      "selectionIntegrity": {
        "criteria": [
          { "kind": "relevance", "algorithm": "semantic-v2" },
          { "kind": "commercial", "sponsor": "displayed-in-ui" }
        ],
        "disclosed": true,
        "disclosureEvidence": {
          "snapshotDigest": "...",
          "disclosureText": "Includes sponsored results"
        }
      }
    }
  }
}
```

### 8.5.8 Combining Collection Constraints

Constraints can be combined:

```json
{
  "ifc": {
    "collection": {
      "subsetOf": "/input/candidates",
      "lengthPreserved": false,
      "memberIntegrity": "preserved",
      "selectionIntegrity": {
        "criteria": [{ "kind": "user-specified" }],
        "disclosed": true
      },
      "addedCollectionIntegrity": [
        { "type": "SelectedBy", "user": "..." }
      ]
    }
  }
}
```

---

## 8.6 Combination Rules

When multiple inputs contribute to a single output, labels combine.

### 8.6.1 Confidentiality Combination (Join)

Confidentiality clauses **concatenate** (CNF join—more restrictive):

```typescript
const input1 = { value: "...", label: { confidentiality: [User(Alice)] } };
const input2 = { value: "...", label: { confidentiality: [User(Bob)] } };

const combined = combineValues(input1.value, input2.value);
// combined.label.confidentiality = [User(Alice), User(Bob)]
// Two clauses, both must be satisfied
// Both Alice AND Bob must authorize access
```

### 8.6.2 Integrity Combination (Meet)

Integrity atoms **intersect** (weaker claims):

```typescript
const input1 = {
  value: coords1,
  integrity: [GPSMeasurement({ device: "A" }), Timestamp({ source: "ntp" })]
};
const input2 = {
  value: coords2,
  integrity: [GPSMeasurement({ device: "B" })]
};

const combined = averageCoords(input1.value, input2.value);
// combined.integrity = []
// No common integrity - the combination is not a valid GPS measurement from any single device
```

Runtime helper (used by propagation and by checked recomposition):

```typescript
// Combine multiple labels when an output depends on multiple inputs.
//
// - confidentiality is CNF-join (concatenate clauses)
// - integrity is meet (intersection)
//
// Helper implementations of `concatClauses(...)` and `intersectAtoms(...)` appear in 8.9.2.
function combineLabels(labels: Label[]): Label {
  return {
    confidentiality: concatClauses(labels.map(l => l.confidentiality)),
    integrity: intersectAtoms(labels.map(l => l.integrity))
  };
}
```

### 8.6.3 Schema Annotation for Combinations

```json
{
  "output": {
    "properties": {
      "summary": {
        "type": "string",
        "ifc": {
          "combinedFrom": ["/input/field1", "/input/field2"],
          "combinationType": "transformation"
        }
      }
    }
  }
}
```

---

## 8.7 Transformation Rules

When code transforms data, the output gains new integrity from the transformer.

### 8.7.1 Transformation Integrity

```typescript
interface TransformationIntegrity {
  type: "TransformedBy";
  codeHash: string;           // Hash of transformer code
  inputs: Reference[];        // References to input values
  inputIntegrity: IntegrityAtom[][]; // Integrity of each input
}
```

### 8.7.2 Endorsed Transformations

Certain transformations may **preserve or upgrade** integrity:

```typescript
// A trusted unit converter
function metersToFeet(meters: number): number {
  return meters * 3.28084;
}

// If endorsed as a semantic-preserving transformation:
// Input: { value: 100, integrity: [LengthMeasurement({ unit: "m" })] }
// Output: { value: 328.084, integrity: [LengthMeasurement({ unit: "ft" })] }
```

This requires the transformer to be in a trusted registry:

```json
{
  "ifc": {
    "transformation": {
      "codeHash": "abc123...",
      "preservesIntegrity": ["LengthMeasurement"],
      "transformsUnit": { "from": "m", "to": "ft" }
    }
  }
}
```

Runtime verification + label derivation:

```typescript
// A trusted registry of endorsed transformers.
//
// In a production runtime this is typically:
// - compiled into the runtime binary, or
// - attested configuration loaded at startup.
interface EndorsedTransformerRule {
  codeHash: string;
  // Which integrity atom types this transformer is allowed to preserve/upgrade.
  preservesIntegrityTypes: string[];
  // Optional additional metadata (example): unit conversion semantics.
  // (The runtime trusts this only because `codeHash` is trusted.)
  transformsUnit?: { from: string; to: string };
}

function lookupEndorsedTransformer(
  registry: EndorsedTransformerRule[],
  codeHash: string
): EndorsedTransformerRule | undefined {
  return registry.find(r => r.codeHash === codeHash);
}

// Verify that the schema's "preservesIntegrity" claim is allowed for this transformer.
//
// This is a *checked* schema claim:
// if a handler/output schema claims preserved integrity but the transformer is not endorsed,
// the runtime rejects the handler output.
function verifyEndorsedTransformation(
  registry: EndorsedTransformerRule[],
  measuredCodeHash: string,
  declared: { codeHash: string; preservesIntegrity?: string[] }
): { valid: boolean; rule?: EndorsedTransformerRule } {
  // Ensure schema is bound to the actual code that ran.
  if (declared.codeHash !== measuredCodeHash) return { valid: false };

  const rule = lookupEndorsedTransformer(registry, measuredCodeHash);
  if (!rule) return { valid: false };

  const preserves = declared.preservesIntegrity ?? [];
  const ok = preserves.every(t => rule.preservesIntegrityTypes.includes(t));
  return ok ? { valid: true, rule } : { valid: false };
}

// Derive a transformation label, optionally preserving/upgrading integrity for endorsed transformers.
//
// For simplicity, the preserved integrity here is: "copy forward any atom whose type is in the
// allowlist AND which appears in every input integrity list".
function deriveTransformationLabel(
  registry: EndorsedTransformerRule[],
  measuredCodeHash: string,
  inputRefs: Reference[],
  inputLabels: Label[],
  declared?: { codeHash: string; preservesIntegrity?: string[] }
): Label {
  const base: Label = {
    confidentiality: concatClauses(inputLabels.map(l => l.confidentiality)),
    integrity: [{
      type: "TransformedBy",
      codeHash: measuredCodeHash,
      inputs: inputRefs
    }]
  };

  // If the schema declares preserved integrity, it must be verified against the trusted registry.
  if (declared?.preservesIntegrity?.length) {
    const v = verifyEndorsedTransformation(registry, measuredCodeHash, declared);
    if (!v.valid) throw new Error("IFC endorsed transformation violation");

    const allowed = new Set(v.rule!.preservesIntegrityTypes);
    const common = intersectAtoms(inputLabels.map(l => l.integrity));
    const preserved = common.filter(a => allowed.has(a.type));

    // In richer models, this is where trusted upgrades can occur (e.g. unit conversion).
    base.integrity = [...base.integrity, ...preserved];
  }

  return base;
}
```

### 8.7.3 Handler-Level Transitions

A handler's output schema declares how labels transition:

```json
{
  "$id": "ForwardEmailHandler",
  "type": "object",
  "properties": {
    "input": {
      "properties": {
        "email": { "$ref": "#/$defs/Email" },
        "recipients": {
          "type": "array",
          "items": { "type": "string", "format": "email" }
        }
      }
    },
    "output": {
      "properties": {
        "forwardedEmail": {
          "$ref": "#/$defs/Email",
          "ifc": {
            "passThrough": { "from": "/input/email" },
            "addedIntegrity": [
              { "type": "ForwardedBy", "handler": "ForwardEmailHandler" }
            ]
          }
        },
        "recipientList": {
          "type": "array",
          "items": { "type": "string" },
          "ifc": {
            "exactCopyOf": "/input/recipients"
          }
        }
      }
    }
  }
}
```

---

## 8.8 IFC Annotations Summary

The `ifc` field in JSON Schema supports these transition annotations:

```typescript
interface IFCTransitionAnnotations {
  // Pass-through: output is a reference to input
  passThrough?: {
    from: string;  // JSON Pointer to input path
  };

  // Projection: output is a field extracted from input
  projection?: {
    from: string;  // JSON Pointer to input object
    path: string;  // JSON Pointer within that object
  };

  // Safe recomposition of multiple projections into a single structured output (8.3.4).
  //
  // This is typically attached to the *output object* that is being recomposed.
  // The runtime verifies that each `outputPath` is an exact copy of the corresponding
  // projection of the input at `from`, and then it may restore whole-object integrity.
  recomposeProjections?: {
    from: string;  // JSON Pointer to input object
    baseIntegrityType: string;
    parts: Array<{ outputPath: string; projectionPath: string }>;
  };

  // Exact copy: output must equal input (verified at runtime)
  exactCopyOf?: string;  // JSON Pointer to input path

  // Combination: output derived from multiple inputs
  combinedFrom?: string[];  // JSON Pointers to input paths
  combinationType?: "join" | "transformation";

  // Collection constraints (8.5).
  //
  // These are checked constraints: violations reject handler output.
  collection?: {
    subsetOf?: string;        // JSON Pointer to input collection
    permutationOf?: string;   // JSON Pointer to input collection
    filteredFrom?: string;    // JSON Pointer to input collection
    predicate?: string;       // Predicate name (runtime generally cannot verify semantics)
    sourceCollection?: string;  // JSON Pointer to source collection (for lengthPreserved)
    lengthPreserved?: boolean;
    // Optional selection-decision integrity to attach to the *container* label (8.5.7).
    selectionIntegrity?: SelectionDecisionIntegrity;
    // Extra integrity atoms to attach to the *container* label (8.5.8).
    addedCollectionIntegrity?: IntegrityAtom[];
  };

  // Added integrity: new integrity atoms for this output
  addedIntegrity?: IntegrityAtom[];

  // Transformation metadata
  transformation?: {
    codeHash: string;
    preservesIntegrity?: string[];  // Integrity types preserved
  };

  // Store-field write authorization (derived from handlers declaring `writes: true`)
  // Used only for in-place modifications (Section 8.15), not for computed outputs.
  writeAuthorizedBy?: Atom[];
}

// Input-side annotations (on input schema paths)
interface IFCInputAnnotations {
  // Opaque input: handler receives reference but cannot read content
  opaque?: boolean | {
    // Schema that the opaque value must conform to (for type safety)
    schema?: JSONSchema;
    // Whether the handler may pass this reference to output
    allowPassThrough?: boolean;  // default: true
  };

  // Minimum integrity required for this input
  requiredIntegrity?: AtomPattern[];

  // Maximum confidentiality allowed for this input
  maxConfidentiality?: AtomPattern[];
}

// Handler type annotations (on handler-declared fields)
interface IFCHandlerTypeAnnotations {
  // Handler writes to this field; pattern compilation derives a write-authority set (Section 8.15)
  writes?: boolean;
  // Minimum integrity required on input (for reads)
  minIntegrity?: string;
}
```

---

## 8.9 Runtime Label Propagation

**Trust boundary note**: The propagation and verification steps in this section (including `refer(...)` comparisons for `exactCopyOf`) are performed by the trusted runtime/policy layer. Patterns/handlers are not trusted to assert label transitions; they are validated against the schema and runtime evidence at boundaries.

### 8.9.1 Propagation Algorithm

In addition to content-based label transitions, the runtime MUST account for **flow-path confidentiality** (PC confidentiality): if a handler's control decisions (branching, gating, selection) are influenced by labeled inputs, the decision itself contributes confidentiality that must be joined onto downstream outputs (Section 8.11).

For implementation clarity, the algorithm below models this as an explicit `pcConfidentiality` input computed by the runtime (potentially conservatively).
At minimum, `pcConfidentiality` must include the confidentiality of any values that can influence which outputs are produced, selected, or routed. A conservative implementation may approximate this as the join of confidentiality of all inputs the handler can observe.

```typescript
function propagateLabels(
  handler: Handler,
  inputLabels: Map<string, Label>,
  pcConfidentiality: Clause[],
  outputValue: unknown,
  outputSchema: JSONSchema
): Map<string, Label> {
  const outputLabels = new Map<string, Label>();
  const pendingRecompositions: Array<{ path: string; schema: JSONSchema }> = [];

  for (const [path, schema] of walkSchema(outputSchema)) {
    const ifc = schema.ifc;

    if (ifc?.passThrough) {
      // Reference to input - label follows reference
      outputLabels.set(path, inputLabels.get(ifc.passThrough.from)!);

    } else if (ifc?.projection) {
      // Projection - inherit confidentiality, scope integrity
      const sourceLabel = inputLabels.get(ifc.projection.from)!;
      outputLabels.set(path, {
        confidentiality: sourceLabel.confidentiality,
        integrity: scopeIntegrity(sourceLabel.integrity, ifc.projection.path)
      });

    } else if (ifc?.collection) {
      // Collection constraints (8.5):
      //
      // The container at `path` carries membership/selection taint, while the member labels
      // describe per-item content/integrity. Reads join prefix path labels (4.6.3), so the
      // container label taints reads of members without rewriting each member label.
      const outputMembers = getValueAtPath(outputValue, path);
      if (!Array.isArray(outputMembers)) {
        throw new Error(`IFC collection annotation requires array at ${path}`);
      }

      // Determine the source collection declared by the schema.
      const src =
        ifc.collection.sourceCollection ??
        ifc.collection.subsetOf ??
        ifc.collection.filteredFrom ??
        ifc.collection.permutationOf;
      if (!src) {
        throw new Error(`IFC collection annotation missing source collection at ${path}`);
      }

      const inputCollection = getValueAtPath(handler.input, src);
      if (!Array.isArray(inputCollection)) {
        throw new Error(`IFC collection source is not an array: ${src}`);
      }

      const inputContainerLabel = inputLabels.get(src)!;
      const sourceRef = refer(inputCollection);

      // Input member labels are available at indexed paths (e.g. `${src}/0`, `${src}/1`, ...).
      const inputMemberLabels = inputCollection.map((_, i) =>
        inputLabels.get(`${src}/${i}`)!
      );

      if (ifc.collection.lengthPreserved) {
        // Map-like: members may be transformed, so their labels are derived by the per-element rules.
        // The checked property here is only that the length is preserved.
        if (inputCollection.length !== outputMembers.length) {
          throw new Error("IFC lengthPreserved violation");
        }

        const extra: IntegrityAtom[] = [];
        if (ifc.collection.selectionIntegrity) extra.push(ifc.collection.selectionIntegrity);
        if (ifc.collection.addedCollectionIntegrity?.length) {
          extra.push(...ifc.collection.addedCollectionIntegrity);
        }

        outputLabels.set(path, {
          confidentiality: [...inputContainerLabel.confidentiality],
          integrity: [
            ...stripCollectionIntegrity(inputContainerLabel.integrity),
            { type: "LengthPreserved", source: sourceRef },
            ...extra
          ]
        });

      } else {
        const kind =
          ifc.collection.subsetOf ? "subset" :
          ifc.collection.filteredFrom ? "filtered" :
          ifc.collection.permutationOf ? "permutation" :
          null;
        if (!kind) {
          throw new Error(`IFC collection annotation missing constraint kind at ${path}`);
        }

        const { outputContainerLabel, outputMemberLabels } =
          propagateCollectionConstraint(
            kind,
            inputContainerLabel,
            inputCollection,
            inputMemberLabels,
            outputMembers,
            {
              sourceRef,
              predicate: ifc.collection.predicate,
              selectionIntegrity: ifc.collection.selectionIntegrity,
              addedCollectionIntegrity: ifc.collection.addedCollectionIntegrity
            }
          );

        outputLabels.set(path, outputContainerLabel);
        outputMembers.forEach((_, i) => {
          outputLabels.set(`${path}/${i}`, outputMemberLabels[i]);
        });
      }

    } else if (ifc?.recomposeProjections) {
      // Safe recomposition is a checked transition (8.3.4).
      //
      // We defer it to a second pass so the part labels are available in `outputLabels`.
      pendingRecompositions.push({ path, schema });
      continue;

    } else if (ifc?.exactCopyOf) {
      // Exact copy - verify and preserve if identical
      const inputPath = ifc.exactCopyOf;
      const inputValue = getValueAtPath(handler.input, inputPath);
      const outputVal = getValueAtPath(outputValue, path);

      if (refer(inputValue).equals(refer(outputVal))) {
        outputLabels.set(path, inputLabels.get(inputPath)!);
      } else {
        // Mismatch: schema contract violated → reject handler output
        throw new Error(`IFC exactCopyOf violation: ${path} is not an exact copy of ${inputPath}`);
      }

    } else if (ifc?.combinedFrom) {
      // Combination:
      // - confidentiality is always CNF-join across the declared inputs
      // - integrity depends on combination type:
      //   - "join": meet/intersection (8.6)
      //   - "transformation": mint transformation integrity (8.7)
      const sourcePaths = ifc.combinedFrom;
      const sourceLabels = sourcePaths.map(p => inputLabels.get(p)!);

      if (ifc.combinationType === "transformation") {
        const measuredCodeHash = refer(handler.code).toString();
        const inputRefs = sourcePaths.map(p => refer(getValueAtPath(handler.input, p)));
        outputLabels.set(path, deriveTransformationLabel(
          /* registry */ getEndorsedTransformerRegistry(),
          measuredCodeHash,
          inputRefs,
          sourceLabels,
          ifc.transformation
        ));
      } else {
        // Default combination type: "join"
        outputLabels.set(path, {
          confidentiality: concatClauses(sourceLabels.map(l => l.confidentiality)),
          integrity: intersectAtoms(sourceLabels.map(l => l.integrity))
        });
      }

    } else {
      // Default: inherit all input confidentiality, transformation integrity
      outputLabels.set(path, deriveTransformedLabel(inputLabels, handler));
    }

    // Add control/flow confidentiality (PC) to the path label we just derived.
    // (Content labels come from the rules above; flow labels come from control.)
    //
    // Note: for collections, member reads are tainted via the container path label (4.6.3),
    // so we do not additionally rewrite each member label here.
    const outLabel = outputLabels.get(path)!;
    outLabel.confidentiality = [...outLabel.confidentiality, ...pcConfidentiality];

    // Add any explicit integrity
    if (ifc?.addedIntegrity) {
      outLabel.integrity = [...outLabel.integrity, ...ifc.addedIntegrity];
    }
  }

  // Second pass: apply checked recompositions now that their parts are labeled.
  for (const pending of pendingRecompositions) {
    const ifc = pending.schema.ifc?.recomposeProjections!;
    const { from, baseIntegrityType, parts } = ifc;

    if (!verifyRecomposeProjections(
      handler,
      inputLabels,
      outputLabels,
      outputValue,
      from,
      baseIntegrityType,
      parts
    )) {
      throw new Error(`IFC recomposeProjections violation at ${pending.path}`);
    }

    const sourceValue = getValueAtPath(handler.input, from);
    const sourceRef = refer(sourceValue);
    const partLabels = parts.map(p => outputLabels.get(p.outputPath)!);

    outputLabels.set(
      pending.path,
      recomposeFromProjections(partLabels, sourceRef, baseIntegrityType)
    );

    // Apply the same post-processing as other derived labels.
    const outLabel = outputLabels.get(pending.path)!;
    outLabel.confidentiality = [...outLabel.confidentiality, ...pcConfidentiality];
    if (pending.schema.ifc?.addedIntegrity) {
      outLabel.integrity = [...outLabel.integrity, ...pending.schema.ifc.addedIntegrity];
    }
  }

  return outputLabels;
}
```

### 8.9.2 Default Transition (No Annotation)

When no IFC annotation is present:
- **Confidentiality**: Concatenate all input confidentiality clauses (CNF join)
- **Integrity**: `TransformedBy` with handler code hash and input references

```typescript
function deriveTransformedLabel(
  inputLabels: Map<string, Label>,
  handler: Handler
): Label {
  return {
    confidentiality: concatClauses(
      Array.from(inputLabels.values()).map(l => l.confidentiality)
    ),
    integrity: [{
      type: "TransformedBy",
      codeHash: refer(handler.code).toString(),
      inputs: Array.from(inputLabels.keys()).map(p => refer(getValueAtPath(handler.input, p)))
    }]
  };
}

// Helper: concatenate clause arrays (CNF join)
function concatClauses(clauseArrays: Clause[][]): Clause[] {
  return clauseArrays.flat();
}

// Helper: intersect integrity atoms (meet).
//
// This keeps only atoms that appear in *every* input integrity list.
// Atom equality is structural equality over canonicalized JSON (Section 4.1.3).
function intersectAtoms(atomArrays: IntegrityAtom[][]): IntegrityAtom[] {
  if (atomArrays.length === 0) return [];
  const [first, ...rest] = atomArrays;
  return first.filter(a =>
    rest.every(arr => arr.some(b => canonicalize(b) === canonicalize(a)))
  );
}
```

---

## 8.10 Validation at Boundaries

At trusted boundaries (display, network egress, storage), the runtime validates that label transitions were correct.

### 8.10.1 Transition Verification

```typescript
function verifyTransition(
  handler: Handler,
  inputLabels: Map<string, Label>,
  outputLabels: Map<string, Label>,
  outputValue: unknown,
  schema: JSONSchema
): boolean {
  for (const [path, outputLabel] of outputLabels) {
    const ifc = getSchemaAtPath(schema, path).ifc;

    // Verify confidentiality is not reduced
    if (!isConfidentialityMonotone(inputLabels, outputLabel.confidentiality)) {
      return false;
    }

    // Verify integrity claims are justified
    if (ifc?.exactCopyOf) {
      // Must actually be exact copy
      const inputPath = ifc.exactCopyOf;
      const inputValue = getValueAtPath(handler.input, inputPath);
      const outputVal = getValueAtPath(outputValue, path);
      if (!refer(inputValue).equals(refer(outputVal))) return false;
    }

    if (ifc?.projection) {
      // Projection claims can be verified as an "exact copy of the source field".
      const sourceValue = getValueAtPath(handler.input, ifc.projection.from);
      const expectedFieldValue = getValueAtPath(sourceValue, ifc.projection.path);
      const outputVal = getValueAtPath(outputValue, path);
      if (!refer(expectedFieldValue).equals(refer(outputVal))) return false;
    }

    // Endorsed transformations (8.7.2):
    // if the schema claims preserved integrity, the transformer must be endorsed by the registry.
    if (ifc?.transformation?.preservesIntegrity?.length) {
      const measuredCodeHash = refer(handler.code).toString();
      const v = verifyEndorsedTransformation(
        /* registry */ getEndorsedTransformerRegistry(),
        measuredCodeHash,
        ifc.transformation
      );
      if (!v.valid) return false;
    }

    // Collection constraints (8.5): handler claims are verified and violations reject output.
    if (ifc?.collection?.subsetOf) {
      if (!verifySubset(ifc.collection.subsetOf, path, handler)) return false;
    }
    if (ifc?.collection?.permutationOf) {
      if (!verifyPermutation(ifc.collection.permutationOf, path, handler)) return false;
    }
    if (ifc?.collection?.filteredFrom) {
      if (!verifyFilteredFrom(ifc.collection.filteredFrom, path, handler)) return false;
    }
    if (ifc?.collection?.lengthPreserved) {
      const src = ifc.collection.sourceCollection;
      if (!src) return false;
      if (!verifyLengthPreserved(src, path, handler)) return false;
    }

    // Safe recomposition of projections (8.3.4): checked transition.
    if (ifc?.recomposeProjections) {
      const { from, baseIntegrityType, parts } = ifc.recomposeProjections;
      if (!verifyRecomposeProjections(
        handler,
        inputLabels,
        outputLabels,
        outputValue,
        from,
        baseIntegrityType,
        parts
      )) return false;
    }
  }
  return true;
}
```

### 8.10.2 Integrity Binding Verification

For instance-bound integrity, verify the scope binding:

```typescript
function verifyIntegrityBinding(
  integrity: IntegrityAtom[],
  value: unknown,
  resolveByRef: (ref: Reference) => unknown
): boolean {
  for (const atom of integrity) {
    if (atom.scope?.valueRef) {
      // Integrity claims to be about a specific value OR about a specific projection of a value.
      if (atom.scope?.projection) {
        // Scoped projection: check that the value matches the referenced source field.
        const sourceVal = resolveByRef(atom.scope.valueRef);
        const expected = getValueAtPath(sourceVal, atom.scope.projection);
        if (!refer(value).equals(refer(expected))) return false;
      } else {
        // Direct binding: valueRef refers to the value itself.
        if (!refer(value).equals(atom.scope.valueRef)) return false;
      }
    }
  }
  return true;
}
```

---

## 8.11 Content Labels vs Flow Labels

Confidentiality clauses can arise from two conceptually distinct sources, but are stored together in the single `Label` structure (Section 3.1.7):

### 8.11.1 Data Content Labels

Clauses describing the sensitivity of the **value itself**:

```typescript
const location = { lat: 37.7749, long: -122.4194 };
// Content contributes: [HighPrecision], [User(Alice)]
```

This answers: "How sensitive is this value?"

### 8.11.2 Data Flow Labels

Clauses describing what the **presence or routing** of this data reveals:

```typescript
// This location was routed through a decision influenced by:
// Flow contributes: [WeatherRequest]
```

This answers: "What does the existence of this data at this point reveal?"

### 8.11.3 Why Both Matter

The router attack (Section 10) shows why flow labels are needed. An adversary can encode high-precision data in routing decisions:

```
High-precision location → [router] → 64 paths → [declassifier] → low-precision outputs
```

Even though each output *value* is low-precision, the *routing decision* (which path was taken) encodes the high-precision input. If we only track content labels, the attack succeeds.

**Rule**: When data flows through a decision point influenced by labeled inputs, the *decision itself* inherits that label. All downstream outputs—regardless of their content—carry the decision's label.

### 8.11.4 Unified Representation

Both content and flow labels are stored in the same `confidentiality: Clause[]` array. They are not tracked separately at runtime—they're simply concatenated as the data flows through computations. The distinction is conceptual, helping explain where clauses come from:

- **Content clauses**: From schema `ifc` annotations and input data labels
- **Flow clauses**: Added when data passes through decision points influenced by labeled inputs

---

## 8.12 Store Label Monotonicity

Stores (persistent cells) have labels that must be **monotonically non-decreasing** over their lifetime.

### 8.12.1 The Constraint

A store's label may become **stricter** (more clauses, earlier `Expires` atoms) but never **looser**:

```typescript
function canUpdateStoreLabel(current: Label, proposed: Label): boolean {
  // Confidentiality (CNF): can only add clauses or remove alternatives
  // More clauses = more restrictive (more requirements)
  // Fewer alternatives per clause = more restrictive (fewer ways to satisfy)
  // Note: Expires atoms are confidentiality clauses; adding Expires(earlier) is allowed
  if (!isMoreRestrictiveCNF(current.confidentiality, proposed.confidentiality)) {
    return false;
  }

  // Integrity: can only remove atoms (weaker claims OK)
  if (!isSubset(proposed.integrity, current.integrity)) {
    return false;
  }

  return true;
}

// Check if proposed is at least as restrictive as current (CNF)
function isMoreRestrictiveCNF(current: Clause[], proposed: Clause[]): boolean {
  // Every clause in current must have a corresponding clause in proposed
  // that is at least as restrictive (same atoms or fewer alternatives)
  for (const currentClause of current) {
    const currentAlts = Array.isArray(currentClause) ? currentClause : [currentClause];

    // Find a matching clause in proposed
    const hasMatch = proposed.some(proposedClause => {
      const proposedAlts = Array.isArray(proposedClause) ? proposedClause : [proposedClause];
      // Proposed alternatives must be a subset of current alternatives
      // (fewer alternatives = more restrictive)
      return proposedAlts.every(alt =>
        currentAlts.some(c => atomEquals(c, alt))
      );
    });

    if (!hasMatch) return false;
  }

  // Additional clauses in proposed are fine (more restrictive)
  return true;
}
```

**Note**: In practice, store labels typically contain only singleton clauses (no disjunctions). Disjunctions arise from exchange rules evaluated at access time, not from storage. This simplifies monotonicity checking to clause set containment.

### 8.12.2 Rationale

This constraint:
1. **Simplifies analysis**: No need to track temporal sequences of label changes
2. **Prevents aliasing attacks**: Can't downgrade a store's label after high-confidentiality data was written
3. **Matches schema evolution**: Just as schemas can only add fields (backward compatible), labels can only add constraints

### 8.12.3 Schema Evolution Alignment

This aligns with the system's schema evolution rules:
- Schemas are strictly additive (new fields only)
- Each schema version is backward compatible with previous
- Labels follow the same principle: each update is "backward compatible" with prior confidentiality expectations

### 8.12.4 Writers and Readers

The store label constrains both:

**Writers**: Data written to the store must have a label that is ≤ the store's label:
```typescript
// Writer's data label must be covered by store label
function canWrite(dataLabel: Label, storeLabel: Label): boolean {
  return isSubsetOrEqual(dataLabel.confidentiality, storeLabel.confidentiality);
}
```

**Readers**: Anyone reading the store is tainted by the store's label:
```typescript
// Reader inherits store's label
function readLabel(storeLabel: Label): Label {
  return storeLabel;  // Reader's output is at least this restrictive
}
```

### 8.12.5 Upgrading Store Labels

When stricter data needs to be written to a store with looser labels:

1. **Reject the write**: The store cannot accept data more sensitive than its label
2. **Upgrade the store label**: Atomically tighten the store's label, then write
3. **Create a new store**: Write to a different store with appropriate labels

Option 2 is safe because upgrading is monotonic—existing readers already expect data at the original label level, and stricter data is always acceptable where looser data was expected.

### 8.12.6 Expiration Cascade

When a cell's data expires, the expiration **cascades** to all dependents in the reactive graph:

```typescript
interface ExpiredState {
  type: "expired";
  expiredAt: number;
  originalLabel: Label;
}

function onCellExpiration(cell: Cell): void {
  // Mark cell as expired
  cell.state = { type: "expired", expiredAt: Date.now(), originalLabel: cell.label };

  // Cascade to all dependents
  for (const dependent of cell.dependents) {
    propagateExpiration(dependent, cell);
  }
}

function propagateExpiration(cell: Cell, expiredSource: Cell): void {
  // If this cell has its own independent TTL (e.g., from declassification),
  // it may preserve its value until that TTL expires
  if (cell.hasDeclassifiedTTL && cell.declassifiedExpiration > Date.now()) {
    // Value preserved via declassified output path
    return;
  }

  // Otherwise, cascade the expiration
  cell.state = { type: "expired", expiredAt: Date.now(), originalLabel: cell.label };

  for (const dependent of cell.dependents) {
    propagateExpiration(dependent, cell);
  }
}
```

**Key behaviors**:

1. **Cascade by default**: Expired state propagates through the reactive graph
2. **Declassified TTL preservation**: If an output was declassified with a longer TTL (e.g., API response cached for 1 hour), that value persists until its own TTL expires
3. **Integrity on expiration**: Expired cells lose their integrity claims—the value is stale
4. **UI behavior**: Expired cells should display stale indicators or refresh prompts

**Example**: A user profile cell expires after 5 minutes. A derived "greeting" cell that depends on the profile also expires. However, if the greeting was sent to an external system with a 1-hour cache TTL, that external copy remains valid until its own expiration.

---

## 8.13 Opaque Inputs (Blind Data Passing)

Handlers can declare inputs as **opaque**: they receive a reference to the data but cannot read its content. This enables high-integrity routing decisions while passing untrusted content.

### 8.13.1 The Problem

Consider a routing module that decides where to send an email based on trusted metadata:

```typescript
function routeEmail(email: Email): Destination {
  // We want to:
  // 1. Read email.priority (trusted) to make routing decision
  // 2. Pass email.body (untrusted) to output without reading it
  // Problem: If we read email.body, our routing decision is tainted
}
```

Without opaque inputs, the routing decision's integrity is tainted by the untrusted body, even if the code doesn't actually use it.

### 8.13.2 Solution: Opaque Input Annotation

Mark inputs as opaque in the schema:

```json
{
  "type": "object",
  "properties": {
    "input": {
      "type": "object",
      "properties": {
        "priority": {
          "type": "string",
          "enum": ["high", "normal", "low"]
        },
        "body": {
          "type": "string",
          "ifc": {
            "opaque": true
          }
        }
      }
    },
    "output": {
      "type": "object",
      "properties": {
        "destination": { "type": "string" },
        "body": {
          "type": "string",
          "ifc": {
            "passThrough": { "from": "/input/body" }
          }
        }
      }
    }
  }
}
```

### 8.13.3 Semantics

When an input is marked `opaque`:

1. **Reference only**: The handler receives a reference to the value, not the value itself
2. **No content access**: Any attempt to read the content is a runtime error
3. **Type safety**: The schema can still specify the expected type for validation
4. **Pass-through allowed**: The reference can be placed in output (with `passThrough`)
5. **Integrity isolation**: The routing decision's integrity is NOT tainted by opaque input content

```typescript
function routeEmail(input: { priority: string; body: OpaqueRef<string> }) {
  // ✅ Can read priority (trusted)
  const dest = input.priority === "high" ? "urgent-queue" : "normal-queue";

  // ❌ Cannot read body.value - runtime error
  // const text = input.body.value;  // ERROR

  // ✅ Can pass reference to output
  return { destination: dest, body: input.body };
}
```

### 8.13.4 Label Propagation with Opaque Inputs

| Aspect | Effect |
|--------|--------|
| **Handler integrity** | NOT tainted by opaque input's label |
| **Output containing opaque ref** | Inherits opaque input's label (pass-through) |
| **Routing decisions** | Based only on non-opaque inputs |

This enables:
- High-integrity routing based on trusted metadata
- Untrusted content flowing through without contaminating decisions
- Safe "blind forwarding" patterns

### 8.13.5 Opaque with Schema Constraint

For type safety, specify what schema the opaque value must conform to:

```json
{
  "body": {
    "ifc": {
      "opaque": {
        "schema": { "type": "string", "maxLength": 10000 },
        "allowPassThrough": true
      }
    }
  }
}
```

The runtime validates the opaque value against the schema before passing it to the handler, but the handler still cannot read the content.

### 8.13.6 Use Cases

1. **Email routing**: Route based on headers without reading body
2. **Content moderation pipeline**: Route to appropriate moderator based on metadata, pass content blindly
3. **Multi-tenant processing**: Route based on tenant ID, process payload opaquely
4. **Confidential aggregation**: Collect references for later batch processing without reading individual items

### 8.13.7 Comparison with Authority-Only

Opaque and authority-only both prevent certain data from tainting outputs, but they operate at **different levels**:

| Concept | Level | Mechanism | Example |
|---------|-------|-----------|---------|
| **Opaque** | Handler schema annotation | Handler receives reference, cannot read content | Email body passes through router |
| **Authority-only** | Policy field classification | Policy declares API field authorizes but doesn't taint response | OAuth token in Authorization header |

**Key distinction**:
- **Opaque** is a schema annotation on *handler inputs* — the handler declares it won't read the content
- **Authority-only** is a policy classification for *external API fields* — the policy declares which request fields don't taint the response (Section 5.3.1)

Both achieve non-tainting but through different means:
- Opaque: Handler provably can't access content (enforced by runtime)
- Authority-only: Policy asserts the field's confidentiality doesn't flow to response (trusted assertion)

### 8.13.8 Opaque Violations Are Fatal

Attempts to access opaque reference content are **fatal errors** that cannot be caught by pattern code. This prevents information leakage through exception messages.

**Why fatal:**

1. **Exception messages leak content**: A runtime error like "Cannot read property 'name' of {ssn: '123-45-6789'}" would expose the opaque data in the error message.

2. **Catch blocks enable exfiltration**: If pattern code could catch opaque violations, it could infer information through exception handling patterns.

3. **Should not compile**: Ideally, the type system prevents opaque access at compile time. Runtime checks are a fallback.

**Behavior:**

```typescript
// This should not compile (type error)
function badHandler(data: OpaqueRef<Email>) {
  console.log(data.subject);  // Type error: cannot access opaque content
}

// If type check is bypassed, runtime enforcement:
function riskyHandler(data: unknown) {
  const opaque = data as OpaqueRef<Email>;
  try {
    console.log(opaque.subject);  // FATAL: terminates handler, no catch
  } catch (e) {
    // Never reached - opaque violations bypass catch
  }
}
```

**Fatal error handling:**

```typescript
interface OpaqueViolation {
  type: "OpaqueViolation";
  // NO content or stack trace - those might leak
  handlerHash: string;
  violationType: "read" | "stringify" | "reflect";
  // Reported to trusted runtime, not to pattern code
}
```

**Implications:**

- Pattern code cannot recover from opaque violations
- Violations are logged to trusted runtime for debugging
- Error details are sanitized before any output
- Handler execution terminates immediately

---

## 8.14 Open Problem: Contamination Scoping

When patterns process data through multiple steps, contamination in one step can cascade. This section describes the current model and open design questions.

### 8.14.1 Contamination as Absence of Integrity

The CFC model treats "safety from contamination" (e.g., no prompt injection) as an **added integrity atom**, not a default state:

```typescript
// Safety is expressed as presence of integrity atoms
interface InjectionSafeIntegrity {
  type: "InjectionSafe";
  validator: CodeHash;    // What validated it
  validatedAt: number;    // When
}

// Absence of this atom means: unknown, might be contaminated
// This is the normal IFC model—low integrity by default
```

**Key principle**: Data starts with no integrity claims. Trusted sources or validators *add* integrity atoms. Absence simply means "unknown"—the data might or might not be safe.

This follows standard IFC: you don't track "contaminated" as a taint, you track "validated" as an endorsement.

### 8.14.2 Blast Radius Isolation

Each processing step should have isolated failure domains:
- Contamination in step N doesn't automatically compromise step N+1
- Intent boundaries reset or constrain propagation
- Subtask outputs can be validated before integration

**Open design question**: How to make adding integrity practical without requiring validation at every step. Current mechanisms (scoped intents, integrity guards) provide building blocks, but the ergonomics need further design work.

---

## 8.15 Modification Authorization (Write Authority)

Previous sections describe label transitions for **computed values** (inputs → transformation → output). This section addresses **modifications**—updating stored data in place rather than computing new values.

### 8.15.1 Handler-Declared Write Capability

Each handler declares which fields it writes to. The handler's identity (code hash) is the unit of write authorization—no separate naming scheme is required.

**Handler schema** (each handler only knows about itself):

```json
{
  "$id": "IncrementHandler",
  "type": "object",
  "properties": {
    "count": {
      "type": "number",
      "default": 0,
      "ifc": { "writes": true }
    }
  }
}
```

```json
{
  "$id": "DecrementHandler",
  "type": "object",
  "properties": {
    "count": {
      "type": "number",
      "default": 0,
      "ifc": { "writes": true }
    }
  }
}
```

```json
{
  "$id": "ResetHandler",
  "type": "object",
  "properties": {
    "count": {
      "type": "number",
      "default": 0,
      "ifc": { "writes": true }
    }
  }
}
```

The `"ifc": { "writes": true }` annotation means “this handler writes this field.” Pattern compilation uses these declarations to derive a per-field **write-authority set**.

### 8.15.2 Schema Composes via Union

The pattern schema composes write-authority via **union**. When handlers declare `"writes": true` on a field, the composed schema records the set of handler identities authorized to modify that field:

```json
{
  "$id": "CounterPattern",
  "type": "object",
  "properties": {
    "count": {
      "type": "number",
      "default": 0,
      "ifc": {
        "writeAuthorizedBy": [
          { "type": "CodeHash", "hash": "sha256:increment-handler-..." },
          { "type": "CodeHash", "hash": "sha256:decrement-handler-..." },
          { "type": "CodeHash", "hash": "sha256:reset-handler-..." }
        ]
      }
    }
  }
}
```

The field's write-authority set means:
- Any listed handler identity may write this field
- Handlers don't need to know about each other
- Authorization is stable until the schema changes

### 8.15.3 Write Authority is Stable

Write authority is a property of the schema, not the value. It does not change per write:

| Event | Value | Write Authority |
|-------|-------|-----------|
| Creation (from default) | `0` | `{Increment, Decrement, Reset}` |
| After increment | `1` | `{Increment, Decrement, Reset}` |
| After decrement | `0` | `{Increment, Decrement, Reset}` |
| After reset | `0` | `{Increment, Decrement, Reset}` |

After any sequence of operations, the write-authority set remains the same.

**Provenance tracking** (the actual sequence of operations) is an audit log concern, not a label concern.

### 8.15.4 Default Value Initialization

Defaults are initialized by trusted runtime/pattern instantiation according to the schema. Write authorization applies to **subsequent modifications**; it does not require treating a default value as “written by” any particular handler.

### 8.15.5 Write Capability vs Minimum Integrity

Two distinct input constraints:

| Constraint | Meaning | Use case |
|------------|---------|----------|
| **Write capability** | "I write to this field" | Handler modifying a field |
| **Minimum integrity** | "Input must have at least this integrity" | Handler requiring trusted input |

**Write capability** (handler declares it writes):

```json
{
  "$id": "IncrementHandler",
  "properties": {
    "count": {
      "type": "number",
      "ifc": { "writes": true }
    }
  }
}
```

**Minimum integrity** (handler requires trusted input):

```json
{
  "$id": "SendEmailHandler",
  "properties": {
    "recipient": {
      "type": "string",
      "ifc": { "minIntegrity": [{ "type": "UserVerified" }] }
    }
  }
}
```

A handler that reads AND writes the same field (like `increment` reading then incrementing `count`):
- Reads are governed by confidentiality/integrity labels on the value (Sections 3–8)
- Writes are governed by the field's `writeAuthorizedBy` set (Section 8.15)

### 8.15.6 Write Authorization

When a handler attempts to modify a field:

```typescript
function authorizeWrite(
  handler: Handler,
  field: FieldSchema
): boolean {
  const writeAuthorizedBy = field.ifc?.writeAuthorizedBy ?? [];
  const handlerIdentity = { type: "CodeHash", hash: handler.identity };

  // Handler identity must be present in the field's write-authority set
  return writeAuthorizedBy.some(a => atomEquals(a, handlerIdentity));
}
```

### 8.15.7 Worked Example: Counter Pattern

**Handler schemas** (each independent):

```json
{
  "$id": "IncrementHandler",
  "type": "object",
  "properties": {
    "count": {
      "type": "number",
      "default": 0,
      "ifc": { "writes": true }
    }
  }
}
```

```json
{
  "$id": "DecrementHandler",
  "type": "object",
  "properties": {
    "count": {
      "type": "number",
      "default": 0,
      "ifc": { "writes": true }
    }
  }
}
```

**Composed pattern schema** (inferred from handlers):

```json
{
  "$id": "CounterPattern",
  "type": "object",
  "properties": {
    "count": {
      "type": "number",
      "default": 0,
      "ifc": {
        "writeAuthorizedBy": [
          { "type": "CodeHash", "hash": "sha256:increment-handler-..." },
          { "type": "CodeHash", "hash": "sha256:decrement-handler-..." }
        ]
      }
    }
  }
}
```

**Lifecycle**:

1. **Creation**: `count` exists with value `0`, write-authority `{Increment, Decrement}`

2. **Increment**: `IncrementHandler` identity in write-authority set ✓ → write authorized

3. **Malicious write**: External code identity not in write-authority set → rejected

4. **Decrement**: `DecrementHandler` identity in write-authority set ✓ → write authorized

### 8.15.8 Cross-Pattern Reuse

Because write authorization is keyed by handler identity, handlers can be reused across patterns:

```json
{
  "$id": "BoundedCounterPattern",
  "type": "object",
  "properties": {
    "count": {
      "type": "number",
      "default": 0,
      "ifc": {
        "writeAuthorizedBy": [
          { "type": "CodeHash", "hash": "sha256:increment-handler-..." },
          { "type": "CodeHash", "hash": "sha256:decrement-handler-..." },
          { "type": "CodeHash", "hash": "sha256:clamp-handler-..." }
        ]
      }
    }
  }
}
```

The `IncrementHandler` doesn't know about `ClampHandler`—its identity is simply included in the write-authority set. The pattern composes them.

### 8.15.9 Event Integrity Requirements

Handlers can require integrity on their triggering events:

```json
{
  "$id": "IncrementHandler",
  "type": "object",
  "properties": {
    "count": {
      "type": "number",
      "ifc": { "writes": true }
    }
  },
  "ifc": {
    "requiredEventIntegrity": [{ "type": "UserIntent", "action": "increment" }]
  }
}
```

This creates a two-layer check:
1. **Event integrity**: Is this event trustworthy enough to trigger the handler?
2. **Write authorization**: Is this handler's identity in the field's write-authority set?

### 8.15.10 Modification vs Replacement

| Operation | Example | Integrity model |
|-----------|---------|-----------------|
| **Modification** | `self.count++` | Handler identity must be in field's write-authority set |
| **Replacement** | `return { count: 5 }` | Standard transformation rules (Section 8.7) |

Modification preserves the field's identity and uses write authorization. Replacement creates a new value with transformation-derived integrity.

### 8.15.11 Compound Modifications

When a handler modifies multiple fields, its identity must be in each field's write-authority set:

```json
{
  "$id": "IncrementHandler",
  "type": "object",
  "properties": {
    "count": {
      "type": "number",
      "ifc": { "writes": true }
    },
    "lastModified": {
      "type": "number",
      "ifc": { "writes": true }
    }
  }
}
```

The handler declares it writes to both fields; its identity is included in both fields' write-authority sets.
