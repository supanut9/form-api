/**
 * Singleton ioredis connection for BullMQ.
 *
 * Lazily initialised on first access so that unit-test processes that import
 * queue/worker modules don't attempt to open a socket unless they actually
 * enqueue a job or start the worker.
 */
import IORedis from 'ioredis'
import { env } from '../config/env.js'

let _connection: IORedis | undefined

export function getRedisConnection(): IORedis {
  if (!_connection) {
    _connection = new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: null, // required by BullMQ
      enableReadyCheck: false,
    })
  }
  return _connection
}
