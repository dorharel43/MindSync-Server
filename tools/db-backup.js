// A full backup of the database to a folder on YOUR computer: one file per
// collection, in MongoDB's extended JSON (ids and dates kept exactly), plus a
// manifest with the count of each. Nothing is changed in the database.
//
//   Windows (PowerShell), from the MindSync-Server folder:
//     $env:BACKUP_MONGO_URI="<the MONGO_URI from Render>"; node tools/db-backup.js
//   Mac / Linux:
//     BACKUP_MONGO_URI="<the MONGO_URI from Render>" node tools/db-backup.js
//
// Writes backups/<date-time>/ (the folder is in .gitignore - a backup holds
// users' data and never goes into the repository). Restore: tools/db-restore.js.
const fs = require('fs');
const path = require('path');
const { MongoClient, BSON } = require('mongodb');

const uri = process.env.BACKUP_MONGO_URI;
if (!uri) {
  console.error('Set BACKUP_MONGO_URI to the database address first (see the top of this file).');
  process.exit(1);
}

(async () => {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  const db = client.db();   // the database named in the address
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(__dirname, '..', 'backups', `${db.databaseName}-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { database: db.databaseName, takenAt: new Date().toISOString(), collections: {} };
  const collections = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map(c => c.name).filter(n => !n.startsWith('system.')).sort();
  console.log(`Database "${db.databaseName}": ${collections.length} collections`);
  if (!collections.length) {
    // the wrong address, or one without the database's name (then it's "test")
    console.error('Nothing to back up here - check that the address is the MONGO_URI from Render.');
    fs.rmdirSync(dir);
    await client.close();
    process.exit(1);
  }
  for (const name of collections) {
    const out = fs.createWriteStream(path.join(dir, `${name}.jsonl`));
    let n = 0;
    for await (const doc of db.collection(name).find({})) {
      out.write(BSON.EJSON.stringify(doc, { relaxed: false }) + '\n');
      n += 1;
    }
    await new Promise(r => out.end(r));
    manifest.collections[name] = n;
    console.log(`${name}: ${n}`);
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await client.close();
  console.log(`\nBackup done: ${dir}`);
  console.log('Keep this folder somewhere safe (it holds users\' data - never in git or a public place).');
})().catch(err => { console.error('Backup failed:', err.message); process.exit(1); });
