/*
 * domains/spacedc.js — the space datacenter business domain.
 *
 * A separate domain from domains/datacenter.js (terrestrial). It models the
 * emerging "compute in orbit" thesis and the launch economics it rides on, all
 * through the SAME shared engine (js/engine.js). Three selectable scenarios:
 *
 *   orbital-dc — Orbital data center: solar-powered GPUs in LEO. Capex is
 *                launch-dominated, so its economics are a direct function of
 *                $/kg to orbit — the same $/kg the two launch scenarios sell.
 *   spacex     — Merchant launch provider (SpaceX): launch-services business
 *                (Falcon 9 today, Starship target). Starlink service revenue is
 *                out of scope — this is the launch business only.
 *   rocketlab  — Rocket Lab (RKLB): Electron + Neutron launch plus the (now
 *                majority) Space Systems segment.
 *
 * Defaults/presets are calibrated to 2025–26 public reporting and are ESTIMATES
 * (see each scenario's notes). All money is in the selected currency; the engine
 * is currency-agnostic.
 */
(function (global) {
  'use strict';

  var Format = global.Format;

  // ---- shared helpers (kept local; domains are deliberately standalone) ----

  // Ramp curve: linearly fill to `stabilized` utilization over `fillMonths`,
  // producing a per-year average utilization fraction for `years` years.
  function rampCurve(years, fillMonths, stabilized) {
    var curve = [];
    for (var y = 1; y <= years; y++) {
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

  // Availability curve for orbital hardware: ramp up to `peak` over `fillMonths`,
  // then (unless replenished) decay at `decayRate`/yr — solar-array degradation
  // plus GPU failures that can't be repaired in orbit. With `replenish` true,
  // capacity is held flat at `peak` (you launch replacements — priced as opex
  // elsewhere) instead of decaying. Returns a per-year availability fraction.
  function availabilityCurve(years, fillMonths, peak, decayRate, replenish) {
    var curve = [];
    var peakYear = Math.max(1, Math.ceil((fillMonths || 0) / 12)); // year full deployment is reached
    for (var y = 1; y <= years; y++) {
      var startM = (y - 1) * 12;
      var acc = 0;
      for (var m = 0; m < 12; m++) {
        var monthIndex = startM + m + 0.5; // mid-month
        var ramp = fillMonths <= 0 ? peak : Math.min(peak, peak * monthIndex / fillMonths);
        acc += ramp;
      }
      var avgRamp = acc / 12;
      if (replenish || decayRate <= 0) {
        curve.push(avgRamp);
      } else {
        // Decay compounds only after the fleet is fully deployed.
        var yearsSincePeak = Math.max(0, y - peakYear);
        curve.push(avgRamp * Math.pow(1 - decayRate, yearsSincePeak));
      }
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
      depreciationLife: num(inputs, 'depreciationLife', 5),
      salvageValue: 0,
      taxRate: num(inputs, 'taxRate', 0.21),
      discountRate: num(inputs, 'discountRate', 0.10)
    };
  }

  function sumAmounts(items) {
    return items.reduce(function (s, i) { return s + i.amount; }, 0);
  }

  // =======================================================================
  //  SCENARIO 1 — ORBITAL DATA CENTER (the space DC itself)
  // =======================================================================
  //
  // Physics/economics: compute power (MW of GPUs) sets the system mass, and
  // system mass × $/kg sets the launch bill — usually the biggest line. Solar
  // is free and the vacuum is the heatsink, so there is NO energy opex — the
  // whole point of going to orbit. Chip-limited ~5-yr life → short depreciation.
  function computeOrbitalDc(inputs) {
    var m = commonModel(inputs);

    var computeMw = num(inputs, 'computePowerMw', 5);
    var massPerMw = num(inputs, 'systemMassKgPerMw', 8000); // GPUs + bus + solar + radiator, kg per MW
    var totalMassKg = computeMw * massPerMw;

    var launchCostPerKg = num(inputs, 'launchCostPerKg', 200);   // the swing variable (Starship-era premise)
    var computeHwPerMw = num(inputs, 'computeHardwarePerMw', 12000000); // $/MW of GPUs
    var platformPerKg = num(inputs, 'platformCostPerKg', 2000);  // satellite bus/solar/radiator build
    var groundSegment = num(inputs, 'groundSegmentCapex', 40000000);

    var launchCapex = totalMassKg * launchCostPerKg;
    var computeCapex = computeMw * computeHwPerMw;
    var platformCapex = totalMassKg * platformPerKg;

    var capexItems = [
      { label: 'Launch to orbit', amount: launchCapex },
      { label: 'Compute hardware (GPUs)', amount: computeCapex },
      { label: 'Satellite platform (solar, radiator, bus)', amount: platformCapex }
    ];
    if (groundSegment > 0) capexItems.push({ label: 'Ground segment & comms', amount: groundSegment });
    var totalCapex = sumAmounts(capexItems);

    // Revenue: sold compute (GPU-hours), same shape as a terrestrial GPU cloud.
    var unitsPerMw = num(inputs, 'sellableUnitsPerMw', 500); // GPU-equivalents per MW
    var totalUnits = computeMw * unitsPerMw;
    var pricePerUnitHour = num(inputs, 'pricePerUnitHour', 2.0);
    var soldUtilization = num(inputs, 'soldUtilization', 0.8);
    var hoursYear = 8760;
    var computeRevenue = totalUnits * pricePerUnitHour * hoursYear * soldUtilization;

    // Availability: fleet ramps to an adjustable PEAK (never truly 100% —
    // pointing, eclipse, thermal duty-cycle), then degrades unless replenished.
    var peakUtilization = Math.max(0, Math.min(1, num(inputs, 'peakUtilization', 0.9)));
    var degradationRate = Math.max(0, Math.min(0.95, num(inputs, 'degradationRate', 0.06))); // per year, post-peak
    var replenish = num(inputs, 'replenish', 0) ? true : false;
    var fillMonths = num(inputs, 'fillMonths', 18);

    // Opex: mission/ground ops, insurance (% of capex/yr), station-keeping.
    // Deliberately NO energy line — free solar is the space advantage.
    var opsStaff = num(inputs, 'opsStaffCount', 20) * num(inputs, 'costPerStaff', 160000);
    var insurance = totalCapex * num(inputs, 'insurancePct', 0.03);
    var stationKeeping = num(inputs, 'stationKeepingAnnual', 2000000);
    var bandwidth = num(inputs, 'bandwidthAnnual', 5000000);
    var maintenanceOverheadPct = num(inputs, 'maintenanceOverheadPct', 0.02);
    var maintenanceOverhead = totalCapex * maintenanceOverheadPct;

    var opexItems = [
      { label: 'Mission & ground operations', amount: opsStaff, capacityLinked: false, growth: 0.03 },
      { label: 'Insurance', amount: insurance, capacityLinked: false, growth: 0.02 },
      { label: 'Maintenance overhead', amount: maintenanceOverhead, capacityLinked: false, growth: 0.02 },
      { label: 'Station-keeping & propellant', amount: stationKeeping, capacityLinked: true, growth: 0.02 }
    ];
    if (bandwidth > 0) opexItems.push({ label: 'Downlink / bandwidth', amount: bandwidth, capacityLinked: true, growth: 0 });
    // Replenishment: to HOLD capacity against decay you must re-launch failed
    // hardware every year. Cost ≈ decayRate × (launch + compute) capex — the
    // fraction of the fleet you replace annually. Fixed (not capacity-linked):
    // it's the price of keeping availability flat.
    if (replenish && degradationRate > 0) {
      var replenishCost = degradationRate * (launchCapex + computeCapex);
      opexItems.push({ label: 'Replenishment (replacement launches)', amount: replenishCost, capacityLinked: false, growth: 0.0 });
    }

    m.capexItems = capexItems;
    m.opexItems = opexItems;
    m.revenueItems = [
      { label: 'Compute (GPU-hours)', amount: computeRevenue, growth: num(inputs, 'priceGrowth', 0) }
    ];
    m.ramp = availabilityCurve(m.years, fillMonths, peakUtilization, degradationRate, replenish);
    m.depreciationLife = num(inputs, 'depreciationLife', 5); // chip-limited satellite life

    var launchShare = totalCapex > 0 ? launchCapex / totalCapex : 0;
    var endAvailability = m.ramp[m.ramp.length - 1];
    m.derived = {
      mw: { label: 'Compute power', value: Format.trimZeros(computeMw.toFixed(1)) + ' MW', help: 'GPU electrical load in orbit' },
      mass: { label: 'Mass to orbit', value: Format.number(Math.round(totalMassKg / 1000)) + ' t', help: 'Total system mass launched' },
      dollarKg: { label: 'Launch cost', value: Format.currency(launchCostPerKg, m.currency) + '/kg', help: 'Assumed price to LEO — the swing variable' },
      launchShare: { label: 'Launch % of capex', value: Format.percent(launchShare), help: 'How launch-dominated the build is' },
      peak: { label: 'Peak availability', value: Format.percent(peakUtilization), help: 'Best-case capacity — never 100% (pointing, eclipse, thermal duty-cycle)' },
      endAvail: { label: replenish ? 'Held (replenished)' : 'Availability at year ' + m.years, value: Format.percent(endAvailability), help: replenish ? 'Capacity held flat by launching replacements' : 'Capacity left after ' + Format.percent(degradationRate) + '/yr degradation with no repair' },
      maintenance: { label: 'Maintenance overhead', value: Format.percent(maintenanceOverheadPct), help: 'Annual non-energy upkeep as a share of orbital capex' },
      allInWatt: { label: 'All-in cost / W', value: Format.currency(totalCapex / Math.max(1, computeMw * 1e6), m.currency, 2), help: 'Total capex per watt of compute' }
    };
    m.notes = [
      'Orbital data center: solar-powered GPUs in LEO. Capex is launch-dominated, so economics track $/kg to orbit.',
      'No energy opex — solar is free and the vacuum is the heatsink (radiative cooling). This is the core space advantage.',
      'Availability peaks at ' + Format.percent(peakUtilization) + ' — never 100% (attitude pointing, eclipse periods, thermal duty-cycle).',
      'Maintenance overhead: ' + Format.percent(maintenanceOverheadPct) + ' of orbital capex per year for non-energy upkeep, spares planning, software, ground procedures and anomaly response.',
      replenish
        ? 'Replenishment ON: capacity held flat by launching ~' + Format.percent(degradationRate) + ' of the fleet each year — recurring opex, no revenue decay.'
        : 'Replenishment OFF: no on-orbit repair, so capacity decays ' + Format.percent(degradationRate) + '/yr (solar degradation + GPU failures). Revenue bends down over the horizon.',
      'Google\'s 2025 study put the break-even vs ground energy near ~$200/kg to LEO; below that, orbit competes.',
      'Short depreciation (~5 yrs) reflects GPU-limited satellite life; on-orbit servicing is still immature.',
      'Figures are estimates from public 2025–26 concepts (Starcloud, Project Suncatcher) — validate before committing capital.'
    ];
    return m;
  }

  // =======================================================================
  //  SCENARIO 2 — SPACEX (merchant launch provider)
  // =======================================================================
  //
  // Scoped to the launch-services business (Falcon 9 today → Starship target).
  // Starlink service revenue is intentionally excluded — modelled separately in
  // the real world and would swamp the launch economics here.
  function computeSpacex(inputs) {
    var m = commonModel(inputs);

    var launchesPerYear = num(inputs, 'launchesPerYear', 150);
    var pricePerLaunch = num(inputs, 'pricePerLaunch', 60000000);
    var marginalCost = num(inputs, 'marginalCostPerLaunch', 20000000);
    var payloadKg = num(inputs, 'payloadPerLaunchKg', 22800);

    var fleetCapex = num(inputs, 'fleetCapex', 3000000000);
    var rdCapex = num(inputs, 'rdCapex', 5000000000);
    var fixedOverhead = num(inputs, 'fixedOverheadPerYear', 2000000000);

    var launchRevenue = launchesPerYear * pricePerLaunch;
    var launchCost = launchesPerYear * marginalCost;

    m.capexItems = [
      { label: 'Vehicle fleet, pads & GSE', amount: fleetCapex },
      { label: 'R&D / vehicle development', amount: rdCapex }
    ];
    m.revenueItems = [
      { label: 'Launch services', amount: launchRevenue, growth: num(inputs, 'cadenceGrowth', 0.10) }
    ];
    m.opexItems = [
      { label: 'Launch marginal cost', amount: launchCost, capacityLinked: true, growth: num(inputs, 'costGrowth', 0.0) },
      { label: 'Fixed overhead & staff', amount: fixedOverhead, capacityLinked: false, growth: 0.03 }
    ];
    // Ramp = cadence ramp: capacity-linked cost and revenue both scale up.
    m.ramp = rampCurve(m.years, num(inputs, 'fillMonths', 12), 1.0);
    m.depreciationLife = num(inputs, 'depreciationLife', 8);

    var grossMargin = launchRevenue > 0 ? (launchRevenue - launchCost) / launchRevenue : 0;
    m.derived = {
      launches: { label: 'Launches / yr', value: Format.number(launchesPerYear), help: 'Steady-state cadence' },
      dollarKg: { label: 'Price / kg', value: Format.currency(payloadKg > 0 ? pricePerLaunch / payloadKg : 0, m.currency) + '/kg', help: 'List price ÷ max payload to LEO' },
      revPerLaunch: { label: 'Revenue / launch', value: Format.currency(pricePerLaunch, m.currency), help: 'List price per flight' },
      grossMargin: { label: 'Launch gross margin', value: Format.percent(grossMargin), help: '(price − marginal cost) ÷ price' }
    };
    m.notes = [
      'SpaceX modelled as a merchant launch provider — launch services only. Starlink service revenue is out of scope.',
      'Falcon 9 anchors: ~$60–67M list, ~22.8 t to LEO (~$2,900/kg), reused-flight marginal cost ~$15–20M, ~170 launches/yr.',
      'Starship preset targets ~$100–200/kg (~$10–30M/flight, 100–150 t) — aspirational, not yet demonstrated.',
      'Revenue grows with cadence; marginal cost is capacity-linked so it scales with the ramp.'
    ];
    return m;
  }

  // =======================================================================
  //  SCENARIO 3 — ROCKET LAB (launch + Space Systems)
  // =======================================================================
  //
  // Two launch vehicles (Electron small-lift, Neutron medium-lift reusable) plus
  // the Space Systems segment, which is now the majority of RKLB revenue. Modelled
  // top-down from a blended gross margin rather than per-flight marginal cost.
  function computeRocketlab(inputs) {
    var m = commonModel(inputs);

    var electronPerYear = num(inputs, 'electronPerYear', 16);
    var electronPrice = num(inputs, 'electronPrice', 7500000);
    var neutronPerYear = num(inputs, 'neutronPerYear', 0);
    var neutronPrice = num(inputs, 'neutronPrice', 52000000);
    var spaceSystems = num(inputs, 'spaceSystemsRevenue', 350000000);

    var grossMargin = num(inputs, 'grossMargin', 0.30);
    var sga = num(inputs, 'sgaPerYear', 120000000);
    var rd = num(inputs, 'rdPerYear', 150000000);
    var capex = num(inputs, 'capex', 400000000);

    var electronRevenue = electronPerYear * electronPrice;
    var neutronRevenue = neutronPerYear * neutronPrice;
    var totalRevenue = electronRevenue + neutronRevenue + spaceSystems;
    var cogs = totalRevenue * (1 - grossMargin);

    m.capexItems = [
      { label: 'Neutron development & production', amount: capex }
    ];
    m.revenueItems = [
      { label: 'Electron launches', amount: electronRevenue, growth: 0.05 },
      { label: 'Neutron launches', amount: neutronRevenue, growth: num(inputs, 'neutronGrowth', 0.20) },
      { label: 'Space Systems', amount: spaceSystems, growth: num(inputs, 'spaceSystemsGrowth', 0.25) }
    ];
    m.opexItems = [
      { label: 'Cost of goods sold', amount: cogs, capacityLinked: true, growth: 0.0 },
      { label: 'SG&A', amount: sga, capacityLinked: false, growth: 0.05 },
      { label: 'Research & development', amount: rd, capacityLinked: false, growth: 0.05 }
    ];
    m.ramp = rampCurve(m.years, num(inputs, 'fillMonths', 12), 1.0);
    m.depreciationLife = num(inputs, 'depreciationLife', 10);

    var totalLaunches = electronPerYear + neutronPerYear;
    m.derived = {
      launches: { label: 'Launches / yr', value: Format.number(totalLaunches), help: 'Electron + Neutron' },
      revenue: { label: 'Revenue (full)', value: Format.currency(totalRevenue, m.currency), help: 'Launch + Space Systems at steady state' },
      ssShare: { label: 'Space Systems %', value: Format.percent(totalRevenue > 0 ? spaceSystems / totalRevenue : 0), help: 'Share of revenue from Space Systems' },
      margin: { label: 'Gross margin', value: Format.percent(grossMargin), help: 'Blended across launch & systems' }
    };
    m.notes = [
      'Rocket Lab (RKLB): Electron + Neutron launch plus the Space Systems segment (now the majority of revenue).',
      'Anchors: Electron ~$7.5M / ~300 kg; Neutron ~$50–55M / ~13 t (~$4,200/kg), first flight ~2026; FY2025 revenue ~$605M.',
      'Modelled top-down from a blended gross margin (~40–50% target) net of SG&A and heavy R&D.',
      'Backlog ~$1.1B provides multi-year revenue visibility; Neutron is expected to flip the company to profit as it ramps.'
    ];
    return m;
  }

  // ---- field groups ------------------------------------------------------

  var constellationGroup = {
    id: 'constellation', label: 'Orbital capacity & mass', icon: '🛰️', scenarios: ['orbital-dc'],
    fields: [
      { key: 'computePowerMw', label: 'Compute power', type: 'number', default: 5, min: 0.1, step: 0.5, unit: 'MW', help: 'GPU electrical load placed in orbit' },
      { key: 'systemMassKgPerMw', label: 'System mass', type: 'number', default: 8000, min: 500, step: 500, unit: 'kg/MW', help: 'GPUs + bus + solar + radiator mass per MW' },
      { key: 'computeHardwarePerMw', label: 'Compute hardware', type: 'currency', prefix: '$', default: 12000000, min: 0, step: 1000000, unit: '/MW', help: 'GPU cost per MW of compute' },
      { key: 'platformCostPerKg', label: 'Platform build cost', type: 'currency', prefix: '$', default: 3000, min: 0, step: 250, unit: '/kg', help: 'Satellite bus, solar & radiator build cost per kg' },
      { key: 'groundSegmentCapex', label: 'Ground segment', type: 'currency', prefix: '$', default: 40000000, min: 0, step: 5000000, help: 'Ground stations, comms & control' }
    ]
  };

  var launchEconGroup = {
    id: 'launch-econ', label: 'Launch economics', icon: '🚀', scenarios: ['orbital-dc'],
    fields: [
      { key: 'launchCostPerKg', label: 'Launch cost', type: 'currency', prefix: '$', default: 500, min: 50, step: 50, unit: '/kg', help: 'Price to LEO — the swing variable (Starship target ~$200, Falcon 9 ~$2,900)' }
    ]
  };

  // Scenario revenue / opex groups.
  var orbitalRevenue = {
    id: 'orbital-rev', label: 'Compute pricing', icon: '🖥️', scenarios: ['orbital-dc'],
    fields: [
      { key: 'sellableUnitsPerMw', label: 'Units / MW', type: 'number', default: 1000, min: 1, step: 10, help: 'Sellable GPU-equivalents per MW (~700 W each)' },
      { key: 'pricePerUnitHour', label: 'Price / unit-hour', type: 'currency', prefix: '$', default: 2.0, min: 0, step: 0.1, unit: '/hr', help: 'Billed rate per GPU-hour' },
      { key: 'priceGrowth', label: 'Price growth', type: 'percent', default: 0.0, min: -0.2, step: 0.5, help: 'Annual price change (compute often deflates)' }
    ]
  };

  var orbitalUtilization = {
    id: 'orbital-util', label: 'Utilization & maintenance', icon: '📈', scenarios: ['orbital-dc'],
    fields: [
      { key: 'soldUtilization', label: 'Billed utilization', type: 'range', percent: true, default: 0.8, min: 0, max: 1, step: 0.01, help: 'Steady-state fraction of available GPU-hours billed' },
      { key: 'peakUtilization', label: 'Peak availability', type: 'percent', default: 0.9, min: 0, max: 1, step: 1, help: 'Best-case usable capacity after eclipse, pointing and thermal duty-cycle limits' },
      { key: 'degradationRate', label: 'Annual degradation', type: 'percent', default: 0.06, min: 0, max: 0.5, step: 0.5, help: 'Annual capacity loss after deployment from solar degradation and hardware failures' },
      { key: 'replenish', label: 'Replenishment', type: 'select', default: 0, options: [{ value: 0, label: 'No - capacity decays' }, { value: 1, label: 'Yes - launch replacements' }], help: 'Whether to add recurring replacement-launch opex to hold capacity flat' },
      { key: 'fillMonths', label: 'Ramp period', type: 'number', default: 18, min: 1, step: 1, unit: 'mo', help: 'Months to reach peak orbital availability' },
      { key: 'maintenanceOverheadPct', label: 'Maintenance overhead', type: 'percent', default: 0.02, min: 0, step: 0.25, help: 'Annual non-energy upkeep as % of orbital capex' }
    ]
  };

  var spaceOpexGroup = {
    id: 'space-opex', label: 'Operating costs', icon: '🛠️', scenarios: ['orbital-dc'],
    fields: [
      { key: 'opsStaffCount', label: 'Ops staff (FTE)', type: 'number', default: 20, min: 0, step: 1, help: 'Mission & ground operations headcount' },
      { key: 'costPerStaff', label: 'Cost / staff', type: 'currency', prefix: '$', default: 160000, min: 0, step: 5000, unit: '/yr', help: 'Fully-loaded annual cost per FTE' },
      { key: 'insurancePct', label: 'Insurance', type: 'percent', default: 0.03, min: 0, step: 0.5, help: 'Annual insurance as % of capex' },
      { key: 'stationKeepingAnnual', label: 'Station-keeping', type: 'currency', prefix: '$', default: 2000000, min: 0, step: 500000, unit: '/yr', help: 'Propellant & orbit maintenance' },
      { key: 'bandwidthAnnual', label: 'Downlink / bandwidth', type: 'currency', prefix: '$', default: 5000000, min: 0, step: 1000000, unit: '/yr', help: 'Ground-link & data egress' }
    ]
  };

  var spacexRevenue = {
    id: 'spacex-rev', label: 'Launch business', icon: '🚀', scenarios: ['spacex'],
    fields: [
      { key: 'launchesPerYear', label: 'Launches / yr', type: 'number', default: 150, min: 1, step: 1, help: 'Steady-state cadence' },
      { key: 'pricePerLaunch', label: 'Price / launch', type: 'currency', prefix: '$', default: 60000000, min: 0, step: 1000000, help: 'List price per flight' },
      { key: 'marginalCostPerLaunch', label: 'Marginal cost / launch', type: 'currency', prefix: '$', default: 20000000, min: 0, step: 1000000, help: 'Incremental cost of one reused flight' },
      { key: 'payloadPerLaunchKg', label: 'Payload / launch', type: 'number', default: 22800, min: 1, step: 100, unit: 'kg', help: 'Max payload to LEO (for $/kg)' },
      { key: 'cadenceGrowth', label: 'Cadence growth', type: 'percent', default: 0.10, min: 0, step: 1, help: 'Annual growth in launch revenue' },
      { key: 'fleetCapex', label: 'Fleet & pads capex', type: 'currency', prefix: '$', default: 3000000000, min: 0, step: 100000000, help: 'Vehicles, pads & ground support' },
      { key: 'rdCapex', label: 'R&D / development', type: 'currency', prefix: '$', default: 5000000000, min: 0, step: 100000000, help: 'Vehicle development (e.g. Starship)' },
      { key: 'fixedOverheadPerYear', label: 'Fixed overhead / yr', type: 'currency', prefix: '$', default: 2000000000, min: 0, step: 100000000, help: 'Staff & fixed operating cost' }
    ]
  };

  var rocketlabRevenue = {
    id: 'rklb-rev', label: 'Launch & Space Systems', icon: '🛰️', scenarios: ['rocketlab'],
    fields: [
      { key: 'electronPerYear', label: 'Electron / yr', type: 'number', default: 16, min: 0, step: 1, help: 'Electron launches per year' },
      { key: 'electronPrice', label: 'Electron price', type: 'currency', prefix: '$', default: 7500000, min: 0, step: 500000, help: 'Price per Electron launch' },
      { key: 'neutronPerYear', label: 'Neutron / yr', type: 'number', default: 0, min: 0, step: 1, help: 'Neutron launches per year (0 until ~2026)' },
      { key: 'neutronPrice', label: 'Neutron price', type: 'currency', prefix: '$', default: 52000000, min: 0, step: 1000000, help: 'Price per Neutron launch' },
      { key: 'neutronGrowth', label: 'Neutron growth', type: 'percent', default: 0.20, min: 0, step: 1, help: 'Annual growth in Neutron revenue' },
      { key: 'spaceSystemsRevenue', label: 'Space Systems / yr', type: 'currency', prefix: '$', default: 350000000, min: 0, step: 25000000, help: 'Satellite & components segment revenue' },
      { key: 'spaceSystemsGrowth', label: 'Space Systems growth', type: 'percent', default: 0.25, min: 0, step: 1, help: 'Annual growth in Space Systems' },
      { key: 'grossMargin', label: 'Gross margin', type: 'percent', default: 0.30, min: 0, max: 1, step: 1, help: 'Blended gross margin across segments' },
      { key: 'sgaPerYear', label: 'SG&A / yr', type: 'currency', prefix: '$', default: 120000000, min: 0, step: 10000000, help: 'Selling, general & admin' },
      { key: 'rdPerYear', label: 'R&D / yr', type: 'currency', prefix: '$', default: 150000000, min: 0, step: 10000000, help: 'Research & development' },
      { key: 'capex', label: 'Capex', type: 'currency', prefix: '$', default: 400000000, min: 0, step: 25000000, help: 'Neutron development & production capex' }
    ]
  };

  var financeGroup = {
    id: 'finance', label: 'Financing, tax & horizon', icon: '💰',
    fields: [
      { key: 'horizonYears', label: 'Model horizon', type: 'number', default: 10, min: 1, max: 30, step: 1, unit: 'yrs', help: 'Projection length' },
      { key: 'debtFraction', label: 'Debt financing', type: 'percent', default: 0.3, min: 0, max: 1, step: 5, help: 'Share of capex funded by debt' },
      { key: 'interestRate', label: 'Interest rate', type: 'percent', default: 0.07, min: 0, step: 0.25, help: 'Annual loan interest rate' },
      { key: 'loanTermYears', label: 'Loan term', type: 'number', default: 10, min: 1, max: 30, step: 1, unit: 'yrs', help: 'Amortization period' },
      { key: 'depreciationLife', label: 'Depreciation life', type: 'number', default: 5, min: 1, max: 40, step: 1, unit: 'yrs', help: 'Straight-line asset life' },
      { key: 'taxRate', label: 'Tax rate', type: 'percent', default: 0.21, min: 0, max: 0.6, step: 1, help: 'Corporate income tax rate' },
      { key: 'discountRate', label: 'Discount rate (WACC)', type: 'percent', default: 0.12, min: 0, step: 0.5, help: 'Hurdle rate for NPV / IRR' }
    ]
  };

  // ---- domain config -----------------------------------------------------
  var config = {
    id: 'spacedc',
    name: 'Space Datacenter',
    tagline: 'Model orbital data-center economics and the launch businesses (SpaceX, Rocket Lab) they ride on.',
    currency: 'USD',
    scenarios: [
      { id: 'orbital-dc', name: 'Orbital data center', description: 'Solar-powered GPUs in orbit; capex is launch-dominated, so economics track $/kg to LEO.' },
      { id: 'spacex', name: 'SpaceX (launch)', description: 'Merchant launch provider — Falcon 9 today, Starship target. Launch services only.' },
      { id: 'rocketlab', name: 'Rocket Lab', description: 'Electron + Neutron launch plus the Space Systems segment.' }
    ],
    groups: [
      constellationGroup, launchEconGroup, orbitalRevenue, orbitalUtilization, spaceOpexGroup,
      spacexRevenue, rocketlabRevenue, financeGroup
    ],
    presets: [
      { id: 'odc-starship', label: 'Orbital DC — Starship ($200/kg)', scenarios: ['orbital-dc'], values: { computePowerMw: 5, launchCostPerKg: 200, systemMassKgPerMw: 8000, soldUtilization: 0.8, pricePerUnitHour: 2.0, depreciationLife: 5, discountRate: 0.12 } },
      { id: 'odc-falcon', label: 'Orbital DC — Falcon 9 ($2,900/kg)', scenarios: ['orbital-dc'], values: { computePowerMw: 5, launchCostPerKg: 2900, systemMassKgPerMw: 8000, soldUtilization: 0.8, pricePerUnitHour: 2.0, depreciationLife: 5, discountRate: 0.12 } },
      { id: 'spacex-f9', label: 'SpaceX — Falcon 9 era', scenarios: ['spacex'], values: { launchesPerYear: 150, pricePerLaunch: 60000000, marginalCostPerLaunch: 20000000, payloadPerLaunchKg: 22800, depreciationLife: 8 } },
      { id: 'spacex-starship', label: 'SpaceX — Starship era', scenarios: ['spacex'], values: { launchesPerYear: 100, pricePerLaunch: 30000000, marginalCostPerLaunch: 10000000, payloadPerLaunchKg: 100000, depreciationLife: 8 } },
      { id: 'rklb-2025', label: 'Rocket Lab — 2025 actual', scenarios: ['rocketlab'], values: { electronPerYear: 16, electronPrice: 7500000, neutronPerYear: 0, spaceSystemsRevenue: 350000000, grossMargin: 0.28, depreciationLife: 10 } },
      { id: 'rklb-neutron', label: 'Rocket Lab — Neutron ramp', scenarios: ['rocketlab'], values: { electronPerYear: 20, electronPrice: 8000000, neutronPerYear: 8, neutronPrice: 52000000, spaceSystemsRevenue: 600000000, grossMargin: 0.40, depreciationLife: 10 } }
    ],
    compute: function (inputs, scenarioId) {
      switch (scenarioId) {
        case 'spacex': return computeSpacex(inputs);
        case 'rocketlab': return computeRocketlab(inputs);
        case 'orbital-dc':
        default: return computeOrbitalDc(inputs);
      }
    }
  };

  global.SPACEDC_DOMAIN = config;
  // Register into the generic domain registry so app.js can list domains.
  global.DOMAINS = global.DOMAINS || {};
  global.DOMAINS.spacedc = config;
})(typeof window !== 'undefined' ? window : this);
