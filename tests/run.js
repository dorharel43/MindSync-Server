// Runs every test against a real server and a fake Gemini - no real AI key,
// nothing paid. Needs a MongoDB (TEST_MONGO, default mongodb://127.0.0.1:27017).
// Each run uses a fresh database, dropped at the end.
//
//   npm test                    -> everything
//   npm test -- map daily       -> only the files whose name has "map" or "daily"
//
// A test passes when it exits 0, prints no "FAIL" line, and - when it prints
// a final "N/M" - N equals M.
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const MONGO = (process.env.TEST_MONGO || 'mongodb://127.0.0.1:27017').replace(/\/$/, '');
const DB = `mindsync_test_${Date.now()}`;
const FAKE_PORT = Number(process.env.FAKE_PORT || 9999);
const PORT = Number(process.env.TEST_PORT || 5070);
const BASE = `http://127.0.0.1:${PORT}`;
const FAKE = `http://127.0.0.1:${FAKE_PORT}`;
const only = process.argv.slice(2);

const files = ['unit', 'e2e'].flatMap(dir => fs.readdirSync(path.join(__dirname, dir))
  .filter(f => f.endsWith('.test.js')).sort().map(f => path.join(__dirname, dir, f)))
  .filter(f => !only.length || only.some(o => path.basename(f).includes(o)));

const children = [];
function start(name, args, env) {
  const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  p.stdout.on('data', d => { log += d; });
  p.stderr.on('data', d => { log += d; });
  p.log = () => log;
  children.push(p);
  return p;
}
function stopAll() { for (const p of children) { try { p.kill(); } catch (e) { /* gone */ } } }
process.on('exit', stopAll);
process.on('SIGINT', () => { stopAll(); process.exit(130); });

async function waitFor(url, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch (e) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

function verdict(code, out) {
  if (code !== 0) return `exit code ${code}`;
  if (/^(FAIL|E2E FAIL|UI FAIL|CRASH)\b/m.test(out)) return 'a FAIL line';
  const counts = [...out.matchAll(/^(\d+)\/(\d+)\s*$/gm)];
  const last = counts[counts.length - 1];
  if (last && last[1] !== last[2]) return `${last[1]}/${last[2]}`;
  // (a test that ran no check at all - e.g. took a wrong argument - is not a pass)
  if (!last && !/^PASS\b|passed|^ok\b/im.test(out)) return 'no check ran';
  return null;
}

(async () => {
  const env = {
    PORT: String(PORT),
    MONGO_URI: `${MONGO}/${DB}`, MONGODB_URI: `${MONGO}/${DB}`,
    GEMINI_API_KEY: 'fake', GEMINI_BASE_URL: `${FAKE}/v1beta/models`,
    OPENROUTER_API_KEY: '', JWT_SECRET: 'test_secret_test_secret_test_secret_1234',
    AI_RETRY_SCALE: '0.01',
    FAKE_GEMINI: FAKE, TEST_BASE: BASE, TEST_DB: DB, TEST_MONGO: MONGO
  };
  const fake = start('fake gemini', ['tests/fake-gemini.js'], { ...env, PORT: String(FAKE_PORT) });
  const server = start('server', ['server.js'], env);
  if (!(await waitFor(`${FAKE}/hits`, 15000))) { console.error('The fake Gemini did not start:\n' + fake.log()); process.exit(1); }
  if (!(await waitFor(`${BASE}/`, 60000))) { console.error('The server did not start:\n' + server.log()); process.exit(1); }

  const failed = [];
  for (const file of files) {
    const name = path.relative(ROOT, file);
    const t0 = Date.now();
    // (only the e2e tests take the server's address - a unit test may read argv as its own)
    const r = spawnSync(process.execPath, file.includes(`${path.sep}e2e${path.sep}`) ? [file, BASE] : [file], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
    const out = (r.stdout || '') + (r.stderr || '');
    const bad = r.error ? r.error.message : verdict(r.status, out);
    const counts = [...out.matchAll(/^(\d+)\/(\d+)\s*$/gm)].pop();
    console.log(`${bad ? 'FAIL' : 'ok  '}  ${name}${counts ? `  ${counts[1]}/${counts[2]}` : ''}  (${Math.round((Date.now() - t0) / 1000)}s)${bad ? `  - ${bad}` : ''}`);
    if (bad) {
      failed.push(name);
      console.log(out.split('\n').filter(l => /FAIL|Error|CRASH/.test(l)).slice(0, 15).map(l => '      ' + l.slice(0, 300)).join('\n'));
    }
  }

  // The test database goes away.
  try {
    const mongoose = require('mongoose');
    await mongoose.connect(`${MONGO}/${DB}`);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  } catch (e) { console.warn('could not drop the test database:', e.message); }

  console.log(failed.length ? `\n${failed.length} of ${files.length} failed: ${failed.join(', ')}` : `\nall ${files.length} passed`);
  stopAll();
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); stopAll(); process.exit(1); });
