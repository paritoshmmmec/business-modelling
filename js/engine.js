/*
 * engine.js — the domain-agnostic financial projection engine.
 *
 * A domain config's compute(inputs) returns a normalized `model` describing
 * the business in generic terms (capex items, revenue items, opex items,
 * financing, tax, ramp). The engine below projects that model over N years and
 * derives a full P&L, cash-flow statement and the standard investment KPIs
 * (NPV, IRR, payback, ROI, margins). No domain-specific logic lives here — add
 * a new domain by writing a new compute() that returns this same shape.
 *
 * ---- Model contract -----------------------------------------------------
 * {
 *   currency: 'USD',
 *   years: 10,
 *   capexItems:   [{ label, amount }],
 *   revenueItems: [{ label, amount, growth }],   // amount = fully-ramped yr value
 *   opexItems:    [{ label, amount, growth, capacityLinked }],
 *   ramp:         [0.6, 0.85, 1.0, ...],          // per-year utilization fraction
 *   financing:    { debtFraction, interestRate, termYears },
 *   depreciationLife: 15,
 *   salvageValue: 0,
 *   taxRate: 0.21,
 *   discountRate: 0.10,
 *   notes: []                                      // optional strings for UI
 * }
 *
 * `capacityLinked` opex scales with the ramp (e.g. power drawn by live racks);
 * non-linked opex is fixed from year 1 (e.g. staff, insurance).
 */
(function (global) {
  'use strict';

  var F = global.Finance;

  function sum(arr, key) {
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += key ? (arr[i][key] || 0) : arr[i];
    return s;
  }

  function project(model) {
    var years = Math.max(1, Math.round(model.years || 10));
    var ramp = model.ramp || [];
    var capexItems = model.capexItems || [];
    var revenueItems = model.revenueItems || [];
    var opexItems = model.opexItems || [];

    var totalCapex = sum(capexItems, 'amount');
    var fin = model.financing || { debtFraction: 0, interestRate: 0, termYears: 1 };
    var debt = totalCapex * (fin.debtFraction || 0);
    var equity = totalCapex - debt;
    var taxRate = model.taxRate || 0;
    var discountRate = model.discountRate || 0.1;

    // Depreciation schedule (straight line) over its own life.
    var depLife = Math.max(1, Math.round(model.depreciationLife || years));
    var depSchedule = F.straightLineDepreciation(totalCapex, depLife, model.salvageValue || 0);

    // Debt service split into annual interest & principal.
    var debtService = debt > 0 && fin.termYears > 0
      ? F.annualDebtService(debt, fin.interestRate || 0, fin.termYears)
      : { interest: [], principal: [] };

    function rampAt(y) {
      // y is 1-based. Default to 1.0 (fully ramped) beyond the supplied array.
      if (ramp.length === 0) return 1;
      var idx = y - 1;
      return idx < ramp.length ? ramp[idx] : ramp[ramp.length - 1];
    }

    var perYear = [];
    var projectCF = [-totalCapex]; // unlevered, index 0 = outlay
    var equityCF = [-equity];      // levered equity view
    var cumProject = 0, cumEquity = 0;
    var cumNetIncome = 0;

    for (var y = 1; y <= years; y++) {
      var r = rampAt(y);
      var t = y - 1; // 0-based for growth compounding

      // Revenue (fully-ramped amount * ramp * growth^t)
      var revenueBreakdown = revenueItems.map(function (it) {
        var v = F.grow(it.amount, it.growth || 0, t) * r;
        return { label: it.label, amount: v };
      });
      var revenue = sum(revenueBreakdown, 'amount');

      // Opex — capacity-linked items scale with ramp; fixed items do not.
      var opexBreakdown = opexItems.map(function (it) {
        var base = F.grow(it.amount, it.growth || 0, t);
        var v = it.capacityLinked ? base * r : base;
        return { label: it.label, amount: v };
      });
      var opex = sum(opexBreakdown, 'amount');

      var ebitda = revenue - opex;
      var depreciation = t < depSchedule.length ? depSchedule[t] : 0;
      var interest = t < debtService.interest.length ? debtService.interest[t] : 0;
      var principal = t < debtService.principal.length ? debtService.principal[t] : 0;

      var ebit = ebitda - depreciation;
      var ebt = ebit - interest;
      var tax = Math.max(0, ebt) * taxRate;
      var netIncome = ebt - tax;

      // Unlevered (project) free cash flow: NOPAT + depreciation.
      // Tax here is computed on EBIT so the financing decision doesn't distort
      // the project's intrinsic return.
      var projectTax = Math.max(0, ebit) * taxRate;
      var projectFCF = (ebit - projectTax) + depreciation;

      // Levered (equity) free cash flow: net income + depreciation - principal.
      var equityFCF = netIncome + depreciation - principal;

      cumProject += projectFCF;
      cumEquity += equityFCF;
      cumNetIncome += netIncome;

      projectCF.push(projectFCF);
      equityCF.push(equityFCF);

      perYear.push({
        year: y,
        ramp: r,
        revenue: revenue,
        revenueBreakdown: revenueBreakdown,
        opex: opex,
        opexBreakdown: opexBreakdown,
        ebitda: ebitda,
        ebitdaMargin: revenue ? ebitda / revenue : 0,
        depreciation: depreciation,
        ebit: ebit,
        interest: interest,
        ebt: ebt,
        tax: tax,
        netIncome: netIncome,
        netMargin: revenue ? netIncome / revenue : 0,
        principal: principal,
        projectFCF: projectFCF,
        equityFCF: equityFCF,
        cumProjectFCF: cumProject - totalCapex, // net of initial outlay
        cumEquityFCF: cumEquity - equity
      });
    }

    // ---- KPIs -------------------------------------------------------------
    var first = perYear[0];
    var last = perYear[perYear.length - 1];

    var kpis = {
      totalCapex: totalCapex,
      equity: equity,
      debt: debt,
      year1Revenue: first.revenue,
      steadyRevenue: last.revenue,
      year1NetIncome: first.netIncome,
      steadyNetIncome: last.netIncome,
      year1NetMargin: first.netMargin,
      steadyNetMargin: last.netMargin,
      steadyEbitdaMargin: last.ebitdaMargin,
      cumulativeNetIncome: cumNetIncome,
      npvProject: F.npv(discountRate, projectCF),
      irrProject: F.irr(projectCF),
      irrEquity: F.irr(equityCF),
      paybackProject: F.paybackPeriod(projectCF),
      discountedPayback: F.discountedPayback(discountRate, projectCF),
      // ROI over the horizon: cumulative net income / equity invested.
      roi: equity > 0 ? cumNetIncome / equity : (totalCapex > 0 ? cumNetIncome / totalCapex : null),
      discountRate: discountRate
    };

    return {
      currency: model.currency || 'USD',
      years: years,
      totalCapex: totalCapex,
      equity: equity,
      debt: debt,
      capexItems: capexItems,
      perYear: perYear,
      kpis: kpis,
      cashflows: { project: projectCF, equity: equityCF },
      notes: model.notes || [],
      derived: model.derived || {} // domain-supplied display extras (PUE, $/kW…)
    };
  }

  global.Engine = { project: project };
})(typeof window !== 'undefined' ? window : this);
