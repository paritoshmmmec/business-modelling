# Business Modelling

Interactive, **client-side-only** financial models for capital-intensive
businesses. The first domain is a **datacenter** cost/profit calculator with
four selectable business models; the code is a small, config-driven framework
so new domains are mostly a config file.

Open `index.html` in any browser — no build step, no server, nothing is sent
anywhere. All math runs locally.

- **Live app:** `index.html`
- **Test suite:** `tests.html` (or `node run-tests.js`)

## The datacenter model

Pick a business model from the top of the sidebar:

| Model | Who makes money, how | Revenue driver |
|-------|----------------------|----------------|
| **Colocation** | Rent racks, resell power at a markup, charge for cross-connects | racks × price + power margin |
| **Compute reseller** | Sell VM / GPU hours off hardware you own | units × price/hr × utilization |
| **Enterprise self-build** | Build for your own workloads; "revenue" = public-cloud spend avoided (TCO) | cloud cost avoided |
| **Wholesale / hyperscale** | Lease whole halls at $/kW/month to big tenants (triple-net) | IT kW × $/kW/mo |

All four share one projection engine, so every model produces the same rich
output: capex/opex breakdown, a year-by-year P&L and cash-flow table, and the
standard investment KPIs — **NPV, IRR (project & equity), payback, discounted
payback, ROI, and margins** — plus charts (revenue vs. profit, cost stack,
cumulative cash flow with a break-even marker).

Everything is driven from a handful of physical inputs (IT load in MW, PUE, rack
density, build cost per watt) and financial assumptions (debt %, interest,
depreciation life, tax, discount rate). Use the **preset chips** for realistic
starting points (small/large colo, GPU cloud, VM cloud, enterprise, hyperscale
hall).

Extras: **currency selector**, **CSV export**, and a **Share** button that packs
all your inputs into the URL so a link reproduces the exact model.

## Architecture

Plain ES5-style global scripts loaded with `<script>` tags — deliberately **no
framework and no build** (see below for why). Layered so the domain-agnostic
core is reusable:

```
index.html              main app
tests.html              in-browser test runner
run-tests.js            Node runner for the same tests (CI-friendly)
netlify.toml            static hosting config

css/styles.css          professional dark theme

js/format.js            currency / percent / number formatting        (pure)
js/finance.js           depreciation, amortization, NPV, IRR, payback  (pure)
js/engine.js            projection engine: model → P&L, cash flow, KPIs (pure)
js/charts.js            dependency-free SVG charts
js/ui.js                config-driven form + results renderer (DOM)
js/app.js               boot, currency, URL-state sharing, CSV export
js/tests.js             assertion suite (runs in browser or Node)

domains/datacenter.js   the datacenter domain: 4 scenarios + field defs
```

The dependency direction is one-way: `format → finance → engine → charts/ui →
app`. `format`, `finance` and `engine` have **no DOM dependencies**, which is why
the same test file runs headlessly under Node.

### The model contract

A domain's `compute(inputs, scenarioId)` returns a normalized model object; the
engine projects it. Nothing datacenter-specific lives in the engine:

```js
{
  currency: 'USD',
  years: 10,
  capexItems:   [{ label, amount }],
  revenueItems: [{ label, amount, growth }],      // amount = fully-ramped value
  opexItems:    [{ label, amount, growth, capacityLinked }],
  ramp:         [0.6, 0.85, 1.0, ...],            // per-year utilization
  financing:    { debtFraction, interestRate, termYears },
  depreciationLife: 15,
  taxRate: 0.21,
  discountRate: 0.10,
  derived: { ... },                               // display-only chips
  notes: [ ... ]
}
```

`capacityLinked` opex scales with the ramp (e.g. power for live racks); other
opex is fixed from year 1 (staff, insurance).

## Adding a new business domain

1. Create `domains/<name>.js`. Define:
   - `scenarios` — the selectable business models (tabs).
   - `groups` → `fields` — the inputs (with `scenarios`/`showIf` for visibility).
   - `presets` — one-click realistic starting points.
   - `compute(inputs, scenarioId)` — returns the model object above.
2. Register it: `window.DOMAINS['<name>'] = config;` (the datacenter file shows
   the pattern).
3. Add its `<script>` to `index.html`, and open `index.html?domain=<name>`.

No engine, chart, or renderer changes needed — that's the point of the split.

## Field types

`number`, `currency` (adds a `$`/symbol prefix), `percent` (stored as a decimal,
shown as whole %), `select`, and `range`. Each field: `key, label, type,
default, min, max, step, unit, prefix, help`, optional `options` (for select),
and optional `scenarios` / `showIf(inputs)` for conditional visibility.

## Tests

31 assertions cover the finance math (depreciation, amortization reconciliation,
NPV/IRR consistency, payback interpolation), the engine (P&L integrity, debt
split, ramp scaling, NPV sign), and every datacenter scenario.

```bash
node run-tests.js        # headless, sets exit code (CI)
# or open tests.html in a browser
```

## Deploying (Netlify)

It's a static site with no build. `netlify.toml` sets `publish = "."` and an
empty build command, so Netlify serves the repo root directly. Just connect the
repo (or drag-and-drop the folder) — `index.html` is the entry point.

## Disclaimer

Figures are estimates for planning and comparison. Defaults are mid-market
ballparks — **validate against real quotes before committing capital.**
