import { MemoryBlockstore } from 'blockstore-core'
export { FsBlockstore } from 'blockstore-fs'

export class GatewayBlockFetcher {
  #url
  cache

  /**
   * @param {string|URL} [url]
   * @param {Pick<import('interface-blockstore').Blockstore, 'get'|'put'|'delete'>} [cache]
   */
  constructor (url, cache) {
    this.#url = new URL(url ?? 'https://ipfs.io')
    this.cache = cache ?? new MemoryBlockstore()
  }

  /**
   * @param {import('@alanshaw/pail/link').AnyLink} cid
   * @returns {Promise<import('@alanshaw/pail/block').AnyBlock | undefined>}
   */
  async get (cid) {
    try {
      // @ts-ignore
      const bytes = await this.cache.get(cid)
      if (bytes) return { cid, bytes }
    } catch {}
    const controller = new AbortController()
    const timeoutID = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await fetch(new URL(`/ipfs/${cid}?format=raw`, this.#url), { signal: controller.signal })
      if (!res.ok) return
      const bytes = new Uint8Array(await res.arrayBuffer())
      // @ts-ignore
      await this.cache.put(cid, bytes)
      return { cid, bytes }
    } catch (err) {
      throw new Error(`failed to fetch block: ${cid}`, { cause: err })
    } finally {
      clearTimeout(timeoutID)
    }
  }
}
