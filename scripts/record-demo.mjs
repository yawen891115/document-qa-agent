#!/usr/bin/env node
/**
 * Records docs/demo.gif by driving the running app in headless Chrome.
 *
 *   npm run dev          # or: npm run build && npm start
 *   npm run demo         # writes docs/demo.gif
 *
 * With OPENAI_API_KEY in .env, the first question is asked by voice: the script
 * synthesizes it with OpenAI text-to-speech and plays it into Chrome's fake
 * microphone, so the real voice pipeline runs (record -> transcribe -> answer).
 * With SERPAPI_API_KEY set, the demo also asks a web-only question.
 *
 * Options:
 *   --url <url>         app URL (default: first of http://127.0.0.1:5173 and :3000 that responds)
 *   --out <file>        output GIF (default: docs/demo.gif)
 *   --no-voice          type every question instead of speaking the first one
 *   --chrome <path>     Chrome/Chromium executable (default: the installed Google Chrome)
 *   --scale <0..1>      GIF size relative to the 1280x800 viewport (default 0.75)
 *   --frames-dir <dir>  also save some frames as PNG, for checking
 */
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import gifenc from "gifenc"; // CommonJS package: no named ESM exports
import { chromium } from "playwright-core";
import pngjs from "pngjs";

const { GIFEncoder, quantize } = gifenc;
const { PNG } = pngjs;

const ROOT = fileURLToPath(new URL("..", import.meta.url));
if (existsSync(join(ROOT, ".env"))) process.loadEnvFile(join(ROOT, ".env"));

const { values: opts } = parseArgs({
  options: {
    url: { type: "string" },
    out: { type: "string", default: join(ROOT, "docs", "demo.gif") },
    "no-voice": { type: "boolean", default: false },
    chrome: { type: "string" },
    scale: { type: "string", default: "0.75" },
    "frames-dir": { type: "string" },
  },
});

const VIEWPORT = { width: 1280, height: 800 };
const SCALE = Math.min(1, Math.max(0.3, Number(opts.scale)));
const QUESTIONS = {
  docs: "How long is paid parental leave?",
  hybrid: "What is the current IRS mileage rate that our travel policy reimburses?",
  web: "What's the weather in Chicago today?",
};

// --------------------------------------------------------------------------- app checks

async function findApp() {
  const candidates = opts.url ? [opts.url] : ["http://127.0.0.1:5173", "http://127.0.0.1:3000"];
  for (const url of candidates) {
    try {
      const health = await (await fetch(`${url.replace(/\/$/, "")}/api/health`, { signal: AbortSignal.timeout(3000) })).json();
      return { url: url.replace(/\/$/, ""), health };
    } catch {
      // try the next one
    }
  }
  console.error(`The app is not running at ${candidates.join(" or ")}. Start it with "npm run dev" first.`);
  process.exit(1);
}

// --------------------------------------------------------------------------- voice clip

function wavHeader(dataBytes, sampleRate) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); // PCM chunk size
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** Speaks `text` with OpenAI TTS into a WAV file Chrome can use as its microphone. */
async function synthesizeQuestion(text) {
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const res = await fetch(`${base}/audio/speech`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "coral", input: text, response_format: "pcm" }),
  });
  if (!res.ok) throw new Error(`OpenAI text-to-speech failed (${res.status}): ${await res.text()}`);
  const pcm = Buffer.from(await res.arrayBuffer()); // 24 kHz, 16-bit little-endian, mono
  const silence = (ms) => Buffer.alloc(Math.round((24000 * ms) / 1000) * 2);
  // Trailing silence lets the app's silence detection end the recording.
  const data = Buffer.concat([silence(400), pcm, silence(2600)]);
  const file = join(mkdtempSync(join(tmpdir(), "docqa-demo-")), "question.wav");
  writeFileSync(file, Buffer.concat([wavHeader(data.length, 24000), data]));
  return { file, durationMs: Math.round((data.length / 2 / 24000) * 1000) };
}

// --------------------------------------------------------------------------- GIF encoding

const colorKey = (px, o) => (px[o] << 16) | (px[o + 1] << 8) | px[o + 2];

/**
 * Palette for a set of RGBA pixels: the most frequent colors (flat backgrounds, text ink)
 * are kept exact so unchanged-looking areas stay pixel-identical; the rest is quantized.
 */
function makePalette(pixels, maxColors) {
  const counts = new Map();
  for (let o = 0; o < pixels.length; o += 4) counts.set(colorKey(pixels, o), (counts.get(colorKey(pixels, o)) ?? 0) + 1);
  const toRgb = (k) => [(k >> 16) & 255, (k >> 8) & 255, k & 255];
  if (counts.size <= maxColors) return [...counts.keys()].map(toRgb);
  const exact = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 64).map(([k]) => toRgb(k));
  return [...exact, ...quantize(pixels, maxColors - exact.length)];
}

