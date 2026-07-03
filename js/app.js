/*
 * app.js — boots a domain into the page, wires currency, URL state sharing,
 * reset and CSV export. Domain-agnostic: it reads window.DOMAINS and mounts
 * the one selected by ?domain= (default: datacenter).
 */
(function (global) {
  'use strict';

  var app; // current UI.App instance

  function qs(id) { return document.getElementById(id); }

  // ---- URL state (shareable links) --------------------------------------
  // Encodes {domain, scenario, inputs} into the URL hash as compact JSON.
  function encodeState() {
    if (!app) return '';
    var state = {
      d: app.config.id,
      s: app.scenarioId,
      c: app.inputs.currency,
      i: app.inputs
    };
    try {
      return encodeURIComponent(JSON.stringify(state));
    } catch (e) { return ''; }
  }

  function writeUrl() {
    var enc = encodeState();
    if (history.replaceState) {
      history.replaceState(null, '', '#' + enc);
    } else {
      location.hash = enc;
    }
  }

  function readState() {
    var hash = location.hash.replace(/^#/, '');
    if (!hash) return null;
    try {
      return JSON.parse(decodeURIComponent(hash));
    } catch (e) { return null; }
  }

  // ---- CSV export --------------------------------------------------------
  function exportCsv() {
    if (!app || !app.lastResult) return;
    var r = app.lastResult;
    var cur = r.currency;
    var lines = [];
    lines.push(['Datacenter model — ' + app.scenarioId].join(','));
    lines.push([]);
    var header = ['Metric'].concat(r.perYear.map(function (y) { return 'Year ' + y.year; }));
    lines.push(header.join(','));
    function row(label, fn) {
      lines.push([csvCell(label)].concat(r.perYear.map(function (y) { return fn(y); })).join(','));
    }
    row('Utilization %', function (y) { return (y.ramp * 100).toFixed(1); });
    row('Revenue', function (y) { return Math.round(y.revenue); });
    row('Operating expenses', function (y) { return Math.round(y.opex); });
    row('EBITDA', function (y) { return Math.round(y.ebitda); });
    row('Depreciation', function (y) { return Math.round(y.depreciation); });
    row('Interest', function (y) { return Math.round(y.interest); });
    row('Tax', function (y) { return Math.round(y.tax); });
    row('Net profit', function (y) { return Math.round(y.netIncome); });
    row('Cumulative cash flow', function (y) { return Math.round(y.cumProjectFCF); });
    lines.push([]);
    var k = r.kpis;
    lines.push(['KPI', 'Value'].join(','));
    lines.push(['Total capex', Math.round(k.totalCapex)].join(','));
    lines.push(['NPV', Math.round(k.npvProject)].join(','));
    lines.push(['Project IRR %', k.irrProject == null ? 'n/a' : (k.irrProject * 100).toFixed(2)].join(','));
    lines.push(['Payback (yrs)', isFinite(k.paybackProject) ? k.paybackProject.toFixed(2) : 'never'].join(','));
    lines.push(['ROI %', k.roi == null ? 'n/a' : (k.roi * 100).toFixed(1)].join(','));

    var blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'datacenter-' + app.scenarioId + '-model.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function csvCell(s) {
    s = String(s);
    if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function copyLink() {
    writeUrl();
    var url = location.href;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { toast('Shareable link copied to clipboard'); },
        function () { toast('Link is in the address bar'); });
    } else {
      toast('Link is in the address bar');
    }
  }

  var toastTimer;
  function toast(msg) {
    var t = qs('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  // ---- currency selector -------------------------------------------------
  function buildCurrencySelect() {
    var sel = qs('currency-select');
    ['USD', 'EUR', 'GBP', 'INR', 'JPY', 'AUD', 'CAD'].forEach(function (c) {
      var o = document.createElement('option');
      o.value = c; o.textContent = c;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () {
      app.inputs.currency = sel.value;
      app.recompute();
    });
  }

  // ---- boot --------------------------------------------------------------
  function boot() {
    var domains = global.DOMAINS || {};
    var saved = readState();
    var domainId = (saved && saved.d) || getParam('domain') || 'datacenter';
    var config = domains[domainId] || domains.datacenter;

    // Header text
    qs('app-title').textContent = config.name + ' model';
    qs('app-tagline').textContent = config.tagline;

    app = new global.UI.App(config, qs('controls'));

    // Seed inputs
    var initialInputs = { currency: config.currency };
    if (saved && saved.i) initialInputs = saved.i;
    app.setInputs(initialInputs);
    if (!app.inputs.currency) app.inputs.currency = config.currency;
    if (saved && saved.s) app.scenarioId = saved.s;

    // currency select reflects state
    buildCurrencySelect();
    qs('currency-select').value = app.inputs.currency;

    // Recompute pushes URL state + keeps currency select synced.
    app.onChange = function () {
      writeUrl();
      qs('currency-select').value = app.inputs.currency;
    };

    app.render();
    app.recompute();

    qs('btn-reset').addEventListener('click', function () {
      app.setInputs({ currency: app.inputs.currency });
      app.render();
      app.recompute();
      toast('Reset to defaults');
    });
    qs('btn-export').addEventListener('click', exportCsv);
    qs('btn-share').addEventListener('click', copyLink);
  }

  function getParam(name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(location.search);
    return m ? decodeURIComponent(m[1]) : null;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : this);
