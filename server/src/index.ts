import { buildApp } from './app.js'
import { config } from './config/env.js'

/**
 * Process entrypoint.
 *
 * Everything here is about failing loudly and shutting down cleanly: a
 * container that exits on a bad start is recoverable, one that accepts traffic
 * it cannot serve is not.
 */
async function main(): Promise<void> {
  const app = await buildApp()

  try {
    await app.listen({ host: config.HOST, port: config.PORT })
    app.log.info(
      {
        provider: config.TELEPHONY_PROVIDER,
        database: config.usePglite ? 'pglite (embedded)' : 'postgres',
        docs: config.DISABLE_DOCS ? 'disabled' : `http://localhost:${config.PORT}/docs`,
      },
      'dialflow api ready',
    )
  } catch (err) {
    app.log.error({ err }, 'failed to start')
    process.exit(1)
  }

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info({ signal }, 'shutting down')
    try {
      // Stops accepting connections and drains in-flight requests.
      await app.close()
      process.exit(0)
    } catch (err) {
      app.log.error({ err }, 'error during shutdown')
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  process.on('unhandledRejection', (reason) => {
    app.log.error({ reason }, 'unhandled promise rejection')
  })
  process.on('uncaughtException', (err) => {
    app.log.fatal({ err }, 'uncaught exception — process state is undefined, exiting')
    process.exit(1)
  })
}

void main()
