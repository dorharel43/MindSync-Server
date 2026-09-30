// POST /api/uploads   (body: the file itself; header X-File-Name)
//   -> { fileName, fileContent, filePath: 'server:<id>' }
//
// The browser version of "read-upload-file": the desktop app read the file
// from the user's disk; here the browser sends it once, the server keeps the
// original (rpc/storage.js - the AI reads PDFs directly) and extracts its text
// (stored on the FileItem, like before).
const express = require('express');
const path = require('path');
const { requireAuth } = require('../middleware/auth');
const ApiError = require('../middleware/ApiError');
const storage = require('./storage');
const { extractPdfText } = require('./pdfExtract');

const router = express.Router();
const limits = require('../middleware/rateLimit');
const uploadLimit = limits.rateLimit({
    name: 'upload-user', windowMs: 10 * 60 * 1000, max: Number(process.env.UPLOADS_PER_10MIN) || 60, key: limits.byUser,
    message: 'Too many uploads in a short time. Wait a few minutes and try again.'
});
// Reading a PDF's text is CPU work; at most 2 at a time for the whole server.
let extracting = 0;
const waiting = [];
async function withExtractSlot(fn) {
    if (extracting >= 2) await new Promise(r => waiting.push(r));
    extracting += 1;
    try { return await fn(); } finally {
        extracting -= 1;
        const next = waiting.shift();
        if (next) next();
    }
}
const TEXT_TYPES = ['txt', 'md', 'java', 'py', 'js', 'html', 'css', 'json'];

router.post('/', requireAuth, uploadLimit,
    express.raw({ type: () => true, limit: storage.MAX_FILE_BYTES + 1024 * 1024 }),
    async (req, res, next) => {
        try {
            let name = '';
            try { name = decodeURIComponent(String(req.headers['x-file-name'] || '')).trim().slice(0, 250); } catch (e) { name = ''; }
            if (!name) throw new ApiError(400, 'Missing file name.');
            const ext = path.extname(name).slice(1).toLowerCase();
            if (ext !== 'pdf' && !TEXT_TYPES.includes(ext)) throw new ApiError(415, `.${ext} files aren't supported. Supported: pdf, ${TEXT_TYPES.join(', ')}.`);
            const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
            if (!buffer.length) throw new ApiError(400, 'The file is empty.');

            let fileContent = '';
            let filePath = '';
            if (ext === 'pdf') {
                if (buffer.slice(0, 5).toString() !== '%PDF-') throw new ApiError(415, 'This doesn\'t look like a PDF file.');
                const info = {};
                try {
                    fileContent = String(await withExtractSlot(() => extractPdfText(buffer, info)) || '').slice(0, 1500000);
                } catch (err) {
                    // A scanned or unusual PDF: no text, but the AI can still
                    // read the stored original directly.
                    console.warn('upload: text extraction failed:', err.message);
                }
                filePath = await storage.save(req.userId, name, buffer, 'application/pdf', { numPages: info.numPages || null });
            } else {
                fileContent = buffer.toString('utf-8').slice(0, 1500000);
            }
            res.status(201).json({ fileName: name, fileContent, filePath });
        } catch (err) {
            next(err.status ? new ApiError(err.status, err.message) : err);
        }
    });

// A file far over the limit is stopped while it's still arriving (express.raw
// above) - same plain message as the size check in storage.save().
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') {
        return next(new ApiError(413, `This file is too large - the limit is ${Math.round(storage.MAX_FILE_BYTES / 1048576)}MB. Split it into smaller files.`));
    }
    next(err);
});

module.exports = router;
