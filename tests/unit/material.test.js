// Course material for a full exam (24/10): every long file is covered from
// start to end, the parts naming a recurring topic come first, short files
// leave their unused share to the long ones, and the budget holds.
const { examStages: S } = require('../../rpc/handlers');
const assert = require('assert');

const slides = (n, special = {}) => Array.from({ length: n }, (_, i) =>
    `--- Slide ${i + 1} ---\nשקף ${i + 1}. ${special[i + 1] || ''}${'הסבר ארוך על החומר של השיעור. '.repeat(40)}`).join('\n');
const slideNums = (text) => [...text.matchAll(/--- Slide (\d+) ---/g)].map(m => Number(m[1]));
const section = (out, name) => out.split(`=== ${name} ===`)[1].split('\n\n=== ')[0];

// 12 long presentations: each covered from start to end, within the budget.
const lectures = Array.from({ length: 12 }, (_, i) => ({ name: `הרצאה ${i + 1}.pptx`, content: slides(40) }));
let out = S.courseMaterialText(lectures, 90000);
assert.ok(out.length <= 90000, 'within the budget');
assert.strictEqual((out.match(/^=== /gm) || []).length, 12, 'every file is in');
let nums = slideNums(section(out, 'הרצאה 1.pptx'));
assert.ok(nums[0] === 1, 'starts at the beginning');
assert.ok(nums.some(n => n >= 18 && n <= 23), 'the middle: ' + nums);
assert.ok(nums.some(n => n >= 33), 'the end: ' + nums);
assert.ok(section(out, 'הרצאה 1.pptx').includes('[…]'), 'gaps marked');

// A recurring topic on slide 39 (with a prefix: "בכופלי") is taken.
const withTopic = lectures.map((f, i) => i === 4 ? { ...f, content: slides(40, { 39: 'שיטת בכופלי לגרנז׳ לנקודות קיצון עם אילוץ.' }) } : f);
out = S.courseMaterialText(withTopic, 90000, ['כופלי לגרנז׳']);
assert.ok(slideNums(section(out, 'הרצאה 5.pptx')).includes(39), 'the topic slide is in');
assert.ok(section(out, 'הרצאה 5.pptx').includes('כופלי לגרנז'), 'its text is in');

// Short files whole; their unused share goes to the long one.
const mixed = [{ name: 'דף נוסחאות.pdf', content: 'נוסחה. '.repeat(100) }, { name: 'ארוכה.pptx', content: slides(200) }];
out = S.courseMaterialText(mixed, 40000);
assert.ok(section(out, 'דף נוסחאות.pdf').trim() === mixed[0].content.trim(), 'short file whole');
assert.ok(section(out, 'ארוכה.pptx').length > 30000, 'the long one gets the rest: ' + section(out, 'ארוכה.pptx').length);

// A document with no slides (a PDF's pages): covered to its end too.
const pages = Array.from({ length: 60 }, (_, i) => `עמוד ${i + 1}. ${'טקסט של עמוד במסמך. '.repeat(60)}`).join('\n\n');
out = S.courseMaterialText([{ name: 'סיכום.pdf', content: pages }], 20000);
assert.ok(out.length <= 20000, 'pdf within budget');
assert.ok(/עמוד 5\d\./.test(out), 'reaches the end of the document');

// Nothing to read -> nothing.
assert.strictEqual(S.courseMaterialText([{ name: 'ריק.pdf', content: '   ' }]), '', 'empty');

console.log('material: all checks passed');

// ---- review fixes (24/10) ----
// Many files of one long paragraph each (PDF text with no blank lines), a small
// budget: every file still gives text, and most of the budget is used.
const flat = Array.from({ length: 30 }, (_, i) => ({ name: `קובץ ${i + 1}.pdf`, content: `התחלה${i + 1} ` + 'מילה '.repeat(420) }));
out = S.courseMaterialText(flat, 30000);
assert.ok(out.length <= 30000, 'flat: within budget');
assert.ok(flat.every(f => section(out, f.name).replace(/\[…\]/g, '').trim().length > 300), 'flat: every file gives text');
assert.ok(out.length > 25000, 'flat: the budget is used: ' + out.length);
// Single newlines only: the file's start is there, not just a piece from its middle.
const lines = Array.from({ length: 12 }, (_, i) => ({ name: `סיכום ${i + 1}.pdf`, content: `כותרת${i + 1}\n` + Array.from({ length: 120 }, (_, j) => `שורה ${j} של הסיכום`).join('\n') }));
out = S.courseMaterialText(lines, 30000);
assert.ok(lines.every((f, i) => section(out, f.name).includes(`כותרת${i + 1}`) || section(out, f.name).includes('שורה')), 'lines: text from every file');
assert.ok(out.length > 25000, 'lines: the budget is used: ' + out.length);
// 60 files: none dropped off the end.
const sixty = Array.from({ length: 60 }, (_, i) => ({ name: `הרצאה ${i + 1}.pptx`, content: slides(30) }));
out = S.courseMaterialText(sixty, 90000);
assert.ok(out.length <= 90000, 'sixty: within budget');
assert.ok(out.includes('=== הרצאה 60.pptx ===') && section(out, 'הרצאה 60.pptx').includes('Slide'), 'sixty: the last file is in, with slides');
// A slide longer than a piece isn't lost - it's split.
const big = [{ name: 'ארוך.pptx', content: '--- Slide 1 ---\n' + 'א'.repeat(50) + ' ' + 'ב '.repeat(4000) + 'סוף-השקף\n--- Slide 2 ---\nקצר' }];
assert.ok(S.materialParts(big[0].content).join('').includes('סוף-השקף'), 'long slide kept whole across pieces');
// Prefixes: the topic "משוואה" finds "המשוואה" (and isn't cut to "ואה").
const pre = [{ name: 'ש.pptx', content: slides(60, { 55: 'פתרון המשוואה הדיפרנציאלית בעזרת הפרדת משתנים.' }) }];
out = S.courseMaterialText(pre, 8000, ['משוואה דיפרנציאלית']);
assert.ok(slideNums(out).includes(55), 'prefix match: ' + slideNums(out));
// The syllabus: left out - unless it's all there is.
const syl = { name: 'סילבוס.pdf', role: 'syllabus', content: 'סילבוס' };
const lec = { name: 'הרצאה.pdf', role: 'material', content: 'הרצאה' };
assert.deepStrictEqual(S.withoutSyllabus([syl, lec]).map(f => f.name), ['הרצאה.pdf'], 'syllabus out');
assert.deepStrictEqual(S.withoutSyllabus([syl]).map(f => f.name), ['סילבוס.pdf'], 'syllabus only: kept');
console.log('material: review checks passed');
