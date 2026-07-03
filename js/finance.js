/*
 * finance.js — pure financial mathematics used by the projection engine.
 *
 * No DOM, no globals mutated. Every function takes numbers in and returns
 * numbers (or arrays of numbers) out, so the whole module is unit-testable
 * from tests.html. Domain configs never need to reimplement this math.
 */
(function (global) {
  'use strict';

  // ---- Depreciation ------------------------------------------------------

  // Straight-line depreciation schedule over `life` years.
  // Returns an array of annual depreciation amounts (length = life).
  function straightLineDepreciation(cost, life, salvage) {
    salvage = salvage || 0;
    life = Math.max(1, Math.round(life));
    var annual = (cost - salvage) / life;
    var out = [];
    for (var i = 0; i < life; i++) out.push(annual);
    return out;
  }

  // ---- Loan amortization -------------------------------------------------

  // Level-payment (annuity) periodic payment for a fully amortizing loan.
  // ratePerPeriod is a decimal (e.g. 0.005 for 0.5%/month).
  function payment(principal, ratePerPeriod, periods) {
    if (periods <= 0) return 0;
    if (ratePerPeriod === 0) return principal / periods;
    var r = ratePerPeriod;
    return principal * (r * Math.pow(1 + r, periods)) / (Math.pow(1 + r, periods) - 1);
  }

  // Full amortization schedule. Returns array of {period, payment, interest,
  // principal, balance}. Useful for splitting interest (opex/P&L) from
  // principal (financing cash flow).
  function amortize(principal, ratePerPeriod, periods) {
    var pmt = payment(principal, ratePerPeriod, periods);
    var balance = principal;
    var schedule = [];
    for (var p = 1; p <= periods; p++) {
      var interest = balance * ratePerPeriod;
      var principalPaid = pmt - interest;
      balance = Math.max(0, balance - principalPaid);
      schedule.push({
        period: p,
        payment: pmt,
        interest: interest,
        principal: principalPaid,
        balance: balance
      });
    }
    return schedule;
  }

  // Aggregate a monthly amortization schedule into annual interest/principal
  // totals. Returns { interest:[], principal:[], endingBalance:[] } per year.
  function annualDebtService(principal, annualRate, termYears) {
    var months = Math.round(termYears * 12);
    var monthly = amortize(principal, annualRate / 12, months);
    var years = Math.ceil(termYears);
    var interest = [], principalArr = [], endingBalance = [];
    for (var y = 0; y < years; y++) {
      var iSum = 0, pSum = 0, bal = 0;
      for (var m = 0; m < 12; m++) {
        var idx = y * 12 + m;
        if (idx < monthly.length) {
          iSum += monthly[idx].interest;
          pSum += monthly[idx].principal;
          bal = monthly[idx].balance;
        }
      }
      interest.push(iSum);
      principalArr.push(pSum);
      endingBalance.push(bal);
    }
    return { interest: interest, principal: principalArr, endingBalance: endingBalance };
  }

  // ---- Time value of money ----------------------------------------------

  // Net present value. cashflows[0] is period 0 (typically the upfront
  // investment, negative). rate is the per-period discount rate.
  function npv(rate, cashflows) {
    var sum = 0;
    for (var t = 0; t < cashflows.length; t++) {
      sum += cashflows[t] / Math.pow(1 + rate, t);
    }
    return sum;
  }

  // Internal rate of return via bisection then Newton refinement. Robust for
  // the typical "one sign change" investment profile. Returns null if no
  // sign change (IRR undefined) or if it fails to converge.
  function irr(cashflows, guess) {
    var hasPos = false, hasNeg = false;
    for (var i = 0; i < cashflows.length; i++) {
      if (cashflows[i] > 0) hasPos = true;
      if (cashflows[i] < 0) hasNeg = true;
    }
    if (!hasPos || !hasNeg) return null;

    // Bracket the root in [-0.9999, 10] (i.e. -99.99% to 1000%).
    var lo = -0.9999, hi = 10.0;
    var fLo = npv(lo, cashflows);
    var fHi = npv(hi, cashflows);
    // Expand hi if needed.
    var tries = 0;
    while (fLo * fHi > 0 && tries < 60) {
      hi *= 1.5;
      fHi = npv(hi, cashflows);
      tries++;
    }
    if (fLo * fHi > 0) return null; // couldn't bracket

    // Bisection for guaranteed convergence (guess is accepted for API
    // compatibility but bisection doesn't need a seed).
    void guess;
    for (var iter = 0; iter < 200; iter++) {
      var mid = (lo + hi) / 2;
      var fMid = npv(mid, cashflows);
      if (Math.abs(fMid) < 1e-7) return mid;
      if (fLo * fMid < 0) {
        hi = mid;
        fHi = fMid;
      } else {
        lo = mid;
        fLo = fMid;
      }
    }
    return (lo + hi) / 2;
  }

  // ---- Payback -----------------------------------------------------------

  // Simple payback period in periods (with fractional interpolation) from a
  // cashflow array where index 0 is the initial outlay (negative). Returns
  // Infinity if never recovered.
  //
  // The returned value is measured in periods from time 0. If cumulative cash
  // turns non-negative partway through period t, we linearly interpolate the
  // fraction of that period needed to reach break-even.
  function paybackPeriod(cashflows) {
    var cumulative = 0;
    for (var t = 0; t < cashflows.length; t++) {
      var prev = cumulative;
      cumulative += cashflows[t];
      if (cumulative >= 0 && prev < 0) {
        var needed = -prev;          // still-negative amount entering period t
        var gained = cashflows[t];   // inflow during period t
        var fraction = gained !== 0 ? needed / gained : 0;
        return (t - 1) + fraction;
      }
    }
    return Infinity;
  }

  // Discounted payback: same idea but on discounted cashflows.
  function discountedPayback(rate, cashflows) {
    var discounted = cashflows.map(function (cf, t) {
      return cf / Math.pow(1 + rate, t);
    });
    return paybackPeriod(discounted);
  }

  // ---- Growth ------------------------------------------------------------

  // Compound annual growth rate between two values over n periods.
  function cagr(start, end, periods) {
    if (start <= 0 || periods <= 0) return null;
    return Math.pow(end / start, 1 / periods) - 1;
  }

  // Apply a growth rate to a base value at year index t (0-based).
  function grow(base, rate, t) {
    return base * Math.pow(1 + rate, t);
  }

  global.Finance = {
    straightLineDepreciation: straightLineDepreciation,
    payment: payment,
    amortize: amortize,
    annualDebtService: annualDebtService,
    npv: npv,
    irr: irr,
    paybackPeriod: paybackPeriod,
    discountedPayback: discountedPayback,
    cagr: cagr,
    grow: grow
  };
})(typeof window !== 'undefined' ? window : this);
