'use strict';

// Jork Execution Engine - The Agentic Loop
// The core of Jork's build execution. No CLI dependency.
// Send prompt + tools to any LLM API -> execute tool calls -> loop until done.

var { TOOLS, executeTool, killActiveProcess } = require('./tools');
var { createProvider } = require('./providers');
var { runPreHooks, runPostHooks } = require('./hooks');
var { isDuplicateIntent, recordIntent } = require('../dedup');

var haltPending = false; // Track when we've been told to stop

// Check if user is telling us to stop/wait
function isStopCommand(text) {
    if (!text || typeof text !== 'string') return false;
    var clean = text.toLowerCase().trim();
    
    // Direct command patterns - these are almost always stop commands
    if (/^(stop|wait|hold|pause|halt|nevermind|forget it|stop it)\b/i.test(clean)) return true;
    if (/^(hold on|wait a minute|hold up|wait a sec)/i.test(clean)) return true;
    
    // Multi-word commands in middle of sentence
    if (/\b(stop it|nevermind that|forget that|cancel it|never mind)\b/i.test(clean)) return true;
    
    // Standalone stop/wait words (not part of compound terms)
    // Use positive lookbehind/lookahead to ensure they're standalone commands
    if (/(?:^|[\s.,!?])(stop|wait|hold|pause|halt)(?:$|[\s.,!?])/i.test(clean)) {
        // Exclude common compound terms that contain these words
        var exclusions = [
            'stop loss', 'stop order', 'stop limit',  // trading terms
            'waiting for', 'waiting room',  // waiting as participle
            'hold onto', 'hold of', 'hold over',  // hold prepositions
            'pause button', 'pause menu',  // UI terms
        ];
        for (var i = 0; i < exclusions.length; i++) {
            if (clean.indexOf(exclusions[i]) !== -1) return false;
        }
        return true;
    }
    
    return false;
}

// ===========================================================================
// THE LOOP
// ===========================================================================

// Execute the agent loop.
// Options:
//   provider: provider config object { provider, apiKey, model, baseUrl }
//   system: system prompt string
//   messages: conversation history (array of {role, content})
//   tools: which tools to enable (array of names, or 'all' for all)
//   maxTurns: max tool-use rounds (default 30)
//   timeout: per-API-call timeout in ms (default 120000)
//   maxTokens: max tokens per response (default 4096)
//   onToolCall: callback(name, params) called before each tool execution
//   onToolResult: callback(name, result) called after each tool execution
//   onText: callback(text) called when LLM produces text output
//   cwd: working directory for tool execution

