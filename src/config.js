'use strict';
require('dotenv').config();
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

function required(name) {
    const val = process.env[name];
    if (!val) {
        console.error('Missing required config: ' + name);
        console.error('Copy .env.example to .env and fill in your values.');
        process.exit(1);
    }
    return val;
}

const WORKSPACE = process.env.JORK_WORKSPACE
    ? path.resolve(ROOT, process.env.JORK_WORKSPACE)
    : path.join(ROOT, 'workspace');

const NUCLEUS = path.join(WORKSPACE, '.jork');

module.exports = {
    ROOT,
    WORKSPACE,
    NUCLEUS,

    TG_BOT_TOKEN: required('TELEGRAM_BOT_TOKEN'),
    TG_CHAT_ID: required('TELEGRAM_CHAT_ID'),

    // LLM providers
    LLM_PROVIDER: process.env.LLM_PROVIDER || 'claude-cli',
    LLM_API_KEY: process.env.LLM_API_KEY || '',
    LLM_BASE_URL: process.env.LLM_BASE_URL || '',
    LLM_MODEL: process.env.LLM_MODEL || '',

    // Provider-specific defaults (only used when LLM_MODEL is not set)
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
    ZAI_BASE_URL: 'https://api.z.ai/api/anthropic',
    ZAI_MODEL: process.env.ZAI_MODEL || 'glm-5.1',
    OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o',
    GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.5-flash',

    // Solana defaults
    SOLANA_CLUSTER: process.env.SOLANA_CLUSTER || 'devnet',
    SOLANA_RPC: process.env.SOLANA_RPC || '',

    JORK_NAME: process.env.JORK_NAME || 'Jork',

    // Intervals
    THINK_INTERVAL: parseInt(process.env.THINK_INTERVAL) || 300000,
    HEARTBEAT_INTERVAL: parseInt(process.env.HEARTBEAT_INTERVAL) || 30000,
    POLL_INTERVAL: parseInt(process.env.POLL_INTERVAL) || 3000,
    INVOKE_TIMEOUT: parseInt(process.env.INVOKE_TIMEOUT) || 900000,
    MAX_TURNS: parseInt(process.env.MAX_TURNS) || 150,

    POWERS_DIR: path.join(WORKSPACE, 'powers'),
    TEMPLATES_DIR: path.join(ROOT, 'nucleus'),

    // Runtime state files
    PULSE: path.join(ROOT, 'jork.pulse'),
    THREAD: path.join(ROOT, 'jork.thread'),

    // Nucleus files
    SELF: () => path.join(NUCLEUS, 'SELF.md'),
    SNAPSHOT: () => path.join(NUCLEUS, 'SNAPSHOT.md'),
    SOLANA: () => path.join(NUCLEUS, 'SOLANA.md'),
    GOALS: () => path.join(NUCLEUS, 'goals.json'),
    HISTORY: () => path.join(NUCLEUS, 'history.jsonl'),
    COFOUNDER: () => path.join(NUCLEUS, 'COFOUNDER.md'),
    AVAILABLE_POWERS: () => path.join(NUCLEUS, 'available_powers.md'),

    ensure() {
        [WORKSPACE, NUCLEUS, path.join(NUCLEUS, 'memory')].forEach(d => {
            try { fs.mkdirSync(d, { recursive: true }); } catch(e) {}
        });
    }
};
