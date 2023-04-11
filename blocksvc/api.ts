import { Signer, Proof, DID, Principal, ConnectionView } from '@ucanto/interface'
import { Service } from './service'

export interface InvocationConfig {
  /**
   * Signing authority that is issuing the UCAN invocation(s).
   */
  issuer: Signer
  /**
   * The principal delegated to in the current UCAN.
   */
  audience?: Principal
  /**
   * The resource the invocation applies to.
   */
  with: DID
  /**
   * Proof(s) the issuer has the capability to perform the action.
   */
  proofs: Proof[]
}

export interface Connectable {
  connection?: ConnectionView<Service>
}

export interface RequestOptions extends Connectable {}
