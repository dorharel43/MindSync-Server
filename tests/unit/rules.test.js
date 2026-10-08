const { examStages: S } = require('../../rpc/handlers');
const assert = require('assert');
const qs = (bonus) => [{ n: 1, points: 50, parts: [] }, { n: 2, points: 50, parts: [] }, ...(bonus ? [{ n: 3, points: 10, bonus: true, parts: [] }] : [])];
const long = 'x'.repeat(400);
let b;
// bonus: in the text -> kept; AI says bonus but the text has none -> dropped
b = S.verifyBlueprintRules({ questions: qs(true), totalPoints: 100, bonusQuote: 'שאלת בונוס' }, [{ text: long + ' שאלה 5 (בונוס - 10 נקודות)' }]);
assert.strictEqual(b.questions[2].bonus, true, 'bonus in text');
b = S.verifyBlueprintRules({ questions: qs(true), totalPoints: 100, bonusQuote: 'בונוס' }, [{ text: long }]);
assert.strictEqual(b.questions[2].bonus, false, 'invented bonus dropped');
b = S.verifyBlueprintRules({ questions: qs(true), totalPoints: 100, bonusQuote: 'סונוב תלאש' }, [{ text: long + ' סונוב ' }]);
assert.strictEqual(b.questions[2].bonus, true, 'reversed hebrew');
// scanned (no text): the quote decides
b = S.verifyBlueprintRules({ questions: qs(true), bonusQuote: 'Bonus question (10 pts)' }, [{ text: '' }]);
assert.strictEqual(b.questions[2].bonus, true, 'scanned + quote');
b = S.verifyBlueprintRules({ questions: qs(true), bonusQuote: '' }, [{ text: '' }]);
assert.strictEqual(b.questions[2].bonus, false, 'scanned, no quote');
// only bonus questions -> no bonus
b = S.verifyBlueprintRules({ questions: [{ n: 1, points: 10, bonus: true }], bonusQuote: 'בונוס' }, [{ text: long + 'בונוס' }]);
assert.strictEqual(b.questions[0].bonus, false, 'all-bonus');
// maxGrade
const q108 = [{ n: 1, points: 108, parts: [] }];
b = S.verifyBlueprintRules({ questions: q108, maxGrade: 100, maxGradeQuote: 'הציון המקסימלי 100' }, [{ text: long + 'סה"כ 108 נקודות. הציון המקסימלי הוא 100.' }]);
assert.strictEqual(b.maxGrade, 100, 'maxGrade 100/108');
b = S.verifyBlueprintRules({ questions: qs(false), maxGrade: 100 }, [{ text: long + ' 100 ' }]);
assert.strictEqual(b.maxGrade, null, 'maxGrade not below total');
b = S.verifyBlueprintRules({ questions: q108, maxGrade: 60 }, [{ text: long + ' 60 ' }]);
assert.strictEqual(b.maxGrade, null, 'maxGrade too low');
b = S.verifyBlueprintRules({ questions: q108, maxGrade: 100 }, [{ text: long }]);
assert.strictEqual(b.maxGrade, null, 'maxGrade not in text');
// don't know
b = S.verifyBlueprintRules({ questions: qs(false), dontKnowShare: 0.25, dontKnowQuote: "25% לתשובה 'לא יודע/ת'" }, [{ text: long + "על כל שאלה יתקבלו 25% מהנקודות לתשובה 'לא יודע/ת'" }]);
assert.strictEqual(b.dontKnowShare, 0.25, 'dontKnow');
b = S.verifyBlueprintRules({ questions: qs(false), dontKnowShare: 0.25 }, [{ text: long }]);
assert.strictEqual(b.dontKnowShare, null, 'dontKnow invented');
b = S.verifyBlueprintRules({ questions: qs(false), dontKnowShare: 0.9, dontKnowQuote: 'לא יודע' }, [{ text: long + 'לא יודע' }]);
assert.strictEqual(b.dontKnowShare, null, 'dontKnow too big');
// normaliseExam: bonus only as many as the blueprint has; totals
const part = (pts) => ({ type: 'open', text: 'q', answer: 'a', points: pts, rubric: [{ criterion: 'c', points: pts }] });
const raw = { questions: [{ points: 50, parts: [part(50)] }, { points: 50, parts: [part(50)] }, { points: 10, bonus: true, parts: [part(10)] }, { points: 10, bonus: true, parts: [part(10)] }] };
let e = S.normaliseExam(raw, { questions: qs(true), maxGrade: null, dontKnowShare: null });
assert.deepStrictEqual(e.questions.map(q => q.bonus), [false, false, true, false], 'one bonus only');
assert.strictEqual(e.totalPoints, 110 - 0 - 0 === 110 ? 110 : 0, 'total');
e = S.normaliseExam(raw, null);
assert.deepStrictEqual(e.questions.map(q => q.bonus), [false, false, false, false], 'no blueprint, no bonus');
assert.strictEqual(e.totalPoints, 120); assert.strictEqual(e.bonusPoints, 0);
e = S.normaliseExam({ questions: [{ points: 108, parts: [part(100), part(8)] }] }, { questions: q108, maxGrade: 100, regularPoints: 108, dontKnowShare: 0.25 });
assert.strictEqual(e.totalPoints, 108); assert.strictEqual(e.maxGrade, 100); assert.strictEqual(e.dontKnowShare, 0.25);
// the writer wrote other points than the past exams (140): the cap isn't theirs
e = S.normaliseExam({ questions: [{ points: 140, parts: [part(70), part(70)] }] }, { questions: q108, maxGrade: 100, regularPoints: 108 });
assert.strictEqual(e.maxGrade, 0, 'cap dropped for other points');
// review cases: "100" with no grade words next to it; "answer 4 of 5"
const q125 = [1, 2, 3, 4, 5].map(n => ({ n, points: 25, parts: [] }));
b = S.verifyBlueprintRules({ questions: q125, maxGrade: 100, maxGradeQuote: '100' }, [{ text: long + ' ענו על 4 מתוך 5 השאלות. משך המבחן 100 דקות. סה"כ 100 נקודות.' }]);
assert.strictEqual(b.maxGrade, null, '100 without grade words');
b = S.verifyBlueprintRules({ questions: q108, maxGrade: 100 }, [{ text: long + ' סה"כ 108 נקודות, הציון לא יעלה על 100.' }]);
assert.strictEqual(b.maxGrade, 100, 'לא יעלה על');
b = S.verifyBlueprintRules({ questions: q108, maxGrade: 100, maxGradeQuote: 'The maximum grade is 100' }, [{ text: '' }]);
assert.strictEqual(b.maxGrade, 100, 'scanned + quote with grade words');
// the share must be the one printed
b = S.verifyBlueprintRules({ questions: qs(false), dontKnowShare: 0.5, dontKnowQuote: "20% לתשובה 'לא יודע/ת'" }, [{ text: long + "יתקבלו 20% מהנקודות לתשובה 'לא יודע/ת'" }]);
assert.strictEqual(b.dontKnowShare, null, 'share not as printed');
b = S.verifyBlueprintRules({ questions: qs(false), dontKnowShare: 0.2 }, [{ text: long + "יתקבלו 20% מהנקודות לתשובה 'לא יודע/ת'" }]);
assert.strictEqual(b.dontKnowShare, 0.2, '20% as printed');
b = S.verifyBlueprintRules({ questions: qs(false), dontKnowShare: 0.25 }, [{ text: long + "על תשובה 'לא יודע' יינתן רבע מהניקוד" }]);
assert.strictEqual(b.dontKnowShare, 0.25, 'רבע');
b = S.verifyBlueprintRules({ questions: qs(false), dontKnowShare: 0.25 }, [{ text: long + " אני לא יודע מה זה. " + 'y'.repeat(200) + ' 25 ' }]);
assert.strictEqual(b.dontKnowShare, null, '"לא יודע" in a question, no share near it');
// autoMarkPart: don't know
const p = { type: 'open', points: 20 };
assert.strictEqual(S.autoMarkPart(p, { dontKnow: true }, true, 0.25).points, 5);
assert.strictEqual(S.autoMarkPart(p, { dontKnow: true }, true, 0), null);
assert.strictEqual(S.autoMarkPart({ type: 'mc', points: 5, correct: '1' }, { dontKnow: true, choice: '' }, true, 0.25).points, 0, 'mc ignores dontKnow');
assert.strictEqual(S.answerIsBlank({ dontKnow: true }), false);
console.log('all unit checks passed');
// reversed Hebrew (a PDF's visual order)
let r2 = S.verifyBlueprintRules({ questions: [{ n: 1, points: 20 }, { n: 2, points: 20 }], dontKnowShare: 0.2 }, [{ text: 'x'.repeat(400) + " 20% עדוי אל " }]);
assert.strictEqual(r2.dontKnowShare, 0.2, 'reversed לא יודע');
r2 = S.verifyBlueprintRules({ questions: [{ n: 1, points: 108 }], maxGrade: 100 }, [{ text: 'x'.repeat(400) + ' ןויצה יברמה אוה 100 ' }]);
assert.strictEqual(r2.maxGrade, 100, 'reversed ציון מרבי');
console.log('reversed-Hebrew checks passed');
