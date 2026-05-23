import type { FastifyPluginAsync } from 'fastify'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf-8')) as {
  version: string
}

const healthzRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/healthz',
    {
      schema: {
        description: 'Liveness probe — always 200 when the process is up',
        tags: ['ops'],
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              service: { type: 'string' },
              version: { type: 'string' },
            },
          },
        },
      },
    },
    async (_req, reply) => {
      return reply.send({ status: 'ok', service: 'form-api', version: pkg.version })
    },
  )

  fastify.get(
    '/readyz',
    {
      schema: {
        description: 'Readiness probe — checks database connectivity',
        tags: ['ops'],
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              checks: {
                type: 'object',
                properties: {
                  db: { type: 'string' },
                  redis: { type: 'string' },
                },
              },
            },
          },
          503: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              checks: {
                type: 'object',
                properties: {
                  db: { type: 'string' },
                  redis: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    async (_req, reply) => {
      let dbStatus: 'ok' | 'fail' = 'fail'

      try {
        await fastify.prisma.$queryRaw`SELECT 1`
        dbStatus = 'ok'
      } catch (err) {
        fastify.log.error({ err }, '[readyz] database ping failed')
      }

      // TODO Wave 5: replace this stub with a real ioredis ping once the Redis
      // plugin is registered. For now it always reports ok.
      const redisStatus = 'ok'

      const checks = { db: dbStatus, redis: redisStatus }

      if (dbStatus !== 'ok') {
        return reply.status(503).send({ status: 'not_ready', checks })
      }

      return reply.send({ status: 'ok', checks })
    },
  )
}

export default healthzRoutes
