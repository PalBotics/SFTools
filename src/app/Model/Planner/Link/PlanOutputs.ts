/** Just the node fields this reads - true of both revived nodes and raw stored JSON. */
interface GraphLike
{
	readonly nodes?: readonly unknown[];
}

interface NodeLike
{
	readonly type?: string;
	readonly amount?: number;
	readonly itemClassName?: string;
	readonly item?: {readonly className?: string};
}

/**
 * Fork feature (docs/capacity-planning.md § "Linking plans").
 *
 * What a plan's stored graph hands out and takes in, per item and minute.
 * Works on revived graphs and on raw JSON straight from storage alike (a
 * plan never opened this session is still raw), and needs no game data -
 * only class names - so the plan store itself can use it.
 */
export class PlanOutputs
{

	private static readonly EPSILON = 1e-6;

	/** Items the plan delivers: its products and byproducts. */
	public static amounts(graph: GraphLike | null | undefined): Map<string, number>
	{
		return PlanOutputs.sum(graph, ['product', 'byproduct']);
	}

	/** Items the plan draws from Input rows (what its solved graph actually uses). */
	public static drawn(graph: GraphLike | null | undefined): Map<string, number>
	{
		return PlanOutputs.sum(graph, ['input']);
	}

	/** Whether two item/amount maps agree to within float noise. */
	public static same(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean
	{
		const keys = new Set([...a.keys(), ...b.keys()]);
		for (const key of keys) {
			if (Math.abs((a.get(key) ?? 0) - (b.get(key) ?? 0)) > PlanOutputs.EPSILON) {
				return false;
			}
		}
		return true;
	}

	private static sum(graph: GraphLike | null | undefined, types: readonly string[]): Map<string, number>
	{
		const totals = new Map<string, number>();
		(graph?.nodes ?? []).forEach(candidate => {
			const node = candidate as NodeLike;
			const className = node.itemClassName ?? node.item?.className;
			if (!node.type || !types.includes(node.type) || !className || typeof node.amount !== 'number' || !(node.amount > 0)) {
				return;
			}
			totals.set(className, (totals.get(className) ?? 0) + node.amount);
		});
		return totals;
	}

}
