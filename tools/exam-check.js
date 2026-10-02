#!/usr/bin/env node
// The owner's exam quality check (step 1): the full exam's REAL stages
// (rpc/handlers.js -> examStages, generated from the app's main.js) run on
// past exams whose answers are known (a private "gold" set - never in this
// repo), against the real Gemini.
//
//   GEMINI_API_KEY=... node tools/exam-check.js --set ../mindsync-quality-data \
//       --measure grading,check,solve,structure [--model gemini-3.8-flash] \
//       [--repeat 3] [--max-calls 150] [--gap-ms 4000] [--only calc2] \
//       [--holdout] [--out report.json] [--resume report.json] [--variants gold-rubric]
//
// Measures (see PLAN.md in the gold set):
//   grading    A1: student answers with expected point ranges, graded with a
//              hand-written marking scheme; A2: the same with the scheme the
//              app writes itself (solveExamParts)
//   check      B1: the check stage on real exams - with the right key (false
//              alarms) and with planted wrong keys (caught or not)
//   solve      B2: the app's answer key for real questions vs the known
//              answers, before and after its own check
//   structure  C: a blueprint from all but one past exam -> a new exam ->
//              compared with the exam left out
//
// Nothing is saved anywhere and no user's allowance is touched. A run stops
// at --max-calls AI calls (the free tier's limits), waits --gap-ms between
// calls, and waits out "slow down" (429) and "busy" (503) up to 5 times.
const fs = require('fs');
const path = require('path');

// ---- arguments -------------------------------------------------------------
const args = {};
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a.startsWith('--')) continue;
    const next = process.argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[a.slice(2)] = true;
    else { args[a.slice(2)] = next; i++; }
}
const SET = path.resolve(args.set || '../mindsync-quality-data');
const MEASURES = String(args.measure || 'grading,check,solve,structure').split(',').map(s => s.trim()).filter(Boolean);
const MODEL = String(args.model || process.env.GEMINI_MODEL || 'gemini-3.8-flash');
const REPEAT = Math.max(1, Number(args.repeat) || 3);
const MAX_CALLS = Math.max(1, Number(args['max-calls']) || 150);
const GAP_MS = Math.max(0, Number(args['gap-ms'] === undefined ? 4000 : args['gap-ms']));
const ONLY = args.only ? String(args.only).split(',') : null;
const WITH_HOLDOUT = args.holdout === true;
// --resume report.json: carry on from an earlier (stopped) run - what was
// measured is kept, only the rest is run, and the report is updated in place.
// That's how a free key (20 calls a day) gets through a whole measure.
const RESUME = args.resume ? path.resolve(args.resume) : null;
const PREV = RESUME && fs.existsSync(RESUME) ? (JSON.parse(fs.readFileSync(RESUME, 'utf8')).results || {}) : {};
const VARIANTS = String(args.variants || 'gold-rubric,app-rubric').split(',').map(s => s.trim()).filter(Boolean);
const OUT = path.resolve(args.out || RESUME || `exam-check-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`);
if (!process.env.GEMINI_API_KEY) { console.error('GEMINI_API_KEY is not set.'); process.exit(1); }
if (!fs.existsSync(path.join(SET, 'gold'))) { console.error(`No gold set at ${SET}`); process.exit(1); }

const context = require('../rpc/context');
const aiProvider = require('../rpc/aiProvider');
const { examStages: S } = require('../rpc/handlers');
const { extractPdfText } = require('../rpc/pdfExtract');

