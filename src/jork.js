"use strict";
const fs = require("fs");
const path = require("path");
const https = require("https");
const cfg = require("./config");
const tg = require("./telegram");
const llm = require("./llm");
const loop = require("./engine/loop");
var persistence = require("./engine/persistence");
var { isDuplicateIntent, recordIntent } = require("./dedup");

// ---- memory power (loaded if installed) ----
process.env.JORK_NUCLEUS = cfg.NUCLEUS;
var memory = null;
try {
    memory = require(path.join(cfg.WORKSPACE, "powers", "memory"));
    console.log("[jork] memory power loaded");
} catch(e) { /* not installed yet */ }

// ---- state ----

var working = false;
var workCancelled = false;
var workTimer = null;
var workDescription = "";
var pendingConfirm = null;  // { plan, from, text, ctx } waiting for user to approve plan
var thinkBusy = false;
var lastThink = 0;
var lastPulse = 0;
var showThinking = false;
var thinkingAsked = false;
var messageQueue = [];
var recentMessages = [];    // last 5 messages for router context
var progressTimer = null;  // progress update timer (module-level scope)

function stripThinking(text) {
    if (!text || showThinking) return text;
    return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").replace(/^\s*\n/gm, "").trim();
}

function filterRoboticPatterns(text) {
    if (!text) return text;

    // Only remove robotic confirmation openers when they're the ENTIRE first line
    // (e.g. "Understood. " or "Got it. " prefixing actual content)
    var firstLine = text.split('\n')[0];
    var openerRe = /^(Understood|Got it|OK|Sure|Alright|Bet)[.,]?\s+/i;
    if (openerRe.test(firstLine) && firstLine.length > 20) {
        text = text.replace(openerRe, '');
    }

    // Collapse excessive newlines (3+) to 2, but preserve normal paragraph breaks
    text = text.replace(/\n{3,}/g, '\n\n');

    return text.trim();
}

// Centralized send wrapper - applies all filters and dedup checking
function jorkSend(text, skipFilter) {
    if (!text) return;

    // Apply filtering unless explicitly skipped (for critical messages)
    if (!skipFilter) {
        text = filterRoboticPatterns(text);
    }

    // Skip empty responses
    if (!text || text.length < 2) return;

    // Check for duplicate intent
    if (isDuplicateIntent(text)) {
        log("[Skip] Duplicate filtered out");
        return;
    }

    // Send and record
    tg.send(text);
    recordIntent(text);
}

// ---- logging ----

function log(msg) {
    const ts = new Date().toISOString().slice(11, 19);
    const line = "[" + ts + "] " + msg;
    console.log(line);
    fs.appendFile(path.join(cfg.ROOT, "jork.log"), line + "\n", function() {});
}

// ---- pulse ----

function pulse() {
    try { fs.writeFileSync(cfg.PULSE, String(Date.now())); } catch(e) {}
}

// ---- history ----

function remember(role, content) {
    if (memory) {
        try { memory.append(role, content); } catch(e) {}
    } else {
        const entry = { ts: new Date().toISOString(), role, content };
        try { fs.appendFileSync(cfg.HISTORY(), JSON.stringify(entry) + "\n"); } catch(e) {}
    }
    // Track recent messages for router context
    recentMessages.push({ role: role, text: (content || "").slice(0, 100) });
    if (recentMessages.length > 5) recentMessages.shift();
}

// ---- context loaders (cached, 30s TTL) ----

var _cache = {};
var _cacheTTL = 30000;

function cachedRead(key, fileFn) {
    var now = Date.now();
    if (_cache[key] && (now - _cache[key].at) < _cacheTTL) return _cache[key].data;
    try {
        var data = fs.readFileSync(fileFn(), "utf8");
        _cache[key] = { data: data, at: now };
        return data;
    } catch(e) { return ""; }
}

function loadSelf() { return cachedRead("self", cfg.SELF); }
function loadSolana() { return cachedRead("solana", cfg.SOLANA); }
function loadCofounder() { return cachedRead("cofounder", cfg.COFOUNDER); }

function saveCofounderField(field, value) {
    try {
        var content = fs.readFileSync(cfg.COFOUNDER(), 'utf8');
        var re = new RegExp('^(' + field + ':)\\s*.*$', 'm');
        if (re.test(content)) {
            content = content.replace(re, '$1 ' + value);
        }
        fs.writeFileSync(cfg.COFOUNDER(), content);
        _cache["cofounder"] = null;
    } catch(e) { log("saveCofounder err: " + e.message); }
}

