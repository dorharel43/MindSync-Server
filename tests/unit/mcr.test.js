const { examStages: S } = require('../../rpc/handlers');
const assert = require('assert');
const part = { type: 'mc', reasonRequired: true, correct: '1', points: 10, options: ['a', 'b', 'c'] };
// auto: wrong choice 0, right with no reason 30%
assert.strictEqual(S.autoMarkPart(part, { choice: '2', text: 'נימוק' }, true).points, 0);
assert.strictEqual(S.autoMarkPart(part, { choice: '', text: 'נימוק' }, true).points, 0);
assert.strictEqual(S.autoMarkPart(part, { choice: '1', text: '  ' }, true).points, 3);
assert.strictEqual(S.autoMarkPart(part, { choice: '1', text: 'כי...' }, true), null, 'a reason goes to the AI');
// plain mc unchanged
assert.strictEqual(S.autoMarkPart({ ...part, reasonRequired: false }, { choice: '1', text: '' }, true).points, 10);
// the bands
const P = (g) => S.reasonedChoicePoints(part, g);
assert.strictEqual(P({ reason: 'full', points: 4 }), 10, 'full -> 100%');
assert.strictEqual(P({ reason: 'partial', points: 2 }), 5, 'partial floor 50%');
assert.strictEqual(P({ reason: 'partial', points: 10 }), 9, 'partial cap 90%');
assert.strictEqual(P({ reason: 'partial', points: 7 }), 7);
assert.strictEqual(P({ reason: 'wrong', points: 9 }), 3, 'wrong reason -> 30%');
assert.strictEqual(P({ reason: 'none', points: 9 }), 3);
assert.strictEqual(P({ points: 1 }), 3, 'no class: floor 30%');
assert.strictEqual(P({ points: 12 }), 10, 'no class: cap 100%');
assert.strictEqual(P({ reason: 'Partial' }), 5, 'class, no points');
// normalise: mc reason only when the blueprint has one
const raw = { questions: [{ parts: [{ type: 'mc', text: 'q', options: ['a', 'b'], correct: '1', reasonRequired: true, answer: 'b כי', points: 10 }] }] };
assert.strictEqual(S.normaliseExam(raw, null).questions[0].parts[0].reasonRequired, false, 'no blueprint -> plain mc');
assert.strictEqual(S.normaliseExam(raw, { questions: [{ parts: [{ type: 'mc', reasonRequired: true }] }] }).questions[0].parts[0].reasonRequired, true, 'blueprint asks -> mc+reason');
assert.strictEqual(S.normaliseExam(raw, { questions: [{ parts: [{ type: 'mc' }] }] }).questions[0].parts[0].reasonRequired, false, 'blueprint plain mc');
// a tf that fell back to open keeps "needs a reason" for its replacement
const tfBad = S.normaliseExam({ questions: [{ parts: [{ type: 'tf', text: 'q', correct: 'maybe', answer: 'a', points: 5 }] }] }, null).questions[0].parts[0];
assert.strictEqual(tfBad.type, 'open'); assert.strictEqual(tfBad.replace, 'tf'); assert.strictEqual(tfBad.replaceReason, true);
console.log('mc+reason unit checks passed');
