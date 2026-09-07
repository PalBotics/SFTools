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

1. **M1 — baseline (done, tag `m1-baseline`):** clone, `env.ts`, build & run
   against the public API, anonymous local plans, client-side solve verified.
2. **M2 — parallel pool (done):** folder-level. Coarse; still useful for
   genuinely separate factories sharing a node. See "M2 as built".
3. **M3 — buffered capacity, in-plan (in progress):** the real model. Each
   line inside a plan sized to consume 100% of its upstream buffers. See
   "M3 — buffered capacity" below.
4. **M4 — blueprints:** hand-entered production units, whole-unit counts.
5. **M5 — polish:** overview copy, per-line "full-tilt rate" readouts.

## M3 — buffered capacity

**Decided with the user:** the branches that run in parallel are *component
lines inside one plan*, not sibling plans. A mid-tree item (Iron Ingot) is a
**buffer**; every line consuming it is sized to draw its full output,
recursively. A line with several buffered inputs is sized by the **least
generous** one (min).

Not an LP - a deterministic propagation over the recipe graph:

```
target(recipe)       = min over ingredients of  bufferCapacity(ingredient)
                                                ─────────────────────────
                                                consumed / machine·minute
bufferCapacity(item) = raw supply + Σ producers' output
```

A buffer with N consumers feeds each the full capacity: combined draw exceeds
production by design (storage absorbs it; any line can run flat out to
refill). Solved by relaxation (recompute targets ← capacities ← targets until
settled); byproduct loops settle to a fixpoint or warn.

Worked example, one 240 ore/min node, everything buffered:

| line | sized by | target (machines @100%) | output |
|---|---|---|---|
| Iron Ingot | 240 ore | 8 | 240/min |
| Iron Plate | 240 ingot | 8 | 160/min |
| Iron Rod | 240 ingot | 16 | 240/min |
| Screw | 240 rod | 24 | 960/min |
| Reinforced Iron Plate | 160 plate (min, vs 960 screw) | 5.33 | 80/min |

### M3 milestones

- **M3a (done):** `CapacityPropagator` - the pure engine + spec.
- **M3b + M3c (done):** end-to-end, buffer-all.
  - `PlanSettings.sizing: 'balanced' | 'capacity'` (absent = balanced).
    Calculator ▸ Recalculate split-button menu ▸ **Sizing** ▸ Balanced /
    Buffered capacity.
  - `CapacityResizeService` - after the LP solve, turns the graph into a
    `CapacityGraph` (rates via `Formulas.referenceCycles`), propagates,
    rebuilds every `RecipeNode` at the new target (groups via
    `MachineGroupNormalizer`), re-amounts Mine / Product / Byproduct nodes.
    Sources = the plan's effective Resources-tab limits; an unlimited raw
    resource falls back to the balanced mined amount + a warning.
  - Buffers = every item both produced and consumed in the graph.
    `GraphEdgeBuilder.build(nodes, prior, bufferedItems)` gives each
    consumer of a buffer its full-draw edge (deliberately over the
    producer's output).
  - Wired in `PlannerComponent.calculate` (automatic / fresh path).
    Overview / build cost / power read the resized graph for free.
- **M3d (next):** buffer nodes visually distinct + "feeds N lines"
  annotation; per-item direct (non-buffer) override + right-click toggle;
  capacity sizing in the manual-append / upgrade / locked-node graph paths
  (v1 only does the fresh/automatic path); byproduct-loop and somersloop
  handling; miner tier / purity → source rate.

## M2 as built

`Folder.resourcePoolMode?: 'shared' | 'parallel'` (absent = `shared`), stored
next to `resourcePool` in all three backends (local, API, share).

- **`ResourcePoolService.effectiveLimits`** — in `parallel` mode a plan is not
  reduced by its siblings' extraction; it sees the folder's full limit.
  `status()` / `overUsed()` report no contention (`parallel` flag added to
  `PoolResourceStatus`).
- **`PlanManager`** — `resourcePoolModeOf(plan)`, `setResourcePoolMode(folderId,
  mode)` (flags inner plans for recalculation); leaving pool clears the mode.
- **`FolderOverviewService`** — in `parallel` mode the folder totals are the
  branches' **envelope**, not their sum:
  - resources, production: `max` per item across plans
  - recipes: `max` per recipe className (a recipe every branch runs collapses
    to one; different recipes stay separate → effectively summed)
  - buildings: **derived from the enveloped recipe rows**, grouped by
    producing building, so shared machine types count once and same-machine
    different-recipe still adds up. Generators are omitted from this view.
  - power / shards / sloops: envelope (`max` per plan)
  - `FolderOverview.parallelPool` flags it for the UI.
- **UI** — Calculator ▸ Resources, when pooled: a `Shared` / `Parallel`
  toggle (`CalculatorComponent.setResourcePoolMode`). Lock-note and folder
  summaries say "parallel pool".

Not yet done: the Resources tab share-bars and the Overview panel still use
"shared pool" phrasing/visuals in parallel mode (functionally harmless —
`usedByOthers` is 0). Blueprint units (M3). Per-branch "full-tilt rate"
callout.

Tests (`npm test`, vitest — fork-only, not in `angular.json`):
`ResourcePoolService.spec.ts`, `FolderOverviewService.spec.ts` cover the
worked iron rod/plate example (8 Smelter + 18 Constructor envelope).

## Saving work / running the fork

- **Run it:** `.\run.ps1` from the repo root (builds, serves the production
  build at http://localhost:4200 with no-cache + SPA fallback). `-Dev` for
  the hot-reload server, `-NoBuild` to skip the rebuild.
- **Sign-in on localhost bounces to production** - the OAuth callback URLs
  are registered for `new.satisfactorytools.com` and we don't run the
  backend. To use an account on localhost, copy the four `auth.*`
  localStorage keys from a `new.satisfactorytools.com` tab into the
  `localhost:4200` tab (see the session notes / CLAUDE.md).
- **Persistence:** signed-in plans auto-sync to the account
  (`api.new.satisfactorytools.com`) - same store as production.
  `PlanApiDataBackend.hydratePlan` now reads back `settings.sizing` (it was
  saved but dropped on reload before). Anonymous plans live in
  `localStorage` for the `localhost:4200` origin only.
- **Do capacity work on localhost only.** Production has no `sizing` field:
  opening a capacity plan there is harmless (renders balanced), but saving
  an edit there strips the setting. `Share…` (right-click a plan) makes a
  server snapshot that survives regardless - a good checkpoint for complex
  plans.

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
