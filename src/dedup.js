'use strict';

// Intent-level dedup: stops the LLM from sending the same (or near-same)
// response twice within a short rolling window. Shared between the message
// router (jork.js) and the agent loop (engine/loop.js) so confirmations and
// echoes are filtered at both layers with one consistent state.

var WINDOW_MS = 15000;
var _intents = [];

function isDuplicateIntent(response) {
    if (!response || typeof response !== 'string') return false;
    // Skip dedup for long responses (they contain unique content like step results)
    if (response.length > 200) return false;
    var clean = response.toLowerCase().trim().slice(0, 100);
    var now = Date.now();
    _intents = _intents.filter(function(i) { return now - i.ts < WINDOW_MS; });
    for (var i = 0; i < _intents.length; i++) {
        if (_intents[i].text === clean) return true;
    }
    return false;
}

function recordIntent(response) {
    if (!response || typeof response !== 'string') return;
    var clean = response.toLowerCase().trim().slice(0, 100);
    _intents.push({ text: clean, ts: Date.now() });
}

module.exports = { isDuplicateIntent, recordIntent, WINDOW_MS: WINDOW_MS };
