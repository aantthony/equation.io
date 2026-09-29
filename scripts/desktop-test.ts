/**
 * The desktop app's page side, in a browser: the website must show none of
 * it, and inside a mocked Tauri bridge (the Rust side replaced by canned
 * IPC replies, apps/desktop/src-tauri/src/lib.rs) sign-in, the account's
 * model catalogue, a full agent tool loop against the live graph, external
 * links and the voice loop must all work.
 *
 * The Rust side itself is covered by `cargo test` in apps/desktop/src-tauri.
 *
 *   pnpm test:desktop            (CHROMIUM=/path/to/chrome to override the browser)
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PORT = 5199;
const ORIGIN = `http://localhost:${PORT}`;
const ROOT = fileURLToPath(new URL('..', import.meta.url));

let failures = 0;
function ok(cond: unknown, name: string) {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
}

const server = spawn(`${ROOT}node_modules/.bin/vite`, ['--port', String(PORT), '--strictPort'], {
  cwd: ROOT,
  stdio: 'ignore',
});
process.on('exit', () => server.kill());

for (let i = 0; ; i++) {
  try {
    if ((await fetch(ORIGIN)).ok) break;
  } catch {}
  if (i > 100) throw new Error(`vite did not come up on ${ORIGIN}`);
  await new Promise(r => setTimeout(r, 200));
}

// CHROMIUM overrides the browser binary, for containers with a system build.
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || undefined,
  args: ['--enable-unsafe-swiftshader'],
});

// --- 1. The website: unchanged, no desktop UI ---
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => m.type() === 'error' && errors.push(m.text()));
  await page.goto(ORIGIN + '/' + '#y%20%3D%20sin(x)');
  await page.waitForSelector('#equations');
  await page.waitForTimeout(1500);
  ok((await page.locator('#agent-toggle').count()) === 0, 'web: no agent button');
  ok(await page.locator('#voice').isHidden(), 'web: voice button hidden without a key');
  ok((await page.locator('.voice-start').count()) === 0, 'web: no idle voice orb');
  const text = await page.locator('#equations').innerText();
  ok(text.includes('sin'), 'web: graph loaded from URL');
  const scripts = await page.evaluate(() => performance.getEntriesByType('resource').map(r => r.name));
  ok(!scripts.some(s => /desktop/.test(s)), 'web: desktop code not downloaded');
  ok(errors.length === 0, `web: no console errors ${JSON.stringify(errors)}`);
  await page.close();
}

// --- 2. The desktop app, with the Rust side mocked ---
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => m.type() === 'error' && errors.push(m.text()));
  await page.addInitScript(() => {
    const callbacks = new Map();
    let nextId = 1;
    const state = { account: null, requests: [], opened: [] };
    (window as any).__mock = state;
    const events = {
      toolCall: (name, args, id) => [
        {
          type: 'response.output_item.done',
          item: { id: 'fc_' + id, type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) },
        },
        { type: 'response.completed', response: { output: [] } },
      ],
      say: text => [
        { type: 'response.output_text.delta', delta: text.slice(0, 10) },
        { type: 'response.output_text.delta', delta: text.slice(10) },
        {
          type: 'response.output_item.done',
          item: { id: 'msg', type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
        },
        { type: 'response.completed', response: { output: [] } },
      ],
    };
    const script = [
      events.toolCall('set_graph', { equations: ['y = x^2', 'y = 2x - 1 #e24'] }, 'call_a'),
      events.toolCall('look_at_graph', {}, 'call_b'),
      events.say('I drew the parabola y = x² and its tangent at x = 1 in red.'),
    ];
    (window as any).__TAURI_INTERNALS__ = {
      transformCallback(cb) {
        const id = nextId++;
        callbacks.set(id, cb);
        return id;
      },
      unregisterCallback(id) {
        callbacks.delete(id);
      },
      async invoke(cmd, args) {
        switch (cmd) {
          case 'auth_status':
            return state.account;
          case 'auth_sign_in':
            await new Promise(r => setTimeout(r, 200));
            return (state.account = { label: 'ada@example.com', plan: 'plus' });
          case 'auth_sign_out':
            state.account = null;
            return null;
          case 'models_list':
            return {
              data: [
                { id: 'acct-model-old', created: 1 },
                { id: 'text-embedding-3-small', created: 9 },
                { id: 'acct-model-new', created: 2 },
              ],
            };
          case 'speech_supported':
            return false;
          case 'open_external':
            state.opened.push(args.url);
            return null;
          case 'responses_cancel':
            return null;
          case 'responses_stream': {
            state.requests.push(JSON.parse(JSON.stringify(args.request)));
            const send = callbacks.get(args.onEvent.id);
            const reply = script.shift() ?? events.say('(no more scripted replies)');
            let i = 0;
            for (const e of reply) {
              await new Promise(r => setTimeout(r, 20));
              send({ index: i++, message: JSON.stringify(e) });
            }
            send({ index: i++, message: '[END]' });
            return null;
          }
        }
        throw new Error('unmocked command ' + cmd);
      },
    };
  });
  await page.goto(ORIGIN + '/' + '#y%20%3D%20sin(x)');
  await page.waitForSelector('#agent-toggle');
  ok(await page.locator('#voice').isVisible(), 'desktop: voice offered (webview recognizer fallback)');
  await page.click('#agent-toggle');
  await page.waitForSelector('.agent-connect');
  ok(await page.locator('.agent-input').isDisabled(), 'desktop: composer disabled until signed in');
  await page.click('.agent-connect');
  await page.waitForSelector('.agent-who');
  ok((await page.locator('.agent-who').innerText()).includes('ada@example.com'), 'desktop: account label shown');
  await page.waitForFunction(() => !document.querySelector('.agent-model')?.disabled);
  const options = await page.locator('.agent-model option').allInnerTexts();
  ok(
    JSON.stringify(options) === JSON.stringify(['acct-model-new', 'acct-model-old']),
    `desktop: account models, newest first, no embeddings: ${options}`,
  );
  await page.fill('.agent-input', 'Draw a parabola and its tangent at x = 1');
  await page.press('.agent-input', 'Enter');
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.agent-assistant').length > 0 &&
      !document.querySelector('.agent-send')?.textContent?.includes('Stop'),
    null,
    { timeout: 15000 },
  );
  await page.waitForTimeout(500);
  const eqs = await page.locator('#equations').innerText();
  ok(eqs.includes('x^2') || eqs.includes('x²'), `desktop: set_graph changed the live graph: ${JSON.stringify(eqs)}`);
  ok(!eqs.includes('sin'), 'desktop: old row replaced');
  const reply = await page.locator('.agent-assistant').last().innerText();
  ok(reply.includes('parabola'), 'desktop: reply shown');
  const tools = await page.locator('.agent-tool').allInnerTexts();
  ok(tools.join('|') === 'changed the graph|looked at the graph', `desktop: tool calls logged: ${tools}`);
  const requests = await page.evaluate(() => (window as any).__mock.requests);
  ok(requests.length === 3, `desktop: three model calls (got ${requests.length})`);
  ok(
    requests.every(r => r.store === false && r.stream === true),
    'desktop: store:false, stream:true',
  );
  ok(
    requests.every(r => r.model === 'acct-model-new'),
    'desktop: selected model used',
  );
  ok(
    requests[0].tools.some(t => t.name === 'set_graph'),
    'desktop: graph tools offered',
  );
  const out = requests[1].input.find(i => i.type === 'function_call_output');
  ok(
    out && JSON.parse(out.output).rows?.some(r => r.text === 'y = x^2' && r.status === 'ok'),
    'desktop: set_graph result is the live graph state',
  );
  const shot = JSON.stringify(requests[2].input);
  ok(shot.includes('data:image/jpeg;base64,'), 'desktop: look_at_graph attached a real screenshot');

  // External links go to the system browser.
  await page.evaluate(() => document.querySelector('#panel-links a[href^="https://github.com"]').click());
  await page.waitForTimeout(200);
  const opened = await page.evaluate(() => (window as any).__mock.opened);
  ok(opened[0] === 'https://github.com/aantthony/equation.io', `desktop: github link opened externally ${opened}`);
  ok(page.url().startsWith(ORIGIN + '/'), 'desktop: app did not navigate away');

  await page.click('.agent-signout');
  await page.waitForSelector('.agent-connect');
  ok(true, 'desktop: signed out');
  ok(errors.length === 0, `desktop: no console errors ${JSON.stringify(errors)}`);
  await page.close();
}
// --- 3. Desktop voice: native recognition mocked, speech synthesis faked ---
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => m.type() === 'error' && errors.push(m.text()));
  await page.addInitScript(() => {
    const callbacks = new Map();
    let nextId = 1;
    const state = { requests: [], listens: 0, stops: 0, spoken: [] };
    (window as any).__mock = state;
    Object.defineProperty(window, 'speechSynthesis', {
      value: {
        speak(u) {
          state.spoken.push(u.text);
          setTimeout(() => u.onstart?.(), 10);
          setTimeout(() => u.onend?.(), 80);
        },
        cancel() {},
      },
    });
    const script = [
      [
        { type: 'response.output_text.delta', delta: 'Sure. ' },
        {
          type: 'response.output_item.done',
          item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Sure. ' }] },
        },
        {
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            call_id: 'c1',
            name: 'set_graph',
            arguments: '{"equations":["x^2 + y^2 = 4"]}',
          },
        },
        { type: 'response.completed', response: { output: [] } },
      ],
      [
        { type: 'response.output_text.delta', delta: 'There is a circle of radius 2. ' },
        { type: 'response.output_text.delta', delta: 'It is centred at the origin.' },
        {
          type: 'response.output_item.done',
          item: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'There is a circle of radius 2. It is centred at the origin.' }],
          },
        },
        { type: 'response.completed', response: { output: [] } },
      ],
    ];
    (window as any).__TAURI_INTERNALS__ = {
      transformCallback(cb) {
        const id = nextId++;
        callbacks.set(id, cb);
        return id;
      },
      unregisterCallback(id) {
        callbacks.delete(id);
      },
      async invoke(cmd, args) {
        switch (cmd) {
          case 'auth_status':
            return { label: 'ada@example.com' };
          case 'models_list':
            return { data: [{ id: 'acct-model', created: 1 }] };
          case 'speech_supported':
          case 'speech_authorize':
            return true;
          case 'speech_listen': {
            state.listens++;
            if (state.listens > 1) return null; // listening again after the reply
            const send = callbacks.get(args.onEvent.id);
            setTimeout(() => send({ index: 0, message: { type: 'partial', text: 'draw a circle' } }), 200);
            setTimeout(() => send({ index: 1, message: { type: 'partial', text: 'draw a circle of radius 2' } }), 400);
            // No final: the silence timeout ends the utterance.
            return null;
          }
          case 'speech_stop':
            state.stops++;
            return null;
          case 'responses_cancel':
            return null;
          case 'responses_stream': {
            state.requests.push(JSON.parse(JSON.stringify(args.request)));
            const send = callbacks.get(args.onEvent.id);
            let i = 0;
            for (const e of script.shift() ?? []) {
              await new Promise(r => setTimeout(r, 20));
              send({ index: i++, message: JSON.stringify(e) });
            }
            send({ index: i++, message: '[END]' });
            return null;
          }
        }
        throw new Error('unmocked command ' + cmd);
      },
    };
  });
  await page.goto(ORIGIN + '/' + '#y%20%3D%20sin(x)');
  await page.waitForSelector('#agent-toggle');
  await page.waitForFunction(() => !document.getElementById('voice').hidden);
  await page.waitForTimeout(300); // the panel reads the account and models
  await page.click('#voice');
  await page.waitForSelector('.voice-orb');
  await page.waitForFunction(() => (window as any).__mock.listens >= 2, null, { timeout: 15000 });
  const mock = await page.evaluate(() => (window as any).__mock);
  const eqs = await page.locator('#equations').innerText();
  ok(eqs.includes('x^2 + y^2 = 4'), `voice: the spoken request changed the graph: ${JSON.stringify(eqs)}`);
  ok(mock.requests[0].instructions.includes('explain out loud'), 'voice: spoken turn uses the voice prompt');
  ok(
    JSON.stringify(mock.requests[0].input).includes('draw a circle of radius 2'),
    'voice: last partial transcript sent after silence',
  );
  ok(
    mock.spoken.join(' ') === 'Sure. There is a circle of radius 2. It is centred at the origin.',
    `voice: reply spoken in sentences: ${JSON.stringify(mock.spoken)}`,
  );
  ok(mock.spoken.length >= 3, 'voice: first sentence queued before the reply finished');
  ok(mock.stops >= 1, 'voice: stopped listening while answering (never hears itself)');
  ok((await page.locator('.agent-spoken').count()) === 1, 'voice: transcript in the shared conversation log');
  await page.click('#voice');
  await page.waitForTimeout(200);
  ok((await page.locator('.voice-orb').count()) === 0, 'voice: orb gone after stopping');
  ok(errors.length === 0, `voice: no console errors ${JSON.stringify(errors)}`);
  await page.close();
}

await browser.close();
server.kill();
console.log(failures ? `\n${failures} failed` : '\nall passed');
if (failures) process.exit(1);
