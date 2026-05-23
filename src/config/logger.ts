import pino from 'pino'
import { env } from './env.js'

export function createLogger(name?: string) {
  const isDev = env.NODE_ENV === 'development'

  return pino({
    name,
    level: env.LOG_LEVEL,
    ...(isDev
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:HH:MM:ss',
              ignore: 'pid,hostname',
            },
          },
        }
      : {
          // JSON in production — consumed by log aggregators
          formatters: {
            level(label) {
              return { level: label }
            },
          },
          timestamp: pino.stdTimeFunctions.isoTime,
        }),
  })
}

export const logger = createLogger('form-api')
