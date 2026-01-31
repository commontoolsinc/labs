# 9. Threat Model

## 9.1 Attacker Capabilities

CFC defends against:

### 9.1.1 Untrusted Application Code
- Patterns/handlers that may be malicious or buggy
- Code that attempts to exfiltrate data or escalate privileges
- Defense: Sandbox isolation, label propagation, integrity requirements

### 9.1.2 Network Adversary
- Passive observation of network traffic
- Active manipulation of requests/responses
- Defense: TLS required, origin principals track provenance

### 9.1.3 Confused Deputy Attacks
- Tricking trusted components into misusing authority
- Authority-only secrets that could leak into responses
- Defense: Authority-only classification, exchange rules

### 9.1.4 UI Spoofing
- Fake UI elements to trick users into unintended actions
- Clickjacking and similar attacks
- Defense: Snapshot digests, VDOM binding, gesture provenance

## 9.2 Trust Boundaries

### 9.2.1 Trusted Computing Base (TCB)

The following components are part of the TCB and must be attested:

- **UI Runtime**: Renders VDOM, captures gestures, mints UI evidence. Must be isolated and attested to ensure it correctly binds gestures to rendered elements and produces accurate snapshot digests.
- **Policy Evaluator**: Evaluates exchange rules, enforces labels
- **Intent Refiner**: Transforms events to consumable intents
- **Code Identity**: Hash-based identification of handlers

Attestation may use code signing, runtime integrity checks, or platform-specific mechanisms (e.g., Web Attestation API, Trusted Execution Environments). The specific attestation mechanism is deployment-dependent.

### 9.2.2 Untrusted Components
- **Patterns/Handlers**: Application code in sandbox
- **External APIs**: Network services behind fetch boundary
- **User Input**: All user-provided data starts untrusted

## 9.3 Scope of Protection

### 9.3.1 In Scope
- Data confidentiality within the reactive system
- Integrity of authorization flows
- Single-use semantics for intents
- Label propagation through computations

### 9.3.2 Out of Scope

#### Browser Extensions

Browser extensions operate with elevated privileges and can:
- Read and modify DOM content, including sensitive data
- Intercept network requests before TLS and after decryption
- Inject scripts into page context
- Observe user gestures and keystrokes

**CFC cannot protect against malicious browser extensions.** This is a fundamental platform limitation—extensions run outside the browser's content security model.

**Recommendations for high-security deployments**:
- Use managed browsers with extension restrictions
- Deploy as standalone applications (Electron, Tauri) without extension support
- Use enterprise policies to whitelist trusted extensions only
- Consider rendering sensitive content in cross-origin iframes (partial mitigation)

#### Other Out-of-Scope Threats

- **Hardware side channels**: Timing attacks, power analysis, cache timing. These are addressed at the implementation level, not the specification level.
- **Social engineering**: Users who voluntarily share secrets or are tricked into doing so outside the system.
- **Denial of service**: Resource exhaustion attacks are handled by runtime limits, not IFC.

## 9.4 Trust Assumptions

1. **Browser is trusted**: The browser correctly isolates JavaScript contexts (but see [§9.3.2](#932-out-of-scope) regarding extensions)
2. **TLS is secure**: Network encryption prevents tampering
3. **Code hashes are collision-resistant**: SHA-256 or equivalent
4. **UI runtime is attested**: The UI runtime is part of the TCB, verified via attestation, and correctly produces snapshot digests that accurately represent rendered state
5. **Clock is approximately synchronized**: For intent expiration
6. **Reactive system settles**: The reactive model eventually reaches a stable state; transient intermediate states are not observable to external attackers

## 9.5 Limitations

See [§10](./10-safety-invariants.md#10-safety-invariants) (Safety Invariants) for:
- Overlapping declassifiers (recombination attacks)
- Termination sensitivity edge cases
- Multi-step contamination scoping (open problem)
