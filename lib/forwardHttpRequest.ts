/** Keep a serverless invocation alive until Fastify finishes its HTTP response. */
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

/** EventEmitter.emit is synchronous; returning it does not await an asynchronous route. */
export function forwardHttpRequest(
  server: Pick<Server, 'emit'>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off('finish', finish)
      res.off('close', finish)
      res.off('error', fail)
    }
    const finish = () => {
      cleanup()
      resolve()
    }
    const fail = (error: Error) => {
      cleanup()
      reject(error)
    }
    res.once('finish', finish)
    res.once('close', finish)
    res.once('error', fail)
    try {
      server.emit('request', req, res)
    } catch (error) {
      fail(error as Error)
    }
  })
}
