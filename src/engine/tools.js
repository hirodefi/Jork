'use strict';

// Jork Execution Engine - Tool Implementations
// 8 tools. Each is an async function using spawn (not execSync).
// This keeps Node's event loop free during long-running commands.

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { spawn, execSync } = require('child_process');

// ---- Active process tracking (for cancellation) ----

var activeProcess = null;

function setActiveProcess(proc) {
    activeProcess = proc;
}

function killActiveProcess() {
    if (activeProcess) {
        try { activeProcess.kill('SIGTERM'); } catch(e) {}
        setTimeout(function() {
            if (activeProcess) {
                try { activeProcess.kill('SIGKILL'); } catch(e) {}
                activeProcess = null;
            }
        }, 3000);
        activeProcess = null;
    }
}

// ---- Async spawn helper ----

function spawnCommand(command, opts) {
    opts = opts || {};
    return new Promise(function(resolve) {
        var proc = spawn('bash', ['-c', command], {
            cwd: opts.cwd || process.cwd(),
            env: Object.assign({}, process.env, { FORCE_COLOR: '0' }),
        });

        var stdout = '';
        var stderr = '';
        proc.stdout.on('data', function(d) {
            stdout += d;
            if (opts.onChunk) opts.onChunk(d.toString());
        });
        proc.stderr.on('data', function(d) {
            stderr += d;
            if (opts.onChunk) opts.onChunk(d.toString());
        });

        var timer = setTimeout(function() {
            try { proc.kill('SIGTERM'); } catch(e) {}
            resolve({
                output: (stdout + (stderr ? '\n' + stderr : '')).trim().slice(0, 50000),
                exitCode: -1,
                timedOut: true,
            });
        }, opts.timeout || 60000);

        // Store reference for cancellation
        if (opts.trackProcess !== false) setActiveProcess(proc);

        proc.on('close', function(code) {
            clearTimeout(timer);
            setActiveProcess(null);
            var output = (stdout + (stderr ? '\n' + stderr : '')).trim();
            resolve({
                output: output.slice(0, 50000),
                exitCode: code || 0,
            });
        });

        proc.on('error', function(e) {
            clearTimeout(timer);
            setActiveProcess(null);
            resolve({
                output: 'Process error: ' + e.message,
                exitCode: 1,
            });
        });
    });
}

// ---- Tool: Bash ----
// Run a shell command. Returns structured result with exit code.

async function bashTool(params) {
    var command = params.command;
    var timeout = Math.min(parseInt(params.timeout) || 60000, 600000);
    var cwd = params.cwd || process.cwd();
    var onChunk = params.onChunk || null;

    // Auto-create .npmrc in the PROJECT directory before npm install/create.
    // npm 10.x defaults to omit=dev which skips devDependencies (vite, etc).
    // We must create .npmrc NEXT TO the package.json, not in the workspace root.
    if (/npm\s+(i|install|ci|create)/.test(command)) {
        // Find the actual target directory from the command (e.g. "cd foo && npm install")
        var cdMatch = command.match(/cd\s+([^\s&;|]+)/);
        var targetDir = cdMatch ? cdMatch[1] : cwd;
        var npmrcPath = path.join(targetDir, '.npmrc');
        try {
            if (!fs.existsSync(npmrcPath)) {
                fs.writeFileSync(npmrcPath, 'legacy-peer-deps=true\ninclude=dev\n');
            }
        } catch(e) { /* dir may not exist yet, that's ok */ }
    }

    var result = await spawnCommand(command, {
        timeout: timeout,
        cwd: cwd,
        onChunk: onChunk,
    });

    if (result.exitCode === 0) {
        return result.output || '(no output)';
    }

    return 'Exit code ' + result.exitCode + ':\n' + result.output;
}

// ---- Tool: Read ----
// Read a file. Returns contents.

function readTool(params) {
    var filePath = params.file_path;
    var offset = parseInt(params.offset) || 0;
    var limit = parseInt(params.limit) || 0;
    try {
        var content = fs.readFileSync(filePath, 'utf8');
        if (offset > 0 || limit > 0) {
            var lines = content.split('\n');
            if (offset > 0) lines = lines.slice(offset);
            if (limit > 0) lines = lines.slice(0, limit);
            content = lines.join('\n');
        }
        return content.slice(0, 50000);
    } catch(e) {
        return 'Error: ' + e.message;
    }
}

// ---- Tool: Write ----
// Create or overwrite a file.

function writeTool(params) {
    var filePath = params.file_path;
    var content = params.content;
    try {
        var dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, content);
        return 'Written: ' + filePath + ' (' + content.length + ' chars)';
    } catch(e) {
        return 'Error: ' + e.message;
    }
}

