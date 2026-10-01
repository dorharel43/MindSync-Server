// Text out of Word (.docx) and PowerPoint (.pptx) files (30/9).
//
// Most lecture slides in Israeli universities are PowerPoint files, and the
// upload only took PDFs - "save it as PDF first" lost students at the first
// step. Both formats are zip archives of XML: this reads the zip with Node's
// own zlib (no new dependency) and keeps the text, slide by slide.
//
// Limits against a "zip bomb" (a tiny file that unpacks to gigabytes): at most
// 400 entries read, 40MB unpacked in total.
const zlib = require('zlib');

const MAX_ENTRIES = 2000;          // listed in the archive
const MAX_READ = 400;              // actually unpacked
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;

function readZip(buffer) {
    // End of central directory: signature 0x06054b50, within the last 64KB.
    let eocd = -1;
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
        if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip archive');
    const count = buffer.readUInt16LE(eocd + 10);
    let p = buffer.readUInt32LE(eocd + 16);
    if (count > MAX_ENTRIES) throw new Error('too many files inside');
    const entries = [];
    for (let n = 0; n < count; n++) {
        if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== 0x02014b50) throw new Error('damaged archive');
        const method = buffer.readUInt16LE(p + 10);
        const compressed = buffer.readUInt32LE(p + 20);
        const size = buffer.readUInt32LE(p + 24);
        const nameLen = buffer.readUInt16LE(p + 28);
        const extraLen = buffer.readUInt16LE(p + 30);
        const commentLen = buffer.readUInt16LE(p + 32);
        const local = buffer.readUInt32LE(p + 42);
        const name = buffer.slice(p + 46, p + 46 + nameLen).toString('utf8');
        entries.push({ name, method, compressed, size, local });
        p += 46 + nameLen + extraLen + commentLen;
    }
    let total = 0, read = 0;
    const get = (name) => {
        const e = entries.find(x => x.name === name);
        if (!e) return null;
        if (++read > MAX_READ) throw new Error('too many files inside');
        if (buffer.readUInt32LE(e.local) !== 0x04034b50) throw new Error('damaged archive');
        const start = e.local + 30 + buffer.readUInt16LE(e.local + 26) + buffer.readUInt16LE(e.local + 28);
        const data = buffer.slice(start, start + e.compressed);
        const room = MAX_TOTAL_BYTES - total;
        let out;
        if (e.method === 0) out = data;
        else if (e.method === 8) out = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, room) });
        else throw new Error('unsupported compression');
        total += out.length;
        if (total >= MAX_TOTAL_BYTES) throw new Error('the file unpacks to too much');
        return out.toString('utf8');
    };
    return { names: entries.map(e => e.name), get };
}

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');

// Paragraph by paragraph: the text runs (<w:t> / <a:t>) of each <w:p> / <a:p>.
function paragraphs(xml, ns) {
    const out = [];
    const paraRe = new RegExp(`<${ns}:p[ >][\\s\\S]*?</${ns}:p>`, 'g');
    const runRe = new RegExp(`<${ns}:t(?:\\s[^>]*)?>([\\s\\S]*?)</${ns}:t>`, 'g');
    for (const para of xml.match(paraRe) || []) {
        let line = '';
        let m;
        runRe.lastIndex = 0;
        while ((m = runRe.exec(para))) line += decode(m[1]);
        if (ns === 'w' && /<w:tab\/>/.test(para) && !line) line = '\t';
        if (line.trim()) out.push(line.trim());
    }
    return out;
}

function extractDocx(buffer) {
    const zip = readZip(buffer);
    const xml = zip.get('word/document.xml');
    if (!xml) throw new Error('no document inside');
    return paragraphs(xml, 'w').join('\n');
}

function extractPptx(buffer) {
    const zip = readZip(buffer);
    const slideNo = (n) => Number((/slide(\d+)\.xml$/.exec(n) || [])[1] || 0);
    const slides = zip.names.filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => slideNo(a) - slideNo(b));
    if (!slides.length) throw new Error('no slides inside');
    const parts = [];
    for (const name of slides) {
        const lines = paragraphs(zip.get(name) || '', 'a');
        // The speaker's notes often hold the explanation the slide only hints at.
        const notesXml = zip.get(`ppt/notesSlides/notesSlide${slideNo(name)}.xml`);
        const notes = notesXml ? paragraphs(notesXml, 'a').filter(l => !/^\d+$/.test(l)) : [];
        if (!lines.length && !notes.length) continue;
        parts.push(`--- Slide ${slideNo(name)} ---\n${lines.join('\n')}${notes.length ? `\n(Notes: ${notes.join(' ')})` : ''}`);
    }
    return parts.join('\n\n');
}

module.exports = { extractDocx, extractPptx, readZip };
