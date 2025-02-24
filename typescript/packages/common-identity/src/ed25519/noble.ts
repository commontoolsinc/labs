import * as ed25519 from "@noble/ed25519";
import { InsecureCryptoKeyPair, Verifier, Signer, DID } from "../interface.js";
import { bytesToDid, didToBytes } from "./utils.js";

export class NobleEd25519Signer implements Signer {
  private keypair: InsecureCryptoKeyPair;
  constructor(keypair: InsecureCryptoKeyPair) {
    this.keypair = keypair;
  }

  verifier(): NobleEd25519Verifier {
    return new NobleEd25519Verifier(this.keypair.publicKey);
  }

  serialize(): InsecureCryptoKeyPair {
    return this.keypair;
  }
  
  async sign(data: Uint8Array): Promise<Uint8Array> {
    return await ed25519.signAsync(data, this.keypair.privateKey);
  }

  static async fromRaw(privateKey: Uint8Array): Promise<NobleEd25519Signer> {
    const publicKey = await ed25519.getPublicKeyAsync(privateKey);
    return new NobleEd25519Signer({ publicKey, privateKey });
  }

  static async generate(): Promise<NobleEd25519Signer> {
    let privateKey = ed25519.utils.randomPrivateKey();
    return await NobleEd25519Signer.fromRaw(privateKey);
  }

  static async deserialize(keypair: InsecureCryptoKeyPair) {
    return new NobleEd25519Signer(keypair);
  }
}

export class NobleEd25519Verifier implements Verifier {
  private publicKey: Uint8Array;
  private _did: DID;
  constructor(publicKey: Uint8Array) {
    this.publicKey = publicKey;
    this._did = bytesToDid(publicKey);
  }

  async verify(signature: Uint8Array, data: Uint8Array): Promise<boolean> {
    return await ed25519.verifyAsync(signature, data, this.publicKey);
  }

  did(): DID{
    return this._did;
  }
  
  static async fromDid(did: DID): Promise<NobleEd25519Verifier> {
    let bytes = didToBytes(did);
    return await NobleEd25519Verifier.fromRaw(bytes);
  }
  
  static async fromRaw(rawPublicKey: Uint8Array): Promise<NobleEd25519Verifier> {
    return new NobleEd25519Verifier(rawPublicKey);
  }
}