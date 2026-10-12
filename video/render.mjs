// Rendert lotse-promo.html Bild für Bild (window.render(t)) und kodiert mit ffmpeg zu MP4.
// Aufruf: node video/render.mjs [seite.html] [ausgabe.mp4] [fps]   – braucht Playwright (Chromium) und ffmpeg.
// Größe aus window.SIZE der Seite (Standard 1920×1080).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const dir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const page_ = args[0]?.endsWith('.html') ? path.resolve(args.shift()) : path.join(dir, 'lotse-promo.html');
const out = path.resolve(args[0] ?? page_.replace(/\.html$/, '.mp4'));
const fps = Number(args[1] ?? 30);

const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;
const browser = await chromium.launch({ proxy });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', e => console.error('Seitenfehler:', e.message));
await page.goto('file://' + page_, { waitUntil: 'networkidle' });
const size = await page.evaluate(() => window.SIZE ?? [1920, 1080]);
await page.setViewportSize({ width: size[0], height: size[1] });
await page.evaluate(() => document.fonts.ready);
const duration = await page.evaluate(() => window.DURATION);

const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
const frames = Math.round(duration * fps);
for (let i = 0; i < frames; i++) {
  await page.evaluate(t => window.render(t), i / fps);
  const png = await page.screenshot({ type: 'png' });
  if (!ff.stdin.write(png)) await new Promise(r => ff.stdin.once('drain', r));
  if (i % fps === 0) process.stdout.write(`\r${Math.round(i / fps)}/${duration} s`);
}
ff.stdin.end();
await new Promise((res, rej) => ff.on('close', c => (c === 0 ? res() : rej(new Error(`ffmpeg ${c}`)))));
await browser.close();
console.log(`\n${out}`);
