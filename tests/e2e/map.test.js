// "What repeats in the exam" through the real server (fake Gemini).
// Usage: node tests/e2e/map.test.js http://127.0.0.1:5070
const base = process.argv[2] || process.env.TEST_BASE || 'http://127.0.0.1:5070';
const FAKE = (process.env.FAKE_GEMINI || 'http://127.0.0.1:9999');
const j = async (path, opts = {}, token) => {
  const res = await fetch(base + path, { ...opts, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  const t = await res.text();
  let body; try { body = JSON.parse(t); } catch (e) { body = { text: t.slice(0, 200) }; }
  return { status: res.status, body };
};
const rpc = async (token, ch, ...args) => { const r = await j(`/api/rpc/${ch}`, { method: 'POST', body: JSON.stringify({ args }) }, token); return r.body.result !== undefined ? r.body.result : r.body; };
const fake = (m) => fetch(FAKE + '/mode', { method: 'POST', body: JSON.stringify(m) });
const linkCalls = async () => (await (await fetch(FAKE + '/link-calls')).json()).linkCalls;
const wait = async (token, jobId) => { for (let i = 0; i < 120; i++) { const s = await rpc(token, 'full-exam-job', jobId); if (s.status !== 'running') return s; await new Promise(r => setTimeout(r, 400)); } return { status: 'timeout' }; };
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`);
const C = 'חדו"א 2';
let n = 0;
async function newUser(tag) {
  const { body } = await j('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: `map${tag}${Date.now()}@example.com`, password: 'password123', name: 'בודק' }) });
  return body.token;
}
async function deck(token, list) {
  const { body } = await j('/api/study/bulk', { method: 'POST', body: JSON.stringify({ items: list.map(([q, tag]) => ({ question: q, answer: 'x', category: C, skillTag: tag })) }) }, token);
  return (Array.isArray(body) ? body : body.items || []).map(i => i._id || i.id);
}
const answer = (token, id, right) => j(`/api/study/${id}/review`, { method: 'POST', body: JSON.stringify({ confidence: 'think_so', outcome: right ? 'got_it' : 'missed', clientId: `m${++n}` }) }, token);

(async () => {
  await fake({ recurring: 'calc', link: 'ok', fault: 'none' });
  const token = await newUser('a');
  await j('/api/folders', { method: 'POST', body: JSON.stringify({ name: C }) }, token);
  await j('/api/files', { method: 'POST', body: JSON.stringify({ name: 'הרצאה 1', content: 'טורים וחזקות', folder: C }) }, token);
  await j('/api/files', { method: 'POST', body: JSON.stringify({ name: 'מבחן 2024 מועד א', content: 'שאלה 1: רדיוס התכנסות. שאלה 2: אינטגרל לא אמיתי.', folder: C }) }, token);
  let m = await rpc(token, 'exam-map', C);
  check('one past exam: no profile, 1 past exam', m.profile === null && m.pastExams === 1 && m.topics.length === 0, JSON.stringify({ p: m.profile, n: m.pastExams }));
  let start = await rpc(token, 'exam-map-analyze', C);
  let out = await wait(token, start.jobId);
  check('analyzing with one past exam: refused, says why', out.status === 'error' && /at least 2 past exams/.test(out.error), JSON.stringify(out).slice(0, 160));

  await j('/api/files', { method: 'POST', body: JSON.stringify({ name: 'מבחן 2023 מועד ב', content: 'שאלה 1: רדיוס. שאלה 2: גבול.', folder: C }) }, token);
  const r1 = await deck(token, [['ר1', 'רדיוס התכנסות של טורי חזקות'], ['ר2', 'רדיוס התכנסות של טורי חזקות'], ['ר3', 'רדיוס התכנסות של טורי חזקות'], ['א1', 'אינטגרל לא אמיתי'], ['א2', 'אינטגרל לא אמיתי'], ['ג1', 'גבולות ולופיטל'], ['ג2', 'גבולות ולופיטל'], ['נ1', 'נגזרות']]);
  // powers: 1 of 4 right; limits: 3 of 3 right; integrals: never.
  await answer(token, r1[0], false); await answer(token, r1[1], false); await answer(token, r1[2], true); await answer(token, r1[0], false);
  await answer(token, r1[5], true); await answer(token, r1[6], true); await answer(token, r1[5], true);
  m = await rpc(token, 'exam-map', C);
  check('two past exams: still no profile, 2 past exams, cloud', m.profile === null && m.pastExams === 2 && m.cloud === true, JSON.stringify({ n: m.pastExams, cloud: m.cloud }));

  const l0 = await linkCalls();
  start = await rpc(token, 'exam-map-analyze', C);
  out = await wait(token, start.jobId);
  check('analyzed', out.status === 'done' && out.result && out.result.profile, JSON.stringify(out).slice(0, 160));
  check('one link call', (await linkCalls()) - l0 === 1, String((await linkCalls()) - l0));
  m = await rpc(token, 'exam-map', C);
  const byName = Object.fromEntries(m.topics.map(t => [t.topic.split(':')[0].split(' ')[0] + (t.topic.includes('גבולות') ? 'ג' : ''), t]));
  const pow = m.topics.find(t => /חזקות/.test(t.topic));
  const integ = m.topics.find(t => /אינטגרלים/.test(t.topic));
  const lim = m.topics.find(t => /גבולות/.test(t.topic));
  const ext = m.topics.find(t => /קיצון/.test(t.topic));
  check('4 repeating topics, from 2 past exams', m.topics.length === 4 && m.profile.pastExams.length === 2, JSON.stringify(m.profile.pastExams));
  check('power series: linked, you know 25% (4 answers)', pow && pow.skills.includes('רדיוס התכנסות של טורי חזקות') && pow.accuracy === 25 && pow.answered === 4 && pow.count === 2 && pow.of === 2, JSON.stringify(pow));
  check('limits: you know 100% (3 answers)', lim && lim.accuracy === 100 && lim.answered === 3, JSON.stringify(lim));
  check('improper integrals: 2 questions, not practiced', integ && integ.items === 2 && integ.answered === 0 && integ.accuracy === null, JSON.stringify(integ));
  check('extrema: no questions', ext && ext.items === 0, JSON.stringify(ext));
  // (a topic in every exam with no questions at all is the biggest gap - first; one known 100% last)
  check('order: worth most first (no-question topic, then power series), known last', m.topics[0] === ext && m.topics[1] === pow && m.topics[m.topics.length - 1].accuracy === 100, m.topics.map(t => t.topic.slice(0, 12)).join(' | '));
  check('nothing to link now', m.needsLink === false, String(m.needsLink));

  // Home's line and the daily question use the best topic.
  const stats = (await j('/api/study/stats', {}, token)).body;
  const subj = (stats.subjects || []).find(s => s.category === C);
  check('stats: topTopic = power series, with its skills', subj && subj.topTopic && /חזקות/.test(subj.topTopic.topic) && subj.topTopic.skills.length === 1, JSON.stringify(subj && subj.topTopic));
  const dq = await rpc(token, 'daily-question');
  // (the daily question writes a new question - so it takes the topic with none)
  check('daily question: the topic with no questions, with "comes up in 2 of 2"', dq.target && /קיצון/.test(dq.target.topic) && dq.target.repeats && dq.target.repeats.count === 2 && dq.target.repeats.of === 2, JSON.stringify(dq.target));

  // 5 new skills -> a new link is due; linking again (one call).
  await deck(token, [['n1', 'מבחן המנה'], ['n2', 'מבחן השורש'], ['n3', 'טור הנדסי'], ['n4', 'אינטגרל מסוים'], ['n5', 'כלל השרשרת']]);
  m = await rpc(token, 'exam-map', C);
  check('5 new skills: link due', m.needsLink === true, String(m.needsLink));
  const l1 = await linkCalls();
  m = await rpc(token, 'exam-map-link', C);
  check('linked again (one call), nothing due', (await linkCalls()) - l1 === 1 && m.needsLink === false, `${(await linkCalls()) - l1} ${m.needsLink}`);
  // 4 more: not yet.
  await deck(token, [['x1', 'סכום טור 1'], ['x2', 'סכום טור 2'], ['x3', 'סכום טור 3'], ['x4', 'סכום טור 4']]);
  m = await rpc(token, 'exam-map', C);
  check('4 new skills: no link yet', m.needsLink === false, String(m.needsLink));

  // The server keeps only real topics and real skills.
  let r = await j('/api/exam-map/links', { method: 'PUT', body: JSON.stringify({ course: C, links: [{ topic: 'נושא שלא קיים', skills: ['נגזרות'] }, { topic: pow.topic, skills: ['מיומנות מומצאת', 'נגזרות'] }], skills: ['נגזרות'] }) }, token);
  const powNow = (r.body.topics || []).find(t => /חזקות/.test(t.topic));
  // (its earlier skill, not given to this call, keeps its link)
  check('links: an unknown topic dropped, an unknown skill dropped', r.status === 200 && powNow && powNow.skills.includes('נגזרות') && !powNow.skills.includes('מיומנות מומצאת') && r.body.topics.length === 4, JSON.stringify(powNow && powNow.skills));
  r = await j('/api/exam-map/profile', { method: 'PUT', body: JSON.stringify({ course: C, recurring: [{ topic: 'טוב', count: 3, of: 5 }, { topic: 'יותר מהמבחנים', count: 9, of: 5 }, { topic: 'פעם אחת', count: 1, of: 5 }, { topic: '', count: 2, of: 2 }], pastExams: ['a', 'b'] }) }, token);
  m = await rpc(token, 'exam-map', C);
  check('profile: only valid topics kept (count 2+, count <= of)', r.status === 200 && m.topics.length === 1 && m.topics[0].topic === 'טוב', JSON.stringify(m.topics.map(t => t.topic)));
  // An AI that counts more exams than it was given: capped at the files.
  r = await j('/api/exam-map/profile', { method: 'PUT', body: JSON.stringify({ course: C, recurring: [{ topic: 'מנופח', count: 7, of: 8 }], pastExams: ['a', 'b', 'c'] }) }, token);
  m = await rpc(token, 'exam-map', C);
  check('"7 of 8" from 3 files is capped to "3 of 3"', m.topics[0] && m.topics[0].count === 3 && m.topics[0].of === 3, JSON.stringify(m.topics[0]));
  // A full exam's analysis of fewer files never replaces it; nothing valid never wipes it.
  r = await j('/api/exam-map/profile', { method: 'PUT', body: JSON.stringify({ course: C, recurring: [{ topic: 'משני קבצים', count: 2, of: 2 }], pastExams: ['a', 'b'] }) }, token);
  m = await rpc(token, 'exam-map', C);
  check('fewer files (no replace): the analysis of 3 stays', r.body.success === false && m.topics[0].topic === 'מנופח', JSON.stringify({ r: r.body, t: m.topics.map(t => t.topic) }));
  r = await j('/api/exam-map/profile', { method: 'PUT', body: JSON.stringify({ course: C, recurring: [{ topic: 'פעם אחת', count: 1, of: 5 }], pastExams: ['a', 'b', 'c', 'd'], replace: true }) }, token);
  m = await rpc(token, 'exam-map', C);
  check('nothing valid (even with replace): the analysis stays', r.body.success === false && m.topics[0].topic === 'מנופח', JSON.stringify({ r: r.body, t: m.topics.map(t => t.topic) }));
  r = await j('/api/exam-map/profile', { method: 'PUT', body: JSON.stringify({ course: C, recurring: [{ topic: 'משני קבצים', count: 2, of: 2 }], pastExams: ['a', 'b'], replace: true }) }, token);
  m = await rpc(token, 'exam-map', C);
  check('replace (the Analyze button): replaces even with fewer files', r.body.success === true && m.topics[0].topic === 'משני קבצים', JSON.stringify(m.topics.map(t => t.topic)));
  r = await j('/api/exam-map?course=', {}, token);
  check('no course: 400', r.status === 400, String(r.status));
  r = await j(`/api/exam-map?course=${encodeURIComponent(C)}`);
  check('no token: 401', r.status === 401, String(r.status));

  // No repeating topics: an error, nothing saved.
  const tokenB = await newUser('b');
  await j('/api/folders', { method: 'POST', body: JSON.stringify({ name: C }) }, tokenB);
  for (const f of ['מבחן 1', 'מבחן 2']) await j('/api/files', { method: 'POST', body: JSON.stringify({ name: f, content: 'שאלה', folder: C }) }, tokenB);
  await fake({ recurring: 'none' });
  start = await rpc(tokenB, 'exam-map-analyze', C);
  out = await wait(tokenB, start.jobId);
  m = await rpc(tokenB, 'exam-map', C);
  check('nothing repeats: an error, no profile', out.status === 'error' && /No topic repeats/.test(out.error) && m.profile === null, JSON.stringify(out).slice(0, 120));
  // A link that fails: the map still shows, link still due.
  await fake({ recurring: 'calc', link: 'fail' });
  await deck(tokenB, [['q', 'רדיוס של טורי חזקות']]);
  start = await rpc(tokenB, 'exam-map-analyze', C);
  out = await wait(tokenB, start.jobId);
  m = await rpc(tokenB, 'exam-map', C);
  check('link fails: the analysis still succeeds, the link is still due', out.status === 'done' && m.profile && m.topics.length === 4 && m.needsLink === true, JSON.stringify({ s: out.status, e: out.error, need: m.needsLink }));
  check('the same files: nothing to analyze again', m.changed === false, String(m.changed));
  await j('/api/files', { method: 'POST', body: JSON.stringify({ name: 'מבחן 3', content: 'שאלה', folder: C }) }, tokenB);
  m = await rpc(tokenB, 'exam-map', C);
  check('a new past exam: analyze again offered', m.changed === true && m.pastExams === 3, `${m.changed} ${m.pastExams}`);
  await fake({ link: 'ok' });

  // A full exam built on past exams saves the profile on the way (no extra call).
  const tokenC = await newUser('c');
  await j('/api/folders', { method: 'POST', body: JSON.stringify({ name: C }) }, tokenC);
  await j('/api/files', { method: 'POST', body: JSON.stringify({ name: 'הרצאה', content: 'טורים', folder: C }) }, tokenC);
  const pf = [];
  for (const f of ['מבחן 2022', 'מבחן 2023']) pf.push((await j('/api/files', { method: 'POST', body: JSON.stringify({ name: f, content: 'שאלה 1: נכון או לא נכון. שאלה 2: הוכיחו.', folder: C }) }, tokenC)).body);
  const bj = await rpc(tokenC, 'full-exam-build', { course: C, pastIds: pf.map(f => String(f._id || f.id)) });
  const built = await wait(tokenC, bj.jobId);
  m = await rpc(tokenC, 'exam-map', C);
  check('a full exam built on past exams: the profile is saved too', built.status === 'done' && m.profile && m.topics.length === 4, JSON.stringify({ b: built.status, p: !!m.profile, e: built.error }).slice(0, 160));

  // A big course (205 skills, over one call's 200): new skills go first, links
  // merge - two calls, then nothing due (no call on every visit).
  const tokenD = await newUser('d');
  await j('/api/folders', { method: 'POST', body: JSON.stringify({ name: C }) }, tokenD);
  await j('/api/exam-map/profile', { method: 'PUT', body: JSON.stringify({ course: C, recurring: [{ topic: 'טורי חזקות', count: 2, of: 2 }, { topic: 'גבולות', count: 2, of: 2 }], pastExams: ['a', 'b'] }) }, tokenD);
  await deck(tokenD, Array.from({ length: 150 }, (_, i) => [`f${i}`, `פילר ${i}`]));
  await deck(tokenD, Array.from({ length: 55 }, (_, i) => [`g${i}`, `פילר ${150 + i}`]));
  const d0 = await linkCalls();
  m = await rpc(tokenD, 'exam-map-link', C);
  check('205 skills: first call, 5 left - still due', (await linkCalls()) - d0 === 1 && m.needsLink === true, `${(await linkCalls()) - d0} ${m.needsLink}`);
  m = await rpc(tokenD, 'exam-map-link', C);
  const m2 = await rpc(tokenD, 'exam-map', C);
  check('second call takes the 5 new ones: nothing due after it', (await linkCalls()) - d0 === 2 && m.needsLink === false && m2.needsLink === false, `${(await linkCalls()) - d0} ${m.needsLink} ${m2.needsLink}`);
  // A link of a skill the call wasn't given is kept; one it was given is replaced.
  await deck(tokenD, [['p1', 'חזקות א'], ['p2', 'חזקות ב']]);
  await j('/api/exam-map/links', { method: 'PUT', body: JSON.stringify({ course: C, links: [{ topic: 'טורי חזקות', skills: ['חזקות א'] }], skills: ['חזקות א'] }) }, tokenD);
  r = await j('/api/exam-map/links', { method: 'PUT', body: JSON.stringify({ course: C, links: [{ topic: 'טורי חזקות', skills: ['חזקות ב'] }, { topic: 'גבולות', skills: [] }], skills: ['חזקות ב'] }) }, tokenD);
  let tp = r.body.topics.find(t => t.topic === 'טורי חזקות');
  check('links merge: the earlier skill keeps its link', tp && tp.skills.includes('חזקות א') && tp.skills.includes('חזקות ב'), JSON.stringify(tp && tp.skills));
  r = await j('/api/exam-map/links', { method: 'PUT', body: JSON.stringify({ course: C, links: [{ topic: 'גבולות', skills: ['חזקות א'] }], skills: ['חזקות א'] }) }, tokenD);
  tp = r.body.topics.find(t => t.topic === 'טורי חזקות');
  check('a skill given again is re-linked (moved)', tp && !tp.skills.includes('חזקות א') && r.body.topics.find(t => t.topic === 'גבולות').skills.includes('חזקות א'), JSON.stringify(r.body.topics.map(t => t.skills)));

  // A link made for topics that a new analysis has replaced since: refused.
  r = await j('/api/exam-map/links', { method: 'PUT', body: JSON.stringify({ course: C, topics: ['טורי חזקות', 'נושא ישן'], links: [{ topic: 'טורי חזקות', skills: ['חזקות א'] }], skills: ['חזקות א'] }) }, tokenD);
  check('a link for old topics: 409', r.status === 409, String(r.status));
  // A topic the AI named twice: kept once, and its links aren't refused.
  const tokenE = await newUser('e');
  await j('/api/folders', { method: 'POST', body: JSON.stringify({ name: C }) }, tokenE);
  await deck(tokenE, [['e1', 'טורי חזקות']]);
  r = await j('/api/exam-map/profile', { method: 'PUT', body: JSON.stringify({ course: C, recurring: [{ topic: 'טורי חזקות', count: 2, of: 2 }, { topic: 'טורי חזקות', count: 2, of: 2 }, { topic: 'גבולות', count: 2, of: 2 }], pastExams: ['a', 'b'] }) }, tokenE);
  r = await j('/api/exam-map/links', { method: 'PUT', body: JSON.stringify({ course: C, topics: ['טורי חזקות', 'גבולות'], links: [{ topic: 'טורי חזקות', skills: ['טורי חזקות'] }], skills: ['טורי חזקות'] }) }, tokenE);
  check('a topic named twice: kept once, its link saved', r.status === 200 && r.body.topics.length === 2, `${r.status} ${(r.body.topics || []).length}`);
  // The same past exam uploaded twice: one name - no endless "analyze again".
  await fake({ recurring: 'calc', link: 'ok' });
  for (const f of ['מבחן 2021', 'מבחן 2022', 'מבחן 2022']) await j('/api/files', { method: 'POST', body: JSON.stringify({ name: f, content: 'שאלה', folder: C }) }, tokenE);
  start = await rpc(tokenE, 'exam-map-analyze', C);
  out = await wait(tokenE, start.jobId);
  m = await rpc(tokenE, 'exam-map', C);
  check('a duplicate file name: nothing to analyze again', out.status === 'done' && m.changed === false, `${out.status} ${out.error} ${m.changed}`);
  // A new analysis with a new topic: all 207 skills are offered again (two calls), then nothing due.
  await j('/api/exam-map/profile', { method: 'PUT', body: JSON.stringify({ course: C, recurring: [{ topic: 'טורי חזקות', count: 2, of: 2 }, { topic: 'נושא חדש', count: 2, of: 2 }], pastExams: ['a', 'b'], replace: true }) }, tokenD);
  const d1 = await linkCalls();
  m = await rpc(tokenD, 'exam-map', C);
  const firstSkills = m.skills.length;
  await rpc(tokenD, 'exam-map-link', C);
  m = await rpc(tokenD, 'exam-map', C);
  check('new topic: due, 200 skills, then the other 7 still due', firstSkills === 200 && m.needsLink === true && m.skills.length === 200, `${firstSkills} ${m.needsLink}`);
  await rpc(tokenD, 'exam-map-link', C);
  m = await rpc(tokenD, 'exam-map', C);
  check('second round: nothing due (2 calls)', m.needsLink === false && (await linkCalls()) - d1 === 2, `${m.needsLink} ${(await linkCalls()) - d1}`);
  tp = m.topics.find(t => t.topic === 'טורי חזקות');
  check('old topic kept its links through the rounds', tp && tp.skills.includes('חזקות ב'), JSON.stringify(tp && tp.skills));

  // The new shape (7/10): the AI lists which numbered files ask a topic; the app counts.
  const tokenF = await newUser('f');
  await j('/api/folders', { method: 'POST', body: JSON.stringify({ name: C }) }, tokenF);
  for (const f of ['מבחן 2025 א', 'מבחן 2024 ב', 'מבחן 2023 א']) await j('/api/files', { method: 'POST', body: JSON.stringify({ name: f, content: 'שאלה 1: חשבו נגזרת.', folder: C }) }, tokenF);
  await deck(tokenF, [['d1', 'כללי גזירה']]);
  await fake({ recurring: 'list', link: 'ok', listDup: true, notThisCourse: [] });
  start = await rpc(tokenF, 'exam-map-analyze', C);
  out = await wait(tokenF, start.jobId);
  m = await rpc(tokenF, 'exam-map', C);
  let der = m.topics.find(t => /נגזרת/.test(t.topic));
  check('listed files: counted by the app (a duplicate and 99 ignored), names kept', out.status === 'done' && der && der.count === 3 && der.of === 3 && der.exams.length === 3 && der.exams[0] === 'מבחן 2025 א', JSON.stringify(der && { c: der.count, of: der.of, e: der.exams }));
  check('a topic in one exam: not shown', !m.topics.find(t => t.topic === 'נושא במבחן אחד') && m.topics.length === 2, m.topics.map(t => t.topic).join(' | '));
  check('files given to the AI by number, newest year first', /The files, numbered:\n1\. מבחן 2025 א - the text below under "=== מבחן 2025 א ==="\n2\. מבחן 2024 ב - [^\n]+\n3\. מבחן 2023 א - /.test(await (await fetch(FAKE + '/last-prompt')).text()), '');
  // A file the AI marks as another course's: out of "of" and of every count.
  await fake({ listDup: false, notThisCourse: [3] });
  start = await rpc(tokenF, 'exam-map-analyze', C);
  out = await wait(tokenF, start.jobId);
  m = await rpc(tokenF, 'exam-map', C);
  der = m.topics.find(t => /נגזרת/.test(t.topic));
  check('another course file: "2 of 2", without it', der && der.count === 2 && der.of === 2 && !der.exams.includes('מבחן 2023 א'), JSON.stringify(der && { c: der.count, of: der.of, e: der.exams }));
  // The server keeps only names of analysed files.
  r = await j('/api/exam-map/profile', { method: 'PUT', body: JSON.stringify({ course: C, recurring: [{ topic: 'מומצא', count: 2, of: 2, exams: ['a', 'b', 'לא קיים'] }], pastExams: ['a', 'b'], replace: true }) }, tokenF);
  m = await rpc(tokenF, 'exam-map', C);
  check('server: an unknown file name dropped, count from the names', m.topics[0] && m.topics[0].count === 2 && m.topics[0].exams.join() === 'a,b', JSON.stringify(m.topics[0]));
  await fake({ recurring: 'calc', notThisCourse: [] });

  // Reset all data / delete the account: no profile left.
  await j('/api/admin/hard-reset', { method: 'POST' }, tokenC);
  r = await j(`/api/exam-map?course=${encodeURIComponent(C)}`, {}, tokenC);
  check('after "reset all data": no profile', r.body.profile === null, JSON.stringify(r.body.profile));
  const mongoose = require('mongoose');
  await mongoose.connect('mongodb://127.0.0.1:27017/' + (process.env.TEST_DB || 'mindsync_tt2'));
  const me = (await j('/api/auth/me', {}, token)).body;
  await j('/api/auth/me', { method: 'DELETE', body: JSON.stringify({ password: 'password123' }) }, token);
  const left = await mongoose.connection.collection('courseprofiles').countDocuments({ userId: new mongoose.Types.ObjectId(String(me.id)) });
  check('account deleted: no profile left', left === 0, String(left));
  await mongoose.disconnect();

  console.log(results.join('\n'));
  console.log(`${results.filter(x => x.startsWith('PASS')).length}/${results.length}`);
  await fake({ recurring: 'base', link: 'ok' });
})().catch(e => { console.error('E2E FAIL', e); console.log(results.join('\n')); process.exit(1); });
