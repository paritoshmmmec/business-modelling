/*
 * run-tests.js — Node runner for the browser-agnostic test suite.
 *
 * Each source file wraps itself as (function(global){...})(this-or-window).
 * We load them with vm.runInThisContext so their top-level `this` is the real
 * global object, letting them share window-style globals exactly as the
 * browser does. Then tests.js runs and sets the process exit code.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const files = [
  'js/format.js',
  'js/finance.js',
  'js/engine.js',
  'js/charts.js',
  'js/ui.js',
  'domains/datacenter.js',
  'js/tests.js'
];

// Minimal DOM shim so ui.js's App constructor (which only stores refs) loads.
globalThis.document = globalThis.document || undefined;

for (const f of files) {
  const code = fs.readFileSync(path.join(__dirname, f), 'utf8');
  vm.runInThisContext(code, { filename: f });
}
