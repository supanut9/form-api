import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'
import { env } from '../config/env.js'

const prismaPlugin: FastifyPluginAsync = async (fastify) => {
  // Use a real pg.Pool so individual connections can drop and be replaced
  // without wedging the whole adapter (the bare-connectionString path uses
  // a single client that cannot recover from "Server has closed the connection").
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
  })

  // Surface pool errors so dev sees them rather than silently dying.
  pool.on('error', (err) => {
    fastify.log.error({ err }, 'pg pool error')
  })

  const adapter = new PrismaPg(pool)
  const prisma = new PrismaClient({
    adapter,
    log: ['warn', 'error'],
  })

  await prisma.$connect()

  fastify.decorate('prisma', prisma)

  fastify.addHook('onClose', async () => {
    await prisma.$disconnect()
    await pool.end()
  })
}

export default fp(prismaPlugin, {
  name: 'prisma-plugin',
  fastify: '5.x',
})
