// Profile / Stats / Settings are each "one document per app" models.
// This fetches that document, creating it with schema defaults the first
// time the app ever runs (so GET never 404s on a fresh database).
async function getSingleton(Model) {
  let doc = await Model.findOne();
  if (!doc) {
    doc = await Model.create({});
  }
  return doc;
}

// Updates the singleton, creating it first if needed. `updates` is merged
// in (partial update), and Mongoose validators still run.
async function updateSingleton(Model, updates) {
  const doc = await Model.findOneAndUpdate({}, updates, {
    new: true,
    upsert: true,
    runValidators: true,
    setDefaultsOnInsert: true,
  });
  return doc;
}

module.exports = { getSingleton, updateSingleton };