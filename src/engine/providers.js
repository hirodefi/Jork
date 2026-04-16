'use strict';

// Jork Execution Engine - Provider Adapters
// Translates between Jork's tool format and each LLM API's format.
// Two adapter types cover all providers:
//   1. Anthropic format (Anthropic API, Z.AI/GLM)
//   2. OpenAI format (OpenAI, Gemini via compatibility)

const https = require('https');

// ---- HTTP helper with retry ----

var RETRY_DELAYS = [2000, 6000, 18000]; // exponential: 2s, 6s, 18s
var RETRY_STATUS_CODES = [429, 500, 502, 503, 504];

function sleep(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function httpPost(hostname, apiPath, headers, body, timeout) {
    return new Promise(function(resolve, reject) {
        var data = JSON.stringify(body);
        var req = https.request({
            hostname: hostname,
            path: apiPath,
            method: 'POST',
            headers: Object.assign({
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
            }, headers),
        }, function(res) {
            var chunks = '';
            res.on('data', function(c) { chunks += c; });
            res.on('end', function() {
                try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); }
                catch(e) { resolve({ status: res.statusCode, body: chunks }); }
            });
        });
        req.on('error', reject);
        req.setTimeout(timeout || 120000, function() { req.destroy(); reject(new Error('Request timeout')); });
        req.write(data);
        req.end();
    });
}

// Retry wrapper - retries on rate limits and server errors
async function httpPostWithRetry(hostname, apiPath, headers, body, timeout) {
    var lastError;
    for (var attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
        try {
            var result = await httpPost(hostname, apiPath, headers, body, timeout);
            // Check for retryable status codes
            if (result.status && RETRY_STATUS_CODES.indexOf(result.status) !== -1 && attempt < RETRY_DELAYS.length) {
                var delay = RETRY_DELAYS[attempt] + Math.floor(Math.random() * 1000); // jitter
                console.log('[provider] HTTP ' + result.status + ', retrying in ' + (delay / 1000) + 's (attempt ' + (attempt + 1) + ')');
                await sleep(delay);
                continue;
            }
            // Return the body directly (backward compatible)
            if (result.status >= 400 && result.body && result.body.error) {
                throw new Error('API error: ' + (result.body.error.message || JSON.stringify(result.body.error)));
            }
            return result.body || result;
        } catch(e) {
            lastError = e;
            // Network errors are retryable
            if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET|network|socket hang up/i.test(e.message) && attempt < RETRY_DELAYS.length) {
                var netDelay = RETRY_DELAYS[attempt] + Math.floor(Math.random() * 1000);
                console.log('[provider] Network error, retrying in ' + (netDelay / 1000) + 's: ' + e.message);
                await sleep(netDelay);
                continue;
            }
            throw e;
        }
    }
    throw lastError;
}

// ===========================================================================
// ANTHROPIC ADAPTER (covers Anthropic API + Z.AI/GLM)
// ===========================================================================

function AnthropicAdapter(config) {
    this.apiKey = config.apiKey;
    this.model = config.model || 'claude-sonnet-4-6';
    this.baseUrl = config.baseUrl || 'https://api.anthropic.com';
    // Parse hostname and path from baseUrl
    var parsed = new URL(this.baseUrl);
    this.hostname = parsed.hostname;
    this.basePath = parsed.pathname.replace(/\/$/, '');
}

AnthropicAdapter.prototype.formatTools = function(tools) {
    return Object.values(tools).map(function(t) {
        return {
            name: t.name,
            description: t.description,
            input_schema: t.schema,
        };
    });
};

AnthropicAdapter.prototype.call = async function(messages, tools, opts) {
    opts = opts || {};
    var body = {
        model: this.model,
        max_tokens: opts.maxTokens || 4096,
        messages: messages,
    };
    if (opts.system) body.system = opts.system;
    if (tools && Object.keys(tools).length > 0) {
        body.tools = this.formatTools(tools);
    }

    var headers = {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
    };

    var response = await httpPostWithRetry(this.hostname, this.basePath + '/v1/messages', headers, body, opts.timeout || 120000);

    if (response.error) {
        throw new Error('API error: ' + (response.error.message || JSON.stringify(response.error)));
    }

    return response;
};

AnthropicAdapter.prototype.parseToolCalls = function(response) {
    var calls = [];
    if (!response.content) return calls;
    for (var i = 0; i < response.content.length; i++) {
        var block = response.content[i];
        if (block.type === 'tool_use') {
            calls.push({
                id: block.id,
                name: block.name,
                arguments: block.input || {},
            });
        }
    }
    return calls;
};

AnthropicAdapter.prototype.shouldContinue = function(response) {
    return response.stop_reason === 'tool_use';
};

