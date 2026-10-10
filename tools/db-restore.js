// Puts a backup from tools/db-backup.js back into a database. Each collection
// in the backup is emptied first and then filled from the backup - so this
// REPLACES those collections' data. Only for a real emergency (or into an
// empty test database): it asks you to type the database's name to confirm.
// Suspend the server on Render first, so no one writes while it runs.
//
//   Windows (PowerShell):
//     $env:RESTORE_MONGO_URI="<address>"; node tools/db-restore.js backups/<folder>
//   Mac / Linux:
//     RESTORE_MONGO_URI="<address>" node tools/db-restore.js backups/<folder>
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { MongoClient, BSON } = require('mongodb');

const uri = process.env.RESTORE_MONGO_URI;
const dir = process.argv[2];
if (!uri || !dir) {
  console.error('Usage: set RESTORE_MONGO_URI, then: node tools/db-restore.js backups/<folder>');
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
// Every file is read and checked BEFORE anything is deleted: a missing or
// broken file stops here, with the database untouched.
let backup;
try {
  backup = Object.entries(manifest.collections).map(([name, expected]) => {
    const docs = fs.readFileSync(path.join(dir, `${name}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => BSON.EJSON.parse(l, { relaxed: false }));
    if (docs.length !== expected) throw new Error(`${name}.jsonl has ${docs.length} documents, the manifest says ${expected}`);
    return { name, docs };
  });
} catch (err) {
  console.error('The backup folder is broken - nothing was changed:', err.message);
  process.exit(1);
}

(async () => {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  const db = client.db();
  console.log(`Backup of "${manifest.database}" taken ${manifest.takenAt}.`);
  console.log(`This REPLACES ${backup.length} collections in the database "${db.databaseName}".`);
  if (manifest.database !== db.databaseName) console.log(`Note: the backup was taken from a different database ("${manifest.database}").`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(r => rl.question(`Type the database name (${db.databaseName}) to continue: `, r));
  rl.close();
  if (answer.trim() !== db.databaseName) { console.log('Not confirmed - nothing changed.'); await client.close(); return; }
  // One collection's error (e.g. a document the server wrote meanwhile
  // clashing with a unique field) is reported, and the rest still go back.
  let problems = 0;
  for (const { name, docs } of backup) {
    let failed = false;
    try {
      await db.collection(name).deleteMany({});
      for (let i = 0; i < docs.length; i += 500) await db.collection(name).insertMany(docs.slice(i, i + 500), { ordered: false });
    } catch (err) {
      failed = true;
      console.error(`${name}: ERROR - ${err.message}`);
    }
    const now = await db.collection(name).countDocuments();
    if (failed || now !== docs.length) problems += 1;
    console.log(`${name}: ${now}${now === docs.length ? '' : `  (the backup had ${docs.length})`}`);
  }
  await client.close();
  console.log(problems ? `\nRestore finished with ${problems} problem(s) - see above.` : '\nRestore done.');
  if (problems) process.exitCode = 1;
})().catch(err => { console.error('Restore failed:', err.message); process.exit(1); });