// ---- AI calls: counted, spaced, 429s waited out ---------------------------
let calls = 0;
let lastCallAt = 0;
class OutOfCalls extends Error {}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
for (const name of ['generateText', 'generateFromPdf']) {
    const real = aiProvider[name].bind(aiProvider);
    aiProvider[name] = async (...a) => {
        for (let attempt = 0; ; attempt++) {
            if (calls >= MAX_CALLS) throw new OutOfCalls(`stopped at --max-calls ${MAX_CALLS}`);
            const wait = lastCallAt + GAP_MS - Date.now();
            if (wait > 0) await sleep(wait);
            calls += 1;
            lastCallAt = Date.now();
            try {
                return await real(...a);
            } catch (err) {
                if (err instanceof OutOfCalls) throw err;
                // 429 = too many calls for the free tier; 503 = the model is
                // busy (common on the free tier). Both pass - wait and retry.
                const limited = err.status === 429 || /\b429\b|quota|rate limit/i.test(err.message);
                const busy = err.status === 503 || err.overloaded || /\b503\b|busy|overloaded|high demand/i.test(err.message);
                if (err.dailyQuota) throw new OutOfCalls(`the key's daily quota ran out (${err.message})`);
                if ((!limited && !busy) || attempt >= 5) throw err;
                const ms = limited ? Math.max(err.retryAfterMs || 0, 30000) : 15000 * 2 ** Math.min(attempt, 3);
                console.warn(`   ⏳ ${limited ? 'rate limited' : 'model busy'} - waiting ${Math.round(ms / 1000)}s`);
                await sleep(ms);
            }
        }
    };
}
// The stages run as a "no user" request with one fixed model (as the /admin AI check does).
const run = (fn) => context.run({ token: '', userId: null, ip: null, events: new Set(), modelOverride: MODEL }, fn);

// ---- the gold set ----------------------------------------------------------
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const gold = {};
for (const course of fs.readdirSync(path.join(SET, 'gold'))) {
    const dir = path.join(SET, 'gold', course);
    if (!fs.statSync(dir).isDirectory() || course === 'grading') continue;
    for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json') || f === 'topics.json') continue;
        const g = readJson(path.join(dir, f));
        gold[g.id] = g;
    }
}
const inScope = (id) => (!ONLY || ONLY.some(o => id.startsWith(o))) && (WITH_HOLDOUT || gold[id].role !== 'holdout');
const hasKey = (p) => p.answerStatus !== 'none' && String(p.answer || '').trim();

// A gold part in the app's shape (normaliseExamPart's fields).
function appPart(p, rubric) {
    return {
        label: p.label, type: p.type, text: p.text, options: p.options || [],
        correct: p.type === 'mc' || p.type === 'tf' ? String(p.correct) : '',
        reasonRequired: p.type === 'tf' ? p.reasonRequired !== false : p.type === 'mc' && p.reasonRequired === true,
        points: p.points, answer: p.answer || '', rubric: rubric || [{ criterion: 'A complete and correct answer', points: p.points }],
        topic: p.topic || '', check: ''
    };
}
function appExam(g, keyOf) {
    return {
        title: g.id, durationMin: g.durationMin || 120, materials: g.materials || '', instructions: '', totalPoints: g.totalPoints,
        questions: g.questions.map((q, qi) => ({
            n: q.n, title: q.title, stem: q.stem || '', points: q.points, choosePartsCount: q.choosePartsCount || 0,
            parts: q.parts.map((p, pi) => keyOf ? keyOf(p, qi, pi) : appPart(p))
        }))
    };
}
const pct = (got, max) => (max ? Math.round((got / max) * 1000) / 10 : 0);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

// ---- A: grading -------------------------------------------------------------
async function gradeOne(g, qi, pi, part, answer) {
    const he = g.language === 'he';
    const auto = S.autoMarkPart(part, answer, he);
    if (auto) return { points: auto.points, auto: true };
    const q = g.questions[qi];
    const out = await run(() => S.gradeExamQuestion({ stem: q.stem || '' }, [{ part, index: pi, answer }]));
    const r = out.find(x => Number(x.index) === pi);
    // A choice with a required reason: the app's bands (the AI only classifies the reason).
    // (a reply with neither a reason class nor points is a failure, as in the app - not 30%)
    if (part.type === 'mc' && part.reasonRequired && r && S.reasonedChoicePoints
        && (Number.isFinite(Number(r.points)) || /^(full|partial|wrong|none)$/i.test(String(r.reason || '').trim()))) return { points: S.reasonedChoicePoints(part, r), reason: r.reason || '', feedback: String(r.feedback || '').slice(0, 300) };
    // Points per criterion, added up as in the app (its total only when the marks are incomplete).
    const marks = r && S.marksFromAi ? S.marksFromAi(part, r) : null;
    if (!r || !(marks || Number.isFinite(Number(r.points)))) throw new Error('no points in the answer');
    const points = S.pointsFromAi ? S.pointsFromAi(part, r, marks) : Math.max(0, Math.min(part.points, Number(r.points)));
    return { points, marked: !!marks, feedback: String(r.feedback || '').slice(0, 300) };
}

