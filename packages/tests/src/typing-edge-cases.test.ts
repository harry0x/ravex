import { describe, it, expect, afterEach } from 'vitest'
import type { ChatClient } from '@ravex/client'
import type { ChatEngineOptions } from '@ravex/server'
import { createServer, createConnectedClient, type TestServer } from './helpers/setup.js'
import { mkUser, record, sleep, waitFor } from './helpers/events.js'

describe('Typing Indicators: edge cases', () => {
  let server: TestServer
  const clients: ChatClient[] = []

  async function setup(opts: ChatEngineOptions = {}, idA = 'alice', idB = 'bob') {
    server = await createServer(opts)
    const a = await createConnectedClient(server.port, mkUser(idA))
    const b = await createConnectedClient(server.port, mkUser(idB))
    clients.push(a, b)
    const room = await a.createRoom({ type: 'group', members: [idB] })
    return { a, b, roomId: room.id }
  }

  async function connect(id: string) {
    const c = await createConnectedClient(server.port, mkUser(id))
    clients.push(c)
    return c
  }

  afterEach(async () => {
    clients.splice(0).forEach((c) => c.disconnect())
    await server.close()
  })

  it('broadcasts typing:start to other room members', async () => {
    const { a, b, roomId } = await setup()
    const p = waitFor(b, 'typing:start')
    a.startTyping(roomId)
    expect(await p).toMatchObject({ userId: 'alice', username: 'alice', roomId })
  })

  it('auto-clears typing after typingTimeout', async () => {
    const { a, b, roomId } = await setup({ typing: { typingTimeout: 200 } })
    const p = waitFor(b, 'typing:stop', 1000)
    a.startTyping(roomId)
    expect(await p).toMatchObject({ userId: 'alice', roomId })
  })

  it('keeps the indicator alive while the user keeps typing', async () => {
    const { a, b, roomId } = await setup({ typing: { typingTimeout: 300, typingThrottle: 50 } })
    const stops = record(b, 'typing:stop')
    for (let i = 0; i < 10; i++) {
      a.startTyping(roomId)
      await sleep(100)
    }
    expect(stops).toHaveLength(0)
  })

  it('does not let a non-member send typing:start into a room', async () => {
    const { b, roomId } = await setup()
    const mallory = await connect('mallory')
    const starts = record(b, 'typing:start')
    mallory.startTyping(roomId)
    await sleep(200)
    expect(starts).toHaveLength(0)
  })

  it('clears typing when the user leaves the room', async () => {
    const { a, b, roomId } = await setup({ typing: { typingTimeout: 5000 } })
    a.startTyping(roomId)
    await waitFor(b, 'typing:start')
    const p = waitFor(b, 'typing:stop', 500)
    await a.leaveRoom(roomId)
    expect(await p).toMatchObject({ userId: 'alice', roomId })
  })

  it('clears typing when the user disconnects', async () => {
    const { a, b, roomId } = await setup({ typing: { typingTimeout: 5000 } })
    a.startTyping(roomId)
    await waitFor(b, 'typing:start')
    const p = waitFor(b, 'typing:stop', 500)
    a.disconnect()
    expect(await p).toMatchObject({ userId: 'alice', roomId })
  })

  // ── Regressions ───────────────────────────────────────────────────────────

  it('sending a message should clear the sender\'s typing indicator', async () => {
    const { a, b, roomId } = await setup({ typing: { typingTimeout: 3000 } })
    a.startTyping(roomId)
    await waitFor(b, 'typing:start')
    const stop = waitFor(b, 'typing:stop', 500)
    await a.sendMessage({ roomId, content: 'hi' })
    // "alice is typing…" must disappear when her message lands, not after typingTimeout.
    await expect(stop).resolves.toMatchObject({ userId: 'alice', roomId })
  })

  it('does not let a non-member send typing:stop into a room', async () => {
    const { b, roomId } = await setup()
    const mallory = await connect('mallory')
    const stops = record(b, 'typing:stop')
    mallory.stopTyping(roomId)
    await sleep(200)
    expect(stops).toHaveLength(0)
  })

  it('typing:stop without a prior typing:start should not be broadcast', async () => {
    const { a, b, roomId } = await setup()
    const stops = record(b, 'typing:stop')
    a.stopTyping(roomId)
    await sleep(200)
    expect(stops).toHaveLength(0)
  })

  it('the typer\'s other tabs should not see their own typing indicator', async () => {
    const { a, roomId } = await setup()
    const aliceTab2 = await connect('alice')
    const starts = record(aliceTab2, 'typing:start')
    a.startTyping(roomId)
    await sleep(200)
    expect(starts).toHaveLength(0)
  })

  it('closing the tab that was typing should clear typing even if another tab stays open', async () => {
    const { a, b, roomId } = await setup({ typing: { typingTimeout: 3000 } })
    await connect('alice') // second tab stays connected
    a.startTyping(roomId)
    await waitFor(b, 'typing:start')
    const p = waitFor(b, 'typing:stop', 500)
    a.disconnect()
    await expect(p).resolves.toMatchObject({ userId: 'alice', roomId })
  })

  it('kicking a typing user should clear their indicator immediately', async () => {
    const { a, b, roomId } = await setup({ typing: { typingTimeout: 3000 } })
    a.startTyping(roomId)
    await waitFor(b, 'typing:start')
    const p = waitFor(b, 'typing:stop', 500)
    server.engine.kickUser(roomId, 'alice')
    await expect(p).resolves.toMatchObject({ userId: 'alice', roomId })
  })

  it('clears typing on disconnect for user IDs containing ":"', async () => {
    const { a, b, roomId } = await setup({ typing: { typingTimeout: 5000 } }, 'org:alice', 'bob')
    a.startTyping(roomId)
    await waitFor(b, 'typing:start')
    const p = waitFor(b, 'typing:stop', 500)
    a.disconnect()
    await expect(p).resolves.toMatchObject({ userId: 'org:alice', roomId })
  })

  it('one user disconnecting must not cancel another user\'s typing timer (prefix collision)', async () => {
    const { a, b, roomId } = await setup({ typing: { typingTimeout: 300 } }, 'team', 'bob')
    const team2 = await connect('team:2')
    await team2.joinRoom(roomId)
    team2.startTyping(roomId)
    a.startTyping(roomId)
    await sleep(50)
    const stops = record(b, 'typing:stop')
    a.disconnect()
    await sleep(700)
    // "team" disconnecting must not cancel team:2's timer, so bob still gets its stop via timeout.
    expect(stops.map((s) => s.userId)).toContain('team:2')
  })

  it('honours rateLimit.typingThrottle', async () => {
    const { a, b, roomId } = await setup({ rateLimit: { typingThrottle: 0 } })
    const starts = record(b, 'typing:start')
    a.startTyping(roomId)
    await sleep(30)
    a.startTyping(roomId)
    await sleep(200)
    expect(starts).toHaveLength(2)
  })
})
