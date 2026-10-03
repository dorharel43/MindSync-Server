// A guard for the owner's AI test tools (tools/exam-check.js, and the
// private set's sample-exams / real-* tools): a run that is stuck or keeps
// failing stops instead of spending tokens - and money, on a paid key - for
// nothing. Not used by the running server.
//
//   const guard = require('./ai-guard').create({ maxCalls: 30, label: 'sample exams' });
//   guard.wrap(aiProvider);              // counts generateText / generateFromPdf / generateFromImages
//   ...
//   guard.itemFailed('no usable exam');  // a failure the tool sees, not the AI call
//   guard.itemOk();
//
// It stops the run (every later call throws GuardStop) when:
//   - the run isn't approved: a real key needs --approved or AI_GUARD_APPROVED=1.
//     Only a fake Gemini (GEMINI_BASE_URL, not Google's host) with no
//     OpenRouter key is free - OpenRouter is a real, paid vendor either way;
//   - a call fails in a way that won't pass by itself: the monthly spending
//     cap, a rejected key, the day's quota;
//   - the same failure comes back --max-same times, or --max-failures calls
//     or items in a row fail (a cut-off answer counts: the tokens were spent);
//   - --max-calls calls, --max-tokens tokens (input + thinking + output) or
//     --max-minutes minutes are used up. Past the minutes plus 12 (a single
//     call may take 10 - a 5-minute timeout, retried once), a stuck call ends
//     the process - after the tool's onExit (e.g. saving its report).
// A summary (calls, tokens, failures, why it stopped) is printed at exit.
//
// Limits come from the command line (--max-calls 30 --max-tokens 600000
// --max-minutes 30 --max-failures 3 --max-same 3 --max-busy 6), else the
// tool's options, else the defaults below.

class GuardStop extends Error {
    constructor(message) { super(message); this.name = 'GuardStop'; this.guardStop = true; }
}

function argValue(name) {
    const i = process.argv.indexOf(`--${name}`);
    if (i === -1) return undefined;
    const next = process.argv[i + 1];
    return next === undefined || next.startsWith('--') ? true : next;
}
const num = (v, d) => (Number(v) > 0 ? Number(v) : d);

// Two failures are "the same" when they differ only in numbers (seconds,
// counts, ids) - "timed out after 90s" and "after 91s" are one problem.
const signature = (msg) => String(msg || '').replace(/\d+(\.\d+)?/g, '#').replace(/\s+/g, ' ').trim().slice(0, 160);

