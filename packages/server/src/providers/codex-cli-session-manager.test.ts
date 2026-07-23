import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CodexCliSessionManager } from './codex-cli-session-manager.js';

describe('CodexCliSessionManager', () => {
  let manager: CodexCliSessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new CodexCliSessionManager(1000); // 1s TTL for test
  });

  afterEach(() => {
    manager.destroy();
    vi.useRealTimers();
  });

  it('manages Codex CLI sessions', () => {
    manager.set('client-1', 'thread-abc', 'gpt-5.5');
    const session = manager.get('client-1', 'gpt-5.5');
    expect(session?.threadId).toBe('thread-abc');
    expect(session?.model).toBe('gpt-5.5');
  });

  it('manages Codex CLI sessions', () => {
    expect(manager.get('unknown', 'gpt-5.5')).toBeNull();
  });

  it('manages Codex CLI sessions', () => {
    manager.set('client-1', 'thread-abc', 'gpt-5.5');
    vi.advanceTimersByTime(1500);
    expect(manager.get('client-1', 'gpt-5.5')).toBeNull();
    expect(manager.size).toBe(0);
  });

  it('manages Codex CLI sessions', () => {
    manager.set('client-1', 'thread-abc', 'gpt-5.5');
    expect(manager.get('client-1', 'gpt-4o')).toBeNull();

    expect(manager.get('client-1', 'gpt-5.5')).toBeNull();
  });

  it('manages Codex CLI sessions', () => {
    manager.set('client-1', 'thread-abc', 'gpt-5.5');
    vi.advanceTimersByTime(700);
    expect(manager.get('client-1', 'gpt-5.5')).not.toBeNull();
    vi.advanceTimersByTime(700);
    expect(manager.get('client-1', 'gpt-5.5')).not.toBeNull();
  });

  it('manages Codex CLI sessions', () => {
    manager.set('client-1', 'thread-abc', 'gpt-5.5');
    manager.invalidate('client-1');
    expect(manager.get('client-1', 'gpt-5.5')).toBeNull();
  });

  it('manages Codex CLI sessions', () => {
    manager.set('client-1', 'thread-old', 'gpt-5.5');
    manager.set('client-1', 'thread-new', 'gpt-5.5');
    const session = manager.get('client-1', 'gpt-5.5');
    expect(session?.threadId).toBe('thread-new');
  });

  it('manages Codex CLI sessions', () => {
    manager.set('client-1', 'thread-a', 'gpt-5.5');
    manager.set('client-2', 'thread-b', 'gpt-5.5');
    expect(manager.get('client-1', 'gpt-5.5')?.threadId).toBe('thread-a');
    expect(manager.get('client-2', 'gpt-5.5')?.threadId).toBe('thread-b');
  });

  it('manages Codex CLI sessions', () => {
    manager.set('client-1', 'thread-abc', 'gpt-5.5');
    manager.destroy();
    expect(manager.size).toBe(0);
  });
});
