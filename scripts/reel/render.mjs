#!/usr/bin/env node
// Renders an HTML card to PNG frames by stepping its CSS animations.
//
//   node scripts/reel/render.mjs <card.html[?query]> <out-dir> <seconds> [fps]
//
// A query string is passed through to the page, which is how section.html and
// live.html are told what to show. <seconds> also becomes the page's --dur, so
// a card's length is set in one place, by whoever calls this.
//
// Why not ffmpeg's zoompan over a screenshot: zoompan rounds the crop to whole
// pixels each frame, so a slow push on a still shakes. Here Chrome draws every
// frame itself, at sub-pixel precision, and nothing moves that was not
// animated in the card's own CSS.
//
// The card runs ordinary CSS animations. Each frame, every animation is paused
// and set to that frame's time, so the output does not depend on how fast this
// machine renders. No dependencies: Chrome's DevTools protocol over the
// WebSocket that Node ships.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [card, outDir, secsArg, fpsArg] = process.argv.slice(2);
if (!card || !outDir || !secsArg) {
  console.error('usage: render.mjs <card.html> <out-dir> <seconds> [fps]');
  process.exit(2);
}
const FPS = Number(fpsArg) || 30;
const FRAMES = Math.round(Number(secsArg) * FPS);
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const profile = await mkdtemp(join(tmpdir(), 'reel-chrome-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  '--allow-file-access-from-files', '--window-size=1920,1080', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

const cleanup = async () => {
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
};

try {
  // Chrome picks a free port and says which on stderr.
  const wsUrl = await new Promise((ok, fail) => {
    let buf = '';
    const timer = setTimeout(() => fail(new Error('Chrome did not open a DevTools port')), 20_000);
    chrome.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); ok(m[1]); }
    });
    chrome.on('exit', (code) => fail(new Error(`Chrome exited (${code})`)));
  });

  const ws = new WebSocket(wsUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error('DevTools socket failed')); });

  let seq = 0;
  const waiting = new Map();
  const events = new Map();
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id && waiting.has(msg.id)) {
      const { ok, fail } = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error ? fail(new Error(msg.error.message)) : ok(msg.result);
    } else if (msg.method && events.has(msg.method)) {
      events.get(msg.method)(msg.params);
      events.delete(msg.method);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((ok, fail) => {
    const id = ++seq;
    waiting.set(id, { ok, fail });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const once = (method) => new Promise((ok) => events.set(method, ok));

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  const run = async (expression) => {
    const r = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };

  await page('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await page('Page.enable');
  const loaded = once('Page.loadEventFired');
  const [file, query] = card.split('?');
  await page('Page.navigate', { url: pathToFileURL(resolve(file)).href + (query ? `?${query}` : '') });
  await loaded;
  // A frame taken before the mark or the font is decoded would pop a beat later.
  await run('Promise.all([document.fonts.ready, ...Array.from(document.images, (i) => i.decode())]).then(() => 1)');

  await run(`document.body.style.setProperty('--dur', '${Number(secsArg)}s'), 1`);

  await mkdir(outDir, { recursive: true });
  for (let f = 0; f < FRAMES; f++) {
    const ms = (f / FPS) * 1000;
    await run(`(() => {
      for (const a of document.getAnimations()) { a.pause(); a.currentTime = ${ms}; }
      return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))));
    })()`);
    const { data } = await page('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(outDir, `${String(f).padStart(4, '0')}.png`), Buffer.from(data, 'base64'));
  }
  ws.close();
  console.log(`${card}: ${FRAMES} frames -> ${outDir}`);
} catch (err) {
  console.error('render failed:', err.message);
  process.exitCode = 1;
} finally {
  await cleanup();
}