async function measureGrading(result) {
    const { cases } = readJson(path.join(SET, 'gold/grading/cases.json'));
    const { rubrics } = readJson(path.join(SET, 'gold/grading/rubrics.json'));
    const todo = cases.filter(c => gold[c.exam] && inScope(c.exam));
    result.variants = { ...((PREV.grading || {}).variants || {}) };   // a variant not run now keeps its results
    for (const variant of VARIANTS) {
        console.log(`\n▶ grading (${variant}) - ${todo.length} answers × ${REPEAT}`);
        const appKeys = new Map();   // exam#q -> solveExamParts output
        const rows = [];
        result.variants[variant] = { rows };
        const prev = (((PREV.grading || {}).variants || {})[variant] || {}).rows || [];
        for (const c of todo) {
            const old = prev.find(r => r.id === c.id && r.median !== null);
            if (old) { rows.push(old); continue; }
            const g = gold[c.exam];
            const gp = g.questions[c.q].parts[c.p];
            let part;
            if (variant === 'gold-rubric') part = appPart(gp, rubrics[`${c.exam}#${c.q}.${c.p}`]);
            else {
                const k = `${c.exam}#${c.q}`;
                if (!appKeys.has(k)) {
                    const q = g.questions[c.q];
                    const parts = q.parts.map(p => ({ ...appPart(p), answer: '', rubric: [] }));
                    appKeys.set(k, await run(() => S.solveExamParts(g.course, { stem: q.stem || '', parts })).catch(err => ({ error: err.message })));
                }
                const solved = appKeys.get(k);
                const mine = Array.isArray(solved) ? solved.find(s => s.index === c.p) : null;
                // The app's scheme, but the gold answer (A2 isolates the scheme).
                part = appPart(gp, mine && mine.rubric.length ? scaleRubric(mine.rubric, gp.points) : null);
            }
            const answer = { choice: c.choice || '', text: c.answer };
            const got = [];
            let marked = 0;   // replies that marked every criterion (the rest fell back to a total)
            for (let i = 0; i < REPEAT; i++) {
                try { const one = await gradeOne(g, c.q, c.p, part, answer); got.push(one.points); if (one.marked) marked += 1; } catch (err) {
                    if (err instanceof OutOfCalls) throw err;
                    got.push(null);
                    console.warn(`   ✖ ${c.id}: ${err.message}`);
                }
                if (got.length && part && S.autoMarkPart(part, answer, true)) break;   // marked without the AI: no point repeating
            }
            const ps = got.filter(x => x !== null).map(x => pct(x, gp.points));
            const [lo, hi] = c.expectPct;
            const m = median(ps);
            const verdict = m === null ? 'failed' : m < lo ? 'too strict' : m > hi ? 'too lenient' : 'in range';
            rows.push({ id: c.id, exam: c.exam, kind: c.kind, expect: c.expectPct, got: ps, median: m, spread: ps.length ? Math.max(...ps) - Math.min(...ps) : null, verdict, marked });
            console.log(`   ${verdict === 'in range' ? '✓' : '✗'} ${c.id.padEnd(28)} ${String(m).padStart(5)}%  [${lo}-${hi}]  runs: ${ps.join(', ')}`);
        }
    }
}
function scaleRubric(rubric, points) {
    const sum = rubric.reduce((n, r) => n + (Number(r.points) || 0), 0);
    return sum ? rubric.map(r => ({ criterion: r.criterion, points: Math.round((r.points * points / sum) * 100) / 100 })) : null;
}
function summariseGrading(rows) {
    const done = rows.filter(r => r.median !== null);
    const by = {};
    for (const r of done) {
        const k = by[r.kind] = by[r.kind] || { n: 0, inRange: 0, lenient: 0, strict: 0 };
        k.n += 1;
        if (r.verdict === 'in range') k.inRange += 1; else if (r.verdict === 'too lenient') k.lenient += 1; else k.strict += 1;
    }
    const spreads = done.map(r => r.spread).filter(x => x !== null);
    return {
        answers: rows.length, failed: rows.length - done.length,
        inRange: done.filter(r => r.verdict === 'in range').length,
        tooLenient: done.filter(r => r.verdict === 'too lenient').length,
        tooStrict: done.filter(r => r.verdict === 'too strict').length,
        // How far outside the range, on average (points of the part, in %).
        meanMiss: done.length ? Math.round(done.reduce((n, r) => n + (r.median < r.expect[0] ? r.expect[0] - r.median : r.median > r.expect[1] ? r.median - r.expect[1] : 0), 0) / done.length * 10) / 10 : null,
        spreadMedian: median(spreads), spreadMax: spreads.length ? Math.max(...spreads) : null,
        byKind: by
    };
}

