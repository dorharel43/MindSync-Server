// ai-guard + spending cap, against the fake Gemini only.
// node guard-test.js            -> runs every scenario in its own process
// node guard-test.js <scenario> -> one scenario (child)
const { spawnSync } = require('child_process');
const SRV = require('path').join(__dirname, '..', '..');
const FAKE = (process.env.FAKE_GEMINI || 'http://127.0.0.1:9999');
const post = (p, b) => fetch(FAKE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then(r => r.json());
const hits = () => fetch(FAKE + '/hits').then(r => r.json()).then(j => j.hits);

const scenario = process.argv[2];
if (scenario) {
  const ai = require(SRV + '/rpc/aiProvider');
  const context = require(SRV + '/rpc/context');
  const { create } = require(SRV + '/tools/ai-guard');
  const call = (opts = {}) => ai.generateText('hello', { noFallback: true, ...opts });
  const out = (o) => { console.log('RESULT ' + JSON.stringify(o)); };
  (async () => {
    const h0 = await hits();
    if (scenario === 'cap-plain') {
      // The provider alone: one request, no retry / other model, then paused.
      await post('/mode', { fault: 'cap' });
      let e1, e2;
      try { await call(); } catch (e) { e1 = e; }
      const after1 = await hits();
      try { await call(); } catch (e) { e2 = e; }
      out({ msg: e1 && e1.message, cap: !!(e1 && e1.spendingCap), first: after1 - h0, second: (await hits()) - after1, msg2: e2 && e2.message });
    } else if (scenario === 'cap-override') {
      // The owner's tools pin one model (modelOverride): the same.
      await post('/mode', { fault: 'cap' });
      let e1, e2;
      const run = (fn) => context.run({ token: '', userId: null, ip: null, events: new Set(), modelOverride: 'gemini-3.1-pro-preview' }, fn);
      try { await run(call); } catch (e) { e1 = e; }
      const after1 = await hits();
      try { await run(call); } catch (e) { e2 = e; }
      out({ cap: !!(e1 && e1.spendingCap), first: after1 - h0, second: (await hits()) - after1 });
    } else if (scenario === 'guard-cap' || scenario === 'guard-badkey') {
      await post('/mode', { fault: scenario === 'guard-cap' ? 'cap' : 'badkey' });
      const g = create({ label: scenario }).wrap(ai);
      const errs = [];
      for (let i = 0; i < 4; i++) { try { await call(); } catch (e) { errs.push(e.message.slice(0, 90)); } }
      out({ hits: (await hits()) - h0, stopped: g.stopped(), errs });
    } else if (scenario === 'guard-garbage') {
      // The call "works" but nothing usable comes back: the tool reports it.
      await post('/mode', { fault: 'garbage' });
      const g = create({ label: scenario }).wrap(ai);
      let items = 0;
      for (let i = 0; i < 6; i++) {
        try {
          const t = await call();
          items++;
          try { JSON.parse(t); g.itemOk(); } catch (e) { g.itemFailed("didn't return a usable exam"); }
        } catch (e) { if (g.isStop(e)) break; }
      }
      out({ hits: (await hits()) - h0, items, stopped: g.stopped() });
    } else if (scenario === 'guard-cutoff') {
      await post('/mode', { fault: 'cutoff' });
      const g = create({ label: scenario }).wrap(ai);
      for (let i = 0; i < 6; i++) { try { await call(); } catch (e) { if (g.isStop(e)) break; } }
      out({ hits: (await hits()) - h0, stats: g.stats() });
    } else if (scenario === 'guard-busy') {
      await post('/mode', { fault: 'busy' });
      const g = create({ label: scenario, maxBusy: 2 }).wrap(ai);
      for (let i = 0; i < 6; i++) { try { await call(); } catch (e) { if (g.isStop(e)) break; } }
      out({ hits: (await hits()) - h0, stopped: g.stopped() });
    } else if (scenario === 'guard-tokens') {
      await post('/mode', { fault: 'none' });
      const g = create({ label: scenario, maxTokens: 30 }).wrap(ai);
      let ok = 0;
      for (let i = 0; i < 6; i++) { try { await call(); ok++; } catch (e) { if (g.isStop(e)) break; } }
      out({ hits: (await hits()) - h0, ok, stats: g.stats() });
    } else if (scenario === 'guard-calls') {
      await post('/mode', { fault: 'none' });
      const g = create({ label: scenario, maxCalls: 3 }).wrap(ai);
      let ok = 0;
      for (let i = 0; i < 6; i++) { try { await call(); ok++; } catch (e) { if (g.isStop(e)) break; } }
      out({ hits: (await hits()) - h0, ok, stopped: g.stopped() });
    } else if (scenario === 'guard-ok-mixed') {
      // Failures that aren't in a row and aren't the same don't stop a run.
      const g = create({ label: scenario }).wrap(ai);
      const seq = ['none', 'garbage', 'none', 'cutoff', 'none', 'garbage', 'none'];
      let ok = 0;
      for (const f of seq) {
        await post('/mode', { fault: f });
        try { const t = await call(); try { JSON.parse(t); g.itemOk(); ok++; } catch (e) { g.itemFailed(`bad reply ${f}`); } } catch (e) { if (g.isStop(e)) break; }
      }
      out({ ok, stopped: g.stopped() });
    } else if (scenario === 'guard-items-in-a-row') {
      // Calls that "work" between failed items (different messages) don't reset the items' streak.
      await post('/mode', { fault: 'garbage' });
      const g = create({ label: scenario }).wrap(ai);
      let items = 0;
      for (let i = 0; i < 6; i++) {
        try { await call(); await call(); items++; g.itemFailed(`${["calc","dsa","logic","db","ds","x"][i]} failed`); } catch (e) { if (g.isStop(e)) break; }
      }
      out({ items, stopped: g.stopped() });
    } else if (scenario === 'approved-flag') {
      out({ approved: create({ label: scenario }).approved });
    } else if (scenario === 'double-count') {
      // A call fails, and the tool reports the same message for its item: one failure.
      const stub = { generateText: async () => { throw new Error('boom: the model said no'); } };
      const g = create({ label: scenario }).wrap(stub);
      let items = 0;
      for (let i = 0; i < 6; i++) {
        try { await stub.generateText(); } catch (e) {
          if (g.isStop(e)) break;
          items++;
          try { g.itemFailed(e.message); } catch (s) { break; }
        }
      }
      out({ items, stats: g.stats() });
    } else if (scenario === 'not-approved') {
      // A real key (no fake URL) without --approved: refused before the call.
      const g = create({ label: scenario }).wrap(ai);
      let err;
      try { await call(); } catch (e) { err = e; }
      out({ stop: !!(err && err.guardStop), msg: err && err.message, stopped: g.stopped() });
    } else if (scenario === 'not-approved-announce') {
      create({ label: scenario }).wrap(ai).announce();
      out({ reached: 'after announce (should not happen)' });
    }
    await post('/mode', { fault: 'none' });
  })().catch(e => { console.log('CRASH ' + e.stack); });
  return;
}

const base = { ...process.env, GEMINI_API_KEY: 'fake', GEMINI_BASE_URL: FAKE + '/v1beta/models', AI_RETRY_SCALE: '0.01', OPENROUTER_API_KEY: '' };
const results = [];
const check = (name, ok, detail) => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`);
function runOne(name, env = base) {
  const r = spawnSync(process.execPath, [__filename, name], { env, encoding: 'utf8', timeout: 120000 });
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('RESULT '));
  return { res: line ? JSON.parse(line.slice(7)) : null, out: r.stdout + r.stderr, code: r.status };
}
let r;
r = runOne('cap-plain');
check('cap: 1 request, no retry / fallback', r.res && r.res.cap && r.res.first === 1, JSON.stringify(r.res));
check('cap: paused - the next action asks nobody', r.res && r.res.second === 0 && /budget/.test(r.res.msg2 || ''), JSON.stringify(r.res && r.res.msg2));
check('cap: the message says the budget', r.res && /this month's AI budget is used up/.test(r.res.msg || ''), r.res && r.res.msg);
r = runOne('cap-override');
check('cap (one pinned model): 1 request, then paused', r.res && r.res.cap && r.res.first === 1 && r.res.second === 0, JSON.stringify(r.res));
r = runOne('guard-cap');
check('guard: cap stops the run after 1 request', r.res && r.res.hits === 1 && /spending cap/.test(r.res.stopped || ''), JSON.stringify(r.res));
check('guard: summary printed at exit', /ai-guard \(guard-cap\): 1 AI calls/.test(r.out) && /stopped: the key's monthly spending cap/.test(r.out));
r = runOne('guard-badkey');
check('guard: a rejected key stops after 1 request', r.res && r.res.hits === 1 && /rejected/.test(r.res.stopped || ''), JSON.stringify(r.res));
r = runOne('guard-garbage');
check('guard: an unusable reply 3 times -> stop', r.res && r.res.items === 3 && r.res.hits === 3 && /the same failure 3 times/.test(r.res.stopped || ''), JSON.stringify(r.res));
r = runOne('guard-cutoff');
check('guard: cut off (MAX_TOKENS) 3 times -> stop, tokens counted', r.res && r.res.hits === 3 && r.res.stats.cutOff === 3 && r.res.stats.tokens === 24000 && /cut off/.test(r.res.stats.stopped || ''), JSON.stringify(r.res));
r = runOne('guard-busy');
check('guard: busy twice in a row -> stop', r.res && /busy or rate-limited 2 times/.test(r.res.stopped || ''), JSON.stringify(r.res));
r = runOne('guard-tokens');
check('guard: --max-tokens 30 -> 2 calls (20 each), the 3rd refused', r.res && r.res.ok === 2 && r.res.hits === 2 && /tokens used/.test(r.res.stats.stopped || ''), JSON.stringify(r.res));
r = runOne('guard-calls');
check('guard: --max-calls 3', r.res && r.res.ok === 3 && r.res.hits === 3, JSON.stringify(r.res));
r = runOne('guard-items-in-a-row');
check('guard: 3 failed items in a row (calls between them "worked") -> stop', r.res && r.res.items === 3 && /3 failures in a row/.test(r.res.stopped || ''), JSON.stringify(r.res));
r = runOne('guard-ok-mixed');
check('guard: scattered different failures don\'t stop', r.res && r.res.ok === 4 && !r.res.stopped, JSON.stringify(r.res));
const real = { ...base, GEMINI_BASE_URL: '', AI_GUARD_APPROVED: '' };
delete real.GEMINI_BASE_URL;
r = runOne('not-approved', real);
check('guard: real key without approval - refused before any request', r.res && r.res.stop && /not approved/.test(r.res.msg), JSON.stringify(r.res));
r = runOne('not-approved-announce', real);
check('guard: announce() exits (2) before anything runs', r.code === 2 && !r.res && /Not approved/.test(r.out), `code ${r.code}`);
r = runOne('double-count');
check('guard: a failed call + the same item failure count once (stop at the 3rd)', r.res && r.res.items === 2 && r.res.stats.failures === 3 && /the same failure 3 times/.test(r.res.stats.stopped || ''), JSON.stringify(r.res));
const desk = { ...real, MINDSYNC_TEST_GEMINI_URL: FAKE + '/v1beta/models' };
r = runOne('not-approved', desk);
check('guard: the desktop test URL doesn\'t count as fake for the server tools', r.res && r.res.stop && /not approved/.test(r.res.msg), JSON.stringify(r.res));
r = runOne('not-approved', { ...base, OPENROUTER_API_KEY: 'x' });
check('guard: fake Gemini but an OpenRouter key -> needs approval', r.res && r.res.stop && /not approved/.test(r.res.msg), JSON.stringify(r.res));
r = runOne('not-approved', { ...base, GEMINI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/models' });
check('guard: GEMINI_BASE_URL pointing at Google is not fake', r.res && r.res.stop && /not approved/.test(r.res.msg), JSON.stringify(r.res));
{
  const rr = spawnSync(process.execPath, [__filename, 'approved-flag', '--approved', 'gemini-3.8-flash'], { env: real, encoding: 'utf8' });
  const line = (rr.stdout || '').split('\n').find(l => l.startsWith('RESULT '));
  check('guard: --approved followed by a positional argument still approves', line && JSON.parse(line.slice(7)).approved === true, line);
}
console.log(results.join('\n'));
console.log(`${results.filter(x => x.startsWith('PASS')).length}/${results.length}`);
