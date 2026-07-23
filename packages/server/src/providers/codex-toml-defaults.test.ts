import { describe, it, expect } from 'vitest';




function extractTopLevelString(content: string, key: string): string | null {
  const headEnd = content.search(/^\s*\[/m);
  const head = headEnd >= 0 ? content.slice(0, headEnd) : content;
  const re = new RegExp(`^\\s*${key}\\s*=\\s*"([^"\\n]*)"\\s*(?:#.*)?$`, 'm');
  const m = head.match(re);
  return m ? m[1] : null;
}

describe('extractTopLevelString', () => {
  it('reads a top-level string assignment', () => {
    const toml = `model = "gpt-5.6-sol"\nmodel_reasoning_effort = "high"\n`;
    expect(extractTopLevelString(toml, 'model')).toBe('gpt-5.6-sol');
    expect(extractTopLevelString(toml, 'model_reasoning_effort')).toBe('high');
  });

  it('ignores assignments inside sections', () => {
    const toml = `[profile.default]\nmodel = "ignored"\n`;
    expect(extractTopLevelString(toml, 'model')).toBeNull();
  });

  it('stops scanning at first section header', () => {
    const toml = `model = "gpt-5.6-sol"\n[profile.alt]\nmodel = "different"\n`;
    expect(extractTopLevelString(toml, 'model')).toBe('gpt-5.6-sol');
  });

  it('returns null when key is missing', () => {
    expect(extractTopLevelString(`other = "x"\n`, 'model')).toBeNull();
  });

  it('handles inline comments', () => {
    const toml = `model = "gpt-5.6-sol"  # default model\n`;
    expect(extractTopLevelString(toml, 'model')).toBe('gpt-5.6-sol');
  });

  it('does not match unquoted values (only string assignments)', () => {
    const toml = `model = gpt-5.6-sol\n`;
    expect(extractTopLevelString(toml, 'model')).toBeNull();
  });
});
