import { describe, it, expect, afterEach } from 'vitest'
import type { ChatClient } from '@ravex/client'
import type { ChatEngineOptions, PersistenceAdapter } from '@ravex/server'
import type { Message, ServerToClientEvents, User } from '@ravex/types'
import { createServer, createConnectedClient, type TestServer } from './helpers/setup.js'

const mkUser = (id: string): User => ({ id, username: id, status: 'online', socketIds: [] })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Collects every payload of `event` that `client` receives from now on. */
function record<K extends keyof ServerToClientEvents>(client: ChatClient, event: K) {
  const events: Parameters<ServerToClientEvents[K]>[0][] = []
  client.on(event, ((data: Parameters<ServerToClientEvents[K]>[0]) => events.push(data)) as ServerToClientEvents[K])
  return events
}

/** In-memory adapter. `withGetMessage: false` mimics adapters written before getMessage existed. */
function memoryStore({ withGetMessage = true, historyWindow = 50 } = {}) {
  const messages: Message[] = []
  const store: PersistenceAdapter = {
    async saveMessage(m) { messages.push({ ...m }) },
    async getMessages(roomId, limit = historyWindow) { return messages.filter((m) => m.roomId === roomId).slice(-limit) },
    async updateMessage(id, u) { const m = messages.find((x) => x.id === id); if (m) Object.assign(m, u) },
    async deleteMessage(id) { const i = messages.findIndex((x) => x.id === id); if (i >= 0) messages.splice(i, 1) },
  }
  if (withGetMessage) store.getMessage = async (id) => messages.find((m) => m.id === id)
  return { store, messages }
}

let server: TestServer
const clients: ChatClient[] = []

async function start(options: ChatEngineOptions = {}) {
  server = await createServer({ ...options, message: { allowEdits: true, allowDeletes: true, ...options.message } })
}
async function connect(id: string) {
  const client = await createConnectedClient(server.port, mkUser(id))
  clients.push(client)
  return client
}

afterEach(async () => {
  clients.splice(0).forEach((c) => c.disconnect())
  await server?.close()
})

const storageModes: [string, () => ChatEngineOptions][] = [
  ['without persistence', () => ({})],
  ['with persistence (getMessage)', () => ({ persistence: memoryStore().store })],
  ['with persistence (no getMessage)', () => ({ persistence: memoryStore({ withGetMessage: false }).store })],
]

