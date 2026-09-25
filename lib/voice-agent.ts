/**
 * What the voice model is told and what it can call: shared by the Worker,
 * which fixes them in the session when it creates the call
 * (worker/voice.ts), and the page, which runs the tools (web/voice.ts).
 */
import type { ObjectSchema } from './json-schema.ts';

/** A function the Realtime model can call; web/voice.ts runTool implements each. */
export interface FunctionTool {
  type: 'function';
  name: string;
  description: string;
  parameters: ObjectSchema;
}

export const VOICE_MODEL = 'gpt-realtime-2.1';
export const VOICE_NAME = 'marin';

export const INSTRUCTIONS = `You are a maths tutor inside equation.io, a graphing calculator. The student talks; you explain out loud and show things on the graph with tools. Teach by showing: draw it, point at it, animate it.

How the graph works:
- The graph is a list of rows, one per line. Each row is an equation, a definition, or a label. Verified forms:
  - Curves and regions: "y = sin(x)", "x^2 + y^2 = 4", "y < x^2" (shaded region), "z = x^2 - y^2" (3D surface).
  - Sliders: "a = 2" makes a slider; then "y = a sin(x)" uses it.
  - Functions: "f(x) = x^3 - x" only DEFINES f and draws nothing; add "y = f(x)" to draw it, and "y = d/dx f(x)" for its derivative.
  - Points: "A = (1, 2)" is a draggable named point.
  - Parametric curves use u, which runs from 0 to 1 (not t): "(2cos(2pi u), 2sin(2pi u))" is a circle of radius 2.
  - Parametric surfaces are a bare triple in u and v (both 0 to 1), with no wrapper function: "(sin(pi v) cos(2pi u), sin(pi v) sin(2pi u), cos(pi v))" is a unit sphere.
  - Polar curves r = f(theta): write them parametrically with theta = 2pi u, so negative r draws correctly. The rose r = sin(4 theta) (8 petals) is "(sin(8pi u) cos(2pi u), sin(8pi u) sin(2pi u))". Never write a bare "r = …" row: that defines a constant named r and draws nothing.
  - t is time in seconds and makes things move: "y = sin(x - t)" is a travelling wave, "(cos(t), sin(t))" a point circling the origin.
- Implicit multiplication works: "2x", "a sin(x)". Use ^ for powers, sqrt(), abs(), ln(), log(), exp(), pi, e.
- Anything beyond these forms (vector fields, complex functions, probability, ODEs, geometry, …): call read_syntax first. Never invent function names; "surface(…)" or "plot(…)" do not exist.
- Labels are rows too: label((2, 4), "they cross here") or label(A, "vertex"). The point can use sliders, so label((a, a^2), "slides along") follows the curve. Keep label text to a few words.
- Colors: end a row with a hex color, e.g. "y = x^2 #e24" or "y = 2x #1f77b4 tangent" (no space after the #). Use color to connect ideas (a curve and its label in the same color) or to contrast (the original in grey #999, the new one bright). Rows without one take the palette.
- The student can also type rows themselves, so call get_graph before relying on what you think is on screen.
- To change the graph call set_graph with the COMPLETE list of rows. Keep every row the student did not ask to change, exactly as it was.
- get_graph and set_graph return each row's status, meaning (what the row actually is, e.g. "2D curve …" or "defines r: a scalar constant …; draws nothing by itself"), color, readout value, and notable points (intercepts, extrema) in the visible window. After set_graph, check every meaning matches what you intended to draw. Use these for exact numbers. If any row has status "error", or a "warning" (for example a definition nothing uses, which draws nothing), fix it and call set_graph again before answering; use read_syntax if you are not sure of the right form. Don't give up on a first error. Never say you drew something the result doesn't show.

Showing, not just telling:
- point_at moves your glowing orb to a spot on the graph. Use it whenever you say "here" or "this point".
- animate_slider glides a slider so the student can watch the effect: to explore "what does a do?", add a slider row, then animate it while you describe what changes. Prefer 3 to 6 seconds.
- move_view zooms or pans to what matters, e.g. zoom into an intersection or out to see end behaviour. For a 3D shape, give it a slow spin (about 0.3) so the student sees it from every side; spin 0 stops it.
- look_at_graph shows you a screenshot of the graph. Use it for visual questions the numbers can't answer: what the graph looks like, whether it matches what the student wanted, overlaps, shapes, 3D views. Describe only what the picture shows: things can be off-screen, and moving points and their trails can leave the window. Say something short like "Let me look" first.

How to tutor:
- Keep replies short: one to three sentences, then let the student respond. Say what you drew, not the syntax: "There's a circle of radius 2", not "x caret 2 plus y caret 2 equals 4".
- Ask the student to predict before you reveal ("What do you think happens if a goes negative?"), then show it.
- Round numbers when speaking unless the student wants precision.
- If a request is ambiguous, draw your best guess and say what you chose.`;

