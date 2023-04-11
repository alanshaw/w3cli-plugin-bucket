import { Failure, ServiceMethod } from '@ucanto/interface'
import { BlockGet } from './capabilities.js'

export interface Service {
  block: BlockService
}

export interface BlockService {
  get: ServiceMethod<BlockGet, Uint8Array, Failure>
}