// ---- B1: the check stage ------------------------------------------------------
async function measureCheck(out) {
    const { planted } = readJson(path.join(SET, 'gold/planted.json'));
    const exams = Object.keys(gold).filter(id => inScope(id) && gold[id].questions.some(q => q.parts.some(hasKey)));
    out.exams = [];
    console.log(`\n▶ check stage - ${exams.length} exams, right key and planted wrong keys`);
    const prev = ((PREV.check || {}).exams || []).filter(r => r.clean && !r.clean.error && !r.clean.failed && (r.planted === undefined || Array.isArray(r.planted)));
    for (const id of exams) {
        const old = prev.find(r => r.exam === id);
        if (old) { out.exams.push(old); continue; }
        const g = gold[id];
        // Parts without a known answer are left out of the exam the checker sees.
        const keep = (q) => q.parts.filter(hasKey);
        const trimmed = { ...g, questions: g.questions.map(q => ({ ...q, parts: keep(q) })).filter(q => q.parts.length) };
        const mine = planted.filter(x => x.exam === id);
        const row = { exam: id, parts: trimmed.questions.reduce((n, q) => n + q.parts.length, 0) };
        // (a) the right key: every "not ok" is a false alarm.
        try {
            const exam = appExam(trimmed);
            const st = await run(() => S.checkExam(exam));
            row.clean = { failed: st.failed, error: st.error, checked: st.checked, corrected: st.corrected, dropped: st.dropped,
                falseAlarms: st.verdicts.filter(v => v.ok !== true).map(v => ({ q: v.q, p: v.p, problem: String(v.problem || '').slice(0, 200) })) };
        } catch (err) { if (err instanceof OutOfCalls) throw err; row.clean = { error: err.message }; }
        // (b) the planted wrong keys (all of this exam's at once).
        if (mine.length) {
            try {
                const at = new Map();
                trimmed.questions.forEach((q, qi) => q.parts.forEach((p, pi) => at.set(p, { qi, pi })));
                const plantFor = (p) => mine.find(x => g.questions[x.q].parts[x.p] === p);
                const exam = appExam(trimmed, (p) => { const x = plantFor(p); return x ? { ...appPart(p), answer: x.answer, correct: x.correct !== undefined ? String(x.correct) : appPart(p).correct } : appPart(p); });
                const st = await run(() => S.checkExam(exam));
                row.planted = mine.map(x => {
                    const { qi, pi } = at.get(g.questions[x.q].parts[x.p]);
                    const v = st.verdicts.find(v => Number(v.q) === qi && Number(v.p) === pi);
                    const gp = g.questions[x.q].parts[x.p];
                    const fixedChoice = v && v.correct !== undefined && v.correct !== '' ? String(v.correct).toLowerCase() : null;
                    return {
                        part: `${gp.label}`, what: x.what, caught: !!v && v.ok !== true,
                        // For mc / tf: is the checker's own correction the right one?
                        rightFix: (gp.type === 'mc' || gp.type === 'tf') && v && v.ok !== true ? fixedChoice === String(gp.correct) : null,
                        unsolvable: !!v && /unsolvable/i.test(String(v.problem || '')),
                        problem: v ? String(v.problem || '').slice(0, 200) : 'no verdict'
                    };
                });
                row.plantedFailed = st.failed;
            } catch (err) { if (err instanceof OutOfCalls) throw err; row.planted = { error: err.message }; }
        }
        out.exams.push(row);
        const c = row.clean || {};
        const caught = Array.isArray(row.planted) ? row.planted.filter(x => x.caught).length : 0;
        console.log(`   ${id.padEnd(22)} parts ${row.parts}  false alarms ${(c.falseAlarms || []).length}${c.failed ? ' (CHECK FAILED)' : ''}  planted caught ${caught}/${mine.length}`);
    }
}
function summariseCheck(out) {
    const all = out.exams || [];
    const plantedRows = all.flatMap(r => Array.isArray(r.planted) ? r.planted : []);
    return {
        exams: all.length,
        parts: all.reduce((n, r) => n + r.parts, 0),
        falseAlarms: all.reduce((n, r) => n + ((r.clean && r.clean.falseAlarms) || []).length, 0),
        unsolvableOnRealQuestions: all.reduce((n, r) => n + ((r.clean && r.clean.falseAlarms) || []).filter(f => /unsolvable/i.test(f.problem)).length, 0),
        checkFailed: all.filter(r => r.clean && r.clean.failed).length,
        planted: plantedRows.length, caught: plantedRows.filter(x => x.caught).length,
        choiceFixesRight: plantedRows.filter(x => x.rightFix === true).length, choiceFixesWrong: plantedRows.filter(x => x.rightFix === false).length
    };
}