AnthropicAdapter.prototype.getTextContent = function(response) {
    if (!response.content) return '';
    return response.content
        .filter(function(b) { return b.type === 'text'; })
        .map(function(b) { return b.text; })
        .join('\n');
};

AnthropicAdapter.prototype.buildAssistantMessage = function(response) {
    return { role: 'assistant', content: response.content };
};

AnthropicAdapter.prototype.buildToolResults = function(results) {
    return {
        role: 'user',
        content: results.map(function(r) {
            return {
                type: 'tool_result',
                tool_use_id: r.callId,
                content: r.content,
                is_error: r.isError || false,
            };
        }),
    };
};

// ===========================================================================
// OPENAI ADAPTER (covers OpenAI + Gemini via OpenAI-compatible endpoints)
// ===========================================================================

function OpenAIAdapter(config) {
    this.apiKey = config.apiKey;
    this.model = config.model || 'gpt-4o';
    this.baseUrl = config.baseUrl || 'https://api.openai.com';
    var parsed = new URL(this.baseUrl);
    this.hostname = parsed.hostname;
    this.basePath = parsed.pathname.replace(/\/$/, '');
}

OpenAIAdapter.prototype.formatTools = function(tools) {
    return Object.values(tools).map(function(t) {
        return {
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: t.schema,
            },
        };
    });
};

OpenAIAdapter.prototype.call = async function(messages, tools, opts) {
    opts = opts || {};

    // OpenAI/Gemini take the system prompt as a role:'system' message, not a
    // top-level field. Prepend it unless the caller already did.
    var outgoing = messages;
    if (opts.system && (!messages.length || messages[0].role !== 'system')) {
        outgoing = [{ role: 'system', content: opts.system }].concat(messages);
    }

    var body = {
        model: this.model,
        max_tokens: opts.maxTokens || 4096,
        messages: outgoing,
    };
    if (tools && Object.keys(tools).length > 0) {
        body.tools = this.formatTools(tools);
    }

    var headers = {
        'Authorization': 'Bearer ' + this.apiKey,
    };

    var response = await httpPostWithRetry(this.hostname, this.basePath + '/v1/chat/completions', headers, body, opts.timeout || 120000);

    if (response.error) {
        throw new Error('API error: ' + (response.error.message || JSON.stringify(response.error)));
    }

    return response;
};

OpenAIAdapter.prototype.parseToolCalls = function(response) {
    var calls = [];
    var choice = response.choices && response.choices[0];
    if (!choice || !choice.message || !choice.message.tool_calls) return calls;
    for (var i = 0; i < choice.message.tool_calls.length; i++) {
        var tc = choice.message.tool_calls[i];
        var args = {};
        try { args = JSON.parse(tc.function.arguments); } catch(e) {}
        calls.push({
            id: tc.id,
            name: tc.function.name,
            arguments: args,
        });
    }
    return calls;
};

OpenAIAdapter.prototype.shouldContinue = function(response) {
    var choice = response.choices && response.choices[0];
    return choice && choice.finish_reason === 'tool_calls';
};

OpenAIAdapter.prototype.getTextContent = function(response) {
    var choice = response.choices && response.choices[0];
    return (choice && choice.message && choice.message.content) || '';
};

OpenAIAdapter.prototype.buildAssistantMessage = function(response) {
    var choice = response.choices && response.choices[0];
    return choice ? choice.message : { role: 'assistant', content: '' };
};

OpenAIAdapter.prototype.buildToolResults = function(results) {
    return results.map(function(r) {
        return {
            role: 'tool',
            tool_call_id: r.callId,
            content: r.content,
        };
    });
};

// ===========================================================================
// PROVIDER FACTORY
// ===========================================================================

function createProvider(config) {
    var provider = config.provider || 'anthropic';

    if (provider === 'anthropic' || provider === 'claude-cli') {
        return new AnthropicAdapter({
            apiKey: config.apiKey,
            model: config.model || 'claude-sonnet-4-6',
            baseUrl: config.baseUrl || 'https://api.anthropic.com',
        });
    }

    if (provider === 'zai') {
        return new AnthropicAdapter({
            apiKey: config.apiKey,
            model: config.model || 'glm-5.1',
            baseUrl: config.baseUrl || 'https://api.z.ai/api/anthropic',
        });
    }

    if (provider === 'openai') {
        return new OpenAIAdapter({
            apiKey: config.apiKey,
            model: config.model || 'gpt-4o',
            baseUrl: config.baseUrl || 'https://api.openai.com',
        });
    }

    if (provider === 'gemini') {
        return new OpenAIAdapter({
            apiKey: config.apiKey,
            model: config.model || 'gemini-2.5-flash',
            baseUrl: config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta/openai',
        });
    }

    // Default to Anthropic format
    return new AnthropicAdapter(config);
}

module.exports = { createProvider, AnthropicAdapter, OpenAIAdapter };
