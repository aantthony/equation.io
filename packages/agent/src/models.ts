/**
 * The model picker's list: the signed-in account's own catalogue (GET
 * /v1/models with its credential), never a hard-coded list of names. What is
 * dropped is only what cannot hold a conversation with tools at all.
 */

export interface ModelInfo {
  id: string;
  created?: number;
  owned_by?: string;
}

/** Families that are not conversational models: embeddings, speech, images, moderation. */
const NOT_CHAT =
  /(^|[-_:])(embedding|embed|tts|whisper|transcribe|dall-e|image|moderation|audio|realtime|search)([-_:.]|$)/i;

/** The models the agent can use, newest first; ids repeat at most once. */
export function chatModels(list: unknown): ModelInfo[] {
  const data = (list as { data?: unknown })?.data ?? list;
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  for (const m of data as ModelInfo[]) {
    if (!m || typeof m.id !== 'string' || seen.has(m.id) || NOT_CHAT.test(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out.sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id));
}

/** The model to select: the saved choice while the account still offers it, else the newest. */
export function pickModel(models: ModelInfo[], saved: string | null | undefined): string | null {
  if (saved && models.some(m => m.id === saved)) return saved;
  return models[0]?.id ?? null;
}