// ---- B2: the app solving real questions ----------------------------------------
async function judgeFinals(g, pairs) {
    // One light call per exam: are these two results the same? (proofs are
    // judged on validity, so their number is reported apart).
    const prompt = `For each item, decide whether the SOLUTION reaches the same final result as the KEY (an equivalent form counts as the same; for a proof or an explanation: is it correct and complete, given the key). Ignore language and presentation.

${pairs.map((x, i) => `<item index="${i}">\n<question>${x.text.slice(0, 1500)}</question>\n<key>${x.key.slice(0, 2500)}</key>\n<solution>${x.solution.slice(0, 2500)}</solution>\n</item>`).join('\n\n')}

Return ONLY JSON: {"items": [{"index": n, "same": true or false, "why": "one short sentence"}]}`;
    const raw = await run(() => aiProvider.generateText(prompt, { forceJson: true, maxTokens: 6000, thinkingLevel: 'medium', timeoutMs: 180000, noFallback: true }));
    const m = String(raw).match(/\{[\s\S]*\}/);
    return m ? (JSON.parse(m[0]).items || []) : [];
}
async function measureSolve(out) {
    const exams = Object.keys(gold).filter(id => inScope(id) && gold[id].questions.some(q => q.parts.some(hasKey)));
    out.exams = [];
    console.log(`\n▶ solving real questions - ${exams.length} exams`);
    const prev = ((PREV.solve || {}).exams || []).filter(r => !r.error && r.check && !r.check.failed);
    for (const id of exams) {
        const old = prev.find(r => r.exam === id);
        if (old) { out.exams.push(old); continue; }
        const g = gold[id];
        const row = { exam: id, parts: [] };
        try {
            // The app's key, question by question (the questions as printed, no answers).
            const solvedOf = new Map();   // gold part -> the app's key for it
            for (const q of g.questions) {
                if (!q.parts.some(hasKey)) continue;
                const parts = q.parts.map(p => ({ ...appPart(p), answer: '', rubric: [], correct: '' }));
                const keys = await run(() => S.solveExamParts(g.course, { stem: q.stem || '', parts }));
                q.parts.forEach((p, pi) => { const k = keys.find(x => x.index === pi); if (k && k.answer) solvedOf.set(p, { ...appPart(p), answer: k.answer, correct: k.correct, rubric: k.rubric.length ? scaleRubric(k.rubric, p.points) : appPart(p).rubric }); });
            }
            const before = g.questions.map(q => q.parts.map(p => solvedOf.has(p) ? { answer: solvedOf.get(p).answer, correct: solvedOf.get(p).correct } : { answer: '', correct: '' }));
            // ... then its own check, as when it writes an exam (only the parts it solved).
            const trimmed = { ...g, questions: g.questions.map(q => ({ ...q, parts: q.parts.filter(p => solvedOf.has(p)) })).filter(q => q.parts.length) };
            const exam = appExam(trimmed, (p) => ({ ...solvedOf.get(p) }));
            const st = await run(() => S.checkExam(exam));
            // checkExam may drop parts - map them back by text.
            const after = new Map();
            exam.questions.forEach(q => q.parts.forEach(p => after.set(p.text, p)));
            row.check = { failed: st.failed, corrected: st.corrected, dropped: st.dropped };
            const pairs = [];
            g.questions.forEach((q, qi) => q.parts.forEach((p, pi) => {
                if (!hasKey(p) || !before[qi][pi].answer) return;
                const a = after.get(p.text);
                const base = { part: `${q.n}.${p.label}`, type: p.type, proof: /^proof-/.test(p.topic || '') };
                if (p.type === 'mc' || p.type === 'tf') {
                    row.parts.push({ ...base, rightBefore: before[qi][pi].correct === String(p.correct), rightAfter: a ? a.correct === String(p.correct) : null, dropped: !a });
                } else {
                    pairs.push({ ...base, text: p.text, key: p.answer, solution: before[qi][pi].answer, after: a ? a.answer : null, changed: a ? a.answer !== before[qi][pi].answer : false, dropped: !a });
                }
            }));
            if (pairs.length) {
                const j1 = await judgeFinals(g, pairs.map(x => ({ text: x.text, key: x.key, solution: x.solution })));
                const changed = pairs.map((x, i) => ({ x, i })).filter(({ x }) => x.changed && x.after);
                const j2 = changed.length ? await judgeFinals(g, changed.map(({ x }) => ({ text: x.text, key: x.key, solution: x.after }))) : [];
                pairs.forEach((x, i) => {
                    const v1 = j1.find(v => Number(v.index) === i);
                    const ci = changed.findIndex(c => c.i === i);
                    const v2 = ci >= 0 ? j2.find(v => Number(v.index) === ci) : null;
                    const rightBefore = v1 ? v1.same === true : null;
                    row.parts.push({ part: x.part, type: x.type, proof: x.proof, rightBefore, rightAfter: x.dropped ? null : (x.changed ? (v2 ? v2.same === true : null) : rightBefore), dropped: x.dropped, why: v1 ? String(v1.why || '').slice(0, 200) : '' });
                });
            }
        } catch (err) { if (err instanceof OutOfCalls) throw err; row.error = err.message; }
        out.exams.push(row);
        const ok = row.parts.filter(p => p.rightAfter === true).length;
        console.log(`   ${id.padEnd(22)} ${row.error ? 'ERROR ' + row.error : `right after check ${ok}/${row.parts.length}`}`);
    }
}
function summariseSolve(out) {
    const ps = (out.exams || []).flatMap(r => r.parts);
    const s = (sel) => { const xs = ps.filter(sel); return { parts: xs.length, rightBefore: xs.filter(p => p.rightBefore === true).length, rightAfter: xs.filter(p => p.rightAfter === true).length, dropped: xs.filter(p => p.dropped).length, fixedByCheck: xs.filter(p => p.rightBefore === false && p.rightAfter === true).length, brokenByCheck: xs.filter(p => p.rightBefore === true && p.rightAfter === false).length }; };
    return { all: s(() => true), computations: s(p => !p.proof && p.type !== 'mc' && p.type !== 'tf'), proofs: s(p => p.proof), choice: s(p => p.type === 'mc' || p.type === 'tf') };
}

