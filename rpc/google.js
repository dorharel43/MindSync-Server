// Google Calendar for the web version - placeholder until the full module
// (per-user OAuth on the server) is in. Same interface the handlers use.
async function insertEvent() {
    return { success: false, error: 'Google Calendar is not connected.' };
}
async function deleteEvent() {}
module.exports = { insertEvent, deleteEvent };
