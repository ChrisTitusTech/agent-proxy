import { describe, expect, it } from 'vitest';
import { escapePosixShellArg, pipeTextToCommand } from './shell.js';

describe('escapePosixShellArg', () => {
  it('leaves simple command arguments readable', () => {
    expect(escapePosixShellArg('/usr/bin/codex')).toBe('/usr/bin/codex');
    expect(escapePosixShellArg('--model=gpt-5')).toBe('--model=gpt-5');
  });

  it('single-quotes whitespace and shell metacharacters', () => {
    expect(escapePosixShellArg('hello world')).toBe("'hello world'");
    expect(escapePosixShellArg('$(touch /tmp/bad)')).toBe("'$(touch /tmp/bad)'");
    expect(escapePosixShellArg('`id`')).toBe("'`id`'");
  });

  it('safely escapes embedded single quotes', () => {
    expect(escapePosixShellArg("it's safe")).toBe("'it'\"'\"'s safe'");
  });

  it('pipes exact text through a fixed printf format', () => {
    expect(pipeTextToCommand("line 1\nline '2'\\tail", 'codex exec')).toBe(
      "printf '%s' 'line 1\nline '\"'\"'2'\"'\"'\\tail' | codex exec",
    );
  });
});
