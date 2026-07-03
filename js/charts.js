/*
 * charts.js — tiny dependency-free SVG chart helpers.
 *
 * No external libraries: everything is drawn as inline SVG strings so the app
 * works offline from a file:// URL. Each function returns an SVG string that
 * the UI drops into a container. Colors come from CSS custom properties via
 * currentColor / explicit palette so charts follow the theme.
 */
(function (global) {
  'use strict';

  var F = global.Format;

  var PALETTE = [
    '#4f8cff', '#22c55e', '#f59e0b', '#ef4444', '#a855f7',
    '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#14b8a6'
  ];

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function svgOpen(w, h) {
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" preserveAspectRatio="xMidYMid meet" class="chart-svg" role="img">';
  }

  function niceMax(v) {
    if (v <= 0) return 1;
    var mag = Math.pow(10, Math.floor(Math.log10(v)));
    var norm = v / mag;
    var step;
    if (norm <= 1) step = 1;
    else if (norm <= 2) step = 2;
    else if (norm <= 5) step = 5;
    else step = 10;
    return step * mag;
  }

  // Stacked bar chart. series = [{label, color, data:[...perYear]}], labels =
  // x-axis labels. Bars stack the series per column.
  function stackedBars(opts) {
    var series = opts.series || [];
    var labels = opts.labels || [];
    var currency = opts.currency;
    var W = 720, H = 320;
    var pad = { l: 64, r: 16, t: 16, b: 40 };
    var plotW = W - pad.l - pad.r;
    var plotH = H - pad.t - pad.b;
    var n = labels.length;

    // Column totals to size the y-axis.
    var totals = [];
    for (var c = 0; c < n; c++) {
      var s = 0;
      for (var k = 0; k < series.length; k++) s += Math.max(0, series[k].data[c] || 0);
      totals.push(s);
    }
    var maxV = niceMax(Math.max.apply(null, totals.concat([1])));

    var svg = svgOpen(W, H);
    // Gridlines + y labels
    var ticks = 4;
    for (var g = 0; g <= ticks; g++) {
      var val = maxV * g / ticks;
      var y = pad.t + plotH - (val / maxV) * plotH;
      svg += '<line x1="' + pad.l + '" y1="' + y + '" x2="' + (W - pad.r) + '" y2="' + y + '" class="chart-grid"/>';
      svg += '<text x="' + (pad.l - 8) + '" y="' + (y + 4) + '" class="chart-axis-label" text-anchor="end">' + esc(F.currencyShort(val, currency)) + '</text>';
    }

    var bandW = plotW / n;
    var barW = Math.min(48, bandW * 0.62);
    for (var i = 0; i < n; i++) {
      var cx = pad.l + bandW * i + bandW / 2;
      var yCursor = pad.t + plotH;
      for (var j = 0; j < series.length; j++) {
        var v = Math.max(0, series[j].data[i] || 0);
        var hgt = (v / maxV) * plotH;
        var color = series[j].color || PALETTE[j % PALETTE.length];
        svg += '<rect x="' + (cx - barW / 2) + '" y="' + (yCursor - hgt) + '" width="' + barW + '" height="' + Math.max(0, hgt) + '" fill="' + color + '"><title>' + esc(series[j].label) + ': ' + esc(F.currency(v, currency)) + '</title></rect>';
        yCursor -= hgt;
      }
      svg += '<text x="' + cx + '" y="' + (H - pad.b + 20) + '" class="chart-axis-label" text-anchor="middle">' + esc(labels[i]) + '</text>';
    }
    svg += '</svg>';
    return svg;
  }

  // Multi-line chart. series = [{label,color,data:[]}], labels for x-axis.
  // Draws a zero baseline when data spans negative & positive.
  function lines(opts) {
    var series = opts.series || [];
    var labels = opts.labels || [];
    var currency = opts.currency;
    var W = 720, H = 320;
    var pad = { l: 64, r: 16, t: 16, b: 40 };
    var plotW = W - pad.l - pad.r;
    var plotH = H - pad.t - pad.b;
    var n = labels.length;

    var allVals = [];
    series.forEach(function (s) { s.data.forEach(function (v) { if (v != null && isFinite(v)) allVals.push(v); }); });
    var maxV = Math.max.apply(null, allVals.concat([0]));
    var minV = Math.min.apply(null, allVals.concat([0]));
    var niceHi = niceMax(maxV);
    var niceLo = minV < 0 ? -niceMax(-minV) : 0;
    var range = (niceHi - niceLo) || 1;

    function xAt(i) { return pad.l + (n <= 1 ? plotW / 2 : plotW * i / (n - 1)); }
    function yAt(v) { return pad.t + plotH - ((v - niceLo) / range) * plotH; }

    var svg = svgOpen(W, H);
    var ticks = 4;
    for (var g = 0; g <= ticks; g++) {
      var val = niceLo + range * g / ticks;
      var gy = yAt(val);
      svg += '<line x1="' + pad.l + '" y1="' + gy + '" x2="' + (W - pad.r) + '" y2="' + gy + '" class="chart-grid"/>';
      svg += '<text x="' + (pad.l - 8) + '" y="' + (gy + 4) + '" class="chart-axis-label" text-anchor="end">' + esc(F.currencyShort(val, currency)) + '</text>';
    }
    // Zero baseline emphasized.
    if (niceLo < 0) {
      var zy = yAt(0);
      svg += '<line x1="' + pad.l + '" y1="' + zy + '" x2="' + (W - pad.r) + '" y2="' + zy + '" class="chart-zero"/>';
    }

    for (var i = 0; i < n; i++) {
      svg += '<text x="' + xAt(i) + '" y="' + (H - pad.b + 20) + '" class="chart-axis-label" text-anchor="middle">' + esc(labels[i]) + '</text>';
    }

    series.forEach(function (s, si) {
      var color = s.color || PALETTE[si % PALETTE.length];
      var d = '';
      for (var i = 0; i < s.data.length; i++) {
        var v = s.data[i];
        if (v == null || !isFinite(v)) continue;
        d += (d === '' ? 'M' : 'L') + xAt(i).toFixed(1) + ' ' + yAt(v).toFixed(1) + ' ';
      }
      svg += '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2.5" stroke-linejoin="round"/>';
      for (var p = 0; p < s.data.length; p++) {
        var vv = s.data[p];
        if (vv == null || !isFinite(vv)) continue;
        svg += '<circle cx="' + xAt(p).toFixed(1) + '" cy="' + yAt(vv).toFixed(1) + '" r="3" fill="' + color + '"><title>' + esc(s.label) + ' — ' + esc(labels[p]) + ': ' + esc(F.currency(vv, currency)) + '</title></circle>';
      }
    });
    svg += '</svg>';
    return svg;
  }

  // Cumulative cash-flow area with break-even marker. data is an array of
  // cumulative values (can go negative early then positive).
  function cumulativeArea(opts) {
    var data = opts.data || [];
    var labels = opts.labels || [];
    var currency = opts.currency;
    var W = 720, H = 320;
    var pad = { l: 64, r: 16, t: 16, b: 40 };
    var plotW = W - pad.l - pad.r;
    var plotH = H - pad.t - pad.b;
    var n = data.length;

    var maxV = Math.max.apply(null, data.concat([0]));
    var minV = Math.min.apply(null, data.concat([0]));
    var niceHi = niceMax(maxV);
    var niceLo = minV < 0 ? -niceMax(-minV) : 0;
    var range = (niceHi - niceLo) || 1;

    function xAt(i) { return pad.l + (n <= 1 ? plotW / 2 : plotW * i / (n - 1)); }
    function yAt(v) { return pad.t + plotH - ((v - niceLo) / range) * plotH; }

    var svg = svgOpen(W, H);
    var ticks = 4;
    for (var g = 0; g <= ticks; g++) {
      var val = niceLo + range * g / ticks;
      var gy = yAt(val);
      svg += '<line x1="' + pad.l + '" y1="' + gy + '" x2="' + (W - pad.r) + '" y2="' + gy + '" class="chart-grid"/>';
      svg += '<text x="' + (pad.l - 8) + '" y="' + (gy + 4) + '" class="chart-axis-label" text-anchor="end">' + esc(F.currencyShort(val, currency)) + '</text>';
    }
    var zy = yAt(0);
    svg += '<line x1="' + pad.l + '" y1="' + zy + '" x2="' + (W - pad.r) + '" y2="' + zy + '" class="chart-zero"/>';

    // Area path.
    var line = '';
    for (var i = 0; i < n; i++) {
      line += (i === 0 ? 'M' : 'L') + xAt(i).toFixed(1) + ' ' + yAt(data[i]).toFixed(1) + ' ';
    }
    var area = line + 'L' + xAt(n - 1).toFixed(1) + ' ' + zy.toFixed(1) + ' L' + xAt(0).toFixed(1) + ' ' + zy.toFixed(1) + ' Z';
    svg += '<path d="' + area + '" fill="url(#cfGrad)" opacity="0.35"/>';
    svg += '<defs><linearGradient id="cfGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#22c55e"/><stop offset="100%" stop-color="#22c55e" stop-opacity="0"/></linearGradient></defs>';
    svg += '<path d="' + line + '" fill="none" stroke="#22c55e" stroke-width="2.5"/>';

    // Break-even crossing marker (first index where sign turns >= 0).
    for (var b = 1; b < n; b++) {
      if (data[b - 1] < 0 && data[b] >= 0) {
        var frac = data[b] - data[b - 1] !== 0 ? (-data[b - 1]) / (data[b] - data[b - 1]) : 0;
        var bx = xAt(b - 1) + (xAt(b) - xAt(b - 1)) * frac;
        svg += '<line x1="' + bx.toFixed(1) + '" y1="' + pad.t + '" x2="' + bx.toFixed(1) + '" y2="' + (pad.t + plotH) + '" class="chart-breakeven"/>';
        svg += '<circle cx="' + bx.toFixed(1) + '" cy="' + zy.toFixed(1) + '" r="4" fill="#22c55e" stroke="#fff" stroke-width="1.5"/>';
        break;
      }
    }

    for (var p = 0; p < n; p++) {
      svg += '<circle cx="' + xAt(p).toFixed(1) + '" cy="' + yAt(data[p]).toFixed(1) + '" r="3" fill="#22c55e"><title>' + esc(labels[p]) + ': ' + esc(F.currency(data[p], currency)) + '</title></circle>';
      svg += '<text x="' + xAt(p).toFixed(1) + '" y="' + (H - pad.b + 20) + '" class="chart-axis-label" text-anchor="middle">' + esc(labels[p] || '') + '</text>';
    }
    svg += '</svg>';
    return svg;
  }

  // A small horizontal legend for a set of {label,color}.
  function legend(items) {
    var html = '<div class="chart-legend">';
    items.forEach(function (it, i) {
      var color = it.color || PALETTE[i % PALETTE.length];
      html += '<span class="legend-item"><span class="legend-swatch" style="background:' + color + '"></span>' + esc(it.label) + '</span>';
    });
    return html + '</div>';
  }

  global.Charts = {
    PALETTE: PALETTE,
    stackedBars: stackedBars,
    lines: lines,
    cumulativeArea: cumulativeArea,
    legend: legend
  };
})(typeof window !== 'undefined' ? window : this);
