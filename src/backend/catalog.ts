// Facilities and NPCs, defined in wiki articles (docs/articles.md) and published by a DM as snapshots.
//
// Conventions (MCPWiki articles, extension data under extra.persona_chat):
//   type: Facility | Organization   capacity, hours, npcs (NPC article ids)
//   type: NPC (readScope: admin)    name, role, persona, voice, knowledge, secrets (+ reveal conditions), greeting
// Only published snapshots are used in conversations: editing an article changes nothing until the DM publishes
// again (the wiki's status: draft is not involved).

export const EXTRA_KEY = 'persona_chat';
export const FACILITY_TYPES = ['Facility', 'Organization'] as const;
export const NPC_TYPE = 'NPC';
export const ARTICLE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/; // MCPWiki article ids

export interface Secret {
  text: string;
  /** When the server may put the secret into the prompt (evaluated by the server, never by the LLM). */
  reveal: { afterVisits?: number; keywords?: string[] };
}

export interface NpcSnapshot {
  id: string;
  version: number;
  name: string;
  role: string;
  persona: string;
  voice: string;
  knowledge: string[];
  secrets: Secret[];
  greeting: string;
  /** The article body: background the NPC knows (trimmed). */
  background: string;
}

export interface FacilitySnapshot {
  id: string;
  version: number;
  type: (typeof FACILITY_TYPES)[number];
  title: string;
  capacity: number;
  hours: string;
  npcs: string[];
}

export interface Publication {
  facility: FacilitySnapshot;
  npcs: NpcSnapshot[];
  publishedBy: string;
  publishedAt: number;
}

/** What every signed-in user may see: no persona, voice, knowledge, secrets or background. */
export interface PublicFacility {
  id: string;
  title: string;
  type: string;
  capacity: number;
  hours: string;
  npcs: { id: string; name: string; role: string }[];
  publishedAt: number;
}

export class SchemaError extends Error {}

const LIMITS = { name: 60, role: 100, persona: 2000, voice: 500, knowledgeItem: 300, knowledge: 20, secretText: 500, secrets: 10, keyword: 40, keywords: 10, greeting: 300, hours: 40, background: 8000, npcs: 5, capacity: 20 };
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;

function str(v: unknown, at: string, max: number, required = true): string {
  if (v === undefined || v === null || v === '') {
    if (required) throw new SchemaError(`${at} is required`);
    return '';
  }
  if (typeof v !== 'string') throw new SchemaError(`${at} must be a string`);
  const s = v.trim();
  if (s.length > max) throw new SchemaError(`${at} is longer than ${max} characters`);
  if (CONTROL.test(s)) throw new SchemaError(`${at} contains control characters`);
  return s;
}

function list(v: unknown, at: string, max: number): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new SchemaError(`${at} must be a list`);
  if (v.length > max) throw new SchemaError(`${at} has more than ${max} entries`);
  return v;
}

function int(v: unknown, at: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new SchemaError(`${at} must be an integer from ${min} to ${max}`);
  return v;
}

function section(extra: unknown): Record<string, unknown> {
  const x = (extra as Record<string, unknown> | null)?.[EXTRA_KEY];
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new SchemaError(`extra.${EXTRA_KEY} is missing`);
  return x as Record<string, unknown>;
}

/** An MCPWiki article as returned by GET /api/articles/:id (only the fields used here). */
export interface WikiArticle {
  id: string;
  type: string;
  title: string;
  version: number;
  readScope: string;
  extra?: Record<string, unknown>;
  body?: string;
  deleted?: boolean;
}

export function parseFacility(a: WikiArticle): FacilitySnapshot {
  if (!FACILITY_TYPES.includes(a.type as never)) throw new SchemaError(`${a.id}: type must be ${FACILITY_TYPES.join(' or ')}`);
  const x = section(a.extra);
  const npcs = list(x.npcs, 'npcs', LIMITS.npcs).map((n, i) => {
    if (typeof n !== 'string' || !ARTICLE_ID_RE.test(n)) throw new SchemaError(`npcs[${i}] must be an article id`);
    return n;
  });
  if (!npcs.length) throw new SchemaError('npcs: at least one NPC article is required');
  if (new Set(npcs).size !== npcs.length) throw new SchemaError('npcs: duplicate article id');
  return {
    id: a.id,
    version: a.version,
    type: a.type as FacilitySnapshot['type'],
    title: str(a.title, 'title', 200),
    capacity: int(x.capacity, 'capacity', 1, LIMITS.capacity),
    hours: str(x.hours, 'hours', LIMITS.hours, false),
    npcs,
  };
}

export function parseNpc(a: WikiArticle): NpcSnapshot {
  if (a.type !== NPC_TYPE) throw new SchemaError(`${a.id}: type must be ${NPC_TYPE}`);
  // NPC articles carry secrets: only admins may be able to read them in the wiki.
  if (a.readScope !== 'admin') throw new SchemaError(`${a.id}: an NPC article must be readable by admins only (readScope: admin)`);
  const x = section(a.extra);
  return {
    id: a.id,
    version: a.version,
    name: str(x.name, `${a.id}.name`, LIMITS.name),
    role: str(x.role, `${a.id}.role`, LIMITS.role),
    persona: str(x.persona, `${a.id}.persona`, LIMITS.persona),
    voice: str(x.voice, `${a.id}.voice`, LIMITS.voice, false),
    knowledge: list(x.knowledge, `${a.id}.knowledge`, LIMITS.knowledge).map((k, i) => str(k, `${a.id}.knowledge[${i}]`, LIMITS.knowledgeItem)),
    secrets: list(x.secrets, `${a.id}.secrets`, LIMITS.secrets).map((s, i) => {
      const at = `${a.id}.secrets[${i}]`;
      if (!s || typeof s !== 'object' || Array.isArray(s)) throw new SchemaError(`${at} must be an object`);
      const o = s as Record<string, unknown>;
      const r = (o.reveal ?? {}) as Record<string, unknown>;
      if (typeof r !== 'object' || Array.isArray(r)) throw new SchemaError(`${at}.reveal must be an object`);
      const reveal: Secret['reveal'] = {};
      if (r.afterVisits !== undefined) reveal.afterVisits = int(r.afterVisits, `${at}.reveal.afterVisits`, 1, 100);
      if (r.keywords !== undefined) reveal.keywords = list(r.keywords, `${at}.reveal.keywords`, LIMITS.keywords).map((k, j) => str(k, `${at}.reveal.keywords[${j}]`, LIMITS.keyword));
      // A secret without any condition would never be revealed: make the DM say so explicitly.
      if (reveal.afterVisits === undefined && !reveal.keywords?.length) throw new SchemaError(`${at}.reveal needs afterVisits or keywords`);
      return { text: str(o.text, `${at}.text`, LIMITS.secretText), reveal };
    }),
    greeting: str(x.greeting, `${a.id}.greeting`, LIMITS.greeting, false),
    background: (a.body ?? '').slice(0, LIMITS.background),
  };
}

export const publicView = (p: Publication): PublicFacility => ({
  id: p.facility.id,
  title: p.facility.title,
  type: p.facility.type,
  capacity: p.facility.capacity,
  hours: p.facility.hours,
  npcs: p.npcs.map((n) => ({ id: n.id, name: n.name, role: n.role })),
  publishedAt: p.publishedAt,
});

/** The article versions a publication was made from: publishing the same versions again changes nothing. */
export const sourceVersions = (f: FacilitySnapshot, npcs: NpcSnapshot[]) => [`${f.id}@${f.version}`, ...npcs.map((n) => `${n.id}@${n.version}`)].join(',');
