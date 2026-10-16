// Cognito access-token verification (RS256, JWKS) with node:crypto only. The rules are the same as MCPWiki's
// src/backend/auth.ts (issuer, access tokens only, client id, expiry, no tokens from direct sign-in API calls);
// copied rather than imported, because this extension never loads the wiki's code.
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';

/** RSA public JWK as published in Cognito's JWKS. */
export interface Jwk {
  kty?: string;
  kid?: string;
  use?: string;
  [member: string]: unknown;
}

export interface AccessClaims {
  sub: string;
  username: string;
  client_id: string;
  token_use: string;
  scope?: string;
  iss: string;
  exp: number;
  iat: number;
}

export class AuthError extends Error {}

export interface VerifierOptions {
  issuer: string;
  /** The wiki's web client: tokens issued to any other client are rejected. */
  clientId: string;
  fetchJwks: () => Promise<{ keys: Jwk[] }>;
  now?: () => number; // epoch seconds
  clockSkewSec?: number;
}

function b64urlJson(part: string): Record<string, unknown> {
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new AuthError('malformed token');
  }
}

export class TokenVerifier {
  private keys = new Map<string, KeyObject>();
  private lastFetch = 0;

  constructor(private readonly o: VerifierOptions) {}

  private now(): number {
    return this.o.now ? this.o.now() : Math.floor(Date.now() / 1000);
  }

  private async key(kid: string): Promise<KeyObject> {
    const cached = this.keys.get(kid);
    if (cached) return cached;
    // Refetch at most once per minute (key rotation), never on every bad token.
    if (this.now() - this.lastFetch < 60 && this.keys.size) throw new AuthError('unknown signing key');
    this.lastFetch = this.now();
    const { keys } = await this.o.fetchJwks();
    const next = new Map<string, KeyObject>();
    for (const k of keys) {
      if (k.kty !== 'RSA' || !k.kid || (k.use && k.use !== 'sig')) continue;
      next.set(k.kid, createPublicKey({ key: k as never, format: 'jwk' }));
    }
    this.keys = next;
    const found = this.keys.get(kid);
    if (!found) throw new AuthError('unknown signing key');
    return found;
  }

  async verify(token: string): Promise<AccessClaims> {
    if (token.length > 8192) throw new AuthError('token too large');
    const parts = token.split('.');
    if (parts.length !== 3) throw new AuthError('malformed token');
    const [h, p, s] = parts as [string, string, string];
    const header = b64urlJson(h);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new AuthError('unsupported token');
    const key = await this.key(header.kid);
    if (!cryptoVerify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))) throw new AuthError('invalid signature');
    const c = b64urlJson(p) as unknown as AccessClaims;
    const skew = this.o.clockSkewSec ?? 60;
    const now = this.now();
    if (c.iss !== this.o.issuer) throw new AuthError('wrong issuer');
    if (c.token_use !== 'access') throw new AuthError('an access token is required');
    if (typeof c.exp !== 'number' || c.exp + skew < now) throw new AuthError('token expired');
    if (typeof c.iat !== 'number' || c.iat - skew > now) throw new AuthError('token not yet valid');
    if (typeof c.sub !== 'string' || typeof c.client_id !== 'string') throw new AuthError('malformed token');
    if (c.client_id !== this.o.clientId) throw new AuthError('token was issued to another client');
    // Only tokens from managed login: tokens minted by calling Cognito's sign-in API directly carry this scope.
    if (typeof c.scope === 'string' && c.scope.split(' ').includes('aws.cognito.signin.user.admin')) throw new AuthError('direct sign-in tokens are not accepted');
    return c;
  }
}
