'use strict';
const { spawn } = require('child_process');
const cfg = require('./config');

// ---- Claude CLI bridge ----

var _workCallCount = 0;
var SESSION_RESET_EVERY = 20; // start fresh session every 20 work calls

function loadSessionId() {
    const fs = require('fs');
    try { return fs.readFileSync(cfg.THREAD, 'utf8').trim(); } catch(e) { return null; }
}

function saveSessionId(sid) {
    try { require('fs').writeFileSync(cfg.THREAD, sid); } catch(e) {}
}

function resetSession() {
    try { require('fs').unlinkSync(cfg.THREAD); } catch(e) {}
    _workCallCount = 0;
}

// Build env vars for Claude CLI based on LLM provider
function buildClaudeEnv() {
    var env = Object.assign({}, process.env);
    delete env.CLAUDECODE;

    var provider = cfg.LLM_PROVIDER;

    if (provider === 'zai' && cfg.LLM_API_KEY) {
        env.ANTHROPIC_AUTH_TOKEN = cfg.LLM_API_KEY;
        env.ANTHROPIC_BASE_URL = cfg.ZAI_BASE_URL;
        env.ANTHROPIC_MODEL = cfg.LLM_MODEL || cfg.ZAI_MODEL;
        // Map GLM models to Claude model slots for claude CLI
        env.ANTHROPIC_DEFAULT_SONNET_MODEL = cfg.LLM_MODEL || 'glm-5.1';
        env.ANTHROPIC_DEFAULT_HAIKU_MODEL = cfg.LLM_MODEL || 'glm-4.7';
        env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'glm-5';
    } else if (provider === 'anthropic' && cfg.LLM_API_KEY) {
        env.ANTHROPIC_AUTH_TOKEN = cfg.LLM_API_KEY;
    } else if (provider === 'openai' && cfg.LLM_API_KEY) {
        env.ANTHROPIC_AUTH_TOKEN = cfg.LLM_API_KEY;
        env.ANTHROPIC_BASE_URL = cfg.LLM_BASE_URL;
        env.ANTHROPIC_MODEL = cfg.LLM_MODEL || cfg.OPENAI_MODEL;
    } else if (provider === 'gemini' && cfg.LLM_API_KEY) {
        env.ANTHROPIC_AUTH_TOKEN = cfg.LLM_API_KEY;
        env.ANTHROPIC_BASE_URL = cfg.LLM_BASE_URL;
        env.ANTHROPIC_MODEL = cfg.LLM_MODEL || cfg.GEMINI_MODEL;
    }

    return env;
}

