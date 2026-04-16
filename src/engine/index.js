'use strict';

// Jork Execution Engine
// Provider-independent. No CLI dependency.
// Drop-in replacement for Claude CLI tool execution.

var { execute, chat } = require('./loop');
var { TOOLS } = require('./tools');
var { createProvider } = require('./providers');
var { addPreHook, addPostHook } = require('./hooks');

module.exports = { execute, chat, TOOLS, createProvider, addPreHook, addPostHook };
