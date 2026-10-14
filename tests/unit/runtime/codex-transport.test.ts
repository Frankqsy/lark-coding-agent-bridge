import { describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../../src/agent/codex/adapter.js';
import { CodexAppServerAdapter } from '../../../src/agent/codex/app-server-adapter.js';
import { normalizeProfileConfig } from '../../../src/config/profile-schema.js';
import { createRuntimeAgent } from '../../../src/runtime/agent-runtime.js';

function profileWith(transport: 'exec' | 'app-server' | undefined): unknown {
  return {
    schemaVersion: 2,
    agentKind: 'codex',
    accounts: { app: { id: 'cli_test', tenant: 'feishu', secret: '${APP_SECRET}' } },
    codex: {
      binaryPath: '/usr/local/bin/codex',
      ...(transport ? { transport } : {}),
    },
  };
}

describe('codex transport selection', () => {
  it('defaults to the exec transport and keeps configs clean', () => {
    const config = normalizeProfileConfig(profileWith(undefined));

    expect(config.codex?.transport).toBeUndefined();
    expect(
      createRuntimeAgent(config, { profileDir: '/tmp/profile' }),
    ).toBeInstanceOf(CodexAdapter);
  });

  it('keeps an explicit app-server transport through normalization', () => {
    const config = normalizeProfileConfig(profileWith('app-server'));

    expect(config.codex?.transport).toBe('app-server');
    expect(
      createRuntimeAgent(config, { profileDir: '/tmp/profile' }),
    ).toBeInstanceOf(CodexAppServerAdapter);
  });

  it('ignores an unknown transport value', () => {
    const config = normalizeProfileConfig({
      ...(profileWith(undefined) as Record<string, unknown>),
      codex: { binaryPath: '/usr/local/bin/codex', transport: 'carrier-pigeon' },
    });

    expect(config.codex?.transport).toBeUndefined();
    expect(
      createRuntimeAgent(config, { profileDir: '/tmp/profile' }),
    ).toBeInstanceOf(CodexAdapter);
  });
});