// A failure that won't pass by waiting a minute: stop at once, never retry.
function fatalReason(err) {
    if (!err) return null;
    if (err.spendingCap || /spending cap|budget .* used up/i.test(err.message)) return `the key's monthly spending cap was reached (${err.message})`;
    if (err.badKey || /rejected the key|API key not valid/i.test(err.message)) return `the key was rejected (${err.message})`;
    if (err.dailyQuota || /today's .*quota/i.test(err.message)) return `the key's daily quota ran out (${err.message})`;
    return null;
}
// Google busy or "slow down" - costs no tokens, only time.
const isBusy = (err) => !!err && (err.status === 429 || err.status === 503 || err.overloaded || /\b(429|503)\b|rate limit|overloaded|high demand|busy/i.test(err.message));

function create(options = {}) {
    // (the command line wins: a tool's own default is a default)
    const o = (key, flag, d) => num(argValue(flag) !== undefined ? argValue(flag) : options[key], d);
    const limits = {
        maxCalls: o('maxCalls', 'max-calls', 40),
        maxTokens: o('maxTokens', 'max-tokens', 600000),
        maxMinutes: o('maxMinutes', 'max-minutes', 30),
        maxFailures: o('maxFailures', 'max-failures', 3),
        maxSame: o('maxSame', 'max-same', 3),
        // busy / rate-limited in a row (free, but a stuck queue)
        maxBusy: o('maxBusy', 'max-busy', 6)
    };
    const label = options.label || require('path').basename(process.argv[1] || 'ai tool');
    // The tools run the SERVER's rpc/aiProvider.js, which reads GEMINI_BASE_URL
    // only (the desktop app's MINDSYNC_TEST_GEMINI_URL doesn't count here).
    const base = String(process.env.GEMINI_BASE_URL || '');
    const fake = !!base && !/googleapis\.com/i.test(base) && !process.env.OPENROUTER_API_KEY;
    const approved = fake || options.approved === true || process.argv.includes('--approved') || process.env.AI_GUARD_APPROVED === '1';

    const startedAt = Date.now();
    const state = {
        calls: 0, input: 0, thinking: 0, output: 0, cutOff: 0,
        failures: 0, inARow: 0, itemsInARow: 0, busyInARow: 0, same: new Map(), stopped: null,
        lastCallFailure: null   // the last call's failure, until a call succeeds
    };
    const tokens = () => state.input + state.thinking + state.output;
    const minutes = () => (Date.now() - startedAt) / 60000;

    function stop(reason) {
        if (!state.stopped) {
            state.stopped = reason;
            console.warn(`\n🛑 ai-guard: ${reason} - no more AI calls in this run.`);
        }
        return new GuardStop(`ai-guard stopped the run: ${state.stopped}`);
    }
    // Counts one failure (a call's, or an item's - item = true). Returns a
    // GuardStop when it's one too many. The streaks are kept apart: a call
    // that "worked" but returned nothing usable mustn't reset the items'.
    function failed(message, item = false) {
        const sig = signature(message);
        // An item that failed BECAUSE its call failed (the same message) is one
        // failure, not two: it adds to the items' streak only.
        const sameAsCall = item && state.lastCallFailure === sig;
        if (item) state.itemsInARow += 1; else state.inARow += 1;
        if (!item) { state.lastCallFailure = sig; state.busyInARow = 0; }
        let seen = state.same.get(sig) || 0;
        if (!sameAsCall) {
            state.failures += 1;
            seen += 1;
            state.same.set(sig, seen);
        }
        if (seen >= limits.maxSame) return stop(`the same failure ${seen} times: "${sig}"`);
        const inARow = item ? state.itemsInARow : state.inARow;
        if (inARow >= limits.maxFailures) return stop(`${inARow} failures in a row (last: "${sig}")`);
        return null;
    }
    function beforeCall() {
        if (state.stopped) throw new GuardStop(`ai-guard stopped the run: ${state.stopped}`);
        if (!approved) throw stop('this uses the real key and the run is not approved (add --approved, or AI_GUARD_APPROVED=1)');
        if (state.calls >= limits.maxCalls) throw stop(`${limits.maxCalls} AI calls used (--max-calls)`);
        if (tokens() >= limits.maxTokens) throw stop(`${tokens()} tokens used (--max-tokens ${limits.maxTokens})`);
        if (minutes() >= limits.maxMinutes) throw stop(`${limits.maxMinutes} minutes passed (--max-minutes)`);
    }

    function wrap(aiProvider, names = ['generateText', 'generateFromPdf', 'generateFromImages']) {
        if (typeof aiProvider.onUsage === 'function') {
            aiProvider.onUsage((u) => {
                state.input += u.input || 0;
                state.thinking += u.thinking || 0;
                state.output += u.output || 0;
                if (u.finish === 'MAX_TOKENS') state.cutOff += 1;
            });
        }
        for (const name of names) {
            if (typeof aiProvider[name] !== 'function') continue;
            const real = aiProvider[name].bind(aiProvider);
            aiProvider[name] = async (...a) => {
                beforeCall();
                state.calls += 1;
                // (calls the tools run side by side may see each other's cut-off - still counted once each)
                const cutBefore = state.cutOff;
                try {
                    const result = await real(...a);
                    // An answer cut off at the token limit was paid for and is
                    // usually unusable - a failure, not a success.
                    if (state.cutOff > cutBefore) {
                        const s = failed('an answer was cut off by the token limit (MAX_TOKENS)');
                        if (s) throw s;
                    } else {
                        state.inARow = 0;
                        state.lastCallFailure = null;
                    }
                    state.busyInARow = 0;
                    return result;
                } catch (err) {
                    if (err instanceof GuardStop) throw err;
                    const fatal = fatalReason(err);
                    if (fatal) throw stop(fatal);
                    if (isBusy(err)) {
                        state.busyInARow += 1;
                        state.lastCallFailure = signature(err.message);
                        if (state.busyInARow >= limits.maxBusy) throw stop(`Google busy or rate-limited ${state.busyInARow} times in a row (last: ${err.message})`);
                        throw err;   // the tool may wait and retry - each retry passes here again
                    }
                    const s = failed(err.message);
                    if (s) throw s;
                    throw err;
                }
            };
        }
        return guard;
    }

    function summary() {
        const lines = [
            `ai-guard (${label}): ${state.calls} AI calls, ${tokens()} tokens (in ${state.input} | thinking ${state.thinking} | out ${state.output})` +
            `, ${Math.round(minutes() * 10) / 10} min, ${state.failures} failures${state.cutOff ? `, ${state.cutOff} cut off` : ''}`,
            state.stopped ? `   stopped: ${state.stopped}` : '   finished within its limits'
        ];
        return lines.join('\n');
    }

    // Past the time limit a call can still hang (a stalled connection): 12
    // minutes more (longer than any single call), then the process ends -
    // after the tool's onExit, then the summary.
    const GRACE_MIN = 12;
    let onExit = typeof options.onExit === 'function' ? options.onExit : null;
    const watchdog = setTimeout(() => {
        stop(`still running ${limits.maxMinutes + GRACE_MIN} minutes in - a call is stuck`);
        try { if (onExit) onExit(); } catch (e) { console.error('ai-guard: onExit failed:', e.message); }
        process.exit(3);
    }, (limits.maxMinutes + GRACE_MIN) * 60000);
    watchdog.unref();
    process.on('exit', () => console.log('\n' + summary()));

    const guard = {
        wrap,
        // A failure the tool sees in what came back ("no usable exam"),
        // counted with the calls' failures. Throws GuardStop when it's one too many.
        itemFailed(message) { const s = failed(message, true); if (s) throw s; },
        itemOk() { state.itemsInARow = 0; },
        isStop: (err) => !!(err && err.guardStop),
        // Run before the watchdog ends a stuck process (e.g. save the report).
        onExit(fn) { onExit = fn; return guard; },
        stopped: () => state.stopped,
        stats: () => ({ calls: state.calls, tokens: tokens(), input: state.input, thinking: state.thinking, output: state.output, failures: state.failures, cutOff: state.cutOff, minutes: minutes(), stopped: state.stopped }),
        summary,
        limits,
        approved,
        // Prints what the run may spend; exits before any call when a real key isn't approved.
        announce() {
            console.log(`ai-guard (${label}): ${fake ? 'fake Gemini' : 'REAL key (Gemini or OpenRouter)'} - at most ${limits.maxCalls} calls, ${limits.maxTokens} tokens, ${limits.maxMinutes} min; ` +
                `stops after ${limits.maxFailures} failures in a row or the same one ${limits.maxSame} times.`);
            if (!approved) {
                console.error('Not approved: this run can reach a real, paid AI (a real Gemini key, or OpenRouter). Ask first, then re-run with --approved.');
                process.exit(2);
            }
            return guard;
        }
    };
    return guard;
}

module.exports = { create, GuardStop, signature, fatalReason };