/** Maps each pixel to its nearest palette color (exact colors map exactly). */
function indexPixels(pixels, palette) {
  const cache = new Map();
  const index = new Uint8Array(pixels.length / 4);
  for (let i = 0, o = 0; o < pixels.length; i++, o += 4) {
    const key = colorKey(pixels, o);
    let idx = cache.get(key);
    if (idx === undefined) {
      let best = Infinity;
      for (let c = 0; c < palette.length && best > 0; c++) {
        const [r, g, b] = palette[c];
        const d = (pixels[o] - r) ** 2 + (pixels[o + 1] - g) ** 2 + (pixels[o + 2] - b) ** 2;
        if (d < best) {
          best = d;
          idx = c;
        }
      }
      cache.set(key, idx);
    }
    index[i] = idx;
  }
  return index;
}

/**
 * Encodes PNG screencast frames into a GIF. Each frame only stores the pixels that
 * changed since the previous frame (the rest is transparent), which keeps typing and
 * streaming text cheap. Identical frames are merged into one longer frame.
 */
function encodeGif(frames, holdLastMs = 2500) {
  const gif = GIFEncoder();
  let previous = null;
  let pending = null;
  const flush = () => pending && gif.writeFrame(pending.index, pending.width, pending.height, pending.options);

  for (let i = 0; i < frames.length; i++) {
    const png = PNG.sync.read(Buffer.from(frames[i].data, "base64"));
    const { width, height } = png;
    const rgba = new Uint8Array(png.data); // own buffer (gifenc reads .buffer directly)
    const next = i + 1 < frames.length ? frames[i + 1].time : frames[i].time + holdLastMs / 1000;
    const delay = Math.max(20, Math.round((next - frames[i].time) * 1000));

    if (!previous || previous.length !== rgba.length) {
      flush();
      const palette = makePalette(rgba, 256);
      pending = { index: indexPixels(rgba, palette), width, height, options: { palette, delay } };
      previous = rgba;
      continue;
    }

    const changed = [];
    for (let p = 0, o = 0; o < rgba.length; p++, o += 4) {
      if (rgba[o] !== previous[o] || rgba[o + 1] !== previous[o + 1] || rgba[o + 2] !== previous[o + 2]) changed.push(p);
    }
    previous = rgba;

    if (changed.length === 0) {
      pending.options.delay += delay; // nothing moved: show the last frame longer
      continue;
    }

    flush();
    const compact = new Uint8Array(changed.length * 4);
    changed.forEach((p, k) => compact.set(rgba.subarray(p * 4, p * 4 + 4), k * 4));
    const palette = makePalette(compact, 255); // one slot left for transparency
    const compactIndex = indexPixels(compact, palette);
    const transparentIndex = palette.length;
    palette.push([0, 0, 0]);
    const index = new Uint8Array(width * height).fill(transparentIndex);
    changed.forEach((p, k) => (index[p] = compactIndex[k]));
    pending = { index, width, height, options: { palette, delay, transparent: true, transparentIndex, dispose: 1 } };
  }
  flush();
  gif.finish();
  return gif.bytes();
}

// --------------------------------------------------------------------------- recording

/** A visible mouse pointer: headless screenshots don't draw the real one. */
function installCursor() {
  const install = () => {
    if (document.getElementById("__demo_cursor")) return;
    const cursor = document.createElement("div");
    cursor.id = "__demo_cursor";
    cursor.innerHTML =
      '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M5 2.5v16.2l4.3-4.2 2.9 6.6 2.5-1.1-2.9-6.5h6z" fill="#1c2738" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    Object.assign(cursor.style, {
      position: "fixed",
      left: "0",
      top: "0",
      zIndex: "2147483647",
      pointerEvents: "none",
      transform: "translate(-100px, -100px)",
    });
    document.documentElement.appendChild(cursor);
    addEventListener("mousemove", (e) => (cursor.style.transform = `translate(${e.clientX - 5}px, ${e.clientY - 2}px)`), true);
    addEventListener("mousedown", () => (cursor.style.scale = "0.85"), true);
    addEventListener("mouseup", () => (cursor.style.scale = "1"), true);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install);
  else install();
}