// ---- Tool: Edit ----
// Replace a string in a file. Targeted edit, not full rewrite.
// If old_string matches more than once, the edit is rejected so the caller
// can pass a more specific anchor — silently replacing only the first match
// is a classic footgun when the LLM tries to iterate on the same file.

function editTool(params) {
    var filePath = params.file_path;
    var oldString = params.old_string;
    var newString = params.new_string;
    var replaceAll = params.replace_all === true;
    try {
        var content = fs.readFileSync(filePath, 'utf8');
        var firstIdx = content.indexOf(oldString);
        if (firstIdx === -1) {
            return 'Error: old_string not found in ' + filePath;
        }
        if (!replaceAll) {
            var nextIdx = content.indexOf(oldString, firstIdx + oldString.length);
            if (nextIdx !== -1) {
                var count = 1;
                var scan = nextIdx;
                while (scan !== -1) {
                    count++;
                    scan = content.indexOf(oldString, scan + oldString.length);
                }
                return 'Error: old_string matches ' + count + ' times in ' + filePath +
                    '. Provide a more specific old_string (include surrounding context) or set replace_all=true.';
            }
        }
        var updated = replaceAll
            ? content.split(oldString).join(newString)
            : content.slice(0, firstIdx) + newString + content.slice(firstIdx + oldString.length);
        fs.writeFileSync(filePath, updated);
        return 'Edited: ' + filePath;
    } catch(e) {
        return 'Error: ' + e.message;
    }
}

// ---- Tool: Glob ----
// Find files matching a pattern. Async via spawn.

async function globTool(params) {
    var pattern = params.pattern;
    var dir = params.path || '.';
    var name = path.basename(pattern);
    var cmd = 'find ' + JSON.stringify(dir) + ' -name ' + JSON.stringify(name) +
        ' -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -50';

    var result = await spawnCommand(cmd, { timeout: 10000, trackProcess: false });
    if (result.exitCode !== 0 && !result.output) return 'Error: find failed';
    return result.output.trim() || 'No files found.';
}

// ---- Tool: Grep ----
// Search file contents for a pattern. Async via spawn.

async function grepTool(params) {
    var pattern = params.pattern;
    var dir = params.path || '.';
    var fileType = params.file_type || '';

    var cmd = 'grep -rn --include=' + JSON.stringify(fileType ? '*.' + fileType : '*') +
        ' ' + JSON.stringify(pattern) + ' ' + JSON.stringify(dir) +
        ' 2>/dev/null | head -30';

    var result = await spawnCommand(cmd, { timeout: 10000, trackProcess: false });
    if (result.exitCode === 1) return 'No matches found.';
    if (result.exitCode !== 0 && !result.output) return 'Error: grep failed';
    return result.output.trim() || 'No matches found.';
}

// ---- Tool: WebFetch ----
// Fetch a URL and return plain-text content (HTML stripped). Uses node https
// directly for safer handling than shelling out to curl.

async function webFetchTool(params) {
    var url = params.url;
    if (!url) return 'Error: url is required';

    var res = await fetchUrl(url, { timeout: 15000, accept: 'text/html, */*' });
    if (!res) return 'Error fetching ' + url;
    if (res.status >= 400) return 'HTTP ' + res.status + ' fetching ' + url;

    var output = String(res.body || '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ');
    output = htmlDecode(output).replace(/\s+/g, ' ').trim();

    return output.slice(0, 15000) || 'Empty response.';
}

// ---- Tool: WebSearch ----
// Multi-engine web search with graceful fallback.
//
// Preference order (most accurate first):
//   1. Brave Search API      (real Google-class results, needs BRAVE_API_KEY)
//   2. Google via SerpAPI    (real Google, needs SERPAPI_KEY)
//   3. SearXNG public        (aggregates Google+Bing+DDG, no key)
//   4. DuckDuckGo HTML       (free fallback, scrape)
//   5. Wikipedia OpenSearch  (factual last-resort)
//
// Each engine returns an array of {title, url, snippet} or null.
// The tool picks the first engine that yields results. Failures are silent.

