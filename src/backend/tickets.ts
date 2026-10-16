// Short-lived, single-use connection tickets (docs/spike.md, "WebSocket の認証").
//
// The browser cannot set headers on a WebSocket, and an access token in the URL would end up in logs and history.
// So the browser first trades its access token for a ticket over HTTPS (POST /ticket), then connects with
// wss://...?ticket=<ticket>. The $connect authorizer consumes the ticket: a URL that leaks afterwards only holds a
// used or expired ticket. Only the ticket's SHA-256 is stored.
import { createHash, randomBytes } from 'node:crypto';

export const TICKET_TTL_SEC = 30;
/** Connections older than this are asked to reconnect with a fresh ticket (API Gateway's own limit is 2 h). */
export const MAX_CONNECTION_SEC = 55 * 60;

export interface Identity {
  sub: string;
  username: string;
  role: 'admin' | 'editor' | 'viewer';
  /** Set when the ticket was asked for to enter a facility: checked once, when the ticket was issued. */
  session?: Session;
}

/** A PC talking with one NPC of a published facility. */
export interface Session {
  facilityId: string;
  npcId: string;
  pcId: string;
  pcName: string;
}

export interface TicketStore {
  put(hash: string, identity: Identity, expiresAt: number): Promise<void>;
  /** Atomically deletes the ticket and returns its identity, or null when it does not exist or has expired. */
  take(hash: string, now: number): Promise<Identity | null>;
}

const TICKET_RE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url
export const ticketHash = (ticket: string) => createHash('sha256').update(ticket).digest('hex');

export async function issueTicket(store: TicketStore, identity: Identity, now: number): Promise<{ ticket: string; expiresAt: number }> {
  const ticket = randomBytes(32).toString('base64url');
  const expiresAt = now + TICKET_TTL_SEC;
  await store.put(ticketHash(ticket), identity, expiresAt);
  return { ticket, expiresAt };
}

export async function redeemTicket(store: TicketStore, ticket: unknown, now: number): Promise<Identity | null> {
  if (typeof ticket !== 'string' || !TICKET_RE.test(ticket)) return null;
  return store.take(ticketHash(ticket), now);
}

/** In-memory store for tests. */
export class MemoryTicketStore implements TicketStore {
  readonly items = new Map<string, { identity: Identity; expiresAt: number }>();
  async put(hash: string, identity: Identity, expiresAt: number) {
    this.items.set(hash, { identity, expiresAt });
  }
  async take(hash: string, now: number) {
    const it = this.items.get(hash);
    this.items.delete(hash);
    return it && it.expiresAt > now ? it.identity : null;
  }
}
