/** Request completion must follow res.finish, not EventEmitter.emit returning. */
import { EventEmitter } from 'node:events'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { expect, it, vi } from 'vitest'
import { forwardHttpRequest } from '../lib/forwardHttpRequest.js'

it('holds the invocation open until the asynchronous route finishes', async () => {
  const res = new EventEmitter() as ServerResponse
  const server = { emit: vi.fn().mockReturnValue(true) } as unknown as Server
  let completed = false
  const request = forwardHttpRequest(server, {} as IncomingMessage, res).then(() => {
    completed = true
  })
  await Promise.resolve()
  expect(completed).toBe(false)
  res.emit('finish')
  await request
  expect(completed).toBe(true)
  expect(res.listenerCount('close')).toBe(0)
})

it('rejects stream errors and removes completion listeners', async () => {
  const res = new EventEmitter() as ServerResponse
  const server = { emit: vi.fn().mockReturnValue(true) } as unknown as Server
  const request = forwardHttpRequest(server, {} as IncomingMessage, res)
  res.emit('error', new Error('stream failed'))
  await expect(request).rejects.toThrow('stream failed')
  expect(res.listenerCount('finish')).toBe(0)
})
