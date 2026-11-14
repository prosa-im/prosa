import { baseUrl, cleanName, ID } from './runtime.js';

/**
 * Where guest identities are kept between sessions: `$.store` in the plugin, a JSON file in the
 * Codex adapter. One key per identity, so two sessions saving different identities do not
 * overwrite each other. The values are plain text and hold conversation-scoped API keys.
 */
export interface IdentityStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}
/** Which session uses a saved identity, and when it last said so. */
export type Lease = { session: string; at: number };
export type SavedIdentity = {
  v: 1; origin: string; threadId: string; url: string; apiKey: string; agentId: string;
  /** The name this guest goes by in the conversation. */
  name: string; title?: string; lastUsed: number; lease?: Lease;
  /**
   * Only for a conversation this machine created: the key that turns its link off or deletes it.
   * It is sent to the two creator routes and nowhere else; it never enters a tool result or an error.
   */
  creatorKey?: string;
};
/** Most identities kept; the least recently used goes first. */
export const MAX_SAVED = 20;
/** An identity unused for this long is dropped at start. */
export const SAVED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A lease renewed within this time belongs to a live session and is not taken over. */
export const LEASE_FRESH_MS = 2 * 60 * 1000;
/** How often a connected session renews its leases. */
export const LEASE_RENEW_MS = 30 * 1000;
/** More saved keys than this is not something this plugin wrote: the store is ignored and replaced. */
export const MAX_STORE_KEYS = 64;
/** Largest saved entry accepted, in characters of JSON. */
export const MAX_ENTRY_CHARS = 4096;
const PREFIX = 'guest:';
const API_KEY = /^aim_ak_[A-Za-z0-9_-]{1,200}$/;
/** The server's creator key: `aim_ck_` and 43 characters (the prefix is the server's own). */
export const CREATOR_KEY = /^aim_ck_[A-Za-z0-9_-]{43}$/;
const SHARE_PATH = /^\/c\/[A-Za-z0-9_-]{43}$/;

export const identityKey = (e: { origin: string; threadId: string; agentId: string }): string => `${PREFIX}${e.origin}|${e.threadId}|${e.agentId}`;
const time = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** A saved entry as the plugin may use it, or undefined when any field is missing, malformed or over its bound. */
export function parseIdentity(value: unknown): SavedIdentity | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    if (JSON.stringify(value).length > MAX_ENTRY_CHARS) return undefined;
    const r = value as Record<string, unknown>;
    if (r.v !== 1 || typeof r.origin !== 'string' || baseUrl(r.origin) !== r.origin) return undefined;
    if (typeof r.threadId !== 'string' || !ID.test(r.threadId) || typeof r.agentId !== 'string' || !ID.test(r.agentId)) return undefined;
    if (typeof r.apiKey !== 'string' || !API_KEY.test(r.apiKey) || typeof r.url !== 'string' || !time(r.lastUsed)) return undefined;
    const share = new URL(r.url);
    if (share.href !== r.url || share.origin !== r.origin || share.username || share.password || share.search || share.hash || !SHARE_PATH.test(share.pathname)) return undefined;
    let lease: Lease | undefined;
    if (r.lease !== undefined) {
      const l = r.lease as Record<string, unknown> | null;
      if (!l || typeof l !== 'object' || typeof l.session !== 'string' || !l.session || l.session.length > 200 || !time(l.at)) return undefined;
      lease = { session: l.session, at: l.at };
    }
    return {
      v: 1, origin: r.origin, threadId: r.threadId, url: r.url, apiKey: r.apiKey, agentId: r.agentId, name: cleanName(r.name),
      ...(typeof r.title === 'string' && r.title.trim() ? { title: cleanName(r.title) } : {}), lastUsed: r.lastUsed, ...(lease ? { lease } : {}),
      // Absent in entries saved by 0.4.0 and for conversations joined, not created. A malformed one is not kept.
      ...(typeof r.creatorKey === 'string' && CREATOR_KEY.test(r.creatorKey) ? { creatorKey: r.creatorKey } : {}),
    };
  } catch { return undefined; }
}
/** True while another session's lease is fresh; a lease dated in the future counts by its distance too. */
export const heldElsewhere = (e: SavedIdentity, session: string, now: number): boolean =>
  !!e.lease && e.lease.session !== session && Math.abs(now - e.lease.at) < LEASE_FRESH_MS;

/** Reads and writes saved identities. Nothing here throws: a failing or corrupt store reads as empty. */
export class Identities {
  constructor(private store: IdentityStore) {}
  /** Every valid saved identity. Invalid entries are deleted; an oversized store is emptied. */
  async all(): Promise<SavedIdentity[]> {
    let keys: string[];
    try {
      const listed = await this.store.keys();
      keys = Array.isArray(listed) ? listed.filter(k => typeof k === 'string' && k.startsWith(PREFIX)) : [];
    } catch { return []; }
    if (keys.length > MAX_STORE_KEYS) { for (const key of keys) await this.drop(key); return []; }
    const out: SavedIdentity[] = [];
    for (const key of keys) {
      let entry: SavedIdentity | undefined;
      try { entry = parseIdentity(await this.store.get(key)); } catch { continue; }
      if (!entry || identityKey(entry) !== key) { await this.drop(key); continue; }
      out.push(entry);
    }
    return out;
  }
  private async drop(key: string): Promise<void> { try { await this.store.delete(key); } catch { /* a store that cannot delete is read as empty next time too */ } }
  /** The entry as it is saved now, if it still is. */
  async current(e: SavedIdentity): Promise<SavedIdentity | undefined> {
    try { const entry = parseIdentity(await this.store.get(identityKey(e))); return entry && identityKey(entry) === identityKey(e) ? entry : undefined; } catch { return undefined; }
  }
  /** Saves one identity, then drops the least recently used ones beyond the cap. False when the store refused it. */
  async put(e: SavedIdentity): Promise<boolean> {
    try { await this.store.set(identityKey(e), e); } catch { return false; }
    const others = (await this.all()).filter(o => identityKey(o) !== identityKey(e)).sort((a, b) => b.lastUsed - a.lastUsed);
    for (const extra of others.slice(MAX_SAVED - 1)) await this.drop(identityKey(extra));
    return true;
  }
  async remove(e: { origin: string; threadId: string; agentId: string }): Promise<void> { await this.drop(identityKey(e)); }
  /** Drops what has not been used for 30 days. */
  async prune(now: number): Promise<void> {
    for (const e of await this.all()) if (now - e.lastUsed > SAVED_TTL_MS) await this.drop(identityKey(e));
  }
}
