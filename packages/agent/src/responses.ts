/**
 * The Equation.io agent over the OpenAI Responses API: user request → model →
 * tool calls against the live graph → tool results (and screenshots) → model
 * continues, until it answers without calling a tool.
 *
 * Every request is `stream: true, store: false`: OpenAI keeps nothing, so the
 * conversation lives here and is resent whole each step. Reasoning models'
 * thinking comes back encrypted (`reasoning.encrypted_content`) so it can be
 * carried forward without being stored.
 *
 * The transport is a parameter: the desktop app streams through its Rust side,
 * which holds the ChatGPT OAuth credential (apps/desktop), and tests stream
 * canned events. Nothing here knows where the model runs or who pays for it.
 */
import type { FunctionTool } from './tools.ts';

/** One item of a Responses API `input` (or `output`): messages, function calls and their outputs, reasoning. */
export type Item = { type: string; [k: string]: unknown };

/** A streamed Responses API event (the parsed `data:` of one server-sent event). */
export type StreamEvent = { type: string; [k: string]: any };

export interface ResponsesRequest {
  model: string;
  instructions: string;
  input: Item[];
  tools: FunctionTool[];
  tool_choice: 'auto';
  parallel_tool_calls: boolean;
  store: false;
  stream: true;
  include: string[];
}

/** Sends one request and yields its events; throws (or yields an `error` event) on failure. */
export type ResponsesTransport = (request: ResponsesRequest, signal?: AbortSignal) => AsyncIterable<StreamEvent>;

/** Runs one tool call against the app; always resolves to a JSON-serializable result. */
export type ToolRunner = (name: string, args: string) => Promise<unknown>;

export interface AgentOptions {
  transport: ResponsesTransport;
  /** The model id, from the account's own catalogue (models.ts). */
  model: string;
  instructions: string;
  tools: FunctionTool[];
  runTool: ToolRunner;
  /** Model calls per user turn before the agent stops and says so. Default 16. */
  maxSteps?: number;
  /** Screenshots kept in the history; older ones are replaced by a note. Default 2. */
  keepImages?: number;
}

export interface TurnHandlers {
  /** This turn's instructions, when they differ from the agent's (a spoken turn in a typed conversation). */
  instructions?: string;
  /** Text as it streams in. */
  onTextDelta?(delta: string): void;
  /** A tool call is about to run. */
  onToolCall?(name: string, args: string): void;
  /** A tool call finished. */
  onToolResult?(name: string, result: unknown): void;
}

/** The turn was cut short by its AbortSignal. */
export class AgentAborted extends Error {
  constructor() {
    super('interrupted');
    this.name = 'AgentAborted';
  }
}

const userText = (text: string): Item => ({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text }],
});

/**
 * An output item made fit to send back. With store: false an item id names
 * nothing on OpenAI's side, so ids go; reasoning is kept only when it carries
 * its encrypted content, which is the only form a stateless request accepts.
 */
export function replayable(item: Item): Item | null {
  if (item.type === 'reasoning' && typeof item.encrypted_content !== 'string') return null;
  const { id: _id, status: _status, ...rest } = item;
  return rest;
}

/** The text of an assistant message item. */
export function messageText(item: Item): string {
  if (item.type !== 'message' || !Array.isArray(item.content)) return '';
  return (item.content as { type?: string; text?: string }[])
    .filter(c => c.type === 'output_text' && typeof c.text === 'string')
    .map(c => c.text)
    .join('');
}

/** Replaces all but the newest `keep` screenshots with a note: each is hundreds of kilobytes, resent every step. */
export function pruneImages(items: Item[], keep: number): Item[] {
  let seen = 0;
  const out = [...items];
  for (let i = out.length - 1; i >= 0; i--) {
    const item = out[i];
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    const content = item.content as { type: string }[];
    if (!content.some(c => c.type === 'input_image')) continue;
    if (++seen <= keep) continue;
    out[i] = {
      ...item,
      content: content.map(c =>
        c.type === 'input_image' ? { type: 'input_text', text: '[an earlier screenshot, no longer attached]' } : c,
      ),
    };
  }
  return out;
}