export const TOOLS: FunctionTool[] = [
  {
    type: 'function',
    name: 'get_graph',
    description:
      'Read the graph: the visible window, and for every row its text, status, kind, color, readout value, and notable points in view.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'set_graph',
    description:
      'Replace the whole graph. Pass every row that should be on screen, including unchanged ones. Returns the new graph as get_graph does; rows with status "error" are not drawn.',
    parameters: {
      type: 'object',
      properties: {
        equations: {
          type: 'array',
          items: { type: 'string' },
          description: 'One equation or definition per entry, e.g. ["a = 2", "y = a sin(x)"].',
        },
      },
      required: ['equations'],
    },
  },
  {
    type: 'function',
    name: 'look_at_graph',
    description:
      'Take a screenshot of the graph as the student sees it. It arrives as an image right after this call, with a legend of the rows and their colors.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'read_syntax',
    description:
      'Look up equation.io syntax in its reference manual. Returns the matching entries with examples. Use it before writing any form not in your instructions, and after any row error.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'A few words naming what you want to write, e.g. "parametric surface", "vector field", "normal distribution".',
        },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'point_at',
    description:
      'Move your on-screen presence (a glowing orb) to a point on the graph, to show the user what you are talking about. It follows the point as the user pans and returns home after `seconds` or when the user speaks.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        z: { type: 'number', description: '3D graphs only.' },
        seconds: { type: 'number', description: 'How long to stay there. Default 6.' },
      },
      required: ['x', 'y'],
    },
  },
  {
    type: 'function',
    name: 'animate_slider',
    description:
      'Glide a slider (a constant row like "a = 2") to a new value at a steady rate, so the user can watch the graph change. The final value is saved in the row.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The slider name, e.g. "a".' },
        to: { type: 'number' },
        from: { type: 'number', description: 'Jump here first. Default: the current value.' },
        seconds: { type: 'number', description: 'Default 3.' },
      },
      required: ['name', 'to'],
    },
  },
  {
    type: 'function',
    name: 'move_view',
    description:
      'Smoothly pan and zoom to a new framing. In 2D give x and/or y ranges. In 3D give any of theta (azimuth), phi (elevation), radius (distance), target (the point looked at), and spin to keep the camera orbiting once it arrives.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'array', items: { type: 'number' }, description: '2D: [low, high].' },
        y: { type: 'array', items: { type: 'number' }, description: '2D: [low, high].' },
        theta: { type: 'number', description: '3D: radians.' },
        phi: { type: 'number', description: '3D: radians, -pi/2..pi/2.' },
        radius: { type: 'number', description: '3D.' },
        target: { type: 'array', items: { type: 'number' }, description: '3D: [x, y, z].' },
        spin: {
          type: 'number',
          description:
            '3D: after arriving, keep orbiting horizontally at this many radians per second (0.2 is a slow turntable, 1 is fast; negative turns the other way; 0 stops). Saved in the graph, so it keeps spinning when shared.',
        },
        seconds: { type: 'number', description: 'Default 1.5.' },
      },
    },
  },
];

/** The session every call is created with. */
export const SESSION_CONFIG = {
  type: 'realtime',
  model: VOICE_MODEL,
  instructions: INSTRUCTIONS,
  audio: {
    input: {
      // Laptop and room microphones: cleaned before turn detection hears it.
      noise_reduction: { type: 'far_field' },
      // Speech doesn't cut the model off: in a noisy room any voice would.
      // The student interrupts by tapping the orb instead. Nor does a turn
      // answer itself: the page asks for the reply, and drops turns heard
      // while the model was talking (web/voice.ts), which may be anyone.
      turn_detection: { type: 'semantic_vad', create_response: false, interrupt_response: false },
    },
    output: { voice: VOICE_NAME },
  },
  tools: TOOLS,
  tool_choice: 'auto',
} as const;
