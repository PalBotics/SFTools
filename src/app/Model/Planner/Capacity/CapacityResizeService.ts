import {Injectable} from '@angular/core';
import {Formulas} from '@src/Model/Planner/Formulas';
import {GroupingMode} from '@src/Model/Planner/GroupingMode';
import {Item} from '@src/Model/Data/Entities/Item';
import {MachineGroupNormalizer} from '@src/Model/Planner/MachineGroupNormalizer';
import {CapacityGraph, CapacityRecipe} from '@src/Model/Planner/Capacity/CapacityGraph';
import {CapacityPropagator} from '@src/Model/Planner/Capacity/CapacityPropagator';
import {SolverResponse} from '@src/Model/Planner/Solver/Response/SolverResponse';
import {Node} from '@src/Model/Planner/Solver/Response/Node';
import {RecipeNode} from '@src/Model/Planner/Solver/Response/RecipeNode';
import {MineNode} from '@src/Model/Planner/Solver/Response/MineNode';
import {InputNode} from '@src/Model/Planner/Solver/Response/InputNode';
import {ProductNode} from '@src/Model/Planner/Solver/Response/ProductNode';
import {ByproductNode} from '@src/Model/Planner/Solver/Response/ByproductNode';

/** The bit of PlanInput this service needs - avoids importing the full Plan model tree. */
export interface CapacitySourceInput
{
	readonly itemClassName: string;
	readonly amount: number;
}

export interface CapacityResizeResult
{
	readonly response: SolverResponse;
	/** Item classes treated as buffers - the graph edge builder over-commits these. */
	readonly bufferedItems: Set<string>;
	readonly warnings: string[];
}

/**
 * Fork feature. Rewrites a mass-balanced solver result so every line is
 * sized to consume 100% of its upstream buffers (see CapacityPropagator and
 * docs/capacity-planning.md § "M3 - buffered capacity").
 *
 * The LP result still decides which recipes, machines and structure to use;
 * this only replaces the per-node rates. Non-recipe nodes are re-amounted
 * from the propagation, generators and sinks pass through untouched.
 */
@Injectable({providedIn: 'root'})
export class CapacityResizeService
{

	private readonly propagator = new CapacityPropagator();

	public constructor(private readonly normalizer: MachineGroupNormalizer)
	{
	}

	/**
	 * @param resourceLimits per-minute caps by raw-resource class (the plan's
	 *        effective Resources-tab limits). A raw resource with no finite
	 *        limit falls back to the balanced solve's mined amount, with a
	 *        warning - capacity sizing needs a number to size against.
	 * @param planInputs the plan's configured Input-tab sources. Treated as
	 *        fully available regardless of what the balanced solve actually
	 *        drew from them - a costed input the LP found cheaper to route
	 *        around (and so dropped from the graph entirely) is still real
	 *        supply capacity sizing should use. A plan input feeding nothing
	 *        in this graph is silently ignored, not added as a stray node.
	 */
	public apply(
		response: SolverResponse,
		resourceLimits: Record<string, number>,
		groupingMode: GroupingMode,
		planInputs: readonly CapacitySourceInput[] = [],
	): CapacityResizeResult
	{
		const recipeNodes = response.nodes.filter((node): node is RecipeNode => node instanceof RecipeNode);
		if (recipeNodes.length === 0) {
			return {response, bufferedItems: new Set(), warnings: []};
		}

		const warnings: string[] = [];
		const sources: Record<string, number> = {};

		for (const node of response.nodes) {
			if (node instanceof MineNode) {
				const limit = resourceLimits[node.item.className];
				if (limit !== undefined && isFinite(limit) && limit > 0) {
					sources[node.item.className] = (sources[node.item.className] ?? 0) + limit;
				} else {
					sources[node.item.className] = (sources[node.item.className] ?? 0) + node.amount;
					warnings.push(`${node.item.name} has no limit set - sizing against the balanced ${round(node.amount)}/min. Set a limit in the Resources tab.`);
				}
			}
		}

		// The plan's own configured amount is the cap - not whatever (if
		// anything) the balanced solve happened to draw from it.
		const inputByItem = new Map<string, number>();
		for (const input of planInputs) {
			if (input.itemClassName && input.amount > 0) {
				inputByItem.set(input.itemClassName, (inputByItem.get(input.itemClassName) ?? 0) + input.amount);
				sources[input.itemClassName] = (sources[input.itemClassName] ?? 0) + input.amount;
			}
		}

		const graph: CapacityGraph = {recipes: recipeNodes.map(node => this.toCapacityRecipe(node)), sources};
		const result = this.propagator.propagate(graph);
		warnings.push(...result.warnings);

		// Intermediates: produced and consumed inside the graph. These are the
		// buffers the edge builder is allowed to over-commit.
		const produced = new Set<string>();
		const consumed = new Set<string>();
		for (const node of recipeNodes) {
			node.recipe.products.forEach(p => produced.add(p.item.className));
			node.recipe.ingredients.forEach(i => consumed.add(i.item.className));
		}
		const bufferedItems = new Set([...produced].filter(item => consumed.has(item)));

		const nodes: Node[] = response.nodes.map(node => this.resizeNode(node, result, groupingMode, inputByItem));

		// A plan input the balanced solve used $0 of (so filtered out of the
		// solved graph entirely) still needs a node here to carry its edges -
		// only when something in the graph actually consumes that item.
		const covered = new Set(nodes.filter((n): n is InputNode => n instanceof InputNode).map(n => n.item.className));
		const itemLookup = new Map<string, Item>();
		recipeNodes.forEach(node => node.recipe.ingredients.forEach(i => itemLookup.set(i.item.className, i.item)));
		for (const [itemClassName, amount] of inputByItem) {
			if (covered.has(itemClassName) || !consumed.has(itemClassName)) {
				continue;
			}
			const item = itemLookup.get(itemClassName);
			if (item) {
				nodes.push(new InputNode(crypto.randomUUID(), amount, item));
			}
		}

		return {response: {...response, nodes}, bufferedItems, warnings: [...new Set(warnings)]};
	}

