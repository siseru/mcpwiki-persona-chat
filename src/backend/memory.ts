// What an NPC remembers about a PC (Task 9). Behind this interface: AgentCore Memory in AWS (index.ts) and an
// in-memory implementation for tests. Memories are keyed by NPC x PC: the namespace /npc/<npc>/pc/<pc>/ (custom
// namespace variables, validated by AgentCore against the article id pattern; docs/spike.md).
//
// Memories are extracted from what players said, so they are untrusted text: they reach the model fenced as notes,
// never as instructions, and the NPC's secrets are never part of them (secrets stay in the snapshot).
import { createHash } from 'node:crypto';
import type { Turn } from './chat.js';

export interface MemoryKey {
  npcId: string;
  pcId: string;
}

export interface MemoryProvider {
  /** Adds one exchange of a conversation; long-term memories are extracted from it asynchronously. */
  record(key: MemoryKey & { actorId: string; sessionId: string }, turns: Turn[]): Promise<void>;
  /** The NPC's long-term memories of this PC (most recent first, at most `max`). */
  recall(key: MemoryKey, max: number): Promise<string[]>;
}

export const RECALL_MAX = 20;
export const namespaceOf = (k: MemoryKey) => `/npc/${k.npcId}/pc/${k.pcId}/`;
/** AgentCore session ids allow [A-Za-z0-9_-] only; WebSocket connection ids contain "=". */
export const sessionIdOf = (connectionId: string) => createHash('sha256').update(connectionId).digest('hex').slice(0, 32);

/** For tests: records what was sent, and recalls facts that a test put in. */
export class MemoryFake implements MemoryProvider {
  readonly recorded: { key: MemoryKey & { actorId: string; sessionId: string }; turns: Turn[] }[] = [];
  readonly facts = new Map<string, string[]>();
  async record(key: MemoryKey & { actorId: string; sessionId: string }, turns: Turn[]) {
    this.recorded.push({ key, turns });
  }
  async recall(key: MemoryKey, max: number) {
    return (this.facts.get(namespaceOf(key)) ?? []).slice(0, max);
  }
}
