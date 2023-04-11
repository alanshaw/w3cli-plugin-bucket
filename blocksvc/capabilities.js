import { capability, URI, Link, Failure, Schema } from '@ucanto/validator'

/**
 * @typedef {import('@ucanto/interface').InferInvokedCapability<typeof get>} BlockGet
 */

/**
 * Retrieve a block by CID.
 */
export const get = capability({
  can: 'block/get',
  with: URI.match({ protocol: 'did:' }),
  nb: Schema.struct({ link: Link }),
  derives: equalWith
})

/**
 * Checks that `with` on claimed capability is the same as `with`
 * in delegated capability. Note this will ignore `can` field.
 *
 * @param {import('@ucanto/interface').ParsedCapability} claim
 * @param {import('@ucanto/interface').ParsedCapability} proof
 */
function equalWith (claim, proof) {
  return claim.with === proof.with || new Failure(`Can not derive ${claim.can} with ${claim.with} from ${proof.with}`)
}