export class Agent {
  /** The conversation so far, as the next request's input. */
  history: Item[] = [];
  /** Screenshots taken by this step's tool calls, to follow their outputs. */
  private attachments: Item[] = [];

  constructor(private options: AgentOptions) {}

  set model(model: string) {
    this.options.model = model;
  }

  get model(): string {
    return this.options.model;
  }

  /** Starts a fresh conversation. */
  reset() {
    this.history = [];
    this.attachments = [];
  }

  /**
   * Adds a screenshot to the conversation; look_at_graph's ToolContext.attach.
   * It goes in after the tool outputs of the step that took it.
   */
  attach(image: string, legend: string): Promise<void> {
    this.attachments.push({
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: `The screenshot look_at_graph took. ${legend}` },
        { type: 'input_image', image_url: image, detail: 'auto' },
      ],
    });
    return Promise.resolve();
  }

  /**
   * One user turn: runs the model and its tool calls until it answers.
   * Resolves to the final reply's text. On abort the history keeps what
   * completed, and every tool call it holds has an output, so the
   * conversation can go on.
   */
  async send(text: string, handlers: TurnHandlers = {}, signal?: AbortSignal): Promise<string> {
    const { maxSteps = 16, keepImages = 2 } = this.options;
    this.history.push(userText(text));
    for (let step = 0; step < maxSteps; step++) {
      const output = await this.step(handlers, signal);
      const calls = output.filter(item => item.type === 'function_call');
      for (const item of output) {
        const kept = replayable(item);
        if (kept) this.history.push(kept);
      }
      if (!calls.length) return output.map(messageText).join('');
      for (const call of calls) {
        const name = String(call.name);
        const args = typeof call.arguments === 'string' ? call.arguments : '{}';
        let result: unknown;
        if (signal?.aborted) result = { error: 'interrupted by the student' };
        else {
          handlers.onToolCall?.(name, args);
          try {
            result = await this.options.runTool(name, args);
          } catch (e) {
            result = { error: e instanceof Error ? e.message : String(e) };
          }
          handlers.onToolResult?.(name, result);
        }
        this.history.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
      }
      this.history.push(...this.attachments.splice(0));
      this.history = pruneImages(this.history, keepImages);
      if (signal?.aborted) throw new AgentAborted();
    }
    const note = 'I stopped there: that took more steps than I allow myself for one question.';
    this.history.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: note }] });
    return note;
  }

  /** One model call; resolves to its output items. Partial output of an aborted call is dropped. */
  private async step(handlers: TurnHandlers, signal?: AbortSignal): Promise<Item[]> {
    const { transport, model, tools } = this.options;
    const request: ResponsesRequest = {
      model,
      instructions: handlers.instructions ?? this.options.instructions,
      input: this.history,
      tools,
      tool_choice: 'auto',
      parallel_tool_calls: true,
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
    };
    const done: Item[] = [];
    let completed: Item[] | null = null;
    for await (const event of transport(request, signal)) {
      if (signal?.aborted) throw new AgentAborted();
      switch (event.type) {
        case 'response.output_text.delta':
          if (typeof event.delta === 'string') handlers.onTextDelta?.(event.delta);
          break;
        case 'response.output_item.done':
          if (event.item) done.push(event.item as Item);
          break;
        case 'response.completed':
        case 'response.incomplete':
          completed = Array.isArray(event.response?.output) ? (event.response.output as Item[]) : null;
          break;
        case 'response.failed':
          throw new Error(event.response?.error?.message ?? 'the model request failed');
        case 'error':
          throw new Error(event.message ?? event.error?.message ?? 'the model request failed');
      }
    }
    if (signal?.aborted) throw new AgentAborted();
    // Items as each finished; the completed response's list when the stream
    // didn't report them one by one.
    return done.length ? done : (completed ?? []);
  }
}