function fetchUrl(rawUrl, opts) {
    opts = opts || {};
    return new Promise(function(resolve) {
        var u;
        try { u = new URL(rawUrl); } catch(e) { resolve(null); return; }
        var lib = u.protocol === 'http:' ? http : https;
        var req = lib.request({
            hostname: u.hostname,
            port: u.port || (u.protocol === 'http:' ? 80 : 443),
            path: u.pathname + u.search,
            method: opts.method || 'GET',
            headers: Object.assign({
                'User-Agent': 'Mozilla/5.0 (compatible; Jork/2.0; +https://github.com/hirodefi/Jork)',
                'Accept': opts.accept || 'application/json, text/html, */*',
            }, opts.headers || {}),
        }, function(res) {
            // Handle redirects once.
            if ([301, 302, 303, 307, 308].indexOf(res.statusCode) !== -1 && res.headers.location && !opts._redirected) {
                var next = res.headers.location.startsWith('http')
                    ? res.headers.location
                    : u.protocol + '//' + u.hostname + res.headers.location;
                res.resume();
                resolve(fetchUrl(next, Object.assign({}, opts, { _redirected: true })));
                return;
            }
            var chunks = '';
            res.on('data', function(d) { chunks += d; });
            res.on('end', function() { resolve({ status: res.statusCode, body: chunks }); });
        });
        req.on('error', function() { resolve(null); });
        req.setTimeout(opts.timeout || 8000, function() { req.destroy(); resolve(null); });
        if (opts.body) req.write(opts.body);
        req.end();
    });
}

function htmlDecode(s) {
    if (!s) return '';
    return s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, function(_, n) { return String.fromCharCode(parseInt(n, 10)); });
}

