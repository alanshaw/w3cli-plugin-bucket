import * as Client from './client.js'

export class Fetcher {
  #conf
  #options

  /**
   * @param {import('./api').InvocationConfig} conf
   * @param {import('./api').RequestOptions} [options]
   */
  constructor (conf, options) {
    this.#conf = conf
    this.#options = options
  }

  /**
   * @param {import('@alanshaw/pail/link').AnyLink} cid
   * @returns {Promise<import('@alanshaw/pail/block').AnyBlock | undefined>}
   */
  async get (cid) {
    try {
      const bytes = await Client.get(this.#conf, cid, this.#options)
      return { cid, bytes }
    } catch {}
  }
}
