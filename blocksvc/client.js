import { connect as clientConnect } from '@ucanto/client'
import { CAR, CBOR, HTTP } from '@ucanto/transport'
import * as DID from '@ipld/dag-ucan/did'
import * as BlockCaps from './capabilities.js'

export * from './api.js'
export * from './service.js'

export const SERVICE_URL = 'https://block.web3.storage'
export const SERVICE_PRINCIPAL = 'did:web:block.web3.storage'

/**
 * Advance the clock by adding an event.
 *
 * @param {import('./api').InvocationConfig} conf
 * @param {import('@alanshaw/pail/link').AnyLink} cid
 * @param {import('./api').RequestOptions} [options]
 */
export async function get ({ issuer, with: resource, proofs, audience }, cid, options) {
  const conn = options?.connection ?? connect()
  const result = await BlockCaps.get
    .invoke({
      issuer,
      audience: audience ?? conn.id,
      with: resource,
      nb: { link: cid },
      proofs
    })
    .execute(conn)

  if (result.error) {
    throw new Error(`failed ${BlockCaps.get.can} invocation`, { cause: result })
  }

  return result
}

/**
 * @param {object} [options]
 * @param {import('@ucanto/interface').Principal} [options.servicePrincipal]
 * @param {URL} [options.serviceURL]
 * @returns {import('@ucanto/interface').ConnectionView<import('./service').Service>}
 */
export function connect (options) {
  return clientConnect({
    id: options?.servicePrincipal ?? DID.parse(SERVICE_PRINCIPAL),
    encoder: CAR,
    decoder: CBOR,
    channel: HTTP.open({
      url: options?.serviceURL ?? new URL(SERVICE_URL),
      method: 'POST'
    })
  })
}