	private toCapacityRecipe(node: RecipeNode): CapacityRecipe
	{
		const cycles = Formulas.referenceCycles(node.recipe, node.machine);
		return {
			id: node.id,
			ingredients: node.recipe.ingredients.map(i => ({itemClassName: i.item.className, perMachineMinute: i.amount * cycles})),
			products: node.recipe.products.map(p => ({itemClassName: p.item.className, perMachineMinute: p.amount * cycles})),
		};
	}

	private resizeNode(
		node: Node,
		result: {targets: Record<string, number>; itemCapacity: Record<string, number>; itemDemand: Record<string, number>},
		groupingMode: GroupingMode,
		inputByItem: Map<string, number>,
	): Node
	{
		if (node instanceof RecipeNode) {
			const target = result.targets[node.id] ?? 0;
			const resized = new RecipeNode(
				node.id,
				target,
				this.normalizer.generate(target, 100, 0, node.groupingMode ?? groupingMode),
				node.machine,
				node.recipe,
			);
			return carryOver(resized, node);
		}
		if (node instanceof MineNode) {
			return carryOver(new MineNode(node.id, result.itemCapacity[node.item.className] ?? node.amount, node.item), node);
		}
		if (node instanceof ProductNode) {
			return carryOver(new ProductNode(node.id, result.itemCapacity[node.item.className] ?? node.amount, node.item), node);
		}
		if (node instanceof ByproductNode) {
			const leftover = (result.itemCapacity[node.item.className] ?? 0) - (result.itemDemand[node.item.className] ?? 0);
			return carryOver(new ByproductNode(node.id, Math.max(0, leftover), node.item), node);
		}
		if (node instanceof InputNode) {
			// Show the plan's full configured cap, not whatever slice (if any)
			// the balanced solve chose to draw from it.
			const cap = inputByItem.get(node.item.className);
			return cap === undefined ? node : carryOver(new InputNode(node.id, cap, node.item), node);
		}
		// GeneratorNode, SinkNode: unchanged.
		return node;
	}

}

/** Copy position and flags (and grouping mode) from the old node onto its resized replacement. */
function carryOver<T extends Node>(next: T, prev: Node): T
{
	next.x = prev.x;
	next.y = prev.y;
	next.locked = prev.locked;
	next.done = prev.done;
	if (next instanceof RecipeNode && prev instanceof RecipeNode) {
		next.groupingMode = prev.groupingMode;
	}
	return next;
}

function round(value: number): string
{
	return (Math.round(value * 100) / 100).toString();
}
