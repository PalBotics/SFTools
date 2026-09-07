import {CapacityGraph, CapacityRecipe, CapacityResult} from '@src/Model/Planner/Capacity/CapacityGraph';

/**
 * Fork feature - "buffered capacity" planning (see docs/capacity-planning.md).
 *
 * Sizes every recipe line to consume 100% of its upstream buffers, instead of
 * mass-balancing supply against demand. The rule:
 *
 *   target(recipe) = min over ingredients of  bufferCapacity(ingredient)
 *                                             ─────────────────────────
 *                                             consumed per machine·min
 *
 *   bufferCapacity(item) = raw supply + Σ producers' output
 *
 * A buffer with several consumers feeds each of them its full capacity, so
 * the lines' combined draw exceeds production on purpose - storage between
 * them absorbs the mismatch, and any line can run flat out to refill.
 *
 * Solved by relaxation: recompute every target from the current buffer
 * capacities, then the capacities from the new targets, until nothing moves.
 * Acyclic graphs converge in (chain depth) rounds; byproduct loops settle to
 * a fixpoint or trip the non-convergence warning.
 */
export class CapacityPropagator
{

	private static readonly MAX_ROUNDS = 200;

	/** A change below this (items/min, or machine-equivalents) counts as settled. */
	private static readonly EPSILON = 1e-7;

	public propagate(graph: CapacityGraph): CapacityResult
	{
		const warnings: string[] = [];
		const producers = new Map<string, CapacityRecipe[]>();
		const consumers = new Map<string, CapacityRecipe[]>();
		for (const recipe of graph.recipes) {
			for (const product of recipe.products) {
				push(producers, product.itemClassName, recipe);
			}
			for (const ingredient of recipe.ingredients) {
				push(consumers, ingredient.itemClassName, recipe);
			}
		}

		// A non-buffered item shared by several lines would need a real split;
		// M3a always replicates (each line gets the full buffer). Flag it.
		for (const item of graph.directItems ?? []) {
			if ((consumers.get(item)?.length ?? 0) > 1) {
				warnings.push(`"${item}" is marked direct but feeds ${consumers.get(item)!.length} lines - treated as a buffer for now.`);
			}
		}

		const targets: Record<string, number> = {};
		for (const recipe of graph.recipes) {
			targets[recipe.id] = 0;
		}
		let itemCapacity = this.capacities(graph, producers, targets);

		let round = 0;
		let moved = Infinity;
		while (moved > CapacityPropagator.EPSILON && round < CapacityPropagator.MAX_ROUNDS) {
			moved = 0;
			for (const recipe of graph.recipes) {
				const next = this.targetFor(recipe, itemCapacity);
				moved = Math.max(moved, Math.abs(next - targets[recipe.id]));
				targets[recipe.id] = next;
			}
			const nextCapacity = this.capacities(graph, producers, targets);
			for (const item of Object.keys(nextCapacity)) {
				moved = Math.max(moved, Math.abs(nextCapacity[item] - (itemCapacity[item] ?? 0)));
			}
			itemCapacity = nextCapacity;
			round++;
		}

		if (moved > CapacityPropagator.EPSILON) {
			warnings.push('Capacity did not settle - a byproduct loop may be unbounded. Showing the last estimate.');
		}

		for (const recipe of graph.recipes) {
			if (targets[recipe.id] < CapacityPropagator.EPSILON && recipe.ingredients.length > 0) {
				const missing = recipe.ingredients
					.filter(io => (itemCapacity[io.itemClassName] ?? 0) < CapacityPropagator.EPSILON)
					.map(io => io.itemClassName);
				if (missing.length > 0) {
					warnings.push(`Recipe ${recipe.id} gets nothing - no supply of ${[...new Set(missing)].join(', ')}.`);
				}
			}
		}

		const itemDemand: Record<string, number> = {};
		for (const recipe of graph.recipes) {
			for (const ingredient of recipe.ingredients) {
				itemDemand[ingredient.itemClassName] = (itemDemand[ingredient.itemClassName] ?? 0)
					+ targets[recipe.id] * ingredient.perMachineMinute;
			}
		}

		return {targets, itemCapacity, itemDemand, warnings};
	}

	/** min over ingredients of (available buffer / consumed per machine·minute). */
	private targetFor(recipe: CapacityRecipe, itemCapacity: Record<string, number>): number
	{
		if (recipe.ingredients.length === 0) {
			return 0;
		}
		let limit = Infinity;
		for (const ingredient of recipe.ingredients) {
			if (ingredient.perMachineMinute <= 0) {
				continue;
			}
			limit = Math.min(limit, (itemCapacity[ingredient.itemClassName] ?? 0) / ingredient.perMachineMinute);
		}
		return isFinite(limit) ? limit : 0;
	}

	private capacities(
		graph: CapacityGraph,
		producers: Map<string, CapacityRecipe[]>,
		targets: Record<string, number>,
	): Record<string, number>
	{
		const capacity: Record<string, number> = {...graph.sources};
		for (const [item, recipes] of producers) {
			let total = capacity[item] ?? 0;
			for (const recipe of recipes) {
				for (const product of recipe.products) {
					if (product.itemClassName === item) {
						total += targets[recipe.id] * product.perMachineMinute;
					}
				}
			}
			capacity[item] = total;
		}
		return capacity;
	}

}

function push<T>(map: Map<string, T[]>, key: string, value: T): void
{
	const list = map.get(key);
	if (list) {
		list.push(value);
	} else {
		map.set(key, [value]);
	}
}