function extractCofounderInfo(text) {
    if (/\b(macbook|macos|mac os)\b/i.test(text)) saveCofounderField('OS', 'macOS');
    else if (/\b(windows|win11|win10)\b/i.test(text)) saveCofounderField('OS', 'Windows');
    else if (/\b(linux|ubuntu|debian)\b/i.test(text)) saveCofounderField('OS', 'Linux');

    if (/\b(macbook|laptop)\b/i.test(text)) saveCofounderField('Machine', 'laptop');
    else if (/\b(desktop|pc|tower)\b/i.test(text)) saveCofounderField('Machine', 'desktop');
    else if (/\b(server|vps|hetzner|digitalocean|aws|gcp)\b/i.test(text)) saveCofounderField('Machine', 'server');

    if (/\bvercel\b/i.test(text)) saveCofounderField('Frontend', 'Vercel');
    else if (/\bnetlify\b/i.test(text)) saveCofounderField('Frontend', 'Netlify');

    if (/\b(my server|my vps|hetzner|digitalocean)\b/i.test(text)) saveCofounderField('Backend', 'own server');

    var frameworks = [];
    if (/\breact\b/i.test(text) && !/\bnext/i.test(text)) frameworks.push('React');
    if (/\bnext\.?js\b/i.test(text)) frameworks.push('Next.js');
    if (/\bvue\b/i.test(text)) frameworks.push('Vue');
    if (/\bsvelte\b/i.test(text)) frameworks.push('Svelte');
    if (/\bvite\b/i.test(text)) frameworks.push('Vite');
    if (frameworks.length > 0) {
        try {
            var content = fs.readFileSync(cfg.COFOUNDER(), 'utf8');
            var match = content.match(/^Frameworks:\s*(.*)$/m);
            var existing = (match && match[1] !== '(unknown)') ? match[1].split(',').map(function(s) { return s.trim(); }) : [];
            var merged = Array.from(new Set(existing.concat(frameworks))).join(', ');
            saveCofounderField('Frameworks', merged);
        } catch(e) {}
    }

    var nameMatch = text.match(/(?:i'm|i am|call me|my name is)\s+([A-Z][a-z]+)/i);
    if (nameMatch) saveCofounderField('Name', nameMatch[1]);

    // Free-text notes: capture personal preferences that regex fields can't
    var personalKeywords = /\b(prefer|always|never|hate|love|usually|my workflow|can't stand|big fan|i tend to|my style)\b/i;
    if (personalKeywords.test(text)) {
        try {
            var cfPath = cfg.COFOUNDER();
            var cfContent = fs.readFileSync(cfPath, 'utf8');
            if (cfContent.indexOf('## Notes') === -1) {
                cfContent += '\n\n## Notes\n';
            }
            var noteLine = '- [' + new Date().toISOString().slice(0, 10) + '] ' + text.slice(0, 200).replace(/\n/g, ' ');
            cfContent = cfContent.replace(/\n*$/, '\n') + noteLine + '\n';
            fs.writeFileSync(cfPath, cfContent);
            _cache["cofounder"] = null;
        } catch(e) {}
    }
}

function loadSnapshot() {
    var s = cachedRead("snapshot", cfg.SNAPSHOT);
    return s.slice(0, 800);
}

function loadActiveGoal() {
    try {
        var raw = cachedRead("goals", cfg.GOALS);
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (!data.goals) return null;
        let goal = data.goals.find(g => g.status === "in_progress");
        if (!goal) goal = data.goals.find(g => g.status === "pending");
        if (!goal) return null;
        let step = null;
        if (goal.steps) {
            step = goal.steps.find(s => s.status === "in_progress");
            if (!step) step = goal.steps.find(s => s.status === "pending");
        }
        return { goal, step };
    } catch(e) { return null; }
}

function loadPowersIndex() {
    return cachedRead("powersIndex", function() { return path.join(cfg.WORKSPACE, "powers", "INDEX.md"); }).slice(0, 500);
}

function loadAvailablePowers() {
    return cachedRead("availPowers", cfg.AVAILABLE_POWERS);
}

function httpsGet(url) {
    return new Promise(function(resolve) {
        https.get(url, function(res) {
            var data = "";
            res.on("data", function(chunk) { data += chunk; });
            res.on("end", function() { resolve(res.statusCode === 200 ? data : null); });
        }).on("error", function() { resolve(null); });
    });
}

async function fetchAvailablePowers() {
    const base = "https://raw.githubusercontent.com/hirodefi/Jork-Powers/main";
    const indexMd = await httpsGet(base + "/INDEX.md");
    if (!indexMd) { log("Could not fetch powers index from GitHub."); return; }

    var names = [];
    indexMd.split("\n").forEach(function(line) {
        var m = line.match(/^\|\s*([a-z][a-z0-9_-]+)\s*\|/);
        if (m && m[1] !== "power") names.push(m[1]);
    });

    var sections = ["# Available Powers\n\nPowers live at https://github.com/hirodefi/Jork-Powers\n"];
    sections.push("## Index\n" + indexMd);

    for (var i = 0; i < names.length; i++) {
        var readme = await httpsGet(base + "/" + names[i] + "/README.md");
        if (readme) {
            sections.push("## Power: " + names[i] + "\n" + readme.trim());
        }
    }

    var note = sections.join("\n\n---\n\n");
    try { fs.writeFileSync(cfg.AVAILABLE_POWERS(), note); } catch(e) {}
    log("Available powers fetched from GitHub (" + names.length + " powers).");
}

function outboxPath() {
    return path.join(cfg.ROOT, "outbox.jsonl");
}

// ===========================================================================
// CONTEXT ENGINE - load only what's needed
// ===========================================================================

// Selective SOLANA.md section loading
var SOLANA_INDEX = {
    'account': 'Account Model', 'pda': 'PDAs', 'cpi': 'CPIs',
    'anchor': 'Anchor Framework', 'token': 'SPL Tokens', 'spl': 'SPL Tokens',
    'nft': 'NFTs', 'metaplex': 'NFTs', 'deploy': 'Deployment Flow',
    'fee': 'Priority Fees', 'priority': 'Priority Fees',
    'security': 'Security Checklist', 'wallet': 'Wallet Adapter',
    'frontend': 'Frontend', 'transaction': 'Transactions',
    'cluster': 'Clusters', 'devnet': 'Clusters', 'mainnet': 'Clusters',
    'setup': 'CLI Setup', 'version': 'Version Compatibility',
    'server': 'Server Setup', 'nginx': 'Server Setup',
    'ecosystem': 'Ecosystem Map', 'jupiter': 'Ecosystem Map',
    'raydium': 'Ecosystem Map', 'meteora': 'Ecosystem Map',
};

function loadSolanaSections(text) {
    var solana = loadSolana();
    if (!solana) return "";
    var lower = text.toLowerCase();
    var needed = new Set();
    for (var keyword in SOLANA_INDEX) {
        if (lower.indexOf(keyword) !== -1) {
            needed.add(SOLANA_INDEX[keyword]);
        }
    }
    if (needed.size === 0) return "";

    var result = [];
    var sections = solana.split(/^## /m);
    for (var i = 1; i < sections.length; i++) {
        var header = sections[i].split('\n')[0].trim();
        for (var n of needed) {
            if (header.indexOf(n) !== -1) {
                result.push("## " + sections[i].trim());
                break;
            }
        }
    }
    if (result.length === 0) return "";
    return "\n--- SOLANA KNOWLEDGE ---\n" + result.join("\n\n") + "\n";
}

// Chat context: lightweight (~2-5KB)
function buildChatContext(text) {
    var ctx = "--- WHO YOU ARE ---\n" + loadSelf() + "\n\n";
    var cf = loadCofounder();
    if (cf) ctx += "--- YOUR CO-FOUNDER ---\n" + cf + "\n\n";
    ctx += "--- YOUR STATE ---\n" + loadSnapshot() + "\n\n";

    // Inject current working state to prevent state confusion
    if (working) {
        ctx += "--- CURRENT ACTIVITY ---\nACTIVELY BUILDING: " + workDescription + "\n";
        ctx += "You are mid-task. Do NOT act confused or ask for permission.\n\n";
    }

    if (memory) {
        try {
            // Recent conversation (standard context)
            var memCtx = memory.context();
            if (memCtx) ctx += "--- RECENT ---\n" + memCtx + "\n";

            // Targeted recall: search memory for messages relevant to what the user is saying
            if (text && text.length > 10) {
                var relevant = memory.query(text, 5);
                if (relevant && relevant.length > 0) {
                    var relText = relevant.map(function(m) {
                        return "[" + m.role + "] " + (m.msg || "").slice(0, 150);
                    }).join("\n");
                    ctx += "--- RELEVANT MEMORY ---\n" + relText + "\n";
                }
            }
        } catch(e) {}
    }

    ctx += loadSolanaSections(text);
    ctx += "\n--- WORKSPACE ---\n" + cfg.WORKSPACE + "\n";
    return ctx;
}

// Build context: full (~15-20KB)
function buildWorkContext(text) {
    var ctx = "--- WHO YOU ARE ---\n" + loadSelf() + "\n\n";
    var cf = loadCofounder();
    if (cf) ctx += "--- YOUR CO-FOUNDER ---\n" + cf + "\n\n";
    ctx += "--- YOUR STATE ---\n" + loadSnapshot() + "\n\n";

    // Inject current working state to prevent state confusion
    if (working) {
        ctx += "--- CURRENT ACTIVITY ---\nACTIVELY BUILDING: " + workDescription + "\n";
        ctx += "You are mid-task. Do NOT act confused or ask for permission.\n\n";
    }

    var active = loadActiveGoal();
    if (active) {
        ctx += "--- ACTIVE TASK ---\n" + active.goal.title + "\n";
        if (active.step) ctx += "Current step: " + active.step.description + "\n";
        ctx += "\n";
    }

    var powers = loadPowersIndex();
    if (powers) ctx += "--- POWERS ---\n" + powers + "\n";

    var availPowers = loadAvailablePowers();
    if (availPowers) ctx += "--- AVAILABLE POWERS ---\n" + availPowers + "\n";

    if (memory) {
        try {
            var memCtx = memory.context();
            if (memCtx) ctx += "--- RECENT ---\n" + memCtx + "\n";

            // Targeted recall: find past builds or conversations relevant to this task
            if (text && text.length > 10) {
                var relevant = memory.query(text, 8);
                if (relevant && relevant.length > 0) {
                    var relText = relevant.map(function(m) {
                        return "[" + m.role + "] " + (m.msg || "").slice(0, 200);
                    }).join("\n");
                    ctx += "--- RELEVANT MEMORY ---\n" + relText + "\n";
                }
            }
        } catch(e) {}
    }

    ctx += loadSolanaSections(text);

    ctx += "\n--- WORKSPACE ---\n" + cfg.WORKSPACE + "\n";
    ctx += "\n--- OUTBOX ---\nTo message your colleague: echo '{\"text\":\"msg\"}' >> " + outboxPath() + "\n";
    return ctx;
}

// ===========================================================================
// NUCLEUS INIT
// ===========================================================================

function initNucleus() {
    cfg.ensure();
    var walPath = path.join(cfg.NUCLEUS, 'memory', 'wal.json');
    try { if (!fs.existsSync(walPath)) fs.writeFileSync(walPath, '[]'); } catch(e) {}
    const files = [
        { dest: cfg.SELF(), template: "SELF.md" },
        { dest: cfg.SNAPSHOT(), template: "SNAPSHOT.md" },
        { dest: cfg.SOLANA(), template: "SOLANA.md" },
        { dest: cfg.COFOUNDER(), template: "COFOUNDER.md" },
        { dest: cfg.GOALS(), template: "goals.json" },
    ];
    files.forEach(function(f) {
        if (!fs.existsSync(f.dest)) {
            const src = path.join(cfg.TEMPLATES_DIR, f.template);
            if (fs.existsSync(src)) {
                let content = fs.readFileSync(src, "utf8");
                content = content
                    .replace(/\{\{JORK_NAME\}\}/g, cfg.JORK_NAME)
                    .replace(/\{\{JORK_ROOT\}\}/g, cfg.ROOT)
                    .replace(/\{\{JORK_WORKSPACE\}\}/g, cfg.WORKSPACE)
                    .replace(/\{\{JORK_NUCLEUS\}\}/g, cfg.NUCLEUS);
                fs.writeFileSync(f.dest, content);
                log("Initialized " + path.basename(f.dest));
            }
        }
    });
}

// ===========================================================================
// WAKE UP
// ===========================================================================

async function wakeUp() {
    log("Waking up...");
    tg.typing();
    var ctx = buildChatContext("");
    var prompt = ctx + "\n" +
        "You just came online for the first time. Time: " + new Date().toISOString() + ".\n" +
        "You are " + cfg.JORK_NAME + " - Solana's Autonomous Build Engine.\n" +
        "Say hi to your co-founder. Be warm, grateful, ready. 1-2 sentences. No capabilities list. Just hello.";
    try {
        var raw = await llm.invoke(prompt, { tools: false });
        if (raw) {
            var response = stripThinking(raw);
            remember("jork-wake", response);
            log("Wake: " + response.slice(0, 100));
            jorkSend(response, true);
        } else {
            jorkSend("online. ready to build.", true);
        }
    } catch(e) {
        log("Wake err: " + e.message);
        jorkSend("online.", true);
    }
}

// ===========================================================================
// OUTBOX
// ===========================================================================

function flushOutbox() {
    var p = outboxPath();
    try {
        if (!fs.existsSync(p)) return;
        var content = fs.readFileSync(p, "utf8").trim();
        if (!content) return;
        fs.writeFileSync(p, "");
        content.split("\n").forEach(function(line) {
            if (!line.trim()) return;
            try {
                var msg = JSON.parse(line);
                if (msg.text) jorkSend(stripThinking(msg.text), true);
            } catch(e) {}
        });
    } catch(e) {}
}

// ===========================================================================
// WORKSPACE CHECK
// ===========================================================================

function checkWorkspace() {
    try {
        var projects = fs.readdirSync(cfg.WORKSPACE).filter(function(f) {
            return f !== 'powers' && f !== '.jork' && !f.startsWith('.');
        });
        if (projects.length === 0) return "";
        var result = [];
        for (var i = 0; i < projects.length; i++) {
            var projPath = path.join(cfg.WORKSPACE, projects[i]);
            try {
                var stat = fs.statSync(projPath);
                if (stat.isDirectory()) {
                    var children = fs.readdirSync(projPath).filter(function(f) {
                        return f !== 'node_modules' && f !== '.git' && !f.startsWith('.');
                    }).slice(0, 10);
                    result.push(projects[i] + "/" + (children.length > 0 ? " (" + children.join(", ") + ")" : ""));
                } else { result.push(projects[i]); }
            } catch(e) { result.push(projects[i]); }
        }
        return result.join("; ");
    } catch(e) { return ""; }
}

// ===========================================================================
// URL VERIFICATION
// ===========================================================================

function verifyUrls(text) {
    return new Promise(function(resolve) {
        var urlMatch = text.match(/https:\/\/[^\s"*)\]]+/g);
        if (!urlMatch || urlMatch.length === 0) { resolve(text); return; }
        urlMatch = urlMatch.filter(function(u) { return !/localhost|127\.0\.0\.1/i.test(u); });
        if (urlMatch.length === 0) { resolve(text); return; }
        var pending = urlMatch.length;
        var broken = [];
        urlMatch.forEach(function(url) {
            var req = https.get(url, function(res) {
                res.resume();
                if (res.statusCode >= 400) broken.push(url);
                pending--;
                if (pending === 0) finish();
            });
            req.on('error', function() { broken.push(url); pending--; if (pending === 0) finish(); });
            req.setTimeout(5000, function() { req.destroy(); broken.push(url); pending--; if (pending === 0) finish(); });
        });
        function finish() {
            if (broken.length > 0) text += "\n\n(Note: " + broken.join(", ") + " may not be live yet.)";
            resolve(text);
        }
    });
}

// ===========================================================================
// MESSAGE ROUTER - classify then dispatch
// ===========================================================================

// Commands: no LLM needed
function isCommand(text) {
    var lower = text.toLowerCase().trim();
    if (lower === "show thinking" || lower === "show thoughts") return "show_thinking";
    if (lower === "hide thinking" || lower === "hide thoughts") return "hide_thinking";
    if ((lower === "stop" || lower === "cancel") && working) return "cancel";
    if (lower === "status") return "status";
    return null;
}

// Classify: one lightweight LLM call
async function classify(text) {
    var recent = recentMessages.slice(-3).map(function(m) { return m.role + ": " + m.text; }).join("\n");
    var cf = loadCofounder();
    var cfName = "";
    if (cf) {
        var nameMatch = cf.match(/^Name:\s*(.+)$/m);
        cfName = (nameMatch && nameMatch[1] !== '(unknown)') ? nameMatch[1] : "";
    }

    var prompt = "Classify this message as ONE word: chat, build, or analyze\n\n" +
        (cfName ? "Co-founder: " + cfName + "\n" : "") +
        "Currently working: " + (working ? "yes" : "no") + "\n" +
        (recent ? "Recent:\n" + recent + "\n\n" : "") +
        "Message: " + text.slice(0, 300) + "\n\n" +
        "chat = casual conversation, questions, greetings, feedback, follow-up discussion\n" +
        "build = needs real work: create, build, deploy, fix, install, set up, configure, scaffold, write code\n" +
        "analyze = document, list, review, check, summarize, what changes, what files, what did you do\n\n" +
        "Reply with ONE word: chat, build, or analyze";

    try {
        var result = await llm.invoke(prompt, { tools: false });
        result = stripThinking(result);
        var lower = result.toLowerCase().trim();
        if (lower.indexOf("build") !== -1) return "build";
        if (lower.indexOf("analyze") !== -1) return "analyze";
    } catch(e) {
        log("Classify err: " + e.message);
    }
    return "chat";
}

// ===========================================================================
// COMMAND HANDLER - immediate, no LLM
// ===========================================================================

function handleCommand(cmd) {
    if (cmd === "show_thinking") {
        showThinking = true; thinkingAsked = true;
        tg.setShowThinking(true);
        saveCofounderField('Show thinking', 'yes');
        jorkSend("Thinking visible.");
    } else if (cmd === "hide_thinking") {
        showThinking = false; thinkingAsked = true;
        tg.setShowThinking(false);
        saveCofounderField('Show thinking', 'no');
        jorkSend("Thinking hidden.");
    } else if (cmd === "cancel") {
        log("=== WORK CANCELLED ===");
        workCancelled = true;
        if (workTimer) { clearInterval(workTimer); workTimer = null; }
        if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
        // Kill any running tool process immediately
        loop.requestHalt();
        var built = checkWorkspace();
        jorkSend("Stopped." + (built ? " Partial work: " + built : ""), true);
        working = false; workDescription = "";
    } else if (cmd === "status") {
        if (working) {
            jorkSend("Working on: " + workDescription + "\nWorkspace: " + (checkWorkspace() || "just started"), true);
        } else {
            var goal = loadActiveGoal();
            jorkSend(goal ? "Active goal: " + goal.goal.title : "Nothing active. What should I build?", true);
        }
    }
}

// ===========================================================================
// CHAT HANDLER - lightweight context, natural response
// ===========================================================================

async function handleChat(text, from, imagePath) {
    var ctx = buildChatContext(text);

    var prompt = ctx + "\n" + from + " says: " + text + "\n\n" +
        "Reply naturally. Be yourself. Keep it conversational. No code, no structure unless asked.";

    var opts = { tools: false };
    if (imagePath) {
        try {
            opts.imageBase64 = fs.readFileSync(imagePath).toString("base64");
            opts.imagePath = imagePath;
        } catch(e) {}
    }

    try {
        var response = await llm.invoke(prompt, opts);
        if (!response) response = await llm.invoke(prompt, opts);
        if (!response) { jorkSend("Brain not responding. Try again in a minute.", true); return; }
        var clean = stripThinking(response);
        remember("jork", clean);
        log("-> [chat] " + (clean || "").slice(0, 80));
        jorkSend(clean);
    } catch(e) {
        log("Chat err: " + e.message);
        jorkSend("Brain glitch. Give me a sec.");
    }
}

// ===========================================================================
// ANALYZE HANDLER - check files/memory before responding
// ===========================================================================

async function handleAnalyze(text, from, imagePath) {
    var ack = "let me check my files and memory. give me a moment.";
    jorkSend(ack, true); // Skip filtering for this immediate ack
    remember("jork", ack);

    // Use LLM with tools to actually gather information
    var ctx = buildChatContext(text);
    var analyzePrompt = ctx + "\n" + from + " asked: " + text + "\n\n" +
        "Your task is to GATHER INFORMATION, not to do the work yet.\n" +
        "Search your memory, read relevant files (SELF.md, SOLANA.md, nucleus/), check the workspace.\n" +
        "Then provide a summary of what you found.\n" +
        "Do NOT execute any builds or changes. Just discover and report.\n" +
        "Keep it concise - 3-5 sentences max.";

    try {
        var result = await llm.invoke(analyzePrompt, { tools: true, maxTurns: 10 });
        if (!result) {
            result = "couldn't gather info right now. active goal: " +
                (loadActiveGoal()?.goal.title || "none") +
                ", workspace: " + (checkWorkspace() || "empty");
        }
        var clean = stripThinking(result);
        remember("jork", clean);
        jorkSend(clean);
    } catch(e) {
        log("Analyze err: " + e.message);
        jorkSend("had trouble gathering info. try again?");
    }
}

// ===========================================================================
// BUILD HANDLER - plan, confirm, execute, verify, done
// ===========================================================================

async function handleBuild(text, from, imagePath) {
    var ctx = buildWorkContext(text);

    // Step 1: Create plan
    var planPrompt = ctx + "\n" + from + " asked: " + text + "\n\n" +
        "Create a build plan. Output:\n" +
        "1. ONE sentence acknowledging what you will build (warm, direct)\n" +
        "2. Then a numbered plan of 2-4 concrete steps in plain English\n\n" +
        "RULES:\n" +
        "- You have NOT built anything yet. This is a plan.\n" +
        "- NEVER include URLs, results, or code. Just steps.\n" +
        "- Use EXACTLY what the user specified (frameworks, RPCs, networks).\n" +
        "- Each step should be one clear action that can be done in 5-8 tool calls.\n" +
        "- Combine related work into one step. Fewer steps is better.\n" +
        "- Do NOT add infrastructure steps (nginx, SSL, DNS). Only build what was asked.\n" +
        "- Do NOT add a separate 'verify' or 'test' step. Verify within the build step.\n" +
        "- Example:\n" +
        "  Building a React wallet viewer on mainnet, running on port 4588.\n" +
        "  1. Scaffold React Vite app and install Solana wallet adapter + web3.js\n" +
        "  2. Write wallet connection UI and transaction history component\n" +
        "  3. Start dev server on port 4588 and verify it works";

    var opts = { tools: false };
    if (imagePath) {
        try { opts.imageBase64 = fs.readFileSync(imagePath).toString("base64"); opts.imagePath = imagePath; } catch(e) {}
    }

    try {
        var planResponse = await llm.invoke(planPrompt, opts);
        if (!planResponse) planResponse = await llm.invoke(planPrompt, opts);
        if (!planResponse) { jorkSend("Brain not responding. Try again.", true); return; }

        var plan = stripThinking(planResponse);
        // Check for duplicate intent before sending
        if (isDuplicateIntent(plan)) {
            log("[Duplicate] Skipped duplicate plan");
            return;
        }
        remember("jork", plan);
        log("-> [plan] " + plan.slice(0, 80));
        jorkSend(plan);

        // If first build, ask thinking preference
        if (!thinkingAsked) {
            pendingConfirm = { plan: plan, from: from, text: text, ctx: ctx };
            try {
                var askThinking = await llm.invoke(
                    "You are " + cfg.JORK_NAME + ". You just shared a build plan. Ask in ONE casual sentence if they want to see your progress or just the result.",
                    { tools: false }
                );
                askThinking = stripThinking(askThinking);
                if (askThinking) {
                    jorkSend(askThinking, true);
                }
            } catch(e) {
                jorkSend("Want to see my progress as I build, or just the final result?", true);
            }
            return; // Wait for answer
        }

        // Thinking already known, start immediately
        executeBuild(ctx, from, text, plan);

    } catch(e) {
        log("Build plan err: " + e.message);
        jorkSend("Brain glitch creating the plan. Try again.", true);
    }
}

// ===========================================================================
// EXECUTE BUILD - step-by-step pipeline
// ===========================================================================

// Parse plan text into array of step descriptions
function parsePlanSteps(plan) {
    var steps = [];
    var lines = plan.split('\n');
    for (var i = 0; i < lines.length; i++) {
        var match = lines[i].match(/^\s*\d+\.\s+(.+)/);
        if (match) steps.push(match[1].trim());
    }
    return steps;
}

// Execute a single step with scoped Claude CLI call
async function executeStep(stepDesc, stepNum, totalSteps, ctx, fullRequest) {
    var built = checkWorkspace();
    var stepPrompt = ctx + "\n" +
        "Original request: " + fullRequest + "\n" +
        "Workspace so far: " + (built || "empty") + "\n\n" +
        "You are on step " + stepNum + " of " + totalSteps + ".\n" +
        "THIS STEP: " + stepDesc + "\n\n" +
        "Execute ONLY this step. Do not do other steps.\n" +
        "Actually run commands, write files, install things. Do NOT just describe.\n" +
        "IMPORTANT constraints:\n" +
        "- Be efficient. Use the fewest tool calls possible. Do NOT explore or diagnose — just do the work.\n" +
        "- Do NOT set up nginx, SSL, reverse proxies, or DNS. Only what was asked.\n" +
        "- Do NOT read files you don't need to edit. Do NOT check if packages exist if you're about to install them.\n" +
        "- When scaffolding with Vite, keep the ORIGINAL vite.config.js and only add server port config.\n" +
        "  Do NOT overwrite vite.config.js with a different version of @vitejs/plugin-react.\n" +
        "- After npm create vite, run 'npm install' in the new project BEFORE changing any files.\n" +
        "- Verify vite is installed by running 'npx vite --version' before starting the dev server.\n" +
        "IMPORTANT npm rules (CRITICAL):\n" +
        "- The project .npmrc with legacy-peer-deps=true and include=dev is auto-created. Do NOT create it manually.\n" +
        "- Use --legacy-peer-deps when installing packages alongside existing ones.\n" +
        "- NEVER run rm -rf node_modules. If a package is missing, install it with --legacy-peer-deps.\n" +
        "- If a command fails twice, stop and report the error. Do NOT try a third time.\n" +
        "When this step is done, respond with ONE sentence confirming what you did.\n" +
        "If this step fails, explain what went wrong in one sentence.";

    // Start heartbeat for this step
    var heartbeatCount = 0;
    var heartbeatTimer = setInterval(function() {
        heartbeatCount++;
        if (!workCancelled) {
            var heartbeatMsg = "step " + stepNum + "/" + totalSteps + ": " + stepDesc.slice(0, 50);
            jorkSend(heartbeatMsg, true);
        }
    }, 120000); // Every 120 seconds

    try {
        // Streaming: pipe live bash output to Telegram, rate-limited
        var lastStreamTime = 0;
        var streamBuffer = '';
        var onStream = null;

        if (showThinking) {
            onStream = function(chunk) {
                streamBuffer += chunk;
                var now = Date.now();
                if (now - lastStreamTime >= 8000 && streamBuffer.trim()) {
                    var lines = streamBuffer.trim().split('\n');
                    var preview = lines.slice(-3).join(' | ').slice(0, 120);
                    if (preview) jorkSend('> ' + preview, true);
                    streamBuffer = '';
                    lastStreamTime = now;
                }
            };
        }

        var result = await llm.invoke(stepPrompt, { tools: true, maxTurns: 12, noResume: true, onStream: onStream });
        // Flush any remaining stream buffer
        if (streamBuffer && streamBuffer.trim()) {
            var finalPreview = streamBuffer.trim().split('\n').slice(-2).join(' | ').slice(0, 120);
            if (finalPreview) jorkSend('> ' + finalPreview, true);
            streamBuffer = '';
        }
        return stripThinking(result);
    } finally {
        clearInterval(heartbeatTimer);
    }
}

// Verify a step succeeded - uses exit codes and targeted pattern matching
function verifyStep(stepDesc, result) {
    if (!result) return { ok: false, reason: "Step returned no response (timeout or error)" };

    // Check for failure patterns — scan more broadly, not just last 5 lines
    var lastLines = result.trim().split('\n').slice(-8).join('\n');
    var fatalPatterns = [
        /^error:/im,
        /command not found/i,
        /ENOENT.*no such file/i,
        /permission denied/i,
        /fatal error/i,
        /Error: Reached max turns/,
        /failed to load config/i,
        /cannot find module/i,
        /npm error ERESOLVE/i,
    ];
    for (var p = 0; p < fatalPatterns.length; p++) {
        var match = lastLines.match(fatalPatterns[p]);
        if (match) {
            // Check if it was actually resolved in subsequent output
            if (/fixed|resolved|worked around|alternative|success|installed|done/i.test(result)) continue;
            return { ok: false, reason: lastLines.slice(0, 200) };
        }
    }

    // Check if result is just exploration/diagnosis with no actual work done
    var shortResult = result.toLowerCase();
    var hasDoneWork = /wrote|written|created|edited|installed|removed|started|running|built|deployed|npm create|npm install/i.test(shortResult);
    if (!hasDoneWork && result.length < 100) {
        // Very short result with no action verbs — likely just analysis
        return { ok: false, reason: "Step produced no actionable output: " + result.slice(0, 100) };
    }

    return { ok: true };
}

// Group steps that can run in parallel.
// Steps are independent if they target different areas (frontend vs program vs config).
function groupParallelSteps(steps) {
    if (steps.length <= 1) return [steps];

    var groups = [];
    var currentGroup = [0]; // first step always starts alone

    for (var i = 1; i < steps.length; i++) {
        var prevLower = steps[i - 1].toLowerCase();
        var currLower = steps[i].toLowerCase();

        // Detect if steps share a focus area (dependent)
        var areas = {
            frontend: ['frontend', 'react', 'next', 'vue', 'svelte', 'ui', 'component', 'page', 'html', 'css', 'vite', 'web'],
            program: ['program', 'anchor', 'rust', 'solana', 'smart contract', 'instruction', 'account', 'lib.rs'],
            install: ['install', 'dependency', 'package', 'npm', 'cargo', 'setup', 'scaffold', 'init'],
            deploy: ['deploy', 'build', 'compile', 'publish', 'test', 'verify'],
        };

        function getArea(text) {
            for (var area in areas) {
                for (var k = 0; k < areas[area].length; k++) {
                    if (text.indexOf(areas[area][k]) !== -1) return area;
                }
            }
            return 'general';
        }

        var prevArea = getArea(prevLower);
        var currArea = getArea(currLower);

        // Can parallelize if different non-deploy areas and group isn't too big
        if (prevArea !== currArea && currArea !== 'deploy' && prevArea !== 'deploy' && currentGroup.length < 2) {
            currentGroup.push(i);
        } else {
            groups.push(currentGroup);
            currentGroup = [i];
        }
    }
    groups.push(currentGroup);
    return groups;
}

// Execute a single step with verification and one retry
async function executeStepAndVerify(stepDesc, stepNum, totalSteps, stepCtx, fullRequest, completedSteps) {
    var result = null;
    try {
        result = await executeStep(stepDesc, stepNum, totalSteps, stepCtx, fullRequest);
    } catch(e) {
        log("Step " + stepNum + " error: " + e.message);
        result = null;
    }

    var verification = verifyStep(stepDesc, result);

    if (!verification.ok) {
        log("Step " + stepNum + " FAILED: " + verification.reason);
        log("Retrying step " + stepNum + "...");
        if (showThinking) jorkSend("Step " + stepNum + " hit an issue. Retrying...", true);

        try {
            var retryCtx = stepCtx + "\nPrevious attempt at this step failed: " + verification.reason + "\n";
            result = await executeStep(stepDesc, stepNum, totalSteps, retryCtx, fullRequest);
            verification = verifyStep(stepDesc, result);
        } catch(e) {
            verification = { ok: false, reason: e.message };
        }

        if (!verification.ok) {
            log("Step " + stepNum + " FAILED after retry: " + verification.reason);
            jorkSend("Stuck on step " + stepNum + " (" + stepDesc + "): " + verification.reason.slice(0, 150) + "\nWhat should I do?", true);
            return { ok: false, result: result || '', failed: true };
        }
    }

    log("Step " + stepNum + " OK: " + (result || "").slice(0, 80));
    return { ok: true, result: result || '' };
}

async function executeBuild(ctx, from, text, plan) {
    working = true;
    workCancelled = false;
    workDescription = text.slice(0, 200);
    log("=== BUILD START: " + workDescription.slice(0, 80) + " ===");

    // Clear old state and save build start checkpoint
    persistence.clearState(cfg.NUCLEUS);
    persistence.saveCheckpoint(cfg.NUCLEUS, {
        type: 'build_start',
        request: text,
        plan: plan,
        totalSteps: parsePlanSteps(plan).length || 1,
    });

    // Parse steps FIRST before setting up timers that reference them
    var steps = parsePlanSteps(plan);
    if (steps.length === 0) {
        // Fallback: couldn't parse plan, treat entire plan as one step
        steps = ["Execute the full build: " + text.slice(0, 200)];
    }

    // Typing indicator
    workTimer = setInterval(function() { tg.typing(); }, 30000);

    // Progress update timer (every 120 seconds)
    var lastStepProgress = 0;
    progressTimer = setInterval(function() {
        if (working && !workCancelled && steps && steps.length > 0) {
            var built = checkWorkspace();
            var shortDesc = lastStepProgress > 0 && steps[lastStepProgress - 1]
                ? steps[lastStepProgress - 1].slice(0, 60)
                : workDescription.slice(0, 50);
            var progressMsg = "on step " + lastStepProgress + "/" + steps.length + ": " + shortDesc;
            if (built) progressMsg += " | workspace: " + built.slice(0, 80);
            jorkSend(progressMsg, true);
        } else if (!working) {
            // Build finished, clear this timer
            clearInterval(progressTimer);
        }
    }, 120000);

    log("Parsed " + steps.length + " steps from plan");
    var completedSteps = [];
    var failed = false;

    // Group steps for potential parallel execution
    var stepGroups = groupParallelSteps(steps);
    if (stepGroups.length < steps.length) {
        log("Parallel groups detected: " + stepGroups.length + " groups for " + steps.length + " steps");
    }

    for (var g = 0; g < stepGroups.length; g++) {
        if (workCancelled) { log("Build cancelled at group " + (g + 1)); break; }

        var group = stepGroups[g];
        var isParallel = group.length > 1;

        if (isParallel && showThinking) {
            jorkSend("Running steps " + group.map(function(idx) { return idx + 1; }).join(' + ') + " in parallel", true);
        }

        // Execute group (parallel or sequential)
        var groupPromises = [];
        for (var gi = 0; gi < group.length; gi++) {
            var stepIdx = group[gi];
            var stepNum = stepIdx + 1;
            var stepDesc = steps[stepIdx];
            lastStepProgress = stepNum;

            log("=== Step " + stepNum + "/" + steps.length + ": " + stepDesc.slice(0, 60) + (isParallel ? " [parallel]" : "") + " ===");

            if (showThinking) {
                jorkSend("Step " + stepNum + "/" + steps.length + ": " + stepDesc, true);
            }

            // Refresh context for this step
            var stepCtx = ctx;
            if (completedSteps.length > 0) {
                var freshWorkspace = checkWorkspace();
                stepCtx = ctx +
                    "\n\n--- COMPLETED SO FAR ---\n" +
                    completedSteps.map(function(s, idx) { return (idx + 1) + ". " + s.desc + ": " + s.result; }).join("\n") +
                    "\n\n--- CURRENT WORKSPACE ---\n" + (freshWorkspace || "no changes yet") + "\n";
            }

            if (isParallel) {
                // Parallel: wrap in promise, collect results
                groupPromises.push(executeStepAndVerify(stepDesc, stepNum, steps.length, stepCtx, text, completedSteps));
            } else {
                // Sequential: execute directly
                var seqResult = await executeStepAndVerify(stepDesc, stepNum, steps.length, stepCtx, text, completedSteps);
                if (!seqResult.ok) {
                    failed = seqResult.failed;
                    break;
                }
                completedSteps.push({ desc: stepDesc, result: seqResult.result.slice(0, 200) });
                if (seqResult.result) remember("jork-work", "Step " + stepNum + ": " + seqResult.result);
                persistence.saveCheckpoint(cfg.NUCLEUS, {
                    type: 'step_complete', step: stepNum, stepDesc: stepDesc,
                    result: seqResult.result.slice(0, 200), totalSteps: steps.length,
                });
            }
        }

        // Handle parallel results
        if (isParallel) {
            var pResults = await Promise.all(groupPromises);
            for (var pi = 0; pi < pResults.length; pi++) {
                if (!pResults[pi].ok) {
                    failed = true;
                    log("Parallel step " + (group[pi] + 1) + " failed");
                } else {
                    var pStepIdx = group[pi];
                    completedSteps.push({ desc: steps[pStepIdx], result: pResults[pi].result.slice(0, 200) });
                    if (pResults[pi].result) remember("jork-work", "Step " + (pStepIdx + 1) + ": " + pResults[pi].result);
                    persistence.saveCheckpoint(cfg.NUCLEUS, {
                        type: 'step_complete', step: pStepIdx + 1, stepDesc: steps[pStepIdx],
                        result: pResults[pi].result.slice(0, 200), totalSteps: steps.length,
                    });
                }
            }
            if (failed) break;
        }
    }

    // Clean up timers and state
    if (workTimer) { clearInterval(workTimer); workTimer = null; }
    if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
    // Clear build state on completion
    if (!failed && !workCancelled) {
        persistence.clearState(cfg.NUCLEUS);
    }

    if (workCancelled) {
        // Already handled by cancel command
    } else if (failed) {
        // Already sent blocker message
    } else {
        // All steps complete. Generate final summary.
        log("=== ALL STEPS COMPLETE ===");
        try {
            var built = checkWorkspace();
            var summaryPrompt = "You are " + cfg.JORK_NAME + ". You just finished building something for your co-founder.\n" +
                "Original request: " + text + "\n" +
                "Steps completed: " + completedSteps.map(function(s) { return s.desc; }).join(", ") + "\n" +
                "Workspace: " + (built || "unknown") + "\n\n" +
                "Send a SHORT final message (1-3 sentences). Include any live URLs if they exist.\n" +
                "Do NOT include URLs you haven't verified. Be warm and direct.";
            var summary = await llm.invoke(summaryPrompt, { tools: false });
            summary = stripThinking(summary);
            if (summary) {
                summary = await verifyUrls(summary);
                remember("jork-work", summary);
                log("=== BUILD DONE: " + summary.slice(0, 80) + " ===");
                jorkSend(summary);
            } else {
                jorkSend("Done. " + completedSteps.length + " steps completed. Check the workspace for results.");
            }
        } catch(e) {
            jorkSend("Build complete. " + completedSteps.length + " steps done.");
        }
    }

    // Clear outbox
    try { fs.writeFileSync(outboxPath(), ""); } catch(e) {}
    working = false;
    workDescription = "";
    await processQueue();
}

// ===========================================================================
// THINK CYCLE - only when there's reason
// ===========================================================================

async function think() {
    if (thinkBusy || working) return;
    thinkBusy = true;

    var active = loadActiveGoal();

    // No active goals + no pending tasks = don't think
    if (!active) {
        thinkBusy = false;
        return;
    }

    log("Think cycle...");
    var ctx = buildWorkContext(active.goal.title);

    try {
        var stepDesc = active.step ? active.step.id + ": " + active.step.description : active.goal.title;
        log("Think: " + active.goal.title + " / " + (active.step ? active.step.id : "?"));
        var prompt = ctx + "\n" +
            "Life cycle. Time: " + new Date().toISOString() + ".\n" +
            "Active goal: " + active.goal.title + "\n" +
            "Current step: " + stepDesc + "\n\n" +
            "Execute this step. Be concrete. Do NOT message the user. Do NOT write to the outbox. Silent work.";
        var response = await llm.invoke(prompt, { tools: true, noResume: true });
        if (response && response.indexOf("Error: Reached max turns") === -1) {
            remember("jork-think", response);
            log("Think done: " + response.slice(0, 100));
            try { fs.writeFileSync(outboxPath(), ""); } catch(e) {}
        }
    } catch(e) {
        log("Think err: " + e.message);
    }

    thinkBusy = false;
}

// ===========================================================================
// QUEUE PROCESSING
// ===========================================================================

async function processQueue() {
    if (messageQueue.length === 0) return;
    var queued = messageQueue.splice(0);
    log("Processing " + queued.length + " queued task(s)...");
    for (var i = 0; i < queued.length; i++) {
        await handleMessage(queued[i]);
    }
}

// ===========================================================================
// PREPROCESS (voice, image)
// ===========================================================================

async function preprocessMessage(msg) {
    var text = msg.text || "";
    var imagePath = msg.imagePath || null;

    if (msg.voicePath) {
        log("Transcribing voice...");
        try {
            var { exec } = require("child_process");
            var powersDir = path.join(cfg.WORKSPACE, "powers", "voice");
            if (fs.existsSync(path.join(powersDir, "index.py"))) {
                text = await new Promise(function(resolve) {
                    exec('python3 "' + path.join(powersDir, "index.py") + '" transcribe "' + msg.voicePath + '"', { timeout: 60000 }, function(err, stdout) {
                        if (err) resolve("(could not transcribe)");
                        else resolve(stdout.toString().trim());
                    });
                });
                log("Transcribed: " + text.slice(0, 80));
            } else { text = "(voice power not installed)"; }
        } catch(e) { text = "(could not transcribe)"; }
        // Voice file is no longer needed after transcription.
        tg.cleanupMedia(msg.voicePath);
    }

    if (imagePath) {
        text = (text || "Analyze this image") + "\n[Image attached: " + imagePath + "]";
    }

    return { text: text, from: msg.from || "colleague", imagePath: imagePath };
}

// ===========================================================================
// MAIN MESSAGE HANDLER - router
// ===========================================================================

async function handleMessage(msg) {
    tg.typing();

    var processed = await preprocessMessage(msg);
    var text = processed.text;
    var from = processed.from;
    var imagePath = processed.imagePath;

    if (!text) return;

    // 1. Check for commands first (no LLM, instant)
    var cmd = isCommand(text);
    if (cmd) {
        handleCommand(cmd);
        return;
    }

    log("<- " + from + ": " + text.slice(0, 80));
    remember(from, text);
    extractCofounderInfo(text);

    // 2. CHECK FOR STOP COMMANDS - before everything else, so stop works even when waiting for confirmation
    if (loop.isStopCommand(text)) {
        log("[stop] Command detected, halting");
        if (working) {
            workCancelled = true;
            if (workTimer) { clearInterval(workTimer); workTimer = null; }
            if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
            // Kill running tool process immediately
            loop.requestHalt();
            working = false; workDescription = "";
        }
        // Clear pendingConfirm if we're stopping
        pendingConfirm = null;
        var stopMsg = "stopped. waiting for your next instruction.";
        remember("jork", stopMsg);
        jorkSend(stopMsg, true);
        return;
    }

    // 3. If waiting for thinking preference answer
    if (pendingConfirm) {
        // Let LLM classify the answer instead of fragile regex
        try {
            var classifyResult = await llm.invoke(
                "The user was asked if they want to see build progress or just the final result.\n" +
                "They replied: " + text + "\n\n" +
                "Does the user want to SEE progress? Reply with ONE word: show or hide",
                { tools: false }
            );
            classifyResult = stripThinking(classifyResult).toLowerCase().trim();
            if (classifyResult.indexOf("show") !== -1) {
                showThinking = true;
                tg.setShowThinking(true);
                saveCofounderField('Show thinking', 'yes');
            } else {
                showThinking = false;
                tg.setShowThinking(false);
                saveCofounderField('Show thinking', 'no');
            }
        } catch(e) {
            // Default to show if classification fails
            showThinking = true;
            tg.setShowThinking(true);
            saveCofounderField('Show thinking', 'yes');
        }
        thinkingAsked = true;
        log("Thinking: " + (showThinking ? "SHOW" : "HIDE"));

        var pc = pendingConfirm;
        pendingConfirm = null;

        // LLM generates the "starting now" message
        try {
            var startMsg = await llm.invoke(
                "You are " + cfg.JORK_NAME + ". Your co-founder said '" + text + "' about seeing your build progress.\n" +
                "You are about to build: " + pc.plan.split('\n')[0] + "\n" +
                (showThinking ? "They want to see your progress." : "They want just the result.") +
                " Say ONE natural sentence confirming you are starting.",
                { tools: false }
            );
            startMsg = stripThinking(startMsg);
            jorkSend(startMsg);
        } catch(e) {
            jorkSend("Starting now.");
        }

        executeBuild(pc.ctx, pc.from, pc.text, pc.plan);
        return;
    }

    // 4. If currently working, respond with deterministic message
    if (working) {
        var built = checkWorkspace();
        var response = "";
        var lowerText = text.toLowerCase().trim();

        // Check for "go" command to proceed
        if (lowerText === "go") {
            if (messageQueue.length > 0) {
                response = "continuing. " + messageQueue.length + " queued.";
                var queued = messageQueue.slice();
                messageQueue = [];
                setImmediate(function() {
                    queued.forEach(function(m) { handleMessage(m).catch(function() {}); });
                });
            } else {
                response = "continuing with " + workDescription;
            }
        } else {
            // Queue new message
            messageQueue.push(msg);
            response = "working on " + workDescription + (built ? ". got: " + text.slice(0, 40) : ". send 'go' to queue changes or 'stop' to cancel.");
        }

        remember("jork", response);
        jorkSend(response, true); // Skip filtering for these system messages
        return;
    }

    // 5. CLASSIFY: chat, build, or analyze? (lightweight LLM call)
    var type = await classify(text);
    log("[router] " + type);

    if (type === "build") {
        await handleBuild(text, from, imagePath);
    } else if (type === "analyze") {
        await handleAnalyze(text, from, imagePath);
    } else {
        await handleChat(text, from, imagePath);
    }
}

// ===========================================================================
// MAIN LOOP
// ===========================================================================

async function run() {
    log("========================================");
    log("JORK v3 - Router + Build Pipeline");
    log("========================================");

    initNucleus();
    pulse();

    // Restore thinking preference
    try {
        var cf = fs.readFileSync(cfg.COFOUNDER(), 'utf8');
        var thinkMatch = cf.match(/^Show thinking:\s*(.+)$/m);
        if (thinkMatch && thinkMatch[1].trim() !== '(not set)') {
            showThinking = thinkMatch[1].trim() === 'yes';
            thinkingAsked = true;
            tg.setShowThinking(showThinking);
            log("Thinking: " + (showThinking ? "SHOW" : "HIDE"));
        }
    } catch(e) {}

    await fetchAvailablePowers();

    // Check for interrupted build
    var interrupted = persistence.checkInterrupted(cfg.NUCLEUS);
    if (interrupted) {
        log("Found interrupted build: " + interrupted.request.slice(0, 80));
        jorkSend("last session had an interrupted build: \"" + interrupted.request.slice(0, 100) + "\" (" + interrupted.completedSteps + "/" + interrupted.totalSteps + " steps done). clearing the state — tell me if you want me to restart it.", true);
        persistence.clearState(cfg.NUCLEUS);
    }

    var stale = await tg.poll();
    if (stale.length > 0) log("Flushed " + stale.length + " stale message(s)");

    await wakeUp();

    lastThink = Date.now();

    var lastMediaSweep = Date.now();

    async function pollLoop() {
        var now = Date.now();
        if (now - lastPulse >= cfg.HEARTBEAT_INTERVAL) { pulse(); lastPulse = now; }
        if (!working) flushOutbox();

        var msgs = await tg.poll();
        for (var i = 0; i < msgs.length; i++) {
            log("<- TG: " + (msgs[i].text || "(media)").slice(0, 80));
            await handleMessage(msgs[i]);
        }

        if (!thinkBusy && !working && now - lastThink >= cfg.THINK_INTERVAL) {
            lastThink = now;
            think().catch(function(e) { log("Think fatal: " + e.message); thinkBusy = false; });
        }

        // Hourly media GC so leftover image/voice files never accumulate.
        if (now - lastMediaSweep >= 3600000) {
            lastMediaSweep = now;
            tg.sweepMedia(3600000);
        }

        setTimeout(pollLoop, cfg.POLL_INTERVAL);
    }

    pollLoop();
}

// ===========================================================================
// SHUTDOWN
// ===========================================================================

function shutdown(signal) {
    log("Shutting down (" + signal + ")...");
    if (memory) { try { memory.close(); log("Memory flushed."); } catch(e) {} }
    process.exit(0);
}

process.on("SIGTERM", function() { shutdown("SIGTERM"); });
process.on("SIGINT", function() { shutdown("SIGINT"); });
process.on("uncaughtException", function(e) { log("UNCAUGHT: " + e.message); });
process.on("unhandledRejection", function(e) { log("UNHANDLED: " + (e && e.message ? e.message : String(e))); });

run().catch(function(e) { log("Fatal: " + e.message); process.exit(1); });
