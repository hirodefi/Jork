'use strict';

// Jork Execution Engine - Pre/Post Tool Hooks
// Intercept tool calls for validation, safety, and logging.
// Inspired by Claude Code's hookify system.
//
// The workspace path is read from ../config at invocation time so the same
// code works for any install location (user's machine, server, CI). It is
// never hardcoded to a specific absolute path.

var cfg = require('../config');

var PRE_HOOKS = [];
var POST_HOOKS = [];

function addPreHook(fn) { PRE_HOOKS.push(fn); }
function addPostHook(fn) { POST_HOOKS.push(fn); }

// Run pre-hooks before tool execution. Returns null to proceed, or { block, reason } to halt.
async function runPreHooks(toolName, params) {
    for (var i = 0; i < PRE_HOOKS.length; i++) {
        try {
            var result = await PRE_HOOKS[i](toolName, params);
            if (result && result.block) return result;
        } catch(e) {
            console.log('[hooks] pre-hook error: ' + e.message);
        }
    }
    return null;
}

// Run post-hooks after tool execution.
async function runPostHooks(toolName, params, result) {
    for (var i = 0; i < POST_HOOKS.length; i++) {
        try { await POST_HOOKS[i](toolName, params, result); }
        catch(e) { console.log('[hooks] post-hook error: ' + e.message); }
    }
}

// ---- Built-in safety hooks ----

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Block destructive and credential-exposing Bash commands.
addPreHook(function(toolName, params) {
    if (toolName !== 'Bash') return null;
    var cmd = (params.command || '');

    // Block broad destructive patterns targeting real filesystem roots.
    // Examples: `rm -rf /`, `rm -rf /etc`, `rm -rf /home`, `rm -rf ~`, `rm -rf $HOME`
    var rootRe = escapeRegex(cfg.ROOT);
    var dangerousRm = /rm\s+-[rRf]+\s+(\/(?:etc|root|home|var|usr|bin|boot|dev|sys|opt)\b|\/\s|\/$|~\/?$|\$HOME\b)/i;
    if (dangerousRm.test(cmd) && !new RegExp(rootRe, 'i').test(cmd)) {
        return { block: true, reason: 'destructive command outside Jork root blocked' };
    }

    // Block bare `rm -rf /` with a trailing path only if it's not inside cfg.ROOT.
    if (/rm\s+-[rRf]+\s+\//i.test(cmd) && !new RegExp(rootRe, 'i').test(cmd)) {
        return { block: true, reason: 'rm -rf outside Jork root blocked' };
    }

    // Block credential exposure via common readers.
    if (/\b(?:cat|less|more|head|tail|bat|view|type)\s+[^|&;]*\.(env|pem|key|keypair|secret)\b/i.test(cmd)) {
        return { block: true, reason: 'potential credential exposure blocked' };
    }
    if (/\b(?:printenv|env)\b(?!\s+[-A-Z_]*=)/i.test(cmd) && !/\bgrep\b/i.test(cmd)) {
        return { block: true, reason: 'env dump blocked' };
    }
    if (/echo\s+.*\$(?:LLM_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|TELEGRAM_BOT_TOKEN|BRAVE_API_KEY|SERPAPI_KEY)\b/i.test(cmd)) {
        return { block: true, reason: 'secret echo blocked' };
    }

    return null;
});

// Block file reads/writes outside the Jork install tree.
addPreHook(function(toolName, params) {
    if (toolName !== 'Read' && toolName !== 'Write' && toolName !== 'Edit') return null;
    var filePath = params.file_path || '';
    if (!filePath) return null;

    // Relative paths are resolved against cfg.WORKSPACE by the tool, so allow.
    if (!filePath.startsWith('/')) return null;

    // Allow anywhere inside the Jork install or the workspace (which may be a
    // sibling dir if JORK_WORKSPACE points outside ROOT).
    if (filePath.startsWith(cfg.ROOT)) return null;
    if (filePath.startsWith(cfg.WORKSPACE)) return null;

    // Allow /tmp for scratch work.
    if (filePath.startsWith('/tmp/')) return null;

    return { block: true, reason: 'file path outside workspace: ' + filePath };
});

// Log Bash commands for debugging
addPostHook(function(toolName, params, result) {
    if (toolName === 'Bash') {
        var cmd = (params.command || '').slice(0, 100);
        var exitMatch = String(result).match(/Exit code (\d+)/);
        if (exitMatch && exitMatch[1] !== '0') {
            console.log('[hooks] bash failed: ' + cmd + ' (exit ' + exitMatch[1] + ')');
        }
    }
});

module.exports = { addPreHook, addPostHook, runPreHooks, runPostHooks };
