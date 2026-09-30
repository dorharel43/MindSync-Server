// Uploaded files on the server (web version).
//
// The desktop app kept each file's path on the user's computer (sourcePath)
// and read the PDF from there when the AI needed it. A browser can't do that,
// so the original file is uploaded once and kept here; sourcePath becomes
// "server:<id>". Stored in MongoDB (GridFS), not on disk: Render's disk is
// wiped on every deploy.
//
//   UPLOAD_MAX_MB        (default 20)   - one file (Gemini reads up to ~18MB inline)
//   UPLOAD_USER_CAP_MB   (default 40)   - everything one user keeps
//   UPLOAD_TOTAL_CAP_MB  (default 350)  - everyone together: the free database
//                                         is 512MB for EVERYTHING; when it's
//                                         full, nobody can save anything.
// One user's uploads are stored one at a time (30/9): the cap check and the
// write used to race, so parallel uploads went past the cap.
const mongoose = require('mongoose');
const { Readable } = require('stream');
const { currentContext } = require('./context');

const MAX_FILE_BYTES = (Number(process.env.UPLOAD_MAX_MB) || 20) * 1024 * 1024;
const USER_CAP_BYTES = (Number(process.env.UPLOAD_USER_CAP_MB) || 40) * 1024 * 1024;
const TOTAL_CAP_BYTES = (Number(process.env.UPLOAD_TOTAL_CAP_MB) || 350) * 1024 * 1024;
const PREFIX = 'server:';

function bucket() {
    return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'uploads' });
}

async function usedBytes(userId) {
    const files = await mongoose.connection.db.collection('uploads.files')
        .find({ 'metadata.userId': String(userId) }, { projection: { length: 1 } }).toArray();
    return files.reduce((sum, f) => sum + (f.length || 0), 0);
}

async function totalBytes() {
    const r = await mongoose.connection.db.collection('uploads.files')
        .aggregate([{ $group: { _id: null, n: { $sum: '$length' } } }]).toArray();
    return (r[0] && r[0].n) || 0;
}

// Per-user queue: the next save waits for the previous one.
const queues = new Map();
function serialized(userId, fn) {
    const key = String(userId);
    const prev = queues.get(key) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    queues.set(key, tail);
    tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    return run;
}

// Returns "server:<id>".
function save(userId, name, buffer, contentType) {
    return serialized(userId, () => saveNow(userId, name, buffer, contentType));
}
async function saveNow(userId, name, buffer, contentType) {
    if (buffer.length > MAX_FILE_BYTES) {
        const err = new Error(`This file is ${(buffer.length / 1048576).toFixed(0)}MB - the limit is ${MAX_FILE_BYTES / 1048576}MB. Split it into smaller files.`);
        err.status = 413;
        throw err;
    }
    if (await usedBytes(userId) + buffer.length > USER_CAP_BYTES) {
        const err = new Error(`Your storage is full (${USER_CAP_BYTES / 1048576}MB). Delete some files under Materials first.`);
        err.status = 413;
        throw err;
    }
    if (await totalBytes() + buffer.length > TOTAL_CAP_BYTES) {
        console.error('⚠️ Upload refused: the server\'s total file storage is full.');
        const err = new Error('The server\'s file storage is full right now. The text can still be used - try again later, or tell the developer.');
        err.status = 507;
        throw err;
    }
    const id = await new Promise((resolve, reject) => {
        const up = bucket().openUploadStream(name, { metadata: { userId: String(userId), contentType } });
        Readable.from(buffer).pipe(up).on('error', reject).on('finish', () => resolve(up.id));
    });
    return PREFIX + String(id);
}

function parseId(sourcePath) {
    if (typeof sourcePath !== 'string' || !sourcePath.startsWith(PREFIX)) return null;
    const raw = sourcePath.slice(PREFIX.length);
    return mongoose.Types.ObjectId.isValid(raw) ? new mongoose.Types.ObjectId(raw) : null;
}

// The file's bytes, only for its owner; null when missing / not a server file.
async function read(sourcePath, userId) {
    const id = parseId(sourcePath);
    if (!id || !userId) return null;
    const meta = await mongoose.connection.db.collection('uploads.files').findOne({ _id: id });
    if (!meta || String(meta.metadata && meta.metadata.userId) !== String(userId)) return null;
    const chunks = [];
    await new Promise((resolve, reject) => {
        bucket().openDownloadStream(id).on('data', c => chunks.push(c)).on('error', reject).on('end', resolve);
    });
    return Buffer.concat(chunks);
}

// Used by the ported handlers: the current request's user.
async function readSource(sourcePath) {
    const ctx = currentContext();
    return read(sourcePath, ctx && ctx.userId);
}

async function remove(sourcePath, userId) {
    const id = parseId(sourcePath);
    if (!id) return false;
    const meta = await mongoose.connection.db.collection('uploads.files').findOne({ _id: id });
    if (!meta || String(meta.metadata && meta.metadata.userId) !== String(userId)) return false;
    await bucket().delete(id);
    return true;
}

async function removeAllForUser(userId) {
    const files = await mongoose.connection.db.collection('uploads.files')
        .find({ 'metadata.userId': String(userId) }, { projection: { _id: 1 } }).toArray();
    for (const f of files) await bucket().delete(f._id).catch(() => {});
    return files.length;
}

module.exports = { save, read, readSource, remove, removeAllForUser, parseId, MAX_FILE_BYTES, USER_CAP_BYTES, PREFIX };