describe.each(storageModes)('Message permissions %s', (_label, options) => {
  /** alice (admin) + bob in a room, mallory connected but not a member. */
  async function setup() {
    await start(options())
    const alice = await connect('alice')
    const bob = await connect('bob')
    const mallory = await connect('mallory')
    const room = await alice.createRoom({ type: 'group', members: ['bob'] })
    const msg = await alice.sendMessage({ roomId: room.id, content: 'original' })
    return { alice, bob, mallory, roomId: room.id, msg }
  }

  it('rejects a non-member reacting, and nothing is broadcast', async () => {
    const { bob, mallory, roomId, msg } = await setup()
    const seen = record(bob, 'message:reaction')
    await expect(mallory.sendReaction(msg.id, roomId, '💩')).rejects.toThrow('Not a member of this room')
    await sleep(100)
    expect(seen).toHaveLength(0)
  })

  it('drops read receipts from a non-member', async () => {
    const { alice, mallory, roomId, msg } = await setup()
    const seen = record(alice, 'message:read_receipt')
    mallory.markAsRead(msg.id, roomId)
    await sleep(150)
    expect(seen).toHaveLength(0)
  })

  it('rejects a non-member editing or deleting, and nothing is broadcast', async () => {
    const { bob, mallory, roomId, msg } = await setup()
    const edits = record(bob, 'message:edited')
    const deletes = record(bob, 'message:deleted')
    await expect(mallory.editMessage({ messageId: msg.id, roomId, content: 'hacked' })).rejects.toThrow('Not a member of this room')
    await expect(mallory.deleteMessage(msg.id, roomId)).rejects.toThrow('Not a member of this room')
    await sleep(100)
    expect(edits).toHaveLength(0)
    expect(deletes).toHaveLength(0)
  })

  it("rejects a member editing someone else's message", async () => {
    const { bob, roomId, msg } = await setup()
    const edits = record(bob, 'message:edited')
    await expect(bob.editMessage({ messageId: msg.id, roomId, content: 'forged' })).rejects.toThrow("Cannot edit another user's message")
    await sleep(100)
    expect(edits).toHaveLength(0)
  })

  it("rejects a member deleting someone else's message", async () => {
    const { alice, bob, roomId } = await setup()
    const bobsMsg = await bob.sendMessage({ roomId, content: 'mine' })
    const otherMsg = await alice.sendMessage({ roomId, content: 'not yours' })
    await expect(bob.deleteMessage(otherMsg.id, roomId)).rejects.toThrow("Cannot delete another user's message")
    await expect(bob.deleteMessage(bobsMsg.id, roomId)).resolves.toBeUndefined()
  })

  it("lets a room admin delete another member's message", async () => {
    const { alice, bob, roomId } = await setup()
    const bobsMsg = await bob.sendMessage({ roomId, content: 'admin can remove this' })
    await expect(alice.deleteMessage(bobsMsg.id, roomId)).resolves.toBeUndefined()
  })

  it('lets the sender edit and delete their own message', async () => {
    const { alice, bob, roomId, msg } = await setup()
    const edits = record(bob, 'message:edited')
    const edited = await alice.editMessage({ messageId: msg.id, roomId, content: 'edited' })
    expect(edited).toMatchObject({ id: msg.id, roomId, content: 'edited', senderId: 'alice' })
    await alice.deleteMessage(msg.id, roomId)
    await sleep(50)
    expect(edits.map((e) => e.content)).toEqual(['edited'])
  })

  it('lets a member react to a message', async () => {
    const { alice, bob, roomId, msg } = await setup()
    const seen = record(alice, 'message:reaction')
    await bob.sendReaction(msg.id, roomId, '👍')
    await sleep(50)
    expect(seen).toMatchObject([{ messageId: msg.id, userId: 'bob', emoji: '👍' }])
  })

  it('returns MESSAGE_NOT_FOUND for unknown message ids', async () => {
    const { alice, roomId } = await setup()
    await expect(alice.editMessage({ messageId: 'nope', roomId, content: 'x' })).rejects.toThrow('Message not found')
    await expect(alice.deleteMessage('nope', roomId)).rejects.toThrow('Message not found')
    await expect(alice.sendReaction('nope', roomId, '👍')).rejects.toThrow('Message not found')
  })

  it('cannot reach a message by pairing its id with a different room', async () => {
    const { alice, bob, roomId, msg } = await setup()
    // bob owns a room of his own and tries to act on alice's message through it
    const bobsRoom = await bob.createRoom({ type: 'group' })
    const ownMsgElsewhere = await bob.sendMessage({ roomId, content: 'bob in shared room' })
    await expect(bob.deleteMessage(msg.id, bobsRoom.id)).rejects.toThrow('Message not found')
    await expect(bob.editMessage({ messageId: ownMsgElsewhere.id, roomId: bobsRoom.id, content: 'x' })).rejects.toThrow('Message not found')
    await expect(alice.editMessage({ messageId: msg.id, roomId, content: 'still works' })).resolves.toBeTruthy()
  })

  it('cannot edit a message after it was deleted', async () => {
    const { alice, roomId, msg } = await setup()
    await alice.deleteMessage(msg.id, roomId)
    await expect(alice.editMessage({ messageId: msg.id, roomId, content: 'ghost' })).rejects.toThrow('Message not found')
  })

  it('loses access after leaving or being kicked from the room', async () => {
    const { alice, bob, roomId, msg } = await setup()
    const bobsMsg = await bob.sendMessage({ roomId, content: 'before leaving' })
    await bob.leaveRoom(roomId)
    await expect(bob.editMessage({ messageId: bobsMsg.id, roomId, content: 'x' })).rejects.toThrow('Not a member of this room')
    await expect(bob.sendReaction(msg.id, roomId, '👍')).rejects.toThrow('Not a member of this room')

    const carol = await connect('carol')
    await carol.joinRoom(roomId)
    server.engine.kickUser(roomId, 'carol')
    await expect(carol.sendReaction(msg.id, roomId, '👍')).rejects.toThrow('Not a member of this room')
    await expect(alice.sendReaction(msg.id, roomId, '👍')).resolves.toBeUndefined()
  })

  it('returns ROOM_NOT_FOUND for unknown rooms', async () => {
    const { alice, msg } = await setup()
    await expect(alice.editMessage({ messageId: msg.id, roomId: 'nope', content: 'x' })).rejects.toThrow('Room not found')
    await expect(alice.sendReaction(msg.id, 'nope', '👍')).rejects.toThrow('Room not found')
  })
})

