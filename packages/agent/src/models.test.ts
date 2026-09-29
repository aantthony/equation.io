import { describe, expect, it } from 'vitest';
import { chatModels, pickModel } from './models.ts';

describe('chatModels', () => {
  it('keeps the account catalogue, newest first, without non-chat families', () => {
    const list = {
      object: 'list',
      data: [
        { id: 'model-a', created: 1 },
        { id: 'text-embedding-3-large', created: 5 },
        { id: 'model-b', created: 3 },
        { id: 'whisper-1', created: 9 },
        { id: 'model-tts', created: 9 },
        { id: 'model-realtime-preview', created: 9 },
        { id: 'model-b', created: 3 },
      ],
    };
    expect(chatModels(list).map(m => m.id)).toEqual(['model-b', 'model-a']);
  });

  it('reads a bare array and tolerates junk', () => {
    expect(chatModels([{ id: 'x' }, null, { name: 'y' }]).map(m => m.id)).toEqual(['x']);
    expect(chatModels({ error: 'nope' })).toEqual([]);
  });
});

describe('pickModel', () => {
  const models = [{ id: 'new' }, { id: 'old' }];
  it('keeps a saved choice the account still offers', () => {
    expect(pickModel(models, 'old')).toBe('old');
    expect(pickModel(models, 'gone')).toBe('new');
    expect(pickModel([], 'old')).toBeNull();
  });
});
