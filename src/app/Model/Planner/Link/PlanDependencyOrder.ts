import {Plan} from '@src/Model/Planner/Plan';

/**
 * Fork feature (docs/capacity-planning.md § "Linking plans").
 *
 * Orders plans so a plan comes after every plan it pulls from - a batch that
 * recalculates them one by one then feeds each plan the fresh output of its
 * source instead of a stale one. Otherwise keeps the given order. Links to
 * plans outside the set are ignored; a cycle (A pulls from B pulls from A)
 * cannot be ordered, so its members just keep their given order.
 */
export class PlanDependencyOrder
{

	public static sort(plans: readonly Plan[]): Plan[]
	{
		const inSet = new Set(plans.map(plan => plan.id));
		const sources = (plan: Plan): string[] => plan.inputs
			.map(input => input.sourcePlanId)
			.filter((id): id is string => id !== undefined && id !== plan.id && inSet.has(id));

		const remaining = [...plans];
		const placed = new Set<string>();
		const ordered: Plan[] = [];

		while (remaining.length > 0) {
			// First plan (in the given order) whose sources are all placed; on a
			// cycle nothing qualifies, so fall back to the first one left.
			const index = remaining.findIndex(plan => sources(plan).every(id => placed.has(id)));
			const [next] = remaining.splice(index === -1 ? 0 : index, 1);
			ordered.push(next);
			placed.add(next.id);
		}
		return ordered;
	}

}
