import { describe, expect, it } from 'vitest';
import { CLAUDE_PERMISSION_MODES } from '@agent-proxy/shared';
import { parseProviderOverridesInput } from './model-mappings.js';

describe('parseProviderOverridesInput', () => {
  it.each(CLAUDE_PERMISSION_MODES)(
    'accepts the supported Claude SDK permission mode %s',
    (permissionMode) => {
      expect(parseProviderOverridesInput({
        sdk_options: { permission_mode: permissionMode },
      })).toEqual({
        ok: true,
        value: { sdk_options: { permission_mode: permissionMode } },
      });
    },
  );

  it('rejects unsupported Claude SDK permission modes', () => {
    expect(parseProviderOverridesInput({
      sdk_options: { permission_mode: 'legacyMode' },
    })).toEqual({
      ok: false,
      reason: 'sdk_options.permission_mode must be one of: default, acceptEdits, bypassPermissions, plan, dontAsk, auto.',
    });
  });
});
