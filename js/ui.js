/*
 * ui.js — config-driven form + results renderer.
 *
 * Given a domain config (see domains/datacenter.js for the contract) this
 * builds the input form, reads a plain `inputs` object out of it, runs the
 * domain's compute() through the shared Engine, and renders KPIs, the P&L /
 * cash-flow table and the charts. Nothing here knows about datacenters — swap
 * the config and the same renderer drives a different business.
 *
 * ---- Domain config contract --------------------------------------------
 * {
 *   id, name, tagline,
 *   currency: 'USD',
 *   scenarios: [{ id, name, description }],       // selectable business models
 *   groups: [{
 *     id, label, icon,
 *     scenarios: ['colo', ...]  // optional: only show for these scenarios
 *     fields: [ Field ]
 *   }],
 *   presets: [{ id, label, description, values:{key:val} }],
 *   compute(inputs, scenarioId) -> Engine model,
 *   summarize(inputs, result, scenarioId) -> [{label, value}]  // optional headline chips
 * }
 *
 * Field = {
 *   key, label, type: 'number'|'percent'|'currency'|'select'|'range',
 *   default, min, max, step, unit, prefix, help,
 *   options: [{value,label}]   // for select
 *   scenarios: ['colo']        // optional visibility filter
 *   showIf(inputs) -> bool     // optional dynamic visibility
 * }
 */
