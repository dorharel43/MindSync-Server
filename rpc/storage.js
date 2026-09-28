// Uploaded files on the server (web version).
//
// The desktop app kept each file's path on the user's computer (sourcePath)
// and read the PDF from there when the AI needed it. A browser can't do that,
// so the original file is uploaded once and kept here; sourcePath becomes
// "server:<id>". Stored in MongoDB (GridFS), not on disk: Render's disk is
// wiped on every deploy.
//
//   UPLOAD_MAX_MB        (default 20)   - one file (Gemini reads up to ~18MB inline)
//   UPLOAD_USER_CAP_MB   (default 300)  - everything one user keeps
const mongoose = require('mongoose');
const { Readable } = require('stream');
const { currentContext } = require('./context');

const MAX_FILE_BYTES = (Number(process.env.UPLOAD_MAX_MB) || 20) * 1024 * 1024;
const USER_CAP_BYTES = (Number(process.env.UPLOAD_USER_CAP_MB) || 300) * 1024 * 1024;
const PREFIX = 'server:';

function bucket() {
    return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'uploads' });
}

async function usedBytes(userId) {
    const files = await mongoose.connection.db.collection('uploads.files')
        .find({ 'metadata.userId': String(userId) }, { projection: { length: 1 } }).toArray();
    return files.reduce((sum, f) => sum + (f.length || 0), 0);
}

// Returns "server:<id>".
async function save(userId, name, buffer, contentType) {
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
