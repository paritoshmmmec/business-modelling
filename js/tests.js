/*
 * tests.js — lightweight assertion harness. Works in the browser (renders to
 * #results) and under Node (prints to console, sets exit code). No framework.
 */
(function (global) {
  'use strict';

  var isNode = typeof window === 'undefined';
  var F = global.Finance;
  var Fmt = global.Format;
  var Engine = global.Engine;

  var groups = [];
  var current = null;
  var passCount = 0, failCount = 0;

  function group(name) { current = { name: name, tests: [] }; groups.push(current); }
  function test(name, fn) {
    var rec = { name: name, ok: true, detail: '' };
    try { fn(rec); } catch (e) { rec.ok = false; rec.detail = 'threw: ' + e.message; }
    if (rec.ok) passCount++; else failCount++;
    current.tests.push(rec);
  }
  function approx(a, b, tol, rec, label) {
    tol = tol == null ? 1e-6 : tol;
    var ok = Math.abs(a - b) <= tol;
    if (!ok) { rec.ok = false; rec.detail += (label || '') + ' expected ≈' + b + ' got ' + a + '; '; }
    return ok;
  }
  function ok(cond, rec, label) {
    if (!cond) { rec.ok = false; rec.detail += (label || 'assertion failed') + '; '; }
  }

  // ===================================================================
  //  FINANCE MATH
  // ===================================================================
  group('Finance: depreciation');
  test('straight-line splits cost evenly', function (r) {
    var s = F.straightLineDepreciation(150000, 15, 0);
    approx(s.length, 15, 0, r, 'length');
    approx(s[0], 10000, 1e-6, r, 'annual');
    var total = s.reduce(function (a, b) { return a + b; }, 0);
    approx(total, 150000, 1e-4, r, 'sums to cost');
  });
  test('salvage reduces depreciable base', function (r) {
    var s = F.straightLineDepreciation(100000, 10, 20000);
    approx(s[0], 8000, 1e-6, r, 'annual with salvage');
  });

  group('Finance: loan amortization');
  test('zero-interest payment is principal/periods', function (r) {
    approx(F.payment(120000, 0, 12), 10000, 1e-6, r);
  });
  test('known annuity payment (100k, 0.5%/mo, 360 mo)', function (r) {
    // Standard mortgage: 100000 at 6%/yr monthly over 30y ≈ 599.55
    var p = F.payment(100000, 0.06 / 12, 360);
    approx(p, 599.55, 0.05, r);
  });
  test('amortization pays off exactly (balance→0)', function (r) {
    var sched = F.amortize(50000, 0.08 / 12, 60);
    approx(sched[sched.length - 1].balance, 0, 1e-4, r, 'final balance');
    var totalPrincipal = sched.reduce(function (a, x) { return a + x.principal; }, 0);
    approx(totalPrincipal, 50000, 1e-3, r, 'principal sums to loan');
  });
  test('annualDebtService interest+principal reconciles', function (r) {
    var ds = F.annualDebtService(1000000, 0.07, 10);
    var totalInterest = ds.interest.reduce(function (a, b) { return a + b; }, 0);
    var totalPrincipal = ds.principal.reduce(function (a, b) { return a + b; }, 0);
    approx(totalPrincipal, 1000000, 1, r, 'principal repays loan');
    ok(totalInterest > 0, r, 'interest positive');
    approx(ds.endingBalance[ds.endingBalance.length - 1], 0, 1, r, 'ends at zero');
  });

  group('Finance: NPV & IRR');
  test('NPV at 0% = simple sum', function (r) {
    approx(F.npv(0, [-100, 50, 50, 50]), 50, 1e-9, r);
  });
  test('NPV discounts future flows', function (r) {
    // -100 + 110/1.1 = 0
    approx(F.npv(0.1, [-100, 110]), 0, 1e-9, r);
  });
  test('IRR of [-100,110] is 10%', function (r) {
    approx(F.irr([-100, 110]), 0.10, 1e-4, r);
  });
  test('IRR of even 4-yr project', function (r) {
    // -1000, +400 x4: IRR ≈ 21.86%
    var irr = F.irr([-1000, 400, 400, 400, 400]);
    approx(irr, 0.2186, 1e-3, r);
  });
  test('IRR undefined without sign change', function (r) {
    ok(F.irr([100, 200, 300]) === null, r, 'all positive → null');
    ok(F.irr([-100, -200]) === null, r, 'all negative → null');
  });
  test('NPV at IRR ≈ 0 (consistency)', function (r) {
    var cf = [-5000, 1200, 1400, 1600, 1800, 2000];
    var irr = F.irr(cf);
    approx(F.npv(irr, cf), 0, 1e-3, r, 'npv at irr');
  });

  group('Finance: payback & growth');
  test('payback interpolates within a period', function (r) {
    // -100, +40, +40, +40 → cumulative crosses 0 during year 3
    // after y2 cumulative = -20, y3 inflow 40 → 0.5 into y3 → 2.5
    approx(F.paybackPeriod([-100, 40, 40, 40]), 2.5, 1e-6, r);
  });
  test('payback Infinity if never recovered', function (r) {
    ok(!isFinite(F.paybackPeriod([-100, 10, 10])), r, 'never pays back');
  });
  test('cagr computes compound growth', function (r) {
    approx(F.cagr(100, 200, 10), Math.pow(2, 0.1) - 1, 1e-9, r);
  });
  test('grow compounds correctly', function (r) {
    approx(F.grow(100, 0.05, 3), 100 * Math.pow(1.05, 3), 1e-9, r);
  });

  // ===================================================================
  //  FORMAT
  // ===================================================================
  group('Format');
  test('abbreviate scales', function (r) {
    ok(Fmt.abbreviate(1500000) === '1.5M', r, 'M: got ' + Fmt.abbreviate(1500000));
    ok(Fmt.abbreviate(2500) === '2.5K', r, 'K: got ' + Fmt.abbreviate(2500));
    ok(Fmt.abbreviate(3.2e9) === '3.2B', r, 'B: got ' + Fmt.abbreviate(3.2e9));
  });
  test('currency formats with symbol', function (r) {
    ok(Fmt.currency(1234567, 'USD') === '$1,234,567', r, 'got ' + Fmt.currency(1234567, 'USD'));
    ok(Fmt.currency(-500, 'EUR') === '-€500', r, 'got ' + Fmt.currency(-500, 'EUR'));
  });
  test('currencyReadable collapses ≥1M to M/B', function (r) {
    ok(Fmt.currencyReadable(240000000, 'USD') === '$240M', r, 'got ' + Fmt.currencyReadable(240000000, 'USD'));
    ok(Fmt.currencyReadable(21200000000, 'USD') === '$21.2B', r, 'got ' + Fmt.currencyReadable(21200000000, 'USD'));
    ok(Fmt.currencyReadable(-171581746, 'USD') === '-$171.6M', r, 'got ' + Fmt.currencyReadable(-171581746, 'USD'));
    // below 1,000,000 stays fully written out
    ok(Fmt.currencyReadable(999999, 'USD') === '$999,999', r, 'got ' + Fmt.currencyReadable(999999, 'USD'));
    ok(Fmt.currencyReadable(11680000, 'USD') === '$11.7M', r, 'got ' + Fmt.currencyReadable(11680000, 'USD'));
  });
  test('percent formats', function (r) {
    ok(Fmt.percent(0.153, 1) === '15.3%', r, 'got ' + Fmt.percent(0.153, 1));
    ok(Fmt.percent(Infinity) === '—', r, 'infinite → dash');
  });

  // ===================================================================
  //  ENGINE
  // ===================================================================
  group('Engine: projection integrity');
  test('trivial all-equity project: net income & FCF sane', function (r) {
    var model = {
      currency: 'USD', years: 5,
      capexItems: [{ label: 'Build', amount: 1000000 }],
      revenueItems: [{ label: 'Rev', amount: 500000, growth: 0 }],
      opexItems: [{ label: 'Op', amount: 200000, growth: 0, capacityLinked: false }],
      ramp: [1, 1, 1, 1, 1],
      financing: { debtFraction: 0, interestRate: 0, termYears: 5 },
      depreciationLife: 5, taxRate: 0, discountRate: 0.1
    };
    var res = Engine.project(model);
    var y1 = res.perYear[0];
    // EBITDA = 500k-200k=300k; dep=200k; EBIT=100k; tax 0 → net 100k
    approx(y1.ebitda, 300000, 1, r, 'ebitda');
    approx(y1.depreciation, 200000, 1, r, 'dep');
    approx(y1.netIncome, 100000, 1, r, 'net income');
    // project FCF = NOPAT(100k) + dep(200k) = 300k
    approx(y1.projectFCF, 300000, 1, r, 'project FCF');
    approx(res.totalCapex, 1000000, 1, r, 'capex');
  });
  test('debt splits into equity, interest reduces pre-tax profit', function (r) {
    var model = {
      currency: 'USD', years: 10,
      capexItems: [{ label: 'Build', amount: 1000000 }],
      revenueItems: [{ label: 'Rev', amount: 300000 }],
      opexItems: [{ label: 'Op', amount: 100000, capacityLinked: false }],
      ramp: [1,1,1,1,1,1,1,1,1,1],
      financing: { debtFraction: 0.5, interestRate: 0.08, termYears: 10 },
      depreciationLife: 10, taxRate: 0.25, discountRate: 0.1
    };
    var res = Engine.project(model);
    approx(res.debt, 500000, 1, r, 'debt');
    approx(res.equity, 500000, 1, r, 'equity');
    ok(res.perYear[0].interest > 0, r, 'interest positive year 1');
    // interest should decline over time as principal amortizes
    ok(res.perYear[9].interest < res.perYear[0].interest, r, 'interest declines');
  });
  test('ramp scales revenue', function (r) {
    var model = {
      currency: 'USD', years: 3,
      capexItems: [{ label: 'B', amount: 100000 }],
      revenueItems: [{ label: 'R', amount: 100000 }],
      opexItems: [],
      ramp: [0.5, 0.75, 1.0],
      financing: { debtFraction: 0 }, depreciationLife: 3, taxRate: 0, discountRate: 0.1
    };
    var res = Engine.project(model);
    approx(res.perYear[0].revenue, 50000, 1, r, 'y1 half');
    approx(res.perYear[2].revenue, 100000, 1, r, 'y3 full');
  });
  test('NPV positive when returns beat hurdle', function (r) {
    var model = {
      currency: 'USD', years: 10,
      capexItems: [{ label: 'B', amount: 1000000 }],
      revenueItems: [{ label: 'R', amount: 400000 }],
      opexItems: [{ label: 'O', amount: 100000, capacityLinked: false }],
      ramp: [1,1,1,1,1,1,1,1,1,1],
      financing: { debtFraction: 0 }, depreciationLife: 10, taxRate: 0.2, discountRate: 0.1
    };
    var res = Engine.project(model);
    ok(res.kpis.npvProject > 0, r, 'NPV>0');
    ok(res.kpis.irrProject > 0.1, r, 'IRR beats hurdle');
    ok(isFinite(res.kpis.paybackProject), r, 'has payback');
  });

  // ===================================================================
  //  DATACENTER DOMAIN
  // ===================================================================
  group('Datacenter domain: all scenarios compute');
  var dc = global.DATACENTER_DOMAIN;
  function defaultsFor() {
    var app = new global.UI.App(dc, null);
    return app.defaults();
  }
  dc.scenarios.forEach(function (sc) {
    test('scenario "' + sc.id + '" produces a valid model', function (r) {
      var inputs = defaultsFor();
      inputs.currency = 'USD';
      var model = dc.compute(inputs, sc.id);
      ok(model.capexItems && model.capexItems.length > 0, r, 'has capex');
      ok(model.revenueItems && model.revenueItems.length > 0, r, 'has revenue');
      ok(model.ramp && model.ramp.length === model.years, r, 'ramp length = years');
      var res = Engine.project(model);
      ok(res.perYear.length === model.years, r, 'projects all years');
      ok(isFinite(res.kpis.totalCapex) && res.kpis.totalCapex > 0, r, 'capex finite>0');
      ok(isFinite(res.kpis.steadyRevenue), r, 'revenue finite');
      ok(isFinite(res.kpis.npvProject), r, 'npv finite');
      ok(res.derived && Object.keys(res.derived).length > 0, r, 'has derived metrics');
    });
  });
  test('colo: more racks at lower density', function (r) {
    var a = defaultsFor(); a.kwPerRack = 5;
    var b = defaultsFor(); b.kwPerRack = 20;
    var ra = Engine.project(dc.compute(a, 'colo'));
    var rb = Engine.project(dc.compute(b, 'colo'));
    // fewer kW/rack → more racks → derived racks higher
    ok(parseInt(ra.derived.racks.value.replace(/,/g,'')) > parseInt(rb.derived.racks.value.replace(/,/g,'')), r, 'lower density → more racks');
  });
  test('wholesale: triple-net excludes power from opex', function (r) {
    var inputs = defaultsFor();
    inputs.tripleNet = 1;
    var model = dc.compute(inputs, 'wholesale');
    var hasPower = model.opexItems.some(function (i) { return /Power/.test(i.label); });
    ok(!hasPower, r, 'no power opex under triple-net');
  });
  test('enterprise: revenue = cloud avoided, tax defaults 0', function (r) {
    var inputs = defaultsFor();
    var model = dc.compute(inputs, 'enterprise');
    ok(/avoid/i.test(model.revenueItems[0].label), r, 'revenue is cloud avoidance');
    approx(model.taxRate, 0, 0, r, 'tax 0');
  });
  test('higher rack price → higher colo profit', function (r) {
    var lo = defaultsFor(); lo.pricePerRackMonth = 800;
    var hi = defaultsFor(); hi.pricePerRackMonth = 1600;
    var rlo = Engine.project(dc.compute(lo, 'colo'));
    var rhi = Engine.project(dc.compute(hi, 'colo'));
    ok(rhi.kpis.steadyNetIncome > rlo.kpis.steadyNetIncome, r, 'more price → more profit');
  });

  // ===================================================================
  //  SPACE DATACENTER DOMAIN
  // ===================================================================
  group('Space DC domain: all scenarios compute');
  var sdc = global.SPACEDC_DOMAIN;
  function sdcDefaults() {
    var app = new global.UI.App(sdc, null);
    return app.defaults();
  }
  sdc.scenarios.forEach(function (sc) {
    test('scenario "' + sc.id + '" produces a valid model', function (r) {
      var inputs = sdcDefaults();
      inputs.currency = 'USD';
      var model = sdc.compute(inputs, sc.id);
      ok(model.capexItems && model.capexItems.length > 0, r, 'has capex');
      ok(model.revenueItems && model.revenueItems.length > 0, r, 'has revenue');
      ok(model.ramp && model.ramp.length === model.years, r, 'ramp length = years');
      var res = Engine.project(model);
      ok(res.perYear.length === model.years, r, 'projects all years');
      ok(isFinite(res.kpis.totalCapex) && res.kpis.totalCapex > 0, r, 'capex finite>0');
      ok(isFinite(res.kpis.steadyRevenue), r, 'revenue finite');
      ok(isFinite(res.kpis.npvProject), r, 'npv finite');
      ok(res.derived && Object.keys(res.derived).length > 0, r, 'has derived metrics');
    });
  });
  test('orbital-dc: no energy opex (free solar)', function (r) {
    var model = sdc.compute(sdcDefaults(), 'orbital-dc');
    var hasEnergy = model.opexItems.some(function (i) { return /energy|power/i.test(i.label); });
    ok(!hasEnergy, r, 'no energy/power opex line in orbit');
  });
  test('orbital-dc: cheaper launch → higher NPV', function (r) {
    var lo = sdcDefaults(); lo.launchCostPerKg = 200;
    var hi = sdcDefaults(); hi.launchCostPerKg = 2900;
    var rlo = Engine.project(sdc.compute(lo, 'orbital-dc'));
    var rhi = Engine.project(sdc.compute(hi, 'orbital-dc'));
    ok(rlo.kpis.npvProject > rhi.kpis.npvProject, r, 'lower $/kg → better NPV');
    ok(rhi.totalCapex > rlo.totalCapex, r, 'higher $/kg → more capex');
  });
  test('spacex: $/kg derived = price ÷ payload', function (r) {
    var inputs = sdcDefaults();
    inputs.pricePerLaunch = 60000000;
    inputs.payloadPerLaunchKg = 20000;
    var model = sdc.compute(inputs, 'spacex');
    // 60M / 20000 = $3,000/kg
    ok(/3,000/.test(model.derived.dollarKg.value), r, 'got ' + model.derived.dollarKg.value);
  });
  test('rocketlab: adding Neutron raises revenue', function (r) {
    var noN = sdcDefaults(); noN.neutronPerYear = 0;
    var withN = sdcDefaults(); withN.neutronPerYear = 8;
    var rNo = Engine.project(sdc.compute(noN, 'rocketlab'));
    var rWith = Engine.project(sdc.compute(withN, 'rocketlab'));
    ok(rWith.kpis.steadyRevenue > rNo.kpis.steadyRevenue, r, 'Neutron adds revenue');
  });

  // ===================================================================
  //  RENDER / REPORT
  // ===================================================================
  function report() {
    var total = passCount + failCount;
    if (isNode) {
      groups.forEach(function (g) {
        console.log('\n' + g.name);
        g.tests.forEach(function (t) {
          console.log('  ' + (t.ok ? '✓' : '✗') + ' ' + t.name + (t.ok ? '' : '  — ' + t.detail));
        });
      });
      console.log('\n' + (failCount === 0 ? 'PASS' : 'FAIL') + ': ' + passCount + '/' + total + ' passed, ' + failCount + ' failed.');
      if (typeof process !== 'undefined') process.exit(failCount === 0 ? 0 : 1);
      return;
    }
    var sum = document.getElementById('summary');
    sum.className = 'test-summary ' + (failCount === 0 ? 'pass' : 'fail');
    sum.textContent = (failCount === 0 ? '✓ All passed' : '✗ ' + failCount + ' failed') + ' — ' + passCount + '/' + total;
    var out = document.getElementById('results');
    groups.forEach(function (g) {
      var gt = document.createElement('div');
      gt.className = 'group-title';
      gt.textContent = g.name;
      out.appendChild(gt);
      g.tests.forEach(function (t) {
        var row = document.createElement('div');
        row.className = 'test-row ' + (t.ok ? 'ok' : 'no');
        row.innerHTML = '<span class="badge">' + (t.ok ? 'PASS' : 'FAIL') + '</span>' +
          '<span class="test-name">' + t.name + '</span>' +
          '<span class="test-detail">' + (t.detail || '') + '</span>';
        out.appendChild(row);
      });
    });
  }

  report();
})(typeof window !== 'undefined' ? window : this);