async function execute(opts) {
    // Reset halt flag for this execution. A stale halt from a prior cancelled
    // run would otherwise kill every subsequent build at the first tool call.
    haltPending = false;

    var providerConfig = opts.provider;
    var system = opts.system || '';
    var messages = opts.messages || [];
    var enabledTools = opts.tools || 'all';
    var maxTurns = opts.maxTurns || 30;
    var timeout = opts.timeout || 120000;
    var maxTokens = opts.maxTokens || 4096;
    var onToolCall = opts.onToolCall || function() {};
    var onToolResult = opts.onToolResult || function() {};
    var onText = opts.onText || function() {};
    var onStream = opts.onStream || null; // rate-limited bash output streaming
    var cwd = opts.cwd || process.cwd();

    // Check if ANY user message in history is a recent stop command
    var userMessages = messages.filter(function(m) { return m.role === 'user'; });
    var hasStopCommand = false;
    for (var i = userMessages.length - 1; i >= Math.max(0, userMessages.length - 3); i--) {
        if (isStopCommand(userMessages[i].content)) {
            hasStopCommand = true;
            break;
        }
    }
    
    if (hasStopCommand) {
        var stopMsg = 'stopped. waiting for your next instruction.';
        onText(stopMsg);
        // Still return the result so it gets logged properly
        return {
            text: stopMsg,
            messages: messages,
            toolCalls: 0,
            turns: 0,
            hitLimit: false,
            halted: true,
        };
    }

    // Create provider adapter
    var provider = createProvider(providerConfig);

    // Build tool set
    var activeTools = {};
    if (enabledTools === 'all') {
        activeTools = TOOLS;
    } else if (Array.isArray(enabledTools)) {
        enabledTools.forEach(function(name) {
            if (TOOLS[name]) activeTools[name] = TOOLS[name];
        });
    }

    // Don't chdir — that's shared process state and races under parallel
    // execution. Tools receive cwd per-call via toolParams below.

    var finalText = '';
    var totalToolCalls = 0;
    var recentFailures = []; // Track consecutive failures for loop detection

    for (var turn = 0; turn < maxTurns; turn++) {
        // Call the LLM
        var response = await provider.call(messages, activeTools, {
            system: system,
            maxTokens: maxTokens,
            timeout: timeout,
        });

        // Extract any text content
        var text = provider.getTextContent(response);
        if (text) {
            // Check for duplicate intent before processing
            if (isDuplicateIntent(text)) {
                console.log('[IntentTracker] Duplicate response detected, skipping');
                text = null; // Skip this response
            }
            if (text) {
                finalText = text;
                recordIntent(text); // Record the intent
                onText(text);
            }
        }

        // Check if we should continue (model wants to use tools)
        if (!provider.shouldContinue(response)) {
            break; // Done. Model produced final text.
        }

        // Parse tool calls
        var toolCalls = provider.parseToolCalls(response);
        if (toolCalls.length === 0) break; // No tool calls, done.

        // Add assistant message to history
        messages.push(provider.buildAssistantMessage(response));

        // Execute each tool call
        var results = [];
        for (var i = 0; i < toolCalls.length; i++) {
            var call = toolCalls[i];
            totalToolCalls++;

            onToolCall(call.name, call.arguments);

            // Run pre-hooks (safety checks)
            var hookResult = await runPreHooks(call.name, call.arguments);
            if (hookResult && hookResult.block) {
                onToolResult(call.name, 'Blocked: ' + hookResult.reason);
                results.push({
                    callId: call.id,
                    content: 'Blocked: ' + hookResult.reason,
                    isError: true,
                });
                continue;
            }

            // Execute the tool (async - does not block event loop)
            var toolParams = Object.assign({}, call.arguments);
            // Inject cwd from execute() opts so Bash/Glob/Grep land in the
            // right workspace without relying on process.cwd().
            if (cwd && !toolParams.cwd) toolParams.cwd = cwd;
            // Pass streaming callback for Bash tool only
            if (call.name === 'Bash' && onStream) {
                toolParams.onChunk = onStream;
            }
            var result = await executeTool(call.name, toolParams);

            // Run post-hooks (logging, etc.)
            await runPostHooks(call.name, toolParams, result);

            onToolResult(call.name, result);

            results.push({
                callId: call.id,
                content: String(result),
                isError: String(result).indexOf('Error:') === 0,
            });

            // Loop detection: track consecutive failures with similar patterns
            if (String(result).indexOf('Error:') === 0 || /Exit code [1-9]/.test(String(result))) {
                recentFailures.push(call.name + ':' + (call.arguments.command || '').slice(0, 50));
                if (recentFailures.length >= 5) {
                    // Check if same tool+pattern repeated 3+ times
                    var last3 = recentFailures.slice(-3);
                    if (last3[0] === last3[1] && last3[1] === last3[2]) {
                        console.log('[loop-detector] Same tool failing 3x in a row, breaking loop: ' + last3[0]);
                        var loopMsg = 'Stuck in a loop trying: ' + last3[0] + '. Breaking out to reassess.';
                        onText(loopMsg);
                        finalText = finalText || loopMsg;
                        break;
                    }
                }
            } else {
                recentFailures = []; // Reset on success
            }

            // Check for halt between tool calls
            if (haltPending) {
                onText('stopped mid-step.');
                return {
                    text: 'stopped mid-step.',
                    messages: messages,
                    toolCalls: totalToolCalls,
                    turns: turn + 1,
                    hitLimit: false,
                    halted: true,
                };
            }
        }

        // Add tool results to messages
        var toolResultMsg = provider.buildToolResults(results);
        if (Array.isArray(toolResultMsg)) {
            // OpenAI format: each result is a separate message
            toolResultMsg.forEach(function(m) { messages.push(m); });
        } else {
            // Anthropic format: all results in one user message
            messages.push(toolResultMsg);
        }
    }

    return {
        text: finalText,
        messages: messages,
        toolCalls: totalToolCalls,
        turns: Math.min(turn + 1, maxTurns),
        hitLimit: turn >= maxTurns - 1,
    };
}

// ===========================================================================
// SIMPLE CHAT (no tools, just text response)
// ===========================================================================

async function chat(opts) {
    var provider = createProvider(opts.provider);
    var messages = opts.messages || [];
    var onText = opts.onText || function() {};

    // Check if ANY recent user message is a stop command
    var userMessages = messages.filter(function(m) { return m.role === 'user'; });
    var hasStopCommand = false;
    for (var i = userMessages.length - 1; i >= Math.max(0, userMessages.length - 3); i--) {
        if (isStopCommand(userMessages[i].content)) {
            hasStopCommand = true;
            break;
        }
    }

    if (hasStopCommand) {
        var stopResponse = 'stopped. waiting for your next instruction.';
        onText(stopResponse);
        recordIntent(stopResponse);
        return stopResponse;
    }

    var response = await provider.call(messages, null, {
        system: opts.system || '',
        maxTokens: opts.maxTokens || 2000,
        timeout: opts.timeout || 30000,
    });
    var text = provider.getTextContent(response);
    // Check for duplicate intent before returning
    if (text && isDuplicateIntent(text)) {
        console.log('[IntentTracker] Duplicate chat response detected, skipping');
        return null;
    }
    if (text) recordIntent(text);
    return text;
}

// Request halt - called from jork.js when user sends stop
function requestHalt() {
    haltPending = true;
    killActiveProcess();
}

module.exports = { execute, chat, isStopCommand, requestHalt, killActiveProcess };
