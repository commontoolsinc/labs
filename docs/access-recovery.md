# Access Recovery

There are multiple choices available for setting up account recovery. It is also probably best to let users make their own decision which recovery method to opt-into based on their risk profile.

It is also important to observe that convenience of recovery mechanism is at odds with privacy concerns, specifically if you can recover access to multiple spaces with single principal that leaves the trace in the delegation chain as all access will come downstream from that principal.

## Recovery Using Mnemonics

Easiest and most common recovery mechanism is based on [BIP39](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki) mnemonic phrase. During space creation keypair can be serialized into a mnemonic phrase and handed out to the user.

This mechanism is probably reasonable for account recovery, but not for a space access recovery because larger the number of mnemonics greater the chance of them getting lost or not being saved securely.

## Recovery Using Verifiable Claims

Keybase pioneered this interaction flow and then was adopted by web3.storage to implement email based recovery mechanism. General idea is to represent arbirtary identity via [did](https://www.w3.org/TR/did-core/) identifier so that full access could be delegated to it when setting up a recovery. On recovery that identity can then redelagate access to new [did:key] principal by making a verifiable claim claim like "I delegate `/query/*` capability to did:key:z6Mk......". That claim if verifiable can be used more or less like cryptographic signature. In fact [varsig] can be leveraged to define custom signature type so it would be verifiable.

The [did:mailto] specification defines [did] principals for emails so that described scheme can be used to delegate access to email handle and recover it from the email handle, support for which was implemented and shipped in web3.storage.

> Verification process implies resolving domain keys and ensuring that provided claim has being signed by that key.

It is worth calling out that proof creation and verification in this flow is pretty novel which posed challenge, as users need to send out an email with specific text.

To mitigate this challenge web3.storage also came up with a [solution that allowed verification through conventional email flow](https://github.com/storacha/specs/blob/main/w3-session.md#authorization-session). General idea is that when recovery with email is initiated, trusted party can perform verification that user indeed controls email handle by sending them a confirmation prompt. If user confirms request trusted third party can issue attestation that indeed request to delegate from email to specific [did:key] has being verified and sign it with their own key. This attestation can then be used when verifying delegation chain, if verifier trusts issuer of the attestation they can trust the delegation chain. If verifier does not trust issuer of the attestation they can initiate another email verification process through a trusted third party (or themselves).


Please note that this solution is not tied to an email identifiers, same principal can apply to any other identifier which is what keybase did. For example similar approach can be used with bluesky identifiers, where recovery could be posted as special message and that message along with merkle-proof could be used to verify delegation chain.

## Recovery Using Trusted Third Party

This is perhaps very simple yet pragmatic solution. When new space is created user can delegate access to trusted third party e.g. `did:web:common.tools`. For recovery user will have to prove to common.tools out of bound that they were the ones who delegated access to the space and request that it be redelegated to desired [`did:key`](https://www.w3.org/TR/did-core/#did-key).

Unlike all other mechanisms this would disguise any relation across spaces as single principal at play will be the same `did:web:common.tools` across them. Tradeoff however is that `did:web:common.tools` could be compelled to redelegate access to any other [did:key] principal regardless if they are under user control or not.

## Recovery Using Threshold Signatures

[BLS](https://en.wikipedia.org/wiki/BLS_digital_signature) keys and signatures could be used to setup recovery through threshold signatures. Specifically when setting up recovery user may choose `n` principals from which `m` principals would have to cooperate to authorize recovery request.

[varsig]:https://github.com/ChainAgnostic/varsig
[did:mailto]:https://github.com/storacha/specs/blob/main/did-mailto.md
[did:key]:https://www.w3.org/TR/did-core/#did-key
