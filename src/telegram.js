'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const OFFSET_FILE = path.join(cfg.ROOT, 'jork.offset');
const MEDIA_DIR = path.join(cfg.ROOT, 'media');
let tgOffset = 0;
try { tgOffset = parseInt(fs.readFileSync(OFFSET_FILE, 'utf8').trim()) || 0; } catch(e) {}
try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch(e) {}

function saveOffset() {
    try { fs.writeFileSync(OFFSET_FILE, String(tgOffset)); } catch(e) {}
}

function post(endpoint, data) {
    return new Promise(function(resolve) {
        const body = JSON.stringify(data);
        const req = https.request({
            hostname: 'api.telegram.org',
            path: '/bot' + cfg.TG_BOT_TOKEN + '/' + endpoint,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, function(res) {
            let resp = '';
            res.on('data', function(d) { resp += d; });
            res.on('end', function() {
                try { resolve(JSON.parse(resp)); } catch(e) { resolve(null); }
            });
        });
        req.on('error', function() { resolve(null); });
        req.write(body);
        req.end();
    });
}

var _sendQueue = [];
var _sending = false;

// Expose a flag that jork.js can set
var _showThinking = false;
function setShowThinking(val) { _showThinking = val; }

// Message dedup: track last 3 messages to prevent repeats
var _recentSent = [];

function send(text) {
    if (!text) return;
    // Strip thinking blocks unless user asked to see them
    if (!_showThinking) {
        text = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
    }
    // Strip any raw JSON objects that leaked from LLM output
    text = text.replace(/\{"text"\s*:\s*"[^"]*"\}/g, '').trim();
    if (!text) return;

    // Dedup: skip exact duplicates or near-exact (90%+ overlap) from last 3 messages
    var textNorm = text.toLowerCase().replace(/\s+/g, ' ').trim();
    for (var i = 0; i < _recentSent.length; i++) {
        if (_recentSent[i] === textNorm) return; // exact duplicate
        if (textNorm.length < 30) continue;
        var wordsNew = new Set(textNorm.split(' ').filter(function(w) { return w.length > 3; }));
        var wordsOld = new Set(_recentSent[i].split(' ').filter(function(w) { return w.length > 3; }));
        if (wordsNew.size > 0 && wordsOld.size > 0) {
            var overlap = 0;
            wordsNew.forEach(function(w) { if (wordsOld.has(w)) overlap++; });
            if (overlap / Math.max(wordsNew.size, wordsOld.size) > 0.9) return;
        }
    }
    _recentSent.push(textNorm);
    if (_recentSent.length > 3) _recentSent.shift();

    const chunks = [];
    for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));
    for (const chunk of chunks) _sendQueue.push(chunk);
    _drainSendQueue();
}

function _drainSendQueue() {
    if (_sending || _sendQueue.length === 0) return;
    _sending = true;
    var chunk = _sendQueue.shift();
    post('sendMessage', { chat_id: cfg.TG_CHAT_ID, text: chunk }).then(function() {
        _sending = false;
        // 50ms gap between sends to stay under TG rate limits
        if (_sendQueue.length > 0) setTimeout(_drainSendQueue, 50);
    });
}

// Download a file from Telegram by file_id
async function downloadFile(fileId) {
    const fileInfo = await post('getFile', { file_id: fileId });
    if (!fileInfo || !fileInfo.ok || !fileInfo.result || !fileInfo.result.file_path) return null;

    const filePath = fileInfo.result.file_path;
    const ext = path.extname(filePath) || '.bin';
    const localPath = path.join(MEDIA_DIR, Date.now() + ext);

    return new Promise(function(resolve) {
        const url = '/file/bot' + cfg.TG_BOT_TOKEN + '/' + filePath;
        const req = https.request({
            hostname: 'api.telegram.org',
            path: url,
            method: 'GET'
        }, function(res) {
            const stream = fs.createWriteStream(localPath);
            res.pipe(stream);
            stream.on('finish', function() { stream.close(); resolve(localPath); });
        });
        req.on('error', function() { resolve(null); });
        req.end();
    });
}

function poll() {
    return new Promise(function(resolve) {
        const req = https.request({
            hostname: 'api.telegram.org',
            path: '/bot' + cfg.TG_BOT_TOKEN + '/getUpdates?offset=' + tgOffset + '&timeout=0&limit=10',
            method: 'GET'
        }, function(res) {
            let body = '';
            res.on('data', function(d) { body += d; });
            res.on('end', async function() {
                try {
                    const data = JSON.parse(body);
                    if (!data.ok || !data.result || !data.result.length) return resolve([]);
                    const msgs = [];
                    for (const update of data.result) {
                        tgOffset = update.update_id + 1;
                        saveOffset();
                        const m = update.message;
                        if (!m) continue;

                        const from = m.from;
                        if (String(from.id) !== String(cfg.TG_CHAT_ID)) continue;

                        const msg = { text: '', from: from.first_name || 'colleague' };

                        // Text message
                        if (m.text) {
                            if (m.text === '/start') continue;
                            msg.text = m.text;
                        }

                        // Voice message
                        if (m.voice) {
                            try {
                                msg.voicePath = await downloadFile(m.voice.file_id);
                            } catch(e) {}
                        }

                        // Photo (take largest)
                        if (m.photo && m.photo.length > 0) {
                            try {
                                const largest = m.photo[m.photo.length - 1];
                                msg.imagePath = await downloadFile(largest.file_id);
                                if (m.caption) msg.text = m.caption;
                            } catch(e) {}
                        }

                        // Document (images sent as files)
                        if (m.document && m.document.mime_type && m.document.mime_type.startsWith('image/')) {
                            try {
                                msg.imagePath = await downloadFile(m.document.file_id);
                                if (m.caption) msg.text = m.caption;
                            } catch(e) {}
                        }

                        // Only add if there's something to process
                        if (msg.text || msg.voicePath || msg.imagePath) {
                            msgs.push(msg);
                        }
                    }
                    resolve(msgs);
                } catch(e) { resolve([]); }
            });
        });
        req.on('error', function() { resolve([]); });
        req.end();
    });
}

function typing() {
    post('sendChatAction', { chat_id: cfg.TG_CHAT_ID, action: 'typing' });
}

// Delete a media file we finished processing. Silent on failure.
function cleanupMedia(filePath) {
    if (!filePath) return;
    try {
        if (filePath.startsWith(MEDIA_DIR) && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch(e) {}
}

// Sweep old media files (older than maxAgeMs). Runs on a timer so we don't
// fill disk when a cleanup was missed.
function sweepMedia(maxAgeMs) {
    try {
        var cutoff = Date.now() - (maxAgeMs || 3600000); // 1h default
        var entries = fs.readdirSync(MEDIA_DIR);
        for (var i = 0; i < entries.length; i++) {
            var full = path.join(MEDIA_DIR, entries[i]);
            try {
                var st = fs.statSync(full);
                if (st.isFile() && st.mtimeMs < cutoff) fs.unlinkSync(full);
            } catch(e) {}
        }
    } catch(e) {}
}

module.exports = { send, poll, typing, downloadFile, setShowThinking, cleanupMedia, sweepMedia };
