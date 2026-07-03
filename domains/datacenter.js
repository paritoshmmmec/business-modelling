/*
 * domains/datacenter.js — the datacenter business domain.
 *
 * Exposes four selectable business models that all feed the SAME shared
 * projection engine (js/engine.js). Each scenario's compute() only differs in
 * how it derives capex / revenue / opex from the inputs — everything after
 * that (P&L, depreciation, financing, NPV/IRR/payback) is common.
 *
 *   colo       — Colocation operator: rent racks, power & cross-connects.
 *   cloud      — Cloud / compute reseller: sell VM / GPU hours off owned kit.
 *   enterprise — Enterprise self-build: TCO & cloud cost-avoidance view.
 *   wholesale  — Wholesale / hyperscale lease: $/kW/month on committed MW.
 *
 * All money is in the selected currency; the engine is currency-agnostic.
 */
(function (global) {
  'use strict';

  // ---- shared helpers ----------------------------------------------------

  // Ramp curve: linearly fill to `stabilized` utilization over `fillMonths`,
  // producing a per-year average utilization fraction for `years` years.
  function rampCurve(years, fillMonths, stabilized) {
    var curve = [];
    for (var y = 1; y <= years; y++) {
      // average utilization across the 12 months of year y
      var startM = (y - 1) * 12;
      var acc = 0;
      for (var m = 0; m < 12; m++) {
        var monthIndex = startM + m + 0.5; // mid-month
        var u = fillMonths <= 0 ? stabilized : Math.min(stabilized, stabilized * monthIndex / fillMonths);
        acc += u;
      }
      curve.push(acc / 12);
    }
    return curve;
  }

  function num(inputs, key, dflt) {
    var v = inputs[key];
    return (v == null || isNaN(v)) ? (dflt || 0) : Number(v);
  }

  // Common financing / tax / horizon block shared by all scenarios.
  function commonModel(inputs) {
    return {
      currency: inputs.currency || 'USD',
      years: Math.round(num(inputs, 'horizonYears', 10)),
      financing: {
        debtFraction: num(inputs, 'debtFraction', 0),
        interestRate: num(inputs, 'interestRate', 0.07),
        termYears: num(inputs, 'loanTermYears', 10)
      },
      depreciationLife: num(inputs, 'depreciationLife', 15),
      salvageValue: 0,
      taxRate: num(inputs, 'taxRate', 0.21),
      discountRate: num(inputs, 'discountRate', 0.10)
    };
  }

  // Build the standard IT-capacity + facility capex from power & density.
  // Returns { capexItems, itLoadKw, totalKw, pue, racks, derived }.
  //
  // opts.includeItHardware — only the cloud/compute-reseller model owns the
  // servers, so IT hardware capex is opt-in. Without this, fields that are
  // hidden for a scenario (but still carry their default) would silently leak
  // server cost into colo / wholesale / enterprise models.
  function facilityFromPower(inputs, opts) {
    opts = opts || {};
    var itLoadMw = num(inputs, 'itLoadMw', 5);
    var itLoadKw = itLoadMw * 1000;
    var pue = num(inputs, 'pue', 1.5);
    var totalKw = itLoadKw * pue;
    var kwPerRack = num(inputs, 'kwPerRack', 8);
    var racks = kwPerRack > 0 ? Math.round(itLoadKw / kwPerRack) : 0;

    // Capex drivers expressed per Watt of IT load / per rack — standard DC
    // cost engineering. Defaults are mid-market ballparks (USD).
    var buildCostPerWatt = num(inputs, 'buildCostPerWatt', 10); // $/W IT, all-in shell+MEP
    var itHardwarePerRack = opts.includeItHardware ? num(inputs, 'itHardwarePerRack', 0) : 0;
    var landAndShell = num(inputs, 'landAndShell', 0);

    var facilityCapex = itLoadKw * 1000 * buildCostPerWatt; // W = kW*1000
    var itCapex = racks * itHardwarePerRack;

    var capexItems = [
      { label: 'Facility (shell, power, cooling)', amount: facilityCapex }
    ];
    if (landAndShell > 0) capexItems.push({ label: 'Land & site works', amount: landAndShell });
    if (itCapex > 0) capexItems.push({ label: 'IT hardware (servers/GPUs)', amount: itCapex });

    return {
      capexItems: capexItems,
      itLoadKw: itLoadKw,
      totalKw: totalKw,
      pue: pue,
      racks: racks,
      itHardwarePerRack: itHardwarePerRack
    };
  }

  // Shared facility operating costs driven by power draw & PUE.
  function facilityOpex(inputs, fac) {
    var powerPriceKwh = num(inputs, 'powerPriceKwh', 0.10);
    var hoursYear = 8760;
    // Energy cost at 100% utilization (engine scales capacity-linked items by ramp)
    var annualEnergy = fac.totalKw * hoursYear * powerPriceKwh;

    var staffCount = num(inputs, 'staffCount', 8);
    var costPerStaff = num(inputs, 'costPerStaff', 90000);
    var staffCost = staffCount * costPerStaff;

    var maintenancePctCapex = num(inputs, 'maintenancePct', 0.03);
    var facilityCapex = fac.capexItems.reduce(function (s, i) { return s + i.amount; }, 0);
    var maintenance = facilityCapex * maintenancePctCapex;

    var bandwidthAnnual = num(inputs, 'bandwidthAnnual', 0);
    var otherOpex = num(inputs, 'otherOpexAnnual', 0);

    var opexItems = [
      { label: 'Power / energy', amount: annualEnergy, capacityLinked: true, growth: num(inputs, 'powerInflation', 0.03) },
      { label: 'Staff / operations', amount: staffCost, capacityLinked: false, growth: 0.03 },
      { label: 'Maintenance & repairs', amount: maintenance, capacityLinked: false, growth: 0.02 }
    ];
    if (bandwidthAnnual > 0) opexItems.push({ label: 'Bandwidth / network', amount: bandwidthAnnual, capacityLinked: true, growth: 0 });
    if (otherOpex > 0) opexItems.push({ label: 'Other opex', amount: otherOpex, capacityLinked: false, growth: 0.02 });

    return { opexItems: opexItems, annualEnergy: annualEnergy };
  }

  function derivedMetrics(inputs, fac, extra) {
    var d = {
      power: { label: 'IT load', value: Format.number(fac.itLoadKw) + ' kW', help: 'Critical IT power capacity' },
      total: { label: 'Total facility power', value: Format.number(Math.round(fac.totalKw)) + ' kW', help: 'IT load × PUE' },
      pue: { label: 'PUE', value: Format.trimZeros(fac.pue.toFixed(2)), help: 'Power Usage Effectiveness (lower is better)' },
      racks: { label: 'Racks', value: Format.number(fac.racks), help: 'Approx rack count at chosen density' }
    };
    if (extra) for (var k in extra) d[k] = extra[k];
    return d;
  }

  // =======================================================================
  //  SCENARIO 1 — COLOCATION
  // =======================================================================
  function computeColo(inputs) {
    var m = commonModel(inputs);
    var fac = facilityFromPower(inputs);
    var op = facilityOpex(inputs, fac);

    // Revenue: rack/cabinet rental + metered power markup + cross-connects.
    var pricePerRackMonth = num(inputs, 'pricePerRackMonth', 1200);
    var powerResalePerKwh = num(inputs, 'powerResaleKwh', 0.16); // what you charge tenants
    var powerCostKwh = num(inputs, 'powerPriceKwh', 0.10);
    var crossConnectPerRackMonth = num(inputs, 'crossConnectPerRackMonth', 150);

    var rackRevenue = fac.racks * pricePerRackMonth * 12;
    // Power resale margin on IT energy (tenants pay for IT kWh they draw)
    var itEnergyKwh = fac.itLoadKw * 8760;
    var powerRevenue = itEnergyKwh * (powerResalePerKwh - powerCostKwh);
    var crossConnectRevenue = fac.racks * crossConnectPerRackMonth * 12;

    m.capexItems = fac.capexItems;
    m.opexItems = op.opexItems;
    m.revenueItems = [
      { label: 'Rack / cabinet rental', amount: rackRevenue, growth: num(inputs, 'priceGrowth', 0.02) },
      { label: 'Power resale margin', amount: powerRevenue, growth: 0 },
      { label: 'Cross-connects / interconnect', amount: crossConnectRevenue, growth: 0.02 }
    ];
    m.ramp = rampCurve(m.years, num(inputs, 'fillMonths', 24), num(inputs, 'targetOccupancy', 0.85));
    m.derived = derivedMetrics(inputs, fac, {
      revPerRack: { label: 'Revenue / rack / mo', value: Format.currency((rackRevenue + crossConnectRevenue) / Math.max(1, fac.racks) / 12, m.currency), help: 'Blended rental + interconnect' }
    });
    m.notes = [
      'Colocation model: revenue from renting rack space, reselling power at a markup, and interconnection fees.',
      'Occupancy ramps to ' + Format.percent(num(inputs, 'targetOccupancy', 0.85)) + ' over ' + num(inputs, 'fillMonths', 24) + ' months.',
      'Power resale margin = tenant price − your cost, on IT energy drawn.'
    ];
    return m;
  }

  // =======================================================================
  //  SCENARIO 2 — CLOUD / COMPUTE RESELLER
  // =======================================================================
  function computeCloud(inputs) {
    var m = commonModel(inputs);
    // This is the only model that owns the servers, so include IT hardware.
    var fac = facilityFromPower(inputs, { includeItHardware: true });
    var op = facilityOpex(inputs, fac);

    // Revenue driven by sellable compute units (VMs or GPUs) and their price.
    var unitsPerRack = num(inputs, 'unitsPerRack', 40); // e.g. GPUs or VM slots per rack
    var totalUnits = fac.racks * unitsPerRack;
    var pricePerUnitHour = num(inputs, 'pricePerUnitHour', 2.5);
    var soldUtilization = num(inputs, 'soldUtilization', 0.7); // fraction of hours actually billed at steady state
    var hoursYear = 8760;

    var computeRevenue = totalUnits * pricePerUnitHour * hoursYear * soldUtilization;
    var egressRevenue = num(inputs, 'egressAnnual', 0);

    m.capexItems = fac.capexItems;
    m.opexItems = op.opexItems;
    m.revenueItems = [
      { label: 'Compute (VM / GPU hours)', amount: computeRevenue, growth: num(inputs, 'priceGrowth', 0) },
      { label: 'Egress / storage / add-ons', amount: egressRevenue, growth: 0.05 }
    ];
    // Ramp represents utilization ramp of sold capacity.
    m.ramp = rampCurve(m.years, num(inputs, 'fillMonths', 18), 1.0);
    // Shorter default depreciation since servers age fast — but respect input.
    m.derived = derivedMetrics(inputs, fac, {
      units: { label: 'Sellable units', value: Format.number(totalUnits), help: 'Racks × units per rack (GPUs or VM slots)' },
      revPerUnit: { label: 'Revenue / unit / yr', value: Format.currency(computeRevenue / Math.max(1, totalUnits), m.currency), help: 'At steady-state sold utilization' }
    });
    m.notes = [
      'Compute reseller model: revenue from selling VM / GPU hours off owned hardware.',
      'Steady-state billed utilization: ' + Format.percent(soldUtilization) + ' of available unit-hours.',
      'Includes server/GPU capex — consider a shorter depreciation life (3–5 yrs) for IT hardware.'
    ];
    return m;
  }

  // =======================================================================
  //  SCENARIO 3 — ENTERPRISE SELF-BUILD (TCO / cloud avoidance)
  // =======================================================================
  function computeEnterprise(inputs) {
    var m = commonModel(inputs);
    var fac = facilityFromPower(inputs);
    var op = facilityOpex(inputs, fac);

    // "Revenue" here is cost-avoidance: what the equivalent workload would cost
    // on public cloud. This lets the same engine express TCO vs cloud savings
    // as net profit / NPV / payback.
    var cloudMonthlyEquivalent = num(inputs, 'cloudMonthlyEquivalent', 0);
    var avoided = cloudMonthlyEquivalent * 12;
    // If not given explicitly, estimate from IT load at a $/kW/mo cloud proxy.
    if (avoided === 0) {
      var cloudPerKwMonth = num(inputs, 'cloudPerKwMonth', 600);
      avoided = fac.itLoadKw * cloudPerKwMonth * 12;
    }

    m.capexItems = fac.capexItems;
    m.opexItems = op.opexItems;
    m.revenueItems = [
      { label: 'Public-cloud cost avoided', amount: avoided, growth: num(inputs, 'cloudInflation', 0.05) }
    ];
    m.ramp = rampCurve(m.years, num(inputs, 'fillMonths', 12), num(inputs, 'targetOccupancy', 1.0));
    m.taxRate = 0; // internal cost centre — model pre-tax economics by default
    m.derived = derivedMetrics(inputs, fac, {
      avoided: { label: 'Cloud spend avoided / yr', value: Format.currency(avoided, m.currency), help: 'Equivalent public-cloud cost at steady state' }
    });
    m.notes = [
      'Enterprise self-build (TCO) model: "revenue" is the public-cloud spend you avoid by running workloads in-house.',
      'Net profit here = annual cloud savings − operating cost − depreciation. Positive NPV means building beats renting.',
      'Tax defaulted to 0% (internal cost centre). Set a tax rate if you want an after-tax view.'
    ];
    return m;
  }

  // =======================================================================
  //  SCENARIO 4 — WHOLESALE / HYPERSCALE LEASE
  // =======================================================================
  function computeWholesale(inputs) {
    var m = commonModel(inputs);
    // Wholesale: landlord provides shell+power+cooling; tenant brings servers.
    // includeItHardware defaults off, so no server capex here.
    var fac = facilityFromPower(inputs);

    // Revenue: committed $/kW/month on leased IT capacity.
    var leaseRateKwMonth = num(inputs, 'leaseRateKwMonth', 130);
    var leasedFraction = num(inputs, 'targetOccupancy', 0.95);
    var leaseRevenue = fac.itLoadKw * leaseRateKwMonth * 12;

    // In triple-net wholesale, tenant pays energy — so exclude tenant power from opex.
    var op = facilityOpex(inputs, fac);
    if (num(inputs, 'tripleNet', 1)) {
      op.opexItems = op.opexItems.filter(function (i) { return i.label.indexOf('Power') === -1; });
    }

    m.capexItems = fac.capexItems;
    m.opexItems = op.opexItems;
    m.revenueItems = [
      { label: 'Capacity lease ($/kW/mo)', amount: leaseRevenue, growth: num(inputs, 'escalator', 0.025) }
    ];
    m.ramp = rampCurve(m.years, num(inputs, 'fillMonths', 12), leasedFraction);
    m.depreciationLife = num(inputs, 'depreciationLife', 20); // long-life shells
    m.derived = derivedMetrics(inputs, fac, {
      rate: { label: 'Lease rate', value: Format.currency(leaseRateKwMonth, m.currency) + '/kW/mo', help: 'Committed price on IT capacity' },
      annual: { label: 'Lease revenue (full)', value: Format.currency(leaseRevenue, m.currency), help: 'At 100% leased' }
    });
    m.notes = [
      'Wholesale / hyperscale model: lease whole halls at a committed $/kW/month on IT capacity.',
      'Triple-net assumed: tenant pays their own energy, so power is excluded from your opex.',
      'Long-lived asset — depreciation defaults to ' + num(inputs, 'depreciationLife', 20) + ' years.'
    ];
    return m;
  }

  // ---- shared field library ---------------------------------------------
  // Common fields reused across scenarios (with per-scenario visibility).
  var capacityGroup = {
    id: 'capacity', label: 'Capacity & facility', icon: '⚡',
    fields: [
      { key: 'itLoadMw', label: 'IT load', type: 'number', default: 5, min: 0.1, step: 0.1, unit: 'MW', help: 'Critical IT power capacity in megawatts' },
      { key: 'pue', label: 'PUE', type: 'number', default: 1.5, min: 1.0, max: 3, step: 0.01, help: 'Power Usage Effectiveness = total power ÷ IT power' },
      { key: 'kwPerRack', label: 'Density', type: 'number', default: 8, min: 1, step: 0.5, unit: 'kW/rack', help: 'Power per rack — drives rack count' },
      { key: 'buildCostPerWatt', label: 'Build cost', type: 'currency', prefix: '$', default: 9, min: 1, step: 0.5, unit: '/W IT', help: 'All-in facility cost per watt of IT load' },
      { key: 'itHardwarePerRack', label: 'IT hardware / rack', type: 'currency', prefix: '$', default: 120000, min: 0, step: 1000, scenarios: ['cloud'], help: 'Servers / GPUs cost per rack' },
      { key: 'landAndShell', label: 'Land & site works', type: 'currency', prefix: '$', default: 0, min: 0, step: 100000, help: 'Extra one-off land / civil cost' }
    ]
  };

  var opexGroup = {
    id: 'opex', label: 'Operating costs', icon: '🛠️',
    fields: [
      { key: 'powerPriceKwh', label: 'Power price', type: 'currency', prefix: '$', default: 0.10, min: 0, step: 0.01, unit: '/kWh', help: 'Your wholesale electricity cost' },
      { key: 'powerInflation', label: 'Power price growth', type: 'percent', default: 0.03, min: 0, step: 0.5, help: 'Annual energy price escalation' },
      { key: 'staffCount', label: 'Staff (FTE)', type: 'number', default: 8, min: 0, step: 1, help: 'Full-time operations & security headcount' },
      { key: 'costPerStaff', label: 'Cost / staff', type: 'currency', prefix: '$', default: 90000, min: 0, step: 5000, unit: '/yr', help: 'Fully-loaded annual cost per FTE' },
      { key: 'maintenancePct', label: 'Maintenance', type: 'percent', default: 0.03, min: 0, step: 0.5, unit: '', help: 'Annual maintenance as % of facility capex' },
      { key: 'bandwidthAnnual', label: 'Bandwidth / network', type: 'currency', prefix: '$', default: 0, min: 0, step: 10000, unit: '/yr', help: 'Annual transit / peering cost' },
      { key: 'otherOpexAnnual', label: 'Other opex', type: 'currency', prefix: '$', default: 0, min: 0, step: 10000, unit: '/yr', help: 'Insurance, licences, misc.' }
    ]
  };

  var financeGroup = {
    id: 'finance', label: 'Financing, tax & horizon', icon: '💰',
    fields: [
      { key: 'horizonYears', label: 'Model horizon', type: 'number', default: 10, min: 1, max: 30, step: 1, unit: 'yrs', help: 'Projection length' },
      { key: 'debtFraction', label: 'Debt financing', type: 'percent', default: 0.5, min: 0, max: 1, step: 5, help: 'Share of capex funded by debt' },
      { key: 'interestRate', label: 'Interest rate', type: 'percent', default: 0.07, min: 0, step: 0.25, help: 'Annual loan interest rate' },
      { key: 'loanTermYears', label: 'Loan term', type: 'number', default: 10, min: 1, max: 30, step: 1, unit: 'yrs', help: 'Amortization period' },
      { key: 'depreciationLife', label: 'Depreciation life', type: 'number', default: 15, min: 1, max: 40, step: 1, unit: 'yrs', help: 'Straight-line asset life' },
      { key: 'taxRate', label: 'Tax rate', type: 'percent', default: 0.21, min: 0, max: 0.6, step: 1, help: 'Corporate income tax rate' },
      { key: 'discountRate', label: 'Discount rate (WACC)', type: 'percent', default: 0.10, min: 0, step: 0.5, help: 'Hurdle rate for NPV / IRR' }
    ]
  };

  // Scenario-specific revenue groups.
  var coloRevenue = {
    id: 'colo-rev', label: 'Colocation pricing', icon: '🏷️', scenarios: ['colo'],
    fields: [
      { key: 'pricePerRackMonth', label: 'Rack price', type: 'currency', prefix: '$', default: 1500, min: 0, step: 50, unit: '/mo', help: 'Monthly price per rack/cabinet' },
      { key: 'powerResaleKwh', label: 'Power resale', type: 'currency', prefix: '$', default: 0.18, min: 0, step: 0.01, unit: '/kWh', help: 'Price charged to tenants per kWh' },
      { key: 'crossConnectPerRackMonth', label: 'Cross-connect', type: 'currency', prefix: '$', default: 250, min: 0, step: 10, unit: '/rack/mo', help: 'Interconnection revenue per rack' },
      { key: 'targetOccupancy', label: 'Target occupancy', type: 'percent', default: 0.85, min: 0, max: 1, step: 1, help: 'Stabilized fill rate' },
      { key: 'fillMonths', label: 'Fill period', type: 'number', default: 24, min: 1, step: 1, unit: 'mo', help: 'Months to reach target occupancy' },
      { key: 'priceGrowth', label: 'Price growth', type: 'percent', default: 0.02, min: 0, step: 0.5, help: 'Annual pricing escalation' }
    ]
  };

  var cloudRevenue = {
    id: 'cloud-rev', label: 'Compute pricing', icon: '🖥️', scenarios: ['cloud'],
    fields: [
      { key: 'unitsPerRack', label: 'Units / rack', type: 'number', default: 60, min: 1, step: 1, help: 'Sellable units (GPUs / VM slots) per rack' },
      { key: 'pricePerUnitHour', label: 'Price / unit-hour', type: 'currency', prefix: '$', default: 0.12, min: 0, step: 0.01, unit: '/hr', help: 'Billed rate per unit-hour' },
      { key: 'soldUtilization', label: 'Billed utilization', type: 'percent', default: 0.65, min: 0, max: 1, step: 1, help: 'Steady-state fraction of hours billed' },
      { key: 'egressAnnual', label: 'Add-ons / egress', type: 'currency', prefix: '$', default: 0, min: 0, step: 50000, unit: '/yr', help: 'Storage, egress, managed services' },
      { key: 'fillMonths', label: 'Ramp period', type: 'number', default: 18, min: 1, step: 1, unit: 'mo', help: 'Months to reach full sold utilization' },
      { key: 'priceGrowth', label: 'Price growth', type: 'percent', default: 0.0, min: -0.2, step: 0.5, help: 'Annual price change (compute often deflates)' }
    ]
  };

  var enterpriseRevenue = {
    id: 'ent-rev', label: 'Cloud cost-avoidance', icon: '☁️', scenarios: ['enterprise'],
    fields: [
      { key: 'cloudMonthlyEquivalent', label: 'Equivalent cloud bill', type: 'currency', prefix: '$', default: 0, min: 0, step: 50000, unit: '/mo', help: 'Public-cloud cost for the same workload (0 = estimate from IT load)' },
      { key: 'cloudPerKwMonth', label: 'Cloud proxy rate', type: 'currency', prefix: '$', default: 600, min: 0, step: 50, unit: '/kW/mo', help: 'Used to estimate cloud cost when bill not given', showIf: function (i) { return !i.cloudMonthlyEquivalent; } },
      { key: 'cloudInflation', label: 'Cloud price growth', type: 'percent', default: 0.05, min: 0, step: 0.5, help: 'Annual public-cloud price escalation' },
      { key: 'targetOccupancy', label: 'Workload utilization', type: 'percent', default: 1.0, min: 0, max: 1, step: 1, help: 'How fully the build is used' },
      { key: 'fillMonths', label: 'Migration period', type: 'number', default: 12, min: 1, step: 1, unit: 'mo', help: 'Months to migrate workloads in' }
    ]
  };

  var wholesaleRevenue = {
    id: 'ws-rev', label: 'Wholesale lease terms', icon: '📜', scenarios: ['wholesale'],
    fields: [
      { key: 'leaseRateKwMonth', label: 'Lease rate', type: 'currency', prefix: '$', default: 145, min: 0, step: 5, unit: '/kW/mo', help: 'Committed monthly price per kW of IT capacity' },
      { key: 'targetOccupancy', label: 'Leased fraction', type: 'percent', default: 0.95, min: 0, max: 1, step: 1, help: 'Share of capacity under lease at steady state' },
      { key: 'escalator', label: 'Annual escalator', type: 'percent', default: 0.025, min: 0, step: 0.25, help: 'Contractual rent escalation' },
      { key: 'fillMonths', label: 'Lease-up period', type: 'number', default: 12, min: 1, step: 1, unit: 'mo', help: 'Months to fully lease the hall' },
      { key: 'tripleNet', label: 'Triple-net (tenant pays power)', type: 'select', default: 1, options: [{ value: 1, label: 'Yes — tenant pays energy' }, { value: 0, label: 'No — you pay energy' }], help: 'Whether energy cost passes to tenant' }
    ]
  };

  // ---- domain config -----------------------------------------------------
  var config = {
    id: 'datacenter',
    name: 'Datacenter',
    tagline: 'Model space, power, cost, revenue and profit for a datacenter across four business models.',
    currency: 'USD',
    scenarios: [
      { id: 'colo', name: 'Colocation', description: 'Rent rack space, power and interconnection to many tenants.' },
      { id: 'cloud', name: 'Compute reseller', description: 'Sell VM / GPU hours off hardware you own and operate.' },
      { id: 'enterprise', name: 'Enterprise self-build', description: 'Build for your own workloads; value = public-cloud cost avoided (TCO).' },
      { id: 'wholesale', name: 'Wholesale / hyperscale', description: 'Lease whole halls at $/kW/month to large tenants.' }
    ],
    groups: [capacityGroup, coloRevenue, cloudRevenue, enterpriseRevenue, wholesaleRevenue, opexGroup, financeGroup],
    presets: [
      { id: 'colo-small', label: 'Small colo (2 MW)', scenarios: ['colo'], values: { itLoadMw: 2, pue: 1.5, kwPerRack: 6, pricePerRackMonth: 1000, targetOccupancy: 0.85, debtFraction: 0.5 } },
      { id: 'colo-large', label: 'Large colo (20 MW)', scenarios: ['colo'], values: { itLoadMw: 20, pue: 1.4, kwPerRack: 10, pricePerRackMonth: 1400, targetOccupancy: 0.9, debtFraction: 0.6 } },
      { id: 'gpu-cloud', label: 'GPU cloud (5 MW)', scenarios: ['cloud'], values: { itLoadMw: 5, pue: 1.4, kwPerRack: 30, itHardwarePerRack: 350000, unitsPerRack: 8, pricePerUnitHour: 2.8, soldUtilization: 0.8, depreciationLife: 4 } },
      { id: 'vm-cloud', label: 'VM cloud (3 MW)', scenarios: ['cloud'], values: { itLoadMw: 3, pue: 1.5, kwPerRack: 8, itHardwarePerRack: 120000, unitsPerRack: 60, pricePerUnitHour: 0.15, soldUtilization: 0.65, depreciationLife: 5 } },
      { id: 'ent-mid', label: 'Enterprise (1 MW)', scenarios: ['enterprise'], values: { itLoadMw: 1, pue: 1.6, kwPerRack: 8, cloudPerKwMonth: 600, taxRate: 0 } },
      { id: 'ws-hall', label: 'Hyperscale hall (30 MW)', scenarios: ['wholesale'], values: { itLoadMw: 30, pue: 1.3, buildCostPerWatt: 8, leaseRateKwMonth: 125, targetOccupancy: 0.95, debtFraction: 0.65, depreciationLife: 20 } }
    ],
    compute: function (inputs, scenarioId) {
      switch (scenarioId) {
        case 'cloud': return computeCloud(inputs);
        case 'enterprise': return computeEnterprise(inputs);
        case 'wholesale': return computeWholesale(inputs);
        case 'colo':
        default: return computeColo(inputs);
      }
    }
  };

  global.DATACENTER_DOMAIN = config;
  // Register into a generic domain registry so app.js can list domains.
  global.DOMAINS = global.DOMAINS || {};
  global.DOMAINS.datacenter = config;
})(typeof window !== 'undefined' ? window : this);
