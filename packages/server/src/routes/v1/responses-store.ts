import type { ChatMessage } from '@agent-proxy/shared';

export interface StoredResponse {
  id: string;
  clientKey: string;
  model: string;
  contextMessages: ChatMessage[];
  outstandingCallIds: string[];
  expiresAt: number;
}

export interface ResponsesStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export class ResponsesStore {
  private readonly entries = new Map<string, StoredResponse>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: ResponsesStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 30 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 1_000;
    this.now = options.now ?? Date.now;
  }

  set(entry: Omit<StoredResponse, 'expiresAt'>): void {
    this.deleteExpired();
    this.entries.delete(entry.id);
    this.entries.set(entry.id, {
      ...entry,
      contextMessages: structuredClone(entry.contextMessages),
      outstandingCallIds: [...entry.outstandingCallIds],
      expiresAt: this.now() + this.ttlMs,
    });

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.entries.delete(oldestKey);
    }
  }

  get(id: string, clientKey: string): StoredResponse | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(id);
      return null;
    }
    if (entry.clientKey !== clientKey) return null;
    return {
      ...entry,
      contextMessages: structuredClone(entry.contextMessages),
      outstandingCallIds: [...entry.outstandingCallIds],
    };
  }

  deleteExpired(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    this.deleteExpired();
    return this.entries.size;
  }
}
