import {Item} from '@src/Model/Data/Entities/Item';

/** One recipe line (or several merged) that builds an item inside the plan. */
export interface SupplyChainProducer
{
	/** Recipe name, e.g. "Rotor". */
	readonly name: string;

	/** Machine name, e.g. "Assembler" - null for non-machine producers. */
	readonly machine: string | null;

	/** Machines the line runs (as drawn in the graph). */
	readonly machines: number;

	/** Per-minute amount of THIS item the line makes. */
	readonly amount: number;
}

/**
 * Reverse-plan view of one item: how much the plan needs of it, and where it
 * comes from - built here, mined, or supplied by another factory. See
 * docs/capacity-planning.md § "Reverse planning".
 */
export interface SupplyChainRow
{

	readonly item: Item;

	/**
	 * Steps upstream of the final products: 0 = a requested product, 1 = what
	 * its recipes consume, and so on - always below every item that uses it.
	 */
	readonly level: number;

	/** product: a requested output; raw: mined; intermediate: everything else. */
	readonly kind: 'product' | 'intermediate' | 'raw';

	/** Per-minute amount the plan's recipes, generators and sinks draw of it (plus the product output itself). */
	readonly required: number;

	/** Per-minute amount delivered as a requested product - 0 for non-products. */
	readonly output: number;

	/** Recipe lines that build it in this plan. */
	readonly built: SupplyChainProducer[];

	/** Per-minute amount mined. */
	readonly mined: number;

	/** Per-minute amount actually drawn from other-factory inputs. */
	readonly external: number;

	/** Configured other-factory supply (the plan's Input rows summed); null when there is none. */
	readonly externalCap: number | null;

	/** The plan this item is pulled from, when its Input row is linked to one; null for typed supply. */
	readonly linkedPlanId: string | null;

}
