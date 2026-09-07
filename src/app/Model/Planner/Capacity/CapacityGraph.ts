/**
 * Fork feature - "buffered capacity" planning (see docs/capacity-planning.md).
 *
 * The abstract graph the CapacityPropagator sizes. It is deliberately free of
 * Angular / game-data types: a bridge service turns a solved plan graph into
 * this shape (per-machine-minute rates come from Formulas.referenceCycles ×
 * recipe amounts × somersloop boost) and writes the results back.
 */

export interface CapacityRecipeIO
{
	readonly itemClassName: string;
	/** Item/min this recipe consumes or produces per one machine at 100% clock. */
	readonly perMachineMinute: number;
}

export interface CapacityRecipe
{
	readonly id: string;
	readonly ingredients: readonly CapacityRecipeIO[];
	readonly products: readonly CapacityRecipeIO[];
}

export interface CapacityGraph
{
	readonly recipes: readonly CapacityRecipe[];

	/** Raw supply per minute by item class (miners, user inputs). */
	readonly sources: Readonly<Record<string, number>>;

	/**
	 * Item classes that are NOT buffered - a direct belt, mass-balanced among
	 * consumers. Every other intermediate is a buffer: each consuming line is
	 * sized to draw the item's full production. Absent = buffer everything.
	 */
	readonly directItems?: ReadonlySet<string>;
}

export interface CapacityResult
{
	/** recipe id -> machine-equivalents at 100% clock. */
	readonly targets: Readonly<Record<string, number>>;

	/** item class -> total production capacity per minute across the graph. */
	readonly itemCapacity: Readonly<Record<string, number>>;

	/**
	 * item class -> summed consumption capacity per minute (what every
	 * consuming line could draw at once). Exceeds itemCapacity at a buffer
	 * with more than one consumer - that overcommit is the whole point.
	 */
	readonly itemDemand: Readonly<Record<string, number>>;

	readonly warnings: readonly string[];
}
