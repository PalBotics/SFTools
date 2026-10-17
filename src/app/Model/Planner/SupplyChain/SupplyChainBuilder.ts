import {Item} from '@src/Model/Data/Entities/Item';
import {PlanInput} from '@src/Model/Planner/PlanInput';
import {SupplyChainProducer, SupplyChainRow} from '@src/Model/Planner/SupplyChain/SupplyChainRow';
import {Node} from '@src/Model/Planner/Solver/Response/Node';
import {RecipeNode} from '@src/Model/Planner/Solver/Response/RecipeNode';

interface Accumulator
{
	item: Item;
	required: number;
	output: number;
	mined: number;
	external: number;
	built: SupplyChainProducer[];
	isProduct: boolean;
}

/**
 * Fork feature - reverse planning (see docs/capacity-planning.md).
 *
 * Reads a solved plan graph "from the top": starting at the requested
 * products it works out, item by item, what each one needs and where that
 * comes from, ordered so every item sits below everything that uses it -
 * final products first, raw resources last.
 *
 * Pure (no Angular, no game-data lookups): the graph's own node IO carries
 * every rate, so this works on a solved graph however it was sized
 * (balanced or buffered capacity).
 */
export class SupplyChainBuilder
{

	public build(nodes: readonly Node[], inputs: readonly PlanInput[]): SupplyChainRow[]
	{
		const stats = new Map<string, Accumulator>();
		const stat = (item: Item): Accumulator => {
			let entry = stats.get(item.className);
			if (!entry) {
				entry = {item, required: 0, output: 0, mined: 0, external: 0, built: [], isProduct: false};
				stats.set(item.className, entry);
			}
			return entry;
		};

		/** Nodes turning items into other items - the edges of the "what is made from what" graph. */
		const transforms: Node[] = [];
		/** Items a terminal (product, sink, generator) draws - the roots the levels count up from. */
		const seeds = new Set<string>();

		for (const node of nodes) {
			switch (node.type) {
				case 'mine':
					node.outputs.forEach(io => stat(io.item).mined += io.maxAmount);
					break;
				case 'input':
					node.outputs.forEach(io => stat(io.item).external += io.maxAmount);
					break;
				case 'product':
					node.inputs.forEach(io => {
						const entry = stat(io.item);
						entry.required += io.maxAmount;
						entry.output += io.maxAmount;
						entry.isProduct = true;
						seeds.add(io.item.className);
					});
					break;
				case 'byproduct':
					// Leftover waste, not something the plan needs.
					break;
				case 'sink':
				case 'generator':
					node.inputs.forEach(io => {
						stat(io.item).required += io.maxAmount;
						seeds.add(io.item.className);
					});
					break;
				default:
					transforms.push(node);
					node.inputs.forEach(io => stat(io.item).required += io.maxAmount);
					node.outputs.forEach(io => {
						const producer = this.producerOf(node, io.item, io.maxAmount);
						if (producer !== null) {
							stat(io.item).built.push(producer);
						}
					});
			}
		}

		const levels = this.levels(transforms, seeds);

		const capByItem = new Map<string, number>();
		// A row set to 0 still counts: the item is marked as supplied by another
		// factory (just with nothing available yet), not silently back to "built here".
		inputs.forEach(input => {
			if (input.itemClassName !== '') {
				capByItem.set(input.itemClassName, (capByItem.get(input.itemClassName) ?? 0) + Math.max(0, input.amount));
			}
		});

		return [...stats.entries()]
			.filter(([className]) => levels.has(className))
			.map(([className, entry]): SupplyChainRow => ({
				item: entry.item,
				level: levels.get(className)!,
				kind: entry.isProduct ? 'product' : entry.mined > 0 ? 'raw' : 'intermediate',
				required: entry.required,
				output: entry.output,
				built: this.mergeProducers(entry.built),
				mined: entry.mined,
				external: entry.external,
				externalCap: capByItem.get(className) ?? null,
			}))
			.sort((a, b) =>
				a.level - b.level
				|| this.kindRank(a.kind) - this.kindRank(b.kind)
				|| a.item.name.localeCompare(b.item.name));
	}

	/**
	 * Longest-path level of every item that leads to a product: seeds are 0,
	 * and a transform's inputs sit one below its deepest output. Relaxed to a
	 * fixpoint; the cap keeps a byproduct loop from climbing forever.
	 */
	private levels(transforms: readonly Node[], seeds: ReadonlySet<string>): Map<string, number>
	{
		const levels = new Map<string, number>();
		seeds.forEach(className => levels.set(className, 0));

		const cap = transforms.length + 1;
		for (let round = 0; round <= cap; round++) {
			let changed = false;
			for (const node of transforms) {
				let deepestOutput = -1;
				node.outputs.forEach(io => {
					deepestOutput = Math.max(deepestOutput, levels.get(io.item.className) ?? -1);
				});
				if (deepestOutput < 0) {
					continue;
				}
				const wanted = Math.min(deepestOutput + 1, cap);
				node.inputs.forEach(io => {
					if ((levels.get(io.item.className) ?? -1) < wanted) {
						levels.set(io.item.className, wanted);
						changed = true;
					}
				});
			}
			if (!changed) {
				break;
			}
		}
		return levels;
	}

	private producerOf(node: Node, item: Item, amount: number): SupplyChainProducer | null
	{
		if (node.type === 'recipe') {
			const recipeNode = node as RecipeNode;
			return {
				name: recipeNode.recipe.name,
				machine: recipeNode.machine.name,
				machines: node.amount,
				amount,
			};
		}
		if (node.type === 'subplan') {
			return {name: node.getDisplayName(), machine: null, machines: 1, amount};
		}
		return null;
	}

	/** Lines running the same recipe and machine collapse into one with summed machines and amount. */
	private mergeProducers(producers: readonly SupplyChainProducer[]): SupplyChainProducer[]
	{
		const merged = new Map<string, SupplyChainProducer>();
		producers.forEach(producer => {
			const key = `${producer.name}@${producer.machine ?? ''}`;
			const existing = merged.get(key);
			merged.set(key, existing
				? {...existing, machines: existing.machines + producer.machines, amount: existing.amount + producer.amount}
				: producer);
		});
		return [...merged.values()];
	}

	private kindRank(kind: SupplyChainRow['kind']): number
	{
		return kind === 'product' ? 0 : kind === 'intermediate' ? 1 : 2;
	}

}
