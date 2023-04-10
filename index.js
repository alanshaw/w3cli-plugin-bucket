#!/usr/bin/env node
import fs from 'fs'
import os from 'os'
import path from 'path'
import clc from 'cli-color'
import archy from 'archy'
import http from 'http'
import { CID } from 'multiformats/cid'
import { CarBufferWriter } from '@ipld/car'
import * as Pail from '@alanshaw/pail/crdt'
import * as Clock from '@alanshaw/pail/clock'
import { ShardFetcher } from '@alanshaw/pail/shard'
import * as json from '@ipld/dag-json'
import * as Remote from '@web3-storage/clock/client'
import * as Server from '@web3-storage/clock/server'
import * as ClockCaps from '@web3-storage/clock/capabilities'
import { FsBlockstore, GatewayBlockFetcher } from './block.js'
import { Failure } from '@ucanto/server'

/**
 * @typedef {{ id: import('@ucanto/interface').DID, url: string }} Remote
 * @typedef {{ remotes: Record<string, Remote> }} Config
 */

/**
 * @param {import('sade').Sade} cli
 * @param {import('@web3-storage/w3up-client').Client} client
 */
export async function plugin (cli, client) {
  cli.command('bucket put <key> <value>')
    .describe('Put a value (a CID) for the given key. If the key exists it\'s value is overwritten.')
    .alias('set')
    .action(async (key, value, opts) => {
      const space = mustGetSpace(client)
      const [blocks, head] = await Promise.all([getBlockFetcher(client.agent().did(), space.did()), readLocalClockHead(client.agent().did(), space.did())])
      const res = await Pail.put(blocks, head, key, CID.parse(value))

      await blocks.cache.put(res.event.cid, res.event.bytes)
      for (const block of res.additions) {
        await blocks.cache.put(block.cid, block.bytes)
      }

      const pendingBlocks = await readPendingBlocks(client.agent().did(), space.did())
      pendingBlocks.push(res.event.cid, ...res.additions.map(a => a.cid))

      await writePendingBlocks(client.agent().did(), space.did(), pendingBlocks)
      await writeLocalClockHead(client.agent().did(), space.did(), res.head)
    })

  cli.command('bucket get <key>')
    .describe('Get the stored value for the given key from the bucket. If the key is not found, `undefined` is returned.')
    .action(async (key, opts) => {
      const space = mustGetSpace(client)
      const blocks = await getBlockFetcher(client.agent().did(), space.did())
      const head = await readLocalClockHead(client.agent().did(), space.did())
      const value = await Pail.get(blocks, head, key)
      if (value) console.log(value.toString())
    })

  cli.command('bucket del <key>')
    .describe('Delete the value for the given key from the bucket. If the key is not found no operation occurs.')
    .alias('delete', 'rm', 'remove')
    .action(async (key, opts) => {
      const space = mustGetSpace(client)
      const [blocks, head] = await Promise.all([getBlockFetcher(client.agent().did(), space.did()), readLocalClockHead(client.agent().did(), space.did())])
      const res = await Pail.del(blocks, head, key)

      await blocks.cache.put(res.event.cid, res.event.bytes)
      for (const block of res.additions) {
        await blocks.cache.put(block.cid, block.bytes)
      }

      const pendingBlocks = await readPendingBlocks(client.agent().did(), space.did())
      pendingBlocks.push(res.event.cid, ...res.additions.map(a => a.cid))

      await writePendingBlocks(client.agent().did(), space.did(), pendingBlocks)
      await writeLocalClockHead(client.agent().did(), space.did(), res.head)
    })

  cli.command('bucket ls')
    .describe('List entries in the bucket.')
    .alias('list')
    .option('-p, --prefix', 'Key prefix to filter by.')
    .option('--json', 'Format output as newline delimted JSON.')
    .action(async (opts) => {
      const space = mustGetSpace(client)
      const [blocks, head] = await Promise.all([getBlockFetcher(client.agent().did(), space.did()), readLocalClockHead(client.agent().did(), space.did())])
      let n = 0
      if (head.length) {
        for await (const [k, v] of Pail.entries(blocks, head, { prefix: opts.prefix })) {
          console.log(opts.json ? JSON.stringify({ key: k, value: v.toString() }) : `${k}\t${v}`)
          n++
        }
      }
      if (!opts.json) console.log(`total ${n}`)
    })

  cli.command('bucket tree')
    .describe('Visualise the bucket.')
    .action(async (opts) => {
      const space = mustGetSpace(client)
      const blocks = await getBlockFetcher(client.agent().did(), space.did())

      const localHead = await readLocalClockHead(client.agent().did(), space.did())
      if (!localHead.length) return

      const rootRes = await Pail.root(blocks, localHead)
      rootRes.additions.forEach(a => blocks.cache.put(a.cid, a.bytes))

      const shards = new ShardFetcher(blocks)
      const rshard = await shards.get(rootRes.root)
  
      /** @type {archy.Data} */
      const archyRoot = { label: `Shard(${clc.yellow(rshard.cid.toString())}) ${rshard.bytes.length + 'b'}`, nodes: [] }
  
      /** @param {import('@alanshaw/pail/shard').ShardEntry} entry */
      const getData = async ([k, v]) => {
        if (!Array.isArray(v)) {
          return { label: `Key(${clc.magenta(k)})`, nodes: [{ label: `Value(${clc.cyan(v)})` }] }
        }
        /** @type {archy.Data} */
        const data = { label: `Key(${clc.magenta(k)})`, nodes: [] }
        if (v[1]) data.nodes?.push({ label: `Value(${clc.cyan(v[1])})` })
        const blk = await shards.get(v[0])
        data.nodes?.push({
          label: `Shard(${clc.yellow(v[0])}) ${blk.bytes.length + 'b'}`,
          nodes: await Promise.all(blk.value.map(e => getData(e)))
        })
        return data
      }
  
      for (const entry of rshard.value) {
        archyRoot.nodes?.push(await getData(entry))
      }
  
      console.log(archy(archyRoot))
    })

  cli.command('bucket push [remote]')
    .describe('Push local changes to the remote peer.')
    .action(async (remote = 'origin') => {
      const space = mustGetSpace(client)
      const proofs = client.proofs([{ with: space.did(), can: 'clock/advance' }])
      if (!proofs.length) {
        throw new Error(`${client.agent().did()} does not have write access to ${space.did()}`)
      }
      const config = await readConfig(client.agent().did(), space.did())
      if (!config.remotes[remote]) {
        throw new Error(`remote "${remote}" is not known`)
      }
      const localHead = await readLocalClockHead(client.agent().did(), space.did())
      if (!localHead.length) {
        return console.log('Done, nothing to push.')
      }
      const pendingCIDs = await readPendingBlocks(client.agent().did(), space.did())
      if (!pendingCIDs.length) {
        return console.log('Done, nothing to push.')
      }
      
      const blocks = await getBlockFetcher(client.agent().did(), space.did())
      const pendingBlocks = []
      for await (const cid of pendingCIDs) {
        // @ts-ignore
        const bytes = await blocks.cache.get(cid)
        pendingBlocks.push({ cid, bytes })
      }

      const rootRes = await Pail.root(blocks, localHead)
      pendingBlocks.push(...rootRes.additions)

      console.log(`Storing ${pendingBlocks.length} blocks:`)
      pendingCIDs.forEach(cid => console.log(`\t${cid}`))
      // @ts-ignore
      await storeBlocks(client, rootRes.root, pendingBlocks)

      const connection = Remote.connect({
        servicePrincipal: { did: () => config.remotes[remote].id },
        serviceURL: new URL(config.remotes[remote].url)
      })

      let remoteHead
      let n = 1
      console.log(`Pushing events to ${remote}:`)
      for await (const event of localHead) {
        console.log(`\t${event} (${n} of ${localHead.length})`)
        remoteHead = await Remote.advance({ issuer: client.agent(), with: space.did(), proofs }, event, { connection })
        n++
      }

      await writePendingBlocks(client.agent().did(), space.did(), [])
      console.log(`Done, ${remote} head updated:`)
      remoteHead?.forEach(e => console.log(`\t${e}`))
    })

  cli.command('bucket pull [remote]')
    .describe('Pull remote changes from the bucket and advance the local merkle clock.')
    .action(async (remote = 'origin') => {
      const space = mustGetSpace(client)
      const proofs = client.proofs([{ with: space.did(), can: 'clock/head' }])
      if (!proofs.length) {
        throw new Error(`${client.agent().did()} does not have write access to ${space.did()}`)
      }
      const config = await readConfig(client.agent().did(), space.did())
      if (!config.remotes[remote]) {
        throw new Error(`remote "${remote}" is not known`)
      }

      const connection = Remote.connect({
        servicePrincipal: { did: () => config.remotes[remote].id },
        serviceURL: new URL(config.remotes[remote].url)
      })
      const remoteHead = await Remote.head({ issuer: client.agent(), with: space.did(), proofs }, { connection })

      const blocks = await getBlockFetcher(client.agent().did(), space.did())
      let localHead = await readLocalClockHead(client.agent().did(), space.did())
      let n = 1
      console.log(`Pulling events from ${remote}:`)
      for await (const event of remoteHead) {
        console.log(`\t${event} (${n} of ${remoteHead.length})`)
        localHead = await Clock.advance(blocks, localHead, event)
        n++
      }
      if (!localHead.length) {
        return console.log('Done, nothing to pull.')
      }
      await writeLocalClockHead(client.agent().did(), space.did(), localHead)
      console.log(`Done, local head updated:`)
      localHead.forEach(e => console.log(`\t${e}`))
    })

  cli.command('bucket remote add <name> <did> <url>')
    .describe('Add a remote to config.')
    .action(async (name, did, url) => {
      const space = mustGetSpace(client)
      const config = await readConfig(client.agent().did(), space.did())
      config.remotes[name] = { id: did, url }
      await writeConfig(client.agent().did(), space.did(), config)
    })

  cli.command('bucket remote remove <name>')
    .describe('Remove a remote from config.')
    .action(async (name) => {
      const space = mustGetSpace(client)
      const config = await readConfig(client.agent().did(), space.did())
      delete config.remotes[name]
      await writeConfig(client.agent().did(), space.did(), config)
    })

  cli.command('bucket remote ls')
    .describe('List configured remotes.')
    .option('--verbose', 'Show additional remote information.', false)
    .action(async (opts) => {
      const space = mustGetSpace(client)
      const config = await readConfig(client.agent().did(), space.did())
      for (const [name, { id, url }] of Object.entries(config.remotes)) {
        if (opts.verbose) {
          console.log(`${name}\t${id}\t${url}`)
        } else {
          console.log(name)
        }
      }
    })

  cli.command('bucket head')
    .describe('Print the events at the head of a bucket\'s merkle clock')
    .option('-r, --remote', 'Print remote head.')
    .action(async (opts) => {
      const space = mustGetSpace(client)
      let head
      if (opts.remote) {
        const remote = opts.remote === true ? 'origin' : opts.remote
        const proofs = client.proofs([{ with: space.did(), can: 'clock/head' }])
        if (!proofs.length) {
          throw new Error(`${client.agent().did()} does not have write access to ${space.did()}`)
        }
        const config = await readConfig(client.agent().did(), space.did())
        if (!config.remotes[remote]) {
          throw new Error(`remote "${remote}" is not known`)
        }
        const connection = Remote.connect({
          servicePrincipal: { did: () => config.remotes[remote].id },
          serviceURL: new URL(config.remotes[remote].url)
        })
        head = await Remote.head({ issuer: client.agent(), with: space.did(), proofs }, { connection })
      } else {
        head = await readLocalClockHead(client.agent().did(), space.did())
      }
      head.forEach(h => console.log(h.toString()))
    })

  cli.command('bucket server')
    .describe('Start a bucket HTTP server so participants can push updates directly to you.')
    .option('-p, --port', 'Port to start the server on', 9417)
    .action(async (opts) => {
      const space = mustGetSpace(client)
      const server = Server.createServer(client.agent(), {
        clock: {
          advance: Server.provide(
            ClockCaps.advance,
            async ({ capability }) => {
              if (capability.with !== space.did()) {
                return new Failure(`invalid resource: ${capability.with}`)
              }
              const [blocks, head] = await Promise.all([getBlockFetcher(client.agent().did(), space.did()), readLocalClockHead(client.agent().did(), space.did())])
              const res = await Clock.advance(blocks, head, capability.nb.event)
              await writeLocalClockHead(client.agent().did(), space.did(), res)
              return res
            }
          ),
          head: Server.provide(
            ClockCaps.head,
            async ({ capability }) => {
              if (capability.with !== space.did()) {
                return new Failure(`invalid resource: ${capability.with}`)
              }
              return await readLocalClockHead(client.agent().did(), space.did())
            }
          )
        }
      })

      const httpServer = http.createServer(async (request, response) => {
        try {
          const chunks = []
          for await (const chunk of request) {
            chunks.push(chunk)
          }

          const { headers, body } = await server.request({
            body: Buffer.from(chunks),
            // @ts-ignore
            headers: request.headers
          })

          response.writeHead(200, headers)
          response.write(body)
        } catch (err) {
          console.error(err)
          response.writeHead(500)
        } finally {
          response.end()
        }
      })
      const port = opts.port ?? 9417

      httpServer.listen(port, () => console.log(`Listening on :${port}`))
    })
}

