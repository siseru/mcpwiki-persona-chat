// Rooms (Task 10): every published facility is one room. Presence, capacity and who answers a line are decided
// here, deterministically; the model only writes the answering NPC's words.
import type { NpcSnapshot } from './catalog.js';

export interface Member {
  connectionId: string;
  sub: string;
  pcId: string;
  pcName: string;
  /** The NPC this PC addresses by default. */
  npcId: string;
  joinedAt: number;
  lastSeen: number;
}

export type JoinResult = 'joined' | 'full' | 'already';

export interface RoomStore {
  /**
   * Adds the member if the room has fewer than `capacity` members (atomically). Members not seen since
   * `staleBefore` (no heartbeat, e.g. a lost $disconnect) are removed first when the room looks full.
   */
  join(facilityId: string, m: Member, capacity: number, staleBefore: number): Promise<JoinResult>;
  /** Removes the member; returns it, or null when it was not in the room. */
  leave(facilityId: string, connectionId: string): Promise<Member | null>;
  members(facilityId: string): Promise<Member[]>;
  /** Heartbeat. */
  touch(facilityId: string, connectionId: string, now: number): Promise<void>;
}

/** Heartbeats every 60 s (client); a member silent for 3 minutes is considered gone. */
export const HEARTBEAT_SEC = 60;
export const STALE_SEC = 180;

/** One line of the room's shared history. */
export interface RoomLine {
  kind: 'pc' | 'npc' | 'system';
  speaker: string;
  /** For NPC lines: which NPC spoke. */
  npcId?: string;
  text: string;
}

export interface RoomJob {
  facilityId: string;
  connectionId: string;
  text: string;
  /** "npc": the PC talks to an NPC (it answers); "all": to everyone (an NPC answers only when named). */
  to: 'npc' | 'all';
}

/**
 * Which NPC answers a PC's line, or null for none.
 * - A line that names an NPC of the room is answered by that NPC (the earliest name in the text).
 * - Otherwise a line to "npc" is answered by the PC's own NPC; a line to "all" is not answered.
 * NPC lines are never routed here, so NPCs never answer each other (no reply chains).
 */
export function decideResponder(job: Pick<RoomJob, 'text' | 'to'>, npcs: Pick<NpcSnapshot, 'id' | 'name'>[], defaultNpc: string): string | null {
  const named = npcs
    .map((n) => ({ id: n.id, at: n.name ? job.text.indexOf(n.name) : -1 }))
    .filter((n) => n.at >= 0)
    .sort((a, b) => a.at - b.at)[0];
  if (named) return named.id;
  if (job.to === 'npc' && npcs.some((n) => n.id === defaultNpc)) return defaultNpc;
  return null;
}

/** In-memory store for tests (single process, so trivially atomic). */
export class MemoryRoomStore implements RoomStore {
  readonly rooms = new Map<string, Map<string, Member>>();
  async join(facilityId: string, m: Member, capacity: number, staleBefore: number): Promise<JoinResult> {
    const room = this.rooms.get(facilityId) ?? new Map<string, Member>();
    this.rooms.set(facilityId, room);
    if (room.has(m.connectionId)) return 'already';
    if (room.size >= capacity) for (const [id, x] of room) if (x.lastSeen < staleBefore) room.delete(id);
    if (room.size >= capacity) return 'full';
    room.set(m.connectionId, m);
    return 'joined';
  }
  async leave(facilityId: string, connectionId: string) {
    const room = this.rooms.get(facilityId);
    const m = room?.get(connectionId) ?? null;
    room?.delete(connectionId);
    return m;
  }
  async members(facilityId: string) {
    return [...(this.rooms.get(facilityId)?.values() ?? [])];
  }
  async touch(facilityId: string, connectionId: string, now: number) {
    const m = this.rooms.get(facilityId)?.get(connectionId);
    if (m) m.lastSeen = now;
  }
}