function invokeClaude(prompt, opts) {
    return new Promise(function(resolve) {
        var maxTurns = (opts && opts.maxTurns) || cfg.MAX_TURNS;
        var useTools = (opts && opts.tools) || false;

        var args = ['-p', '--output-format', 'text'];

        if (useTools) {
            _workCallCount++;
            if (_workCallCount >= SESSION_RESET_EVERY) {
                resetSession();
                console.log('[LLM] session reset (every ' + SESSION_RESET_EVERY + ' calls)');
            }
            args.push('--max-turns', String(maxTurns));
            args.push('--allowedTools', 'Read,Write,Edit,Bash,Glob,Grep,WebSearch,WebFetch');
            if (!opts.noResume) {
                var sessionId = loadSessionId();
                if (sessionId) { args.push('--resume', sessionId); }
            }
        } else {
            prompt = "IMPORTANT: Reply with plain text only. Do not use any tools or functions.\n\n" + prompt;
            args.push('--max-turns', '3');
        }

        // Image support for Claude CLI
        if (opts && opts.imagePath) {
            args.push('--image', opts.imagePath);
        }

        var claudeCli = process.env.CLAUDE_CLI || 'claude';
        var stdout = '';
        var stderr = '';
        var resolved = false;

        var env = buildClaudeEnv();

        var proc = spawn(claudeCli, args, {
            cwd: cfg.WORKSPACE,
            env: env,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        proc.stdin.write(prompt);
        proc.stdin.end();

        var timer = setTimeout(function() {
            if (!resolved) {
                resolved = true;
                try { proc.kill('SIGTERM'); } catch(e) {}
                setTimeout(function() { try { proc.kill('SIGKILL'); } catch(e) {} }, 5000);
                resolve(stdout.trim() || null);
            }
        }, cfg.INVOKE_TIMEOUT);

        proc.stdout.on('data', function(d) { stdout += d.toString(); });
        proc.stderr.on('data', function(d) { stderr += d.toString(); });

        proc.on('close', function(code) {
            clearTimeout(timer);
            if (resolved) return;
            resolved = true;
            console.log('[LLM] mode=' + (useTools ? 'work' : 'chat') + ' exit=' + code + ' out=' + stdout.length + 'b');
            if (code !== 0) console.log('[LLM] stderr: ' + stderr.slice(0, 500));
            if (useTools && stderr.indexOf('session_id') !== -1) {
                var m = stderr.match(/"session_id"\s*:\s*"([^"]+)"/);
                if (m) saveSessionId(m[1]);
            }
            var response = stdout.trim();
            if (code !== 0 && !response) { resolve(null); }
            else { resolve(response); }
        });

        proc.on('error', function(e) {
            clearTimeout(timer);
            if (!resolved) { resolved = true; resolve(null); }
        });
    });
}

// ---- OpenAI-compatible API (OpenAI, Gemini via compatibility) ----

function invokeOpenAI(systemPrompt, userPrompt, opts) {
    return new Promise(function(resolve) {
        var OpenAI = require('openai');
        var baseURL = cfg.LLM_BASE_URL || 'https://api.openai.com/v1';
        var provider = cfg.LLM_PROVIDER;
        var model = cfg.LLM_MODEL || (provider === 'gemini' ? cfg.GEMINI_MODEL : cfg.OPENAI_MODEL);

        var client = new OpenAI({ apiKey: cfg.LLM_API_KEY, baseURL: baseURL });

        var messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ];

        // Image support via base64
        if (opts && opts.imageBase64) {
            messages[1] = {
                role: 'user',
                content: [
                    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + opts.imageBase64 } },
                    { type: 'text', text: userPrompt }
                ]
            };
        }

        client.chat.completions.create({
            model: model,
            messages: messages,
            max_tokens: 4096
        }).then(function(res) {
            resolve(res.choices[0].message.content || null);
        }).catch(function(e) {
            console.log('[LLM] OpenAI error: ' + (e.message || e));
            resolve(null);
        });
    });
}

// ---- Anthropic API direct ----

function invokeAnthropic(systemPrompt, userPrompt, opts) {
    return new Promise(function(resolve) {
        var Anthropic = require('@anthropic-ai/sdk');
        var client = new Anthropic.Anthropic({ apiKey: cfg.LLM_API_KEY });

        var content = userPrompt;
        // Image support via base64
        if (opts && opts.imageBase64) {
            content = [
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: opts.imageBase64 } },
                { type: 'text', text: userPrompt }
            ];
        }

        client.messages.create({
            model: cfg.LLM_MODEL || cfg.ANTHROPIC_MODEL,
            max_tokens: 4096,
            system: systemPrompt,
            messages: [{ role: 'user', content: content }]
        }).then(function(res) {
            resolve(res.content[0].text || null);
        }).catch(function(e) {
            console.log('[LLM] Anthropic error: ' + (e.message || e));
            resolve(null);
        });
    });
}

// ---- Z.AI (Zhipu AI - Anthropic-compatible) ----

function invokeZai(systemPrompt, userPrompt, opts) {
    return new Promise(function(resolve) {
        var Anthropic = require('@anthropic-ai/sdk');
        var client = new Anthropic.Anthropic({
            apiKey: cfg.LLM_API_KEY,
            baseURL: cfg.ZAI_BASE_URL
        });

        var content = userPrompt;
        if (opts && opts.imageBase64) {
            content = [
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: opts.imageBase64 } },
                { type: 'text', text: userPrompt }
            ];
        }

        client.messages.create({
            model: cfg.LLM_MODEL || cfg.ZAI_MODEL,
            max_tokens: 4096,
            system: systemPrompt,
            messages: [{ role: 'user', content: content }]
        }).then(function(res) {
            resolve(res.content[0].text || null);
        }).catch(function(e) {
            console.log('[LLM] Z.AI error: ' + (e.message || e));
            resolve(null);
        });
    });
}

