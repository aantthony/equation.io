import { describe, expect, it } from 'vitest';
import { GRAPH_GUIDE, TEXT_INSTRUCTIONS, VOICE_INSTRUCTIONS } from './prompt.ts';
import { SESSION_CONFIG } from './realtime.ts';
import { TOOLS } from './tools.ts';

describe('agent prompt', () => {
  it('shares one graph guide between spoken and typed conversations', () => {
    expect(VOICE_INSTRUCTIONS).toContain(GRAPH_GUIDE);
    expect(TEXT_INSTRUCTIONS).toContain(GRAPH_GUIDE);
    expect(VOICE_INSTRUCTIONS).toMatch(/explain out loud/);
    expect(TEXT_INSTRUCTIONS).not.toMatch(/out loud|speaking/);
  });

  it('is what the Realtime session is created with', () => {
    expect(SESSION_CONFIG.instructions).toBe(VOICE_INSTRUCTIONS);
    expect(SESSION_CONFIG.tools).toBe(TOOLS);
  });

  it('names only tools that exist', () => {
    const names = new Set(TOOLS.map(t => t.name));
    for (const name of GRAPH_GUIDE.match(/\b[a-z]+_[a-z_]+\b(?=[ (])/g) ?? []) {
      expect(names.has(name), name).toBe(true);
    }
  });
});