function stripHtml(s) {
    return htmlDecode(String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

async function searchBrave(query) {
    if (!process.env.BRAVE_API_KEY) return null;
    var url = 'https://api.search.brave.com/res/v1/web/search?count=8&q=' + encodeURIComponent(query);
    var res = await fetchUrl(url, {
        headers: {
            'Accept': 'application/json',
            'X-Subscription-Token': process.env.BRAVE_API_KEY,
        },
    });
    if (!res || res.status !== 200) return null;
    try {
        var data = JSON.parse(res.body);
        var web = data.web && data.web.results;
        if (!web || !web.length) return null;
        return web.slice(0, 8).map(function(r) {
            return { title: r.title || '', url: r.url || '', snippet: r.description || '' };
        });
    } catch(e) { return null; }
}

async function searchSerpApi(query) {
    if (!process.env.SERPAPI_KEY) return null;
    var url = 'https://serpapi.com/search.json?engine=google&num=8&q=' + encodeURIComponent(query) +
        '&api_key=' + encodeURIComponent(process.env.SERPAPI_KEY);
    var res = await fetchUrl(url);
    if (!res || res.status !== 200) return null;
    try {
        var data = JSON.parse(res.body);
        var organic = data.organic_results;
        if (!organic || !organic.length) return null;
        return organic.slice(0, 8).map(function(r) {
            return { title: r.title || '', url: r.link || '', snippet: r.snippet || '' };
        });
    } catch(e) { return null; }
}

// SearXNG public instances. We try several — any given one can go down.
var SEARXNG_INSTANCES = [
    'https://searx.be',
    'https://search.sapti.me',
    'https://priv.au',
    'https://searx.tiekoetter.com',
];

async function searchSearxng(query) {
    for (var i = 0; i < SEARXNG_INSTANCES.length; i++) {
        var base = SEARXNG_INSTANCES[i];
        var url = base + '/search?format=json&safesearch=0&q=' + encodeURIComponent(query);
        var res = await fetchUrl(url, { accept: 'application/json', timeout: 6000 });
        if (!res || res.status !== 200) continue;
        try {
            var data = JSON.parse(res.body);
            if (!data.results || !data.results.length) continue;
            return data.results.slice(0, 8).map(function(r) {
                return { title: r.title || '', url: r.url || '', snippet: r.content || '' };
            });
        } catch(e) { continue; }
    }
    return null;
}

async function searchDuckDuckGoHtml(query) {
    var url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
    var res = await fetchUrl(url, { accept: 'text/html' });
    if (!res || res.status !== 200 || !res.body) return null;

    var results = [];
    // DDG HTML result blocks: <a class="result__a" href="...">title</a>
    // followed by <a class="result__snippet">snippet</a>
    var re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
    var m;
    while ((m = re.exec(res.body)) && results.length < 8) {
        var href = m[1];
        // DDG wraps links in a redirect: /l/?uddg=<encoded>
        var encoded = href.match(/[?&]uddg=([^&]+)/);
        if (encoded) { try { href = decodeURIComponent(encoded[1]); } catch(e) {} }
        results.push({
            title: stripHtml(m[2]),
            url: href,
            snippet: stripHtml(m[3]),
        });
    }
    return results.length ? results : null;
}

async function searchWikipedia(query) {
    var url = 'https://en.wikipedia.org/w/api.php?action=opensearch&limit=6&namespace=0&format=json&search=' + encodeURIComponent(query);
    var res = await fetchUrl(url, { accept: 'application/json' });
    if (!res || res.status !== 200) return null;
    try {
        var data = JSON.parse(res.body);
        if (!Array.isArray(data) || data.length < 4) return null;
        var titles = data[1] || [];
        var descs = data[2] || [];
        var urls = data[3] || [];
        if (!titles.length) return null;
        return titles.map(function(t, i) {
            return { title: t, url: urls[i] || '', snippet: descs[i] || '' };
        });
    } catch(e) { return null; }
}

function formatResults(results, query) {
    if (!results || !results.length) return 'No results found for: ' + query;
    return results.map(function(r, i) {
        return (i + 1) + '. ' + (r.title || '(untitled)') +
            (r.url ? '\n   ' + r.url : '') +
            (r.snippet ? '\n   ' + r.snippet : '');
    }).join('\n\n');
}

async function webSearchTool(params) {
    var query = (params.query || '').trim();
    if (!query) return 'Error: query is required';

    var engines = [
        { name: 'brave',    fn: searchBrave },
        { name: 'serpapi',  fn: searchSerpApi },
        { name: 'searxng',  fn: searchSearxng },
        { name: 'ddg',      fn: searchDuckDuckGoHtml },
        { name: 'wikipedia', fn: searchWikipedia },
    ];

    for (var i = 0; i < engines.length; i++) {
        var results;
        try { results = await engines[i].fn(query); }
        catch(e) { results = null; }
        if (results && results.length) {
            return 'via ' + engines[i].name + ':\n\n' + formatResults(results, query);
        }
    }
    return 'No results found for: ' + query;
}

// ---- Tool Registry ----

var TOOLS = {
    Bash: {
        name: 'Bash',
        description: 'Run a shell command and return the output. Use for: installing packages, running builds, deploying, any terminal command.',
        schema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'The shell command to execute' },
                timeout: { type: 'number', description: 'Timeout in ms (default 60000, max 600000)' },
                cwd: { type: 'string', description: 'Working directory (optional)' },
            },
            required: ['command'],
        },
        execute: bashTool,
    },
    Read: {
        name: 'Read',
        description: 'Read the contents of a file. Returns the file text.',
        schema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Absolute or relative path to the file' },
                offset: { type: 'number', description: 'Line number to start reading from (optional)' },
                limit: { type: 'number', description: 'Number of lines to read (optional)' },
            },
            required: ['file_path'],
        },
        execute: readTool,
    },
    Write: {
        name: 'Write',
        description: 'Create or overwrite a file with the given content. Creates directories if needed.',
        schema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Path to the file to write' },
                content: { type: 'string', description: 'The content to write to the file' },
            },
            required: ['file_path', 'content'],
        },
        execute: writeTool,
    },
    Edit: {
        name: 'Edit',
        description: 'Replace a specific string in a file. Fails if old_string matches more than once unless replace_all=true, so pass enough surrounding context to make it unique.',
        schema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Path to the file to edit' },
                old_string: { type: 'string', description: 'The exact string to find and replace (must match exactly once unless replace_all=true)' },
                new_string: { type: 'string', description: 'The replacement string' },
                replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match' },
            },
            required: ['file_path', 'old_string', 'new_string'],
        },
        execute: editTool,
    },
    Glob: {
        name: 'Glob',
        description: 'Find files matching a pattern. Returns file paths.',
        schema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'File name pattern (e.g. "*.js", "package.json")' },
                path: { type: 'string', description: 'Directory to search in (default: current dir)' },
            },
            required: ['pattern'],
        },
        execute: globTool,
    },
    Grep: {
        name: 'Grep',
        description: 'Search file contents for a text pattern. Returns matching lines with file paths and line numbers.',
        schema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Text pattern to search for' },
                path: { type: 'string', description: 'Directory to search in (default: current dir)' },
                file_type: { type: 'string', description: 'File extension to filter (e.g. "js", "py")' },
            },
            required: ['pattern'],
        },
        execute: grepTool,
    },
    WebFetch: {
        name: 'WebFetch',
        description: 'Fetch a URL and return its content as text. HTML is stripped to plain text.',
        schema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'The URL to fetch' },
            },
            required: ['url'],
        },
        execute: webFetchTool,
    },
    WebSearch: {
        name: 'WebSearch',
        description: 'Search the web for information. Returns relevant text results.',
        schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query' },
            },
            required: ['query'],
        },
        execute: webSearchTool,
    },
};

// Execute a tool call by name (async - returns Promise)
async function executeTool(name, params) {
    var tool = TOOLS[name];
    if (!tool) return 'Error: Unknown tool "' + name + '"';
    try {
        var result = await tool.execute(params || {});
        return result;
    } catch(e) {
        return 'Error executing ' + name + ': ' + e.message;
    }
}

module.exports = { TOOLS, executeTool, killActiveProcess };
