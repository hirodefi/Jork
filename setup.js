'use strict';
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function line() { console.log('  ' + '-'.repeat(48)); }

function setKey(env, key, value) {
    const re = new RegExp(`^(#\\s*)?${key}=.*$`, 'm');
    if (re.test(env)) return env.replace(re, `${key}=${value}`);
    return env + `\n${key}=${value}`;
}

// Provider name mapping
const PROVIDERS = {
    '1': 'claude-cli', 'claude': 'claude-cli', 'claude-cli': 'claude-cli',
    '2': 'anthropic', 'anthropic': 'anthropic',
    '3': 'zai', 'glm': 'zai', 'zai': 'zai',
    '4': 'openai', 'openai': 'openai',
    '5': 'gemini', 'gemini': 'gemini',
};

function buildEnv(chatId, botToken, provider, apiKey) {
    let env = fs.readFileSync(path.join(__dirname, '.env.example'), 'utf8');
    env = setKey(env, 'TELEGRAM_CHAT_ID', chatId);
    env = setKey(env, 'TELEGRAM_BOT_TOKEN', botToken);

    var p = PROVIDERS[provider.toLowerCase()] || provider;
    env = setKey(env, 'LLM_PROVIDER', p);

    if (apiKey && p !== 'claude-cli') {
        env = setKey(env, 'LLM_API_KEY', apiKey);
    }
    if (p === 'openai') {
        env = setKey(env, 'LLM_BASE_URL', 'https://api.openai.com/v1');
        env = setKey(env, 'LLM_MODEL', 'gpt-4o');
    }
    if (p === 'gemini') {
        env = setKey(env, 'LLM_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta/openai');
        env = setKey(env, 'LLM_MODEL', 'gemini-2.5-flash');
    }

    return env;
}

function installPowers() {
    console.log('  Installing default powers...');
    const workspace = path.join(__dirname, process.env.JORK_WORKSPACE || 'workspace');
    const powersDir = path.join(workspace, 'powers');
    try { fs.mkdirSync(powersDir, { recursive: true }); } catch(e) {}

    const defaultPowers = ['memory', 'solana', 'web2', 'voice', 'image'];
    const repoUrl = 'https://github.com/hirodefi/Jork-Powers.git';
    const os = require('os');
    const tmpDir = path.join(os.tmpdir(), 'jork-powers-' + Date.now());

    try {
        console.log('  Cloning powers repo...');
        execSync('git clone --depth 1 ' + repoUrl + ' "' + tmpDir + '"', { stdio: 'pipe', timeout: 60000 });
        for (const power of defaultPowers) {
            const src = path.join(tmpDir, power);
            const dst = path.join(powersDir, power);
            if (fs.existsSync(src) && !fs.existsSync(dst)) {
                execSync('cp -r "' + src + '" "' + dst + '"');
                console.log('  - ' + power + ' installed');
            } else if (fs.existsSync(dst)) {
                console.log('  - ' + power + ' already installed');
            }
        }
    } catch(e) {
        console.log('  Could not clone powers: ' + e.message);
    } finally {
        try { execSync('rm -rf "' + tmpDir + '"', { stdio: 'pipe' }); } catch(e) {}
    }

    // Install Node deps for powers with package.json
    for (const power of defaultPowers) {
        const pkgPath = path.join(powersDir, power, 'package.json');
        if (fs.existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
                    console.log('  Installing deps for ' + power + '...');
                    execSync('npm install --production', { cwd: path.join(powersDir, power), stdio: 'pipe', timeout: 120000 });
                }
            } catch(e) {
                console.log('  Warning: ' + power + ' deps failed: ' + e.message);
            }
        }
    }

    // Voice deps
    try { execSync('python3 -c "import whisper"', { stdio: 'pipe' }); }
    catch(e) {
        console.log('  Installing Whisper...');
        try { execSync('pip install openai-whisper --break-system-packages 2>/dev/null || pip install openai-whisper', { stdio: 'pipe', timeout: 300000 }); }
        catch(e2) { console.log('  Whisper install failed. Run: pip install openai-whisper'); }
    }
    try { execSync('which ffmpeg', { stdio: 'pipe' }); }
    catch(e) {
        try { execSync('apt-get install -y ffmpeg 2>/dev/null || brew install ffmpeg 2>/dev/null', { stdio: 'pipe', timeout: 120000 }); }
        catch(e2) { console.log('  ffmpeg install failed. Run: apt install ffmpeg'); }
    }
}

