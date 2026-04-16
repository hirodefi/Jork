'use strict';

// Jork Execution Engine - Build State Persistence
// Saves build state after each step to JSONL.
// On restart, checks for interrupted builds and offers to resume.

const fs = require('fs');
const path = require('path');

function statePath(nucleusDir) {
    return path.join(nucleusDir, 'build-state.jsonl');
}

// Save a checkpoint after each step
function saveCheckpoint(nucleusDir, data) {
    var entry = {
        ts: new Date().toISOString(),
        type: data.type || 'step_complete',
        request: data.request || '',
        step: data.step || 0,
        totalSteps: data.totalSteps || 0,
        stepDesc: data.stepDesc || '',
        result: data.result || '',
    };
    try {
        fs.appendFileSync(statePath(nucleusDir), JSON.stringify(entry) + '\n');
    } catch(e) {
        console.log('[persistence] save error: ' + e.message);
    }
}

// Check for interrupted build on startup
function checkInterrupted(nucleusDir) {
    var filePath = statePath(nucleusDir);
    if (!fs.existsSync(filePath)) return null;

    try {
        var lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
        if (lines.length === 0) return null;

        var buildStart = null;
        var completedSteps = [];
        var lastEntry = null;

        for (var i = 0; i < lines.length; i++) {
            var entry = JSON.parse(lines[i]);
            if (entry.type === 'build_start') buildStart = entry;
            if (entry.type === 'step_complete') completedSteps.push(entry);
            lastEntry = entry;
        }

        if (!buildStart) return null;

        return {
            request: buildStart.request,
            plan: buildStart.plan,
            completedSteps: completedSteps.length,
            totalSteps: buildStart.totalSteps || 0,
            lastStep: lastEntry ? lastEntry.step : 0,
        };
    } catch(e) {
        console.log('[persistence] check error: ' + e.message);
        return null;
    }
}

// Clear build state
function clearState(nucleusDir) {
    try {
        var filePath = statePath(nucleusDir);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch(e) {}
}

module.exports = { saveCheckpoint, checkInterrupted, clearState };