// ---- C: structure (leave one out) ------------------------------------------------
const HELD = { calc2: 'calc2/2025-A', dsa: 'dsa/2023-summer', logic: 'logic/2019-A' };
const words = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
function grams(t, n = 5) { const w = words(t); const s = new Set(); for (let i = 0; i + n <= w.length; i++) s.add(w.slice(i, i + n).join(' ')); return s; }
function overlap(a, b) { if (!a.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n += 1; return n / a.size; }
const shapeOf = (q) => q.parts.map(p => p.type + (p.reasonRequired ? '+reason' : '')).sort().join(',');

async function measureStructure(out) {
    out.courses = [];
    console.log('\n▶ structure (leave one out)');
    const prev = ((PREV.structure || {}).courses || []).filter(r => !r.error);
    for (const [course, heldId] of Object.entries(HELD)) {
        const old = prev.find(r => r.course === course);
        if (old) { out.courses.push(old); continue; }
        if (ONLY && !ONLY.some(o => heldId.startsWith(o))) continue;
        const held = gold[heldId];
        if (!held) continue;
        const train = Object.values(gold).filter(g => g.id.startsWith(course + '/') && g.id !== heldId && g.role !== 'holdout' && !/other-sample/.test(g.id));
        const row = { course, heldOut: heldId, from: train.map(g => g.id) };
        try {
            const past = [];
            for (const g of train) {
                const file = path.join(SET, g.pdfExamOnly || g.pdf);
                const buffer = fs.readFileSync(file);
                let text = '';
                try { text = await extractPdfText(file); } catch (e) { text = ''; }
                past.push({ name: path.basename(file), buffer, text: String(text || '') });
            }
            const blueprint = await run(() => S.examBlueprint(held.course, past));
            const usable = blueprint && blueprint.questions ? blueprint : null;
            const material = past.map(f => `=== ${f.name} ===\n${String(f.text || '').slice(0, 20000)}`).join('\n\n').slice(0, 60000);
            const exam = await run(() => S.writeExam(held.course, usable, material));
            const st = await run(() => S.checkExam(exam));
            const goldQs = held.questions.filter(q => !q.bonus);
            row.blueprint = usable ? { questions: usable.questions.length, totalPoints: usable.totalPoints, durationMin: usable.durationMin } : null;
            const genQs = exam.questions.filter(q => !q.bonus);
            row.generated = { questions: genQs.length, totalPoints: exam.totalPoints, durationMin: exam.durationMin, points: genQs.map(q => q.points), shapes: genQs.map(shapeOf), choose: genQs.map(q => q.choosePartsCount), bonus: exam.questions.some(q => q.bonus), bonusPoints: exam.bonusPoints || 0, maxGrade: exam.maxGrade || 0, dontKnowShare: exam.dontKnowShare || 0 };
            const realDontKnow = (held.rules || []).some(r => /לא\s*יודע|don'?t know/i.test(String(r)));
            row.real = { questions: goldQs.length, totalPoints: held.totalPoints, durationMin: held.durationMin, points: goldQs.map(q => q.points), shapes: goldQs.map(q => shapeOf({ parts: q.parts.map(p => appPart(p)) })), choose: goldQs.map(q => q.choosePartsCount || 0), bonus: held.questions.some(q => q.bonus), maxGrade: held.maxGrade || 0, dontKnow: realDontKnow };
            const n = Math.min(genQs.length, goldQs.length);
            let samePoints = 0, sameShape = 0, sameChoose = 0;
            for (let i = 0; i < n; i++) {
                if (Math.abs(genQs[i].points - goldQs[i].points) < 0.6) samePoints += 1;
                if (row.generated.shapes[i] === row.real.shapes[i]) sameShape += 1;
                if ((genQs[i].choosePartsCount > 0) === ((goldQs[i].choosePartsCount || 0) > 0)) sameChoose += 1;
            }
            // Copying: a generated part that shares most of its 5-word runs with a past question.
            const pastGrams = train.flatMap(g => g.questions.flatMap(q => q.parts.map(p => ({ id: `${g.id} ${q.n}.${p.label}`, g: grams(`${q.stem || ''} ${p.text}`) }))));
            const copies = [];
            exam.questions.forEach(q => q.parts.forEach(p => {
                const mine = grams(`${q.stem || ''} ${p.text}`);
                let best = { id: '', o: 0 };
                for (const x of pastGrams) { const o = overlap(mine, x.g); if (o > best.o) best = { id: x.id, o }; }
                if (best.o >= 0.5) copies.push({ part: `${q.n}.${p.label}`, like: best.id, overlap: Math.round(best.o * 100) });
            }));
            row.match = {
                questionCount: genQs.length === goldQs.length,
                totalPoints: Math.abs(exam.totalPoints - held.totalPoints) < 0.6,
                duration: exam.durationMin === held.durationMin,
                samePoints: `${samePoints}/${goldQs.length}`, sameShape: `${sameShape}/${goldQs.length}`, sameChoose: `${sameChoose}/${goldQs.length}`,
                // true = as in the real exam; 'invented' = a bonus / cap / "don't know" the real exam doesn't have
                bonus: row.real.bonus ? row.generated.bonus : (row.generated.bonus ? 'invented' : null),
                maxGrade: row.real.maxGrade ? row.generated.maxGrade === row.real.maxGrade : (row.generated.maxGrade ? 'invented' : null),
                dontKnow: row.real.dontKnow ? row.generated.dontKnowShare > 0 : (row.generated.dontKnowShare ? 'invented' : null),
                // "circle and explain": kept when the real exam has it, 'invented' when it doesn't
                reasonOnChoice: goldQs.some(q => q.parts.some(p => p.type === 'mc' && p.reasonRequired))
                    ? exam.questions.some(q => q.parts.some(p => p.type === 'mc' && p.reasonRequired))
                    : (exam.questions.some(q => q.parts.some(p => p.type === 'mc' && p.reasonRequired)) ? 'invented' : null)
            };
            row.copies = copies;
            row.check = { failed: st.failed, corrected: st.corrected, dropped: st.dropped };
            row.topics = { generated: [...new Set(exam.questions.flatMap(q => q.parts.map(p => p.topic)))], real: [...new Set(goldQs.flatMap(q => q.parts.map(p => p.topic)))] };
            row.exam = exam;
        } catch (err) { if (err instanceof OutOfCalls) throw err; row.error = err.message; }
        out.courses.push(row);
        console.log(`   ${course.padEnd(8)} ${row.error ? 'ERROR ' + row.error : `questions ${row.generated.questions}/${row.real.questions}  points ${row.match.samePoints}  shapes ${row.match.sameShape}  choose ${row.match.sameChoose}  copies ${row.copies.length}`}`);
    }
}

// ---- main --------------------------------------------------------------------------
(async () => {
    const before = RESUME && fs.existsSync(RESUME) ? JSON.parse(fs.readFileSync(RESUME, 'utf8')) : null;
    const report = { model: MODEL, ranAt: new Date().toISOString(), measures: MEASURES, repeat: REPEAT, holdout: WITH_HOLDOUT, only: ONLY, results: { ...PREV }, runs: [...((before && before.runs) || [])] };
    if (before && before.model && before.model !== MODEL) { console.error(`--resume: that report is for ${before.model}, not ${MODEL}.`); process.exit(1); }
    // Summaries over everything measured so far (also after a stop half way).
    const summarise = () => {
        const r = report.results;
        if (r.grading && r.grading.variants) for (const v of Object.values(r.grading.variants)) v.summary = summariseGrading(v.rows || []);
        if (r.check) r.check.summary = summariseCheck(r.check);
        if (r.solve) r.solve.summary = summariseSolve(r.solve);
    };
    const save = () => { summarise(); report.calls = (before && before.calls || 0) + calls; fs.writeFileSync(OUT, JSON.stringify(report, null, 1)); };
    const t0 = Date.now();
    try {
        for (const m of MEASURES) {
            const fn = { grading: measureGrading, check: measureCheck, solve: measureSolve, structure: measureStructure }[m];
            if (!fn) { console.warn(`unknown measure: ${m}`); continue; }
            report.results[m] = {};
            try { await fn(report.results[m]); } finally { save(); }
        }
    } catch (err) {
        report.stopped = err.message;
        console.warn(`\n■ ${err.message}`);
    }
    report.seconds = Math.round((Date.now() - t0) / 1000);
    report.runs.push({ at: report.ranAt, calls, seconds: report.seconds, stopped: report.stopped || null });
    save();
    console.log(`\n${calls} AI calls, ${report.seconds}s - report: ${OUT}`);
    for (const [m, r] of Object.entries(report.results)) {
        if (r.summary) console.log(m, JSON.stringify(r.summary));
        if (r.variants) for (const [v, x] of Object.entries(r.variants)) console.log(`${m} (${v})`, JSON.stringify(x.summary));
    }
    process.exit(0);
})();