function startJork() {
    // Check Claude CLI
    try {
        execSync('claude --version', { stdio: 'ignore' });
        console.log('  Claude CLI found.');
    } catch(e) {
        console.log('  IMPORTANT: Claude Code CLI needed for build execution.');
        console.log('  Install: https://claude.ai/code then run: claude login');
    }

    console.log('');
    line();
    console.log('  Starting Jork...');
    line();
    console.log('');
    try {
        execSync('pm2 start ecosystem.config.js', { cwd: __dirname, stdio: 'inherit' });
        console.log('');
        console.log('  Jork is alive. She will message you on Telegram.');
        console.log('');
    } catch(e) {
        console.log('  pm2 not found. Start manually: node src/jork.js');
    }
}

// ---- CLI mode: npm run setup <chat_id> <bot_token> <provider> <api_key> ----

const args = process.argv.slice(2);

if (args.length >= 3) {
    console.log('');
    line();
    console.log('  JORK - Solana\'s Autonomous Build Engine');
    line();
    console.log('');

    const [chatId, botToken, provider, apiKey] = args;
    const env = buildEnv(chatId, botToken, provider, apiKey || '');
    fs.writeFileSync(path.join(__dirname, '.env'), env);
    console.log('  Config saved.');
    console.log('');

    installPowers();
    console.log('');
    startJork();
    process.exit(0);
}

// ---- Interactive mode: npm run setup ----

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(q) {
    return new Promise(resolve => rl.question(q, resolve));
}

async function interactive() {
    console.log('');
    line();
    console.log('  JORK - Solana\'s Autonomous Build Engine');
    line();
    console.log('');

    const envPath = path.join(__dirname, '.env');

    if (fs.existsSync(envPath)) {
        const ow = await ask('  .env already exists. Overwrite? (y/n): ');
        if (ow.trim().toLowerCase() !== 'y') {
            console.log('  Keeping existing .env.');
            rl.close();
            installPowers();
            startJork();
            return;
        }
    }

    // Telegram
    console.log('');
    console.log('  STEP 1 - Telegram');
    console.log('  Get your user ID: message @userinfobot on Telegram');
    console.log('  Get a bot token: message @BotFather, send /newbot');
    console.log('');
    const userId = (await ask('  Your Telegram user ID: ')).trim();
    const botToken = (await ask('  Your bot token: ')).trim();

    // LLM
    console.log('');
    console.log('  STEP 2 - AI Provider');
    console.log('  [1] Claude Code CLI  (free with Claude subscription, full tool use)');
    console.log('  [2] Claude API       (https://console.anthropic.com)');
    console.log('  [3] GLM              (https://z.ai)');
    console.log('  [4] OpenAI           (https://platform.openai.com)');
    console.log('  [5] Gemini           (https://aistudio.google.com)');
    console.log('');
    const choice = (await ask('  Choose 1-5: ')).trim();
    var apiKey = '';

    if (choice !== '1') {
        apiKey = (await ask('  API key: ')).trim();
    } else {
        try {
            execSync('claude --version', { stdio: 'ignore' });
            console.log('  Claude CLI found.');
        } catch(e) {
            console.log('  Claude CLI not found. Install: https://claude.ai/code');
        }
    }

    const env = buildEnv(userId, botToken, choice, apiKey);
    fs.writeFileSync(envPath, env);
    console.log('');
    console.log('  Config saved.');

    rl.close();
    console.log('');
    installPowers();
    console.log('');
    startJork();
}

interactive().catch(e => {
    console.error('Setup error:', e.message);
    try { rl.close(); } catch(e) {}
    process.exit(1);
});