// ---- Unified invoke ----
// Work mode (tools: true) always goes through Claude CLI for real execution.
// Chat mode (tools: false) uses API directly for speed, or Claude CLI if that's the provider.

// ---- Jork Engine (provider-independent tool execution) ----

var engine = require('./engine');

function invokeEngine(prompt, opts) {
    var systemPrompt = opts.system || 'You are ' + cfg.JORK_NAME + ', an autonomous Solana builder.';
    var providerConfig = {
        provider: cfg.LLM_PROVIDER === 'claude-cli' ? 'anthropic' : cfg.LLM_PROVIDER,
        apiKey: cfg.LLM_API_KEY,
        model: cfg.LLM_MODEL || undefined,
        baseUrl: cfg.LLM_BASE_URL || undefined,
    };

    // Provider-specific model defaults
    if (providerConfig.provider === 'zai' && !providerConfig.model) providerConfig.model = cfg.ZAI_MODEL;
    if (providerConfig.provider === 'anthropic' && !providerConfig.model) providerConfig.model = cfg.ANTHROPIC_MODEL;
    if (providerConfig.provider === 'openai' && !providerConfig.model) providerConfig.model = cfg.OPENAI_MODEL;
    if (providerConfig.provider === 'gemini' && !providerConfig.model) providerConfig.model = cfg.GEMINI_MODEL;

    // For claude-cli provider without API key, try to use the env auth token
    if (cfg.LLM_PROVIDER === 'claude-cli' && !providerConfig.apiKey) {
        providerConfig.apiKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || '';
    }

    var engineOpts = {
        provider: providerConfig,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }],
        tools: 'all',
        maxTurns: opts.maxTurns || cfg.MAX_TURNS || 30,
        timeout: cfg.INVOKE_TIMEOUT || 120000,
        maxTokens: opts.maxTokens || 4096,
        cwd: cfg.WORKSPACE,
        onToolCall: function(name, params) {
            console.log('[engine] tool: ' + name + (params.command ? ' ' + params.command.slice(0, 60) : ''));
        },
        onToolResult: function(name, result) {
            console.log('[engine] result: ' + name + ' -> ' + (result || '').slice(0, 80));
        },
    };

    // Pass streaming callback if provided
    if (opts.onStream) engineOpts.onStream = opts.onStream;

    return engine.execute(engineOpts).then(function(result) {
        return result.text || null;
    });
}

// ---- Unified invoke ----

function invoke(prompt, opts) {
    opts = opts || {};
    var provider = cfg.LLM_PROVIDER;
    var needsTools = opts && opts.tools;

    // Work mode: use Jork's own engine (no CLI dependency)
    if (needsTools) {
        return invokeEngine(prompt, opts);
    }

    // Chat mode: use API directly for speed
    if (provider === 'claude-cli') {
        // For claude-cli without tools, use Anthropic API directly if we have a key
        if (cfg.LLM_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
            var systemPrompt = opts.system || 'You are ' + cfg.JORK_NAME + ', an autonomous Solana builder.';
            return invokeAnthropic(systemPrompt, prompt, opts);
        }
        return invokeClaude(prompt, opts);
    }

    var systemPrompt = opts.system || 'You are ' + cfg.JORK_NAME + ', an autonomous Solana builder.';

    if (provider === 'anthropic') {
        return invokeAnthropic(systemPrompt, prompt, opts);
    }

    if (provider === 'zai') {
        return invokeZai(systemPrompt, prompt, opts);
    }

    // openai and gemini both use OpenAI-compatible API
    return invokeOpenAI(systemPrompt, prompt, opts);
}

module.exports = { invoke };