async function main() {
  const { url, health } = await findApp();
  if (health.documents === 0) {
    process.stdout.write("Loading the sample documents… ");
    await fetch(`${url}/api/documents/samples`, { method: "POST" });
    console.log("done");
  }

  const wantsVoice = !opts["no-voice"] && Boolean(process.env.OPENAI_API_KEY);
  const voice = wantsVoice && health.voice.serverTranscription ? await synthesizeQuestion(QUESTIONS.docs) : null;
  const includeWeb = Boolean(process.env.SERPAPI_API_KEY) && health.webSearch.connected;
  console.log(
    `App: ${url} | model: ${health.llm.model} | voice: ${voice ? "spoken question (OpenAI TTS)" : "typed"} | web question: ${includeWeb ? "yes" : "no (no SERPAPI_API_KEY)"}`,
  );

  const args = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"];
  if (voice) args.push(`--use-file-for-fake-audio-capture=${voice.file}%noloop`);
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args, ...(opts.chrome ? { executablePath: opts.chrome } : { channel: "chrome" }) });
  } catch (err) {
    console.error(`Could not start Chrome (${err.message.split("\n")[0]}).\nInstall Google Chrome, or pass --chrome /path/to/chrome.`);
    process.exit(1);
  }

  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  await context.addInitScript(installCursor);
  const page = await context.newPage();
  // ?voice=server makes the app record + transcribe on the server, which works in headless Chrome.
  await page.goto(voice ? `${url}/?voice=server` : url, { waitUntil: "networkidle" });
  await page.waitForSelector(".composer");
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(VIEWPORT.width * 0.62, VIEWPORT.height * 0.45);

  const frames = [];
  const cdp = await context.newCDPSession(page);
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    frames.push({ data, time: metadata.timestamp ?? Date.now() / 1000 });
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
  });
  await cdp.send("Page.startScreencast", {
    format: "png",
    maxWidth: Math.round(VIEWPORT.width * SCALE),
    maxHeight: Math.round(VIEWPORT.height * SCALE),
  });

  const pause = (ms) => page.waitForTimeout(ms);
  const clickOn = async (locator) => {
    const box = await locator.boundingBox();
    if (!box) throw new Error("Element to click is not visible");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 });
    await pause(180);
    await page.mouse.down();
    await pause(70);
    await page.mouse.up();
  };
  const turns = () => page.locator(".turn").count();
  const waitForAnswer = (n) =>
    page.waitForFunction((n) => document.querySelectorAll(".turn .timeline, .turn .answer-error").length >= n, n, { timeout: 90_000 });
  const typeQuestion = async (text) => {
    await clickOn(page.locator("#question"));
    await page.keyboard.type(text, { delay: 42 });
    await pause(350);
    await page.keyboard.press("Enter");
  };

  await pause(1800); // the empty page and the library

  // 1. A document question, spoken when possible.
  if (voice) {
    await clickOn(page.locator(".orb"));
    await page.waitForSelector(".orb--listening", { timeout: 10_000 });
    // The app stops listening after 1.5 s of silence; click again only if it doesn't.
    const stopped = await page
      .waitForFunction(() => document.querySelectorAll(".turn").length > 0, null, { timeout: voice.durationMs + 6000 })
      .then(() => true)
      .catch(() => false);
    if (!stopped && (await page.locator(".orb--listening").count())) await clickOn(page.locator(".orb"));
    if ((await turns()) === 0) await page.waitForFunction(() => document.querySelectorAll(".turn").length > 0, null, { timeout: 30_000 });
  } else {
    await typeQuestion(QUESTIONS.docs);
  }
  await waitForAnswer(1);
  await pause(2200);

  // 2. Open the first document citation.
  const cite = page.locator(".turn").last().locator(".cite--doc").first();
  if (await cite.count()) {
    await clickOn(cite);
    await pause(2200);
  }

  // 3. A question that needs the documents and the web.
  await typeQuestion(QUESTIONS.hybrid);
  await waitForAnswer(2);
  await pause(3000);

  // 4. A web-only question (only with a real SerpAPI key; mock results make a poor demo).
  if (includeWeb) {
    await typeQuestion(QUESTIONS.web);
    await waitForAnswer(3);
    await pause(3000);
  }

  await cdp.send("Page.stopScreencast");
  await browser.close();

  const out = resolve(opts.out);
  mkdirSync(dirname(out), { recursive: true });
  process.stdout.write(`Encoding ${frames.length} frames… `);
  writeFileSync(out, encodeGif(frames));
  const seconds = frames.length ? frames.at(-1).time - frames[0].time + 2.5 : 0;
  console.log(`done\nSaved ${relative(process.cwd(), out)} (${(statSync(out).size / 1024 / 1024).toFixed(1)} MB, ${seconds.toFixed(0)} s)`);

  if (opts["frames-dir"]) {
    mkdirSync(opts["frames-dir"], { recursive: true });
    const step = Math.max(1, Math.floor(frames.length / 12));
    frames
      .filter((_, i) => i % step === 0 || i === frames.length - 1)
      .forEach((f, i) => writeFileSync(join(opts["frames-dir"], `frame-${String(i).padStart(2, "0")}.png`), Buffer.from(f.data, "base64")));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