describe('Message permissions with persistence: lookups', () => {
  it('uses getMessage to check ownership of messages outside the getMessages window', async () => {
    const { store } = memoryStore({ historyWindow: 1 })
    await start({ persistence: store })
    const alice = await connect('alice')
    const bob = await connect('bob')
    const room = await alice.createRoom({ type: 'group', members: ['bob'] })
    const old = await alice.sendMessage({ roomId: room.id, content: 'old' })
    await alice.sendMessage({ roomId: room.id, content: 'newer' })
    await expect(bob.editMessage({ messageId: old.id, roomId: room.id, content: 'forged' })).rejects.toThrow("Cannot edit another user's message")
    await expect(alice.editMessage({ messageId: old.id, roomId: room.id, content: 'fine' })).resolves.toBeTruthy()
  })

  it('treats soft-deleted messages (deletedAt) as not found', async () => {
    const { store, messages } = memoryStore()
    await start({ persistence: store })
    const alice = await connect('alice')
    const room = await alice.createRoom({ type: 'group' })
    const msg = await alice.sendMessage({ roomId: room.id, content: 'soon gone' })
    messages[0].deletedAt = new Date()
    await expect(alice.editMessage({ messageId: msg.id, roomId: room.id, content: 'x' })).rejects.toThrow('Message not found')
  })

  it('persists the edit and returns the full updated message', async () => {
    const { store, messages } = memoryStore()
    await start({ persistence: store })
    const alice = await connect('alice')
    const room = await alice.createRoom({ type: 'group' })
    const msg = await alice.sendMessage({ roomId: room.id, content: 'v1' })
    const edited = await alice.editMessage({ messageId: msg.id, roomId: room.id, content: 'v2' })
    expect(edited).toMatchObject({ id: msg.id, content: 'v2', senderId: 'alice', senderName: 'alice', type: 'text' })
    expect(messages[0].content).toBe('v2')
  })
})

describe('Room permissions', () => {
  it('rejects joining a private room you were not invited to', async () => {
    await start()
    const alice = await connect('alice')
    const bob = await connect('bob')
    const mallory = await connect('mallory')
    const room = await alice.createRoom({ type: 'group', isPrivate: true, members: ['bob'] })
    await expect(mallory.joinRoom(room.id)).rejects.toThrow('This room is private')
    expect(server.engine.getRoom(room.id)?.members).not.toContain('mallory')
    // invited members and the creator can still (re)join
    await expect(bob.joinRoom(room.id)).resolves.toMatchObject({ id: room.id })
    await expect(alice.joinRoom(room.id)).resolves.toMatchObject({ id: room.id })
  })

  it('rejects rejoining a private room after leaving it', async () => {
    await start()
    const alice = await connect('alice')
    const bob = await connect('bob')
    const room = await alice.createRoom({ type: 'group', isPrivate: true, members: ['bob'] })
    await bob.leaveRoom(room.id)
    await expect(bob.joinRoom(room.id)).rejects.toThrow('This room is private')
  })

  it('enforces maxMembers on join and frees the slot when someone leaves', async () => {
    await start()
    const alice = await connect('alice')
    const bob = await connect('bob')
    const carol = await connect('carol')
    const room = await alice.createRoom({ type: 'group', maxMembers: 2 })
    await bob.joinRoom(room.id)
    await expect(carol.joinRoom(room.id)).rejects.toThrow('Room is full')
    // an existing member re-joining a full room is fine
    await expect(bob.joinRoom(room.id)).resolves.toMatchObject({ id: room.id })
    await bob.leaveRoom(room.id)
    await expect(carol.joinRoom(room.id)).resolves.toMatchObject({ id: room.id })
    expect(server.engine.getRoom(room.id)?.members).toEqual(['alice', 'carol'])
  })

  it('lets only one of two simultaneous joins take the last slot', async () => {
    await start()
    const alice = await connect('alice')
    const bob = await connect('bob')
    const carol = await connect('carol')
    const room = await alice.createRoom({ type: 'group', maxMembers: 2 })
    const results = await Promise.allSettled([bob.joinRoom(room.id), carol.joinRoom(room.id)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(server.engine.getRoom(room.id)?.members).toHaveLength(2)
  })

  it('rejects creating a room with more members than maxMembers', async () => {
    await start()
    const alice = await connect('alice')
    await expect(alice.createRoom({ type: 'group', maxMembers: 2, members: ['bob', 'carol'] })).rejects.toThrow('Too many members (max 2)')
    await expect(alice.createRoom({ type: 'group', maxMembers: 2, members: ['bob'] })).resolves.toBeTruthy()
  })

  it.each([0, -1, 1.5])('rejects maxMembers = %s', async (maxMembers) => {
    await start()
    const alice = await connect('alice')
    await expect(alice.createRoom({ type: 'group', maxMembers })).rejects.toThrow('maxMembers must be a positive integer')
  })

  it('returns "Room not found" when deleting a room that does not exist', async () => {
    await start()
    const alice = await connect('alice')
    await expect(alice.deleteRoom('does-not-exist')).rejects.toThrow('Room not found')
  })

  it('still requires admin rights to delete an existing room', async () => {
    await start()
    const alice = await connect('alice')
    const bob = await connect('bob')
    const room = await alice.createRoom({ type: 'group', members: ['bob'] })
    await expect(bob.deleteRoom(room.id)).rejects.toThrow('Admin only')
    await expect(alice.deleteRoom(room.id)).resolves.toBeUndefined()
  })
})
