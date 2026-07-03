/*
 * format.js — formatting helpers shared across all domains.
 *
 * Everything here is pure and side-effect free so it can be unit tested and
 * reused by the engine, the UI renderer and the chart layer.
 */
(function (global) {
  'use strict';

  // Abbreviate large numbers: 1_500_000 -> "1.5M". Keeps small numbers intact.
  function abbreviate(n, decimals) {
    if (n == null || isNaN(n)) return '—';
    var sign = n < 0 ? '-' : '';
    var abs = Math.abs(n);
    var d = decimals == null ? 1 : decimals;
    var units = [
      { v: 1e12, s: 'T' },
      { v: 1e9, s: 'B' },
      { v: 1e6, s: 'M' },
      { v: 1e3, s: 'K' }
    ];
    for (var i = 0; i < units.length; i++) {
      if (abs >= units[i].v) {
        return sign + trimZeros((abs / units[i].v).toFixed(d)) + units[i].s;
      }
    }
    return sign + trimZeros(abs.toFixed(abs < 10 && abs % 1 !== 0 ? d : 0));
  }

  function trimZeros(str) {
    if (str.indexOf('.') === -1) return str;
    return str.replace(/\.?0+$/, '');
  }

  var CURRENCY_SYMBOL = {
    USD: '$', EUR: '€', GBP: '£', INR: '₹', JPY: '¥', AUD: 'A$', CAD: 'C$'
  };

  function currencySymbol(code) {
    return CURRENCY_SYMBOL[code] || (code ? code + ' ' : '$');
  }

  // Full currency, grouped thousands. e.g. currency(1234567) -> "$1,234,567"
  function currency(n, code, decimals) {
    if (n == null || isNaN(n)) return '—';
    var d = decimals == null ? 0 : decimals;
    var sym = currencySymbol(code);
    var sign = n < 0 ? '-' : '';
    var val = Math.abs(n).toLocaleString('en-US', {
      minimumFractionDigits: d,
      maximumFractionDigits: d
    });
    return sign + sym + val;
  }

  // Compact currency for KPIs / axes. e.g. "$1.2M"
  function currencyShort(n, code, decimals) {
    if (n == null || isNaN(n)) return '—';
    var sym = currencySymbol(code);
    var sign = n < 0 ? '-' : '';
    return sign + sym + abbreviate(Math.abs(n), decimals);
  }

  // Readable currency: full grouped digits below 1,000,000, but collapse to
  // M / B / T above that so headline figures stay scannable ($240M, $21.2B).
  // (abbreviate() alone would also shrink thousands to "K", which we don't want.)
  function currencyReadable(n, code, decimals) {
    if (n == null || isNaN(n)) return '—';
    if (Math.abs(n) < 1e6) return currency(n, code, 0);
    return currencyShort(n, code, decimals == null ? 1 : decimals);
  }

  function percent(n, decimals) {
    if (n == null || isNaN(n) || !isFinite(n)) return '—';
    var d = decimals == null ? 1 : decimals;
    return trimZeros((n * 100).toFixed(d)) + '%';
  }

  function number(n, decimals) {
    if (n == null || isNaN(n)) return '—';
    var d = decimals == null ? 0 : decimals;
    return n.toLocaleString('en-US', {
      minimumFractionDigits: d,
      maximumFractionDigits: d
    });
  }

  function years(n) {
    if (n == null || isNaN(n) || !isFinite(n)) return 'Never';
    if (n < 0) return 'Never';
    return trimZeros(n.toFixed(1)) + ' yr';
  }

  // Dispatch by a named format used in configs: 'currency','currencyShort',
  // 'percent','number','years','x' (multiplier), 'raw'.
  function apply(value, fmt, opts) {
    opts = opts || {};
    switch (fmt) {
      case 'currency': return currency(value, opts.currency, opts.decimals);
      case 'currencyShort': return currencyShort(value, opts.currency, opts.decimals);
      case 'percent': return percent(value, opts.decimals);
      case 'number': return number(value, opts.decimals);
      case 'years': return years(value);
      case 'x': return (value == null || isNaN(value)) ? '—' : trimZeros(value.toFixed(opts.decimals == null ? 2 : opts.decimals)) + '×';
      default: return String(value);
    }
  }

  global.Format = {
    abbreviate: abbreviate,
    currency: currency,
    currencyShort: currencyShort,
    currencyReadable: currencyReadable,
    currencySymbol: currencySymbol,
    percent: percent,
    number: number,
    years: years,
    apply: apply,
    trimZeros: trimZeros
  };
})(typeof window !== 'undefined' ? window : this);