/**
 * @param {import('@web3-storage/w3up-client').Client} client
 * @param {import('@alanshaw/pail/shard').ShardLink} root
 * @param {import('@alanshaw/pail/block').AnyBlock[]} blocks
 */
async function storeBlocks (client, root, blocks) {
  const headerLength = CarBufferWriter.estimateHeaderLength(1)
  const byteLength = blocks.reduce((l, b) => {
    // @ts-ignore
    return l + CarBufferWriter.blockLength(b)
  }, 0)
  const buffer = new ArrayBuffer(headerLength + byteLength)
  // @ts-ignore
  const writer = CarBufferWriter.createWriter(buffer, { roots: [root] })
  // @ts-ignore
  blocks.forEach(b => writer.write(b))
  writer.close()

  const link = await client.capability.store.add(new Blob([buffer]))
  await client.capability.upload.add(root, [link])
}

/** @returns {Config} */
function defaultConfig () {
  return {
    remotes: {
      origin: {
        id: Remote.SERVICE_PRINCIPAL,
        url: Remote.SERVICE_URL
      }
    }
  }
}

/**
 * @param {import('@ucanto/interface').DID} agentDID
 */
function bucketPath (agentDID) {
  return process.env.W3BUCKET_PATH ?? path.join(os.homedir(), '.w3bucket', agentDID)
}

