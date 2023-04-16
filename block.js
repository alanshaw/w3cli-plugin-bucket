import retry from 'p-retry'

export { FsBlockstore } from 'blockstore-fs'

/**
 * @param {import('@alanshaw/pail/block').BlockFetcher} fetcher
 * @param {Pick<import('interface-blockstore').Blockstore, 'get'|'put'>} cache
 */
export function withCache (fetcher, cache) {
  return {
    /**
     * @param {import('@alanshaw/pail/link').AnyLink} cid
     * @returns {Promise<import('@alanshaw/pail/block').AnyBlock | undefined>}
     */
    async get (cid) {
      try {
        // @ts-ignore
        const bytes = await cache.get(cid)
        if (bytes) return { cid, bytes }
      } catch {}
      const block = await fetcher.get(cid)
      if (block) {
        // @ts-ignore
        await cache.put(cid, block.bytes)
      }
      return block
    }
  }
}

export class GatewayBlockFetcher {
  #url

  /** @param {string|URL} [url] */
  constructor (url) {
    this.#url = new URL(url ?? 'https://ipfs.io')
  }

  /**
   * @param {import('@alanshaw/pail/link').AnyLink} cid
   * @returns {Promise<import('@alanshaw/pail/block').AnyBlock | undefined>}
   */
  async get (cid) {
    return await retry(async () => {
      const controller = new AbortController()
      const timeoutID = setTimeout(() => controller.abort(), 10000)
      try {
        const res = await fetch(new URL(`/ipfs/${cid}?format=raw`, this.#url), { signal: controller.signal })
        if (!res.ok) return
        const bytes = new Uint8Array(await res.arrayBuffer())
        return { cid, bytes }
      } catch (err) {
        throw new Error(`failed to fetch block: ${cid}`, { cause: err })
      } finally {
        clearTimeout(timeoutID)
      }
    })
  }
}
