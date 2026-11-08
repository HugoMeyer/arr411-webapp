'use strict';
// Test helper: a throw-away headless Chrome with DevTools on a free port. Tests that need it skip themselves when no
// browser is installed (set CHROME_BIN to point at one).
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const local = process.env.LOCALAPPDATA;
  const candidates = [
    process.env.CHROME_BIN,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);
  return (
    candidates.find((p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    }) || null
  );
}

// Resolves to { url, stop() } or null when no browser is available.
async function launchChrome() {
  const bin = findChrome();
  if (!bin) return null;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'arr411-chrome-'));
  const child = spawn(
    bin,
    [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--disable-component-update', '--disable-sync', '--password-store=basic', '--no-sandbox',
      '--disable-gpu', '--window-size=1280,800', 'about:blank'
    ],
    { stdio: 'ignore' }
  );
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  const cleanup = async () => {
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(profile, { recursive: true, force: true });
        return;
      } catch {
        await sleep(200);
      }
    }
  };
  const stop = async () => {
    if (!exited) {
      child.kill();
      for (let i = 0; i < 50 && !exited; i++) await sleep(100);
    }
    await sleep(200);
    await cleanup();
  };
  process.on('exit', () => {
    try {
      child.kill();
    } catch {
      // already gone
    }
  });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100; i++) {
    if (exited) break;
    try {
      const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
      if (port > 0) return { url: `http://127.0.0.1:${port}`, stop, kill: () => child.kill(), exited: () => exited };
    } catch {
      // not written yet
    }
    await sleep(100);
  }
  await stop();
  return null;
}

module.exports = { launchChrome, findChrome, sleep };