/**
 * @param {import('@ucanto/interface').DID} agentDID
 * @param {import('@ucanto/interface').DID} spaceDID
 * @returns {Promise<Config>}
 */
async function readConfig (agentDID, spaceDID) {
  const file = path.join(bucketPath(agentDID), spaceDID, 'config.json')
  try {
    return json.decode(await fs.promises.readFile(file))
  } catch (err) {
    if (err.code === 'ENOENT') return defaultConfig()
    throw err
  }
}

/**
 * @param {import('@ucanto/interface').DID} agentDID
 * @param {import('@ucanto/interface').DID} spaceDID
 * @param {Config} config
 */
async function writeConfig (agentDID, spaceDID, config) {
  const dir = path.join(bucketPath(agentDID), spaceDID)
  await fs.promises.mkdir(dir, { recursive: true })
  await fs.promises.writeFile(path.join(dir, 'config.json'), json.encode(config))
}

/**
 * @param {import('@ucanto/interface').DID} agentDID
 * @param {import('@ucanto/interface').DID} spaceDID
 * @returns {Promise<import('@alanshaw/pail/clock').EventLink<import('@alanshaw/pail/crdt').EventData>[]>}
 */
async function readLocalClockHead (agentDID, spaceDID) {
  const file = path.join(bucketPath(agentDID), spaceDID, 'HEAD.json')
  try {
    return json.decode(await fs.promises.readFile(file))
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
}

/**
 * @param {import('@ucanto/interface').DID} agentDID
 * @param {import('@ucanto/interface').DID} spaceDID
 * @param {import('@alanshaw/pail/clock').EventLink<import('@alanshaw/pail/crdt').EventData>[]} head
 */
async function writeLocalClockHead (agentDID, spaceDID, head) {
  const dir = path.join(bucketPath(agentDID), spaceDID)
  await fs.promises.mkdir(dir, { recursive: true })
  await fs.promises.writeFile(path.join(dir, 'HEAD.json'), json.encode(head))
}

/**
 * @param {import('@ucanto/interface').DID} agentDID
 * @param {import('@ucanto/interface').DID} spaceDID
 * @returns {Promise<import('multiformats').Link[]>}
 */
async function readPendingBlocks (agentDID, spaceDID) {
  const file = path.join(bucketPath(agentDID), spaceDID, 'pending.json')
  try {
    return json.decode(await fs.promises.readFile(file))
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
}

/**
 * @param {import('@ucanto/interface').DID} agentDID
 * @param {import('@ucanto/interface').DID} spaceDID
 * @param {import('multiformats').Link[]} blocks
 */
async function writePendingBlocks (agentDID, spaceDID, blocks) {
  const dir = path.join(bucketPath(agentDID), spaceDID)
  await fs.promises.mkdir(dir, { recursive: true })
  await fs.promises.writeFile(path.join(dir, 'pending.json'), json.encode(blocks))
}

/**
 * @param {import('@ucanto/interface').DID} agentDID
 * @param {import('@ucanto/interface').DID} spaceDID
 */
async function getBlockFetcher (agentDID, spaceDID) {
  const dir = path.join(bucketPath(agentDID), spaceDID, 'blocks')
  const cache = new FsBlockstore(dir)
  await cache.open()

  return new GatewayBlockFetcher(undefined, cache)
}

/**
 * @param {import('@web3-storage/w3up-client').Client} client
 */
function mustGetSpace (client) {
  const space = client.currentSpace()
  if (!space) throw new Error('no space selected')
  return space
}

/** @param {Error} err */
function errorHandler (err) {
  console.error(process.env.DEBUG ? err : `Error: ${err.message}`)
}

process.on('uncaughtException', errorHandler)
process.on('unhandledRejection', errorHandler)
