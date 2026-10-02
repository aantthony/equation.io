/**
 * MCP tool usage in Workers Analytics Engine: one data point per tools/call,
 * and one per graph type the call draws. scripts/traffic.ts reads them.
 *
 *   blob1    kind     call | type
 *   blob2    tool     encode_graph_url | show_graph | decode_graph_url
 *   blob3    client   the User-Agent's product name (claude-user, node, …)
 *   blob4    type     a graph type (lib/row-kind.ts KIND_MEANINGS); '' on a call
 *   double1  rows           calls only
 *   double2  error rows     calls only: rows that came back status "error"
 *   double3  invalid        calls only: 1 when any row had an error
 *   double4  failed         calls only: 1 when the call itself was rejected
 *                           (wrong arguments, two equations in one row)
 *
 * Only counts and type names are stored, never what the rows say, so no
 * equation text reaches the dataset. Calls come from the AI provider's
 * servers, so there is no person, IP or country to record either.
 *
 * Site traffic needs nothing like this: Cloudflare's own zone analytics
 * already count it (scripts/traffic.ts).
 */
export const TOOL_NAMES = ['encode_graph_url', 'show_graph', 'decode_graph_url'] as const;
export type Tool = (typeof TOOL_NAMES)[number];

export interface CallStats {
  rows: number;
  errorRows: number;
  types: Iterable<string>;
  failed?: boolean;
}

/** An MCP client's name, without its version: `Claude-User/1.0` → claude-user. */
export function clientName(ua: string): string {
  const m = /compatible;\s*([A-Za-z][\w.-]*)/.exec(ua) ?? /^([A-Za-z][\w.-]*)/.exec(ua);
  return m ? m[1].slice(0, 32).toLowerCase() : '';
}

export function recordToolCall(env: Env, request: Request, tool: Tool, stats: CallStats): void {
  const client = clientName(request.headers.get('User-Agent') ?? '');
  try {
    env.MCP_USAGE.writeDataPoint({
      blobs: ['call', tool, client, ''],
      doubles: [stats.rows, stats.errorRows, stats.errorRows > 0 ? 1 : 0, stats.failed ? 1 : 0],
      indexes: [tool],
    });
    for (const type of new Set(stats.types)) {
      env.MCP_USAGE.writeDataPoint({ blobs: ['type', tool, client, type], indexes: [tool] });
    }
  } catch (e) {
    // Usage counts must never fail a tool call.
    console.error('mcp usage', e);
  }
}
