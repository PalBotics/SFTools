# Capacity Provisioning Planning — design notes

Fork feature. Not upstream. Tracked on branch `capacity-planning`.

## Goal

Support a build strategy where each production line is sized so it *could*
consume 100% of its available upstream resource, rather than sized to the
steady-state amount a balanced factory would need.

Example: one pure iron node + Mk2 miner = 240 ore/min → 240 ingot/min. That
ingot stream feeds a rod line (240 ingot → 240 rod/min) **and** a plate line
(240 ingot → 160 plate/min). The strategy builds **both** lines at full size
(6 constructors for rods, ~12 for plates), even though the 240 ingot/min can
only feed one of them at a time. Storage buffers decouple the branches: a
branch idles when its buffer is full and spins up to max to refill it. The
branches never all peak simultaneously, so provisioning each for its own peak
is the intent, not a mistake.

The stock planner cannot express this — its LP enforces mass balance, so a
split always divides supply to meet the *sum* of downstream demand.

## Two mechanisms

### 1. Parallel resource pool (folders)

Folders already support a **shared** raw-resource pool: sibling plans draw
from one budget, and each plan only gets what the others left
(`ResourcePoolService.effectiveLimits` subtracts `usageByOthers`). That is
sequential division — AND semantics.

Add a **parallel** pool mode:

- Folder gains a pool mode: `shared` (current) vs `parallel` (new). Stored
  alongside `resourcePool` in the folder's opaque `data` JSON (e.g.
  `resourcePoolMode`, absent = `shared`).
- In `parallel` mode, `effectiveLimits(plan)` returns the folder's full
  limit for every pooled resource — every plan is planned as if it alone
  owns the whole node.
- `ResourcePoolService.overUsed()` / over-use warnings are suppressed in
  `parallel` mode (no contention by definition).
- Each sub-factory is its own plan in the folder, typically set to
  `maximise` its product (the "run at full capacity" intent). `rate` plans
  also work.

**Folder overview aggregation** (`FolderOverviewService`) in `parallel` mode:
aggregate buildings / recipes / resources / production / power by **max per
key across plans** (the envelope — the hungriest single branch), not by sum.
Optionally also surface the sum as an "if every branch ran at once" figure.

Why max-per-key is correct: each plan is a complete raw→product factory for
its own max scenario. Shared upstream steps (mining, smelting) appear in
every plan at that plan's peak need; the real build only needs to cover the
largest. Downstream steps are recipe-distinct per branch (rod constructors vs
plate constructors), so max leaves each at its own full size.

### 2. Blueprints

A blueprint is a hand-entered production unit: a small plan the user marks as
a blueprint and annotates with its real in-game capacity (e.g. "Iron Plate
BP = 8 Constructors, 60 plate/min, consumes 90 ingot/min, 32 MW").

- Built on the existing **subplan** mechanism (`SubplanNode` — a plan
  embedded in another as a locked, fixed-IO node). Today the multiplier is
  hard-coded to 1 (`super(id, 1)`).
- Add an integer multiplier: LP column `blueprint_<id>` constrained
  `>= 0`, `General` (integer); item balance contributions are
  `count × per-unit IO`.
- The planner reports **whole blueprint counts + spare capacity**
  ("3 × Iron Plate BP → 180/min capacity, 160/min used, 20 spare"), not
  fractional machines.

## Build order

1. **M1 — baseline (in progress):** clone, `env.ts`, build & run against the
   public API, confirm anonymous local plans work. Add first solver tests.
2. **M2 — parallel pool:** folder pool mode + `effectiveLimits` + folder
   overview aggregation + UI toggle. This is the smallest change that makes
   the strategy expressible.
3. **M3 — blueprints:** subplan multiplier + integer LP column + whole-unit
   reporting + blueprint editor UI.
4. **M4 — polish:** overview "envelope vs simultaneous" view, per-branch
   full-tilt rate readout, docs.

## Architecture reference (upstream, as of `f4367af`)

- Angular 22 standalone. AntV X6 graph. HiGHS LP solver in a web worker
  (`SolverWorker.ts` / `SolverService.ts`).
- LP assembled as CPLEX-LP text in
  `ProductionSolverService.buildLp()`. Item rows: Σ(produced − consumed)
  − `@Byproduct` − `@Product` − `@Maximise` = 0. `@Product = n` bounds set
  fixed targets. Raw resources capped `<class>@Mine <= limit`.
- `maximise` mode runs iterative max-min fairness rounds
  (`runMaximiseRounds`), subtracting each round's leftovers — the engine M2
  leans on for "each branch at full capacity".
- Locked nodes / subplans become fixed LP columns (`= 1` in Bounds).
- Data (recipes/items) comes from `env.apiUrl` (`api.new.satisfactorytools.com`).
  Plans can be stored purely locally (`LocalPlanStoreBackend`); no account
  required.

## Notes / risks

- Upstream has **no LICENSE file** — all rights reserved by default. Fine for
  a private local fork; ask the maintainers before publishing a deployment.
  The game asset icons are Coffee Stain's regardless.
- Angular CLI requires Node ≥ 22.22.3 / 24.15 / 26. Dev machine had 22.19.0
  at M1 — must bump before the build runs.
