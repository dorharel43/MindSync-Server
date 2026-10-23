// The AI is Gemini only (23/10): with no key on the server, a clear message -
// not an attempt to reach a local model (Ollama, removed) on localhost.
process.env.GEMINI_API_KEY = '';
process.env.OPENROUTER_API_KEY = '';
const ai = require('../../rpc/aiProvider.js');
const results = []; const check = (n, ok, d = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${n}${d !== '' ? ' - ' + JSON.stringify(d) : ''}`);
const realFetch = global.fetch;
let reached = [];
global.fetch = async (url) => { reached.push(String(url)); throw new Error('no network in this test'); };
(async () => {
  check('no key: the provider is "none"', ai.resolveProvider() === 'none', ai.resolveProvider());
  let err = null;
  try { await ai.generateText('hello', { maxTokens: 10 }); } catch (e) { err = e; }
  check('no key: a clear error, and nothing is called (no localhost model)', err && err.message === 'No AI key is configured on the server.' && reached.length === 0, [err && err.message, reached]);
  process.env.GEMINI_API_KEY = 'test-key';
  check('a key: the cloud path', ai.resolveProvider() === 'gemini' && ai.supportsVision() === true);
  global.fetch = realFetch;
  console.log(results.join('\n'));
  console.log(`${results.filter(r => r.startsWith('PASS')).length}/${results.length}`);
})();
