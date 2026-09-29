/**
 * @equation/agent: the Equation.io graph agent. Its prompt, its tools, the
 * code that runs them against the live app, and the Responses API loop that
 * drives them. Web voice (Realtime) and the desktop agent share all of it.
 *
 * Runtimes without a DOM (the Worker) import the modules they need directly:
 * host.ts touches canvases.
 */
export * from './host.ts';
export * from './models.ts';
export * from './prompt.ts';
export * from './realtime.ts';
export * from './responses.ts';
export * from './tools.ts';