(function (global) {
  'use strict';

  var F = global.Format;
  var Charts = global.Charts;
  var Engine = global.Engine;

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function App(config, root) {
    this.config = config;
    this.root = root;
    this.inputs = {};
    this.scenarioId = (config.scenarios && config.scenarios[0] && config.scenarios[0].id) || 'default';
    this.onChange = null; // callback(app) after each recompute
    this._fieldEls = {};  // key -> input element
  }

  // Collect all field defs across groups (flattened).
  App.prototype.allFields = function () {
    var fields = [];
    (this.config.groups || []).forEach(function (g) {
      (g.fields || []).forEach(function (f) { fields.push(f); });
    });
    return fields;
  };

  App.prototype.defaults = function () {
    var out = {};
    this.allFields().forEach(function (f) {
      out[f.key] = f.default;
    });
    return out;
  };

  // Seed inputs (from defaults then override map), clamped to defaults for
  // anything missing.
  App.prototype.setInputs = function (values) {
    var base = this.defaults();
    values = values || {};
    for (var k in values) {
      if (Object.prototype.hasOwnProperty.call(values, k)) base[k] = values[k];
    }
    this.inputs = base;
  };

  App.prototype.fieldVisible = function (f) {
    if (f.scenarios && f.scenarios.indexOf(this.scenarioId) === -1) return false;
    if (typeof f.showIf === 'function' && !f.showIf(this.inputs, this.scenarioId)) return false;
    return true;
  };

  App.prototype.groupVisible = function (g) {
    if (g.scenarios && g.scenarios.indexOf(this.scenarioId) === -1) return false;
    // Hidden if all its fields are hidden.
    var anyVisible = false;
    for (var i = 0; i < (g.fields || []).length; i++) {
      if (this.fieldVisible(g.fields[i])) { anyVisible = true; break; }
    }
    return anyVisible;
  };

  // ---- Rendering: form ---------------------------------------------------

  App.prototype.renderScenarioSelector = function () {
    var self = this;
    var scenarios = this.config.scenarios || [];
    if (scenarios.length <= 1) return el('div');
    var wrap = el('div', 'scenario-selector');
    wrap.appendChild(el('div', 'scenario-selector-label', 'Business model'));
    var tabs = el('div', 'scenario-tabs');
    scenarios.forEach(function (s) {
      var btn = el('button', 'scenario-tab' + (s.id === self.scenarioId ? ' active' : ''));
      btn.type = 'button';
      btn.innerHTML = '<span class="scenario-tab-name">' + s.name + '</span>' +
        (s.description ? '<span class="scenario-tab-desc">' + s.description + '</span>' : '');
      btn.addEventListener('click', function () {
        self.scenarioId = s.id;
        self.render();          // full re-render (visibility depends on scenario)
        self.recompute();
      });
      tabs.appendChild(btn);
    });
    wrap.appendChild(tabs);
    return wrap;
  };

  App.prototype.renderField = function (f) {
    var self = this;
    var val = this.inputs[f.key];
    var row = el('div', 'field');
    var labelRow = el('div', 'field-label-row');
    var label = el('label', 'field-label');
    label.textContent = f.label;
    label.htmlFor = 'f_' + f.key;
    labelRow.appendChild(label);
    if (f.help) {
      var help = el('span', 'field-help', '?');
      help.setAttribute('data-tip', f.help);
      help.setAttribute('tabindex', '0'); // focusable so the tip shows on touch/keyboard
      labelRow.appendChild(help);
    }
    row.appendChild(labelRow);

    var control = el('div', 'field-control');
    var input;

    if (f.type === 'select') {
      input = el('select', 'input-select');
      input.id = 'f_' + f.key;
      (f.options || []).forEach(function (opt) {
        var o = el('option');
        o.value = opt.value;
        o.textContent = opt.label;
        if (String(opt.value) === String(val)) o.selected = true;
        input.appendChild(o);
      });
      input.addEventListener('change', function () {
        self.inputs[f.key] = input.value;
        self.render();          // selects can drive visibility
        self.recompute();
      });
      control.appendChild(input);
    } else if (f.type === 'range') {
      var rangeWrap = el('div', 'range-wrap');
      input = el('input', 'input-range');
      input.type = 'range';
      input.id = 'f_' + f.key;
      input.min = f.min; input.max = f.max; input.step = f.step || 1;
      input.value = val;
      var out = el('span', 'range-value');
      out.textContent = f.type === 'range' && f.percent ? F.percent(val) : F.number(val);
      input.addEventListener('input', function () {
        self.inputs[f.key] = parseFloat(input.value);
        out.textContent = f.percent ? F.percent(parseFloat(input.value)) : F.number(parseFloat(input.value)) + (f.unit ? ' ' + f.unit : '');
        self.recompute();
      });
      rangeWrap.appendChild(input);
      rangeWrap.appendChild(out);
      control.appendChild(rangeWrap);
    } else {
      // numeric-ish text input with optional prefix/unit
      var box = el('div', 'input-box');
      if (f.prefix) box.appendChild(el('span', 'input-affix prefix', f.prefix));
      input = el('input', 'input-number');
      input.type = 'number';
      input.id = 'f_' + f.key;
      if (f.min != null) input.min = f.min;
      if (f.max != null) input.max = f.max;
      input.step = f.step != null ? f.step : 'any';
      // percent fields store decimals internally but display as whole percents
      input.value = f.type === 'percent' ? round(val * 100, 4) : val;
      input.addEventListener('input', function () {
        var raw = input.value === '' ? 0 : parseFloat(input.value);
        if (isNaN(raw)) raw = 0;
        self.inputs[f.key] = f.type === 'percent' ? raw / 100 : raw;
        self.recompute();
      });
      box.appendChild(input);
      var unit = f.type === 'percent' ? '%' : f.unit;
      if (unit) box.appendChild(el('span', 'input-affix suffix', unit));
      control.appendChild(box);
    }

    this._fieldEls[f.key] = input;
    row.appendChild(control);
    return row;
  };

  App.prototype.renderForm = function () {
    var self = this;
    var form = el('div', 'form-groups');
    (this.config.groups || []).forEach(function (g) {
      if (!self.groupVisible(g)) return;
      var section = el('section', 'form-group');
      var head = el('div', 'form-group-head');
      head.innerHTML = (g.icon ? '<span class="form-group-icon">' + g.icon + '</span>' : '') +
        '<span class="form-group-title">' + g.label + '</span>';
      section.appendChild(head);
      var grid = el('div', 'field-grid');
      (g.fields || []).forEach(function (f) {
        if (!self.fieldVisible(f)) return;
        grid.appendChild(self.renderField(f));
      });
      section.appendChild(grid);
      form.appendChild(section);
    });
    return form;
  };

  App.prototype.renderPresets = function () {
    var self = this;
    var presets = this.config.presets || [];
    if (!presets.length) return null;
    var wrap = el('div', 'presets');
    wrap.appendChild(el('span', 'presets-label', 'Presets:'));
    presets.forEach(function (p) {
      if (p.scenarios && p.scenarios.indexOf(self.scenarioId) === -1) return;
      var b = el('button', 'preset-chip');
      b.type = 'button';
      b.textContent = p.label;
      if (p.description) b.title = p.description;
      b.addEventListener('click', function () {
        self.setInputs(objMerge(self.inputs, p.values));
        self.render();
        self.recompute();
      });
      wrap.appendChild(b);
    });
    return wrap;
  };

  // ---- Rendering: results ------------------------------------------------

  App.prototype.renderKpis = function (result) {
    var cur = result.currency;
    var k = result.kpis;
    // Each card leads with a plain-English label a non-expert can read; the
    // finance term is a small hover-explained chip, and the sub-line is plain
    // too. `term`/`termHelp` are optional — omit for self-explanatory cards.
    var cards = [
      { label: 'Money to build it', term: 'Capex', termHelp: 'Capital expenditure — the total upfront cost to build before it earns anything.',
        value: F.currencyReadable(k.totalCapex, cur), tone: 'neutral',
        sub: k.debt > 0 ? F.currencyReadable(k.equity, cur) + ' your cash · ' + F.currencyReadable(k.debt, cur) + ' borrowed' : 'all your own cash' },
      { label: 'Money coming in / year', term: 'Revenue', termHelp: 'Total sales per year once the business is fully up and running.',
        value: F.currencyReadable(k.steadyRevenue, cur), tone: 'neutral',
        sub: 'first year: ' + F.currencyReadable(k.year1Revenue, cur) },
      { label: 'Money you keep / year', term: 'Net profit', termHelp: 'What\'s left each year after all costs, loan interest and tax.',
        value: F.currencyReadable(k.steadyNetIncome, cur), tone: k.steadyNetIncome >= 0 ? 'good' : 'bad',
        sub: F.percent(k.steadyNetMargin) + ' of every dollar of sales' },
      { label: 'Profit before the big deductions', term: 'EBITDA margin', termHelp: 'Operating profitability before loan interest, tax and wear-and-tear (depreciation).',
        value: F.percent(k.steadyEbitdaMargin), tone: k.steadyEbitdaMargin >= 0 ? 'good' : 'bad',
        sub: 'the raw earning power of the operation' },
      { label: 'Time to earn it back', term: 'Payback', termHelp: 'How long until the cash it throws off has repaid the upfront build cost.',
        value: F.years(k.paybackProject), tone: isFinite(k.paybackProject) && k.paybackProject <= result.years ? 'good' : 'warn',
        sub: 'allowing for inflation: ' + F.years(k.discountedPayback) },
      { label: 'Yearly return on the money', term: 'IRR', termHelp: 'Internal rate of return — the effective interest rate the project earns per year.',
        value: k.irrProject == null ? '—' : F.percent(k.irrProject), tone: irrTone(k.irrProject, k.discountRate),
        sub: 'beats your target of ' + F.percent(k.discountRate) + '?' },
      { label: 'Value created after all costs', term: 'NPV', termHelp: 'Net present value — profit over ' + result.years + ' years in today\'s money. Above zero means it\'s worth doing.',
        value: F.currencyReadable(k.npvProject, cur), tone: k.npvProject >= 0 ? 'good' : 'bad',
        sub: 'in today\'s money, over ' + result.years + ' years' },
      { label: 'Total return over ' + result.years + ' years', term: 'ROI', termHelp: 'Return on investment — total profit compared with the cash you put in.',
        value: k.roi == null ? '—' : F.percent(k.roi), tone: (k.roi || 0) >= 0 ? 'good' : 'bad',
        sub: 'total profit vs. the cash you put in' }
    ];
    var grid = el('div', 'kpi-grid');
    cards.forEach(function (c) {
      var card = el('div', 'kpi-card tone-' + c.tone);
      var term = c.term ? '<span class="kpi-term" tabindex="0" data-tip="' + escapeAttr(c.termHelp || '') + '">' + c.term + '</span>' : '';
      card.innerHTML = '<div class="kpi-label-row"><span class="kpi-label">' + c.label + '</span>' + term + '</div>' +
        '<div class="kpi-value">' + c.value + '</div>' +
        '<div class="kpi-sub">' + (c.sub || '') + '</div>';
      grid.appendChild(card);
    });
    return grid;
  };

  App.prototype.renderDerived = function (result) {
    var d = result.derived || {};
    var keys = Object.keys(d);
    if (!keys.length) return null;
    var wrap = el('div', 'derived-strip');
    keys.forEach(function (key) {
      var item = d[key];
      var chip = el('div', 'derived-chip');
      chip.innerHTML = '<span class="derived-value">' + item.value + '</span><span class="derived-label">' + item.label + '</span>';
      if (item.help) { chip.setAttribute('data-tip', item.help); chip.setAttribute('tabindex', '0'); }
      wrap.appendChild(chip);
    });
    return wrap;
  };

  App.prototype.renderCharts = function (result) {
    var cur = result.currency;
    var labels = result.perYear.map(function (r) { return 'Y' + r.year; });
    var wrap = el('div', 'charts');

    // 1) Revenue vs cost stacked (revenue as single bar, cost stack of opex+dep+interest)
    var revData = result.perYear.map(function (r) { return r.revenue; });
    var opexData = result.perYear.map(function (r) { return r.opex; });
    var depData = result.perYear.map(function (r) { return r.depreciation; });
    var intData = result.perYear.map(function (r) { return r.interest; });
    var taxData = result.perYear.map(function (r) { return r.tax; });

    var c1 = el('div', 'chart-card');
    c1.appendChild(chartHead('Revenue vs. profit', 'Net profit is what remains after all costs and tax.'));
    c1.appendChild(nodeFromHTML(Charts.lines({
      currency: cur, labels: labels,
      series: [
        { label: 'Revenue', color: '#4f8cff', data: revData },
        { label: 'EBITDA', color: '#06b6d4', data: result.perYear.map(function (r) { return r.ebitda; }) },
        { label: 'Net profit', color: '#22c55e', data: result.perYear.map(function (r) { return r.netIncome; }) }
      ]
    })));
    c1.appendChild(nodeFromHTML(Charts.legend([
      { label: 'Revenue', color: '#4f8cff' },
      { label: 'EBITDA', color: '#06b6d4' },
      { label: 'Net profit', color: '#22c55e' }
    ])));
    wrap.appendChild(c1);

    // 2) Cost breakdown stacked bars
    var c2 = el('div', 'chart-card');
    c2.appendChild(chartHead('Annual cost breakdown', 'Where the money goes each year.'));
    c2.appendChild(nodeFromHTML(Charts.stackedBars({
      currency: cur, labels: labels,
      series: [
        { label: 'Operating expenses', color: '#f59e0b', data: opexData },
        { label: 'Depreciation', color: '#a855f7', data: depData },
        { label: 'Interest', color: '#ef4444', data: intData },
        { label: 'Tax', color: '#ec4899', data: taxData }
      ]
    })));
    c2.appendChild(nodeFromHTML(Charts.legend([
      { label: 'Operating expenses', color: '#f59e0b' },
      { label: 'Depreciation', color: '#a855f7' },
      { label: 'Interest', color: '#ef4444' },
      { label: 'Tax', color: '#ec4899' }
    ])));
    wrap.appendChild(c2);

    // 3) Cumulative cash flow with break-even
    var cumData = result.perYear.map(function (r) { return r.cumProjectFCF; });
    var c3 = el('div', 'chart-card chart-card-wide');
    c3.appendChild(chartHead('Cumulative cash flow & break-even', 'Starts negative (the upfront build) and climbs as profits accrue. The marker is payback.'));
    c3.appendChild(nodeFromHTML(Charts.cumulativeArea({ currency: cur, labels: labels, data: cumData })));
    wrap.appendChild(c3);

    return wrap;
  };

  App.prototype.renderTable = function (result) {
    var cur = result.currency;
    var rows = [
      ['Utilization', function (r) { return F.percent(r.ramp); }],
      ['Revenue', function (r) { return F.currencyReadable(r.revenue, cur); }],
      ['Operating expenses', function (r) { return '(' + F.currencyReadable(r.opex, cur) + ')'; }],
      ['EBITDA', function (r) { return F.currencyReadable(r.ebitda, cur); }],
      ['Depreciation', function (r) { return '(' + F.currencyReadable(r.depreciation, cur) + ')'; }],
      ['EBIT', function (r) { return F.currencyReadable(r.ebit, cur); }],
      ['Interest', function (r) { return '(' + F.currencyReadable(r.interest, cur) + ')'; }],
      ['Pre-tax profit', function (r) { return F.currencyReadable(r.ebt, cur); }],
      ['Tax', function (r) { return '(' + F.currencyReadable(r.tax, cur) + ')'; }],
      ['Net profit', function (r) { return F.currencyReadable(r.netIncome, cur); }],
      ['Net margin', function (r) { return F.percent(r.netMargin); }],
      ['Cumulative cash flow', function (r) { return F.currencyReadable(r.cumProjectFCF, cur); }]
    ];
    var emphasize = { 'EBITDA': 1, 'Net profit': 1, 'Cumulative cash flow': 1 };

    var table = el('table', 'pnl-table');
    var thead = el('thead');
    var htr = el('tr');
    htr.appendChild(el('th', 'row-head', 'P&amp;L / year'));
    result.perYear.forEach(function (r) { htr.appendChild(el('th', null, 'Y' + r.year)); });
    thead.appendChild(htr);
    table.appendChild(thead);

    var tbody = el('tbody');
    rows.forEach(function (def) {
      var tr = el('tr', emphasize[def[0]] ? 'emph' : null);
      tr.appendChild(el('th', 'row-head', def[0]));
      result.perYear.forEach(function (r) {
        var td = el('td');
        var text = def[1](r);
        td.innerHTML = text;
        if (text.charAt(0) === '(' || (text.charAt(0) === '-')) td.classList.add('neg');
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    var scroll = el('div', 'table-scroll');
    scroll.appendChild(table);
    return scroll;
  };

  App.prototype.renderNotes = function (result) {
    if (!result.notes || !result.notes.length) return null;
    var wrap = el('div', 'model-notes');
    wrap.appendChild(el('div', 'model-notes-title', 'Assumptions & notes'));
    var ul = el('ul');
    result.notes.forEach(function (n) { ul.appendChild(el('li', null, n)); });
    wrap.appendChild(ul);
    return wrap;
  };

  // ---- Orchestration -----------------------------------------------------

  App.prototype.recompute = function () {
    var model = this.config.compute(this.inputs, this.scenarioId);
    var result = Engine.project(model);
    this.lastResult = result;
    var out = document.getElementById('results');
    out.innerHTML = '';

    var summary = el('div', 'results-summary');
    summary.appendChild(this.renderKpis(result));
    out.appendChild(summary);

    var derived = this.renderDerived(result);
    if (derived) out.appendChild(sectionWrap('Physical & unit metrics', derived));

    out.appendChild(sectionWrap('Charts', this.renderCharts(result)));
    out.appendChild(sectionWrap('Year-by-year P&L and cash flow', this.renderTable(result)));

    var notes = this.renderNotes(result);
    if (notes) out.appendChild(notes);

    if (typeof this.onChange === 'function') this.onChange(this);
  };

  App.prototype.render = function () {
    this.root.innerHTML = '';
    var scenarioSel = this.renderScenarioSelector();
    this.root.appendChild(scenarioSel);
    var activeScenario = (this.config.scenarios || []).filter(function (s) { return s.id === this.scenarioId; }.bind(this))[0];
    if (activeScenario && activeScenario.description) {
      this.root.appendChild(el('p', 'scenario-active-desc', activeScenario.description));
    }
    var presets = this.renderPresets();
    if (presets) this.root.appendChild(presets);
    this.root.appendChild(this.renderForm());
  };

  // ---- small helpers -----------------------------------------------------

  function chartHead(title, sub) {
    var h = el('div', 'chart-head');
    h.innerHTML = '<span class="chart-title">' + title + '</span>' + (sub ? '<span class="chart-sub">' + sub + '</span>' : '');
    return h;
  }
  function sectionWrap(title, node) {
    var s = el('section', 'result-section');
    s.appendChild(el('h2', 'result-section-title', title));
    s.appendChild(node);
    return s;
  }
  function nodeFromHTML(html) {
    var d = el('div', 'chart-holder');
    d.innerHTML = html;
    return d;
  }
  function objMerge(a, b) {
    var o = {};
    for (var k in a) if (Object.prototype.hasOwnProperty.call(a, k)) o[k] = a[k];
    for (var k2 in b) if (Object.prototype.hasOwnProperty.call(b, k2)) o[k2] = b[k2];
    return o;
  }
  function round(v, dp) {
    var m = Math.pow(10, dp || 0);
    return Math.round(v * m) / m;
  }
  // Escape a string for safe use inside a double-quoted HTML attribute.
  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function irrTone(irr, hurdle) {
    if (irr == null) return 'neutral';
    if (irr >= hurdle * 1.5) return 'good';
    if (irr >= hurdle) return 'warn';
    return 'bad';
  }

  global.UI = { App: App };
})(typeof window !== 'undefined' ? window : this);
