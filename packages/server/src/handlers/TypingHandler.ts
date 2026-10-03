import type { TypingPayload } from '@ravex/types'
import type { TypedNamespace, TypedSocket } from '../ChatEngine.js'
import type { RoomManager } from '../core/RoomManager.js'
import { logger } from '../utils/logger.js'

const DEFAULT_TYPING_THROTTLE_MS = 300
const DEFAULT_TYPING_TIMEOUT_MS = 3_000

export interface TypingConfig {
  typingTimeout?: number
  typingThrottle?: number
}

interface TypingState {
  username: string
  /** The socket that last sent typing:start, so closing that tab clears it. */
  socketId: string
  lastEvent: number
  timer: ReturnType<typeof setTimeout>
}

/** Per-user socket.io room every socket joins, so a user's own tabs can be excluded from broadcasts. */
export const userRoom = (userId: string): string => `ravex:user:${userId}`

export class TypingHandler {
  // roomId -> userId -> state. Nested maps instead of `${userId}:${roomId}` keys so IDs may contain ':'.
  private readonly typing = new Map<string, Map<string, TypingState>>()

  constructor(
    private readonly ns: TypedNamespace,
    private readonly roomManager: RoomManager,
    private readonly config: TypingConfig,
  ) {}

  onStart(socket: TypedSocket, data: TypingPayload): void {
    const user = socket.data.user
    if (!user) return

    const { roomId } = data
    if (!roomId) return

    const room = this.roomManager.get(roomId)
    if (!room || !room.members.includes(user.id)) return

    const now = Date.now()
    const throttle = this.config.typingThrottle ?? DEFAULT_TYPING_THROTTLE_MS
    const existing = this.typing.get(roomId)?.get(user.id)
    if (existing && now - existing.lastEvent < throttle) return

    if (existing) clearTimeout(existing.timer)
    const timeout = this.config.typingTimeout ?? DEFAULT_TYPING_TIMEOUT_MS
    const timer = setTimeout(() => {
      this.clear(roomId, user.id)
      logger.debug(`Typing auto-cleared: ${user.id} in ${roomId}`)
    }, timeout)

    let roomTyping = this.typing.get(roomId)
    if (!roomTyping) {
      roomTyping = new Map()
      this.typing.set(roomId, roomTyping)
    }
    roomTyping.set(user.id, { username: user.username, socketId: socket.id, lastEvent: now, timer })

    this.emit('typing:start', { userId: user.id, username: user.username, roomId })
    logger.debug(`Typing start: ${user.id} in ${roomId}`)
  }

  onStop(socket: TypedSocket, data: TypingPayload): void {
    const user = socket.data.user
    if (!user) return

    const { roomId } = data
    if (!roomId) return

    // Only users that are currently typing (and therefore passed the membership check) can stop.
    this.clear(roomId, user.id)
  }

  /** Clears a user's typing state in one room and notifies the room. No-op if they weren't typing. */
  clearForRoom(userId: string, roomId: string): void {
    this.clear(roomId, userId)
  }

  /** Clears typing started from a specific socket (e.g. when that tab disconnects). */
  clearForSocket(socketId: string): void {
    for (const [roomId, roomTyping] of this.typing) {
      for (const [userId, state] of roomTyping) {
        if (state.socketId === socketId) this.clear(roomId, userId)
      }
    }
  }

  /** Clears a user's typing state in every room. */
  clearAll(userId: string): void {
    for (const roomId of this.typing.keys()) this.clear(roomId, userId)
  }

  /** Drops all typing state for a deleted room without emitting. */
  clearRoomSilently(roomId: string): void {
    const roomTyping = this.typing.get(roomId)
    if (!roomTyping) return
    for (const state of roomTyping.values()) clearTimeout(state.timer)
    this.typing.delete(roomId)
  }

  destroy(): void {
    for (const roomId of [...this.typing.keys()]) this.clearRoomSilently(roomId)
  }

  private clear(roomId: string, userId: string): void {
    const roomTyping = this.typing.get(roomId)
    const state = roomTyping?.get(userId)
    if (!roomTyping || !state) return

    clearTimeout(state.timer)
    roomTyping.delete(userId)
    if (roomTyping.size === 0) this.typing.delete(roomId)

    this.emit('typing:stop', { userId, username: state.username, roomId })
  }

  private emit(event: 'typing:start' | 'typing:stop', data: { userId: string; username: string; roomId: string }): void {
    // Exclude every socket of the typing user, not just the one that sent the event.
    this.ns.to(data.roomId).except(userRoom(data.userId)).emit(event, data)
  }
}
