import {Graph} from '@src/Model/Planner/Graph/Graph';
import {PlanOutputs} from '@src/Model/Planner/Link/PlanOutputs';
import {Plan} from '@src/Model/Planner/Plan';
import {PlanInput} from '@src/Model/Planner/PlanInput';

/**
 * Fork feature (docs/capacity-planning.md § "Linking plans").
 *
 * When a plan's graph is replaced, the plans pulling its output through a
 * linked Input are stale if that output changed - flagged for recalculation
 * the same way a settings push flags a folder's plans.
 */
export class LinkStaleness
{

	/**
	 * `plans` with the dependents of `sourceId` flagged `recalculationNeeded` when
	 * the source's products/byproducts differ between `before` and `after`.
	 * Plans without a graph are not flagged (nothing stored to be stale), and
	 * the same array comes back when there is nothing to flag.
	 */
	public static flagDependents(plans: readonly Plan[], sourceId: string, before: Graph | null, after: Graph | null): readonly Plan[]
	{
		if (PlanOutputs.same(PlanOutputs.amounts(before), PlanOutputs.amounts(after))) {
			return plans;
		}
		const isStale = (plan: Plan): boolean =>
			plan.id !== sourceId
			&& plan.graph !== null
			&& !(plan.metadata.recalculationNeeded ?? false)
			&& plan.inputs.some(input => input.sourcePlanId === sourceId);

		return LinkStaleness.flag(plans, isStale);
	}

	/**
	 * A plan's reservation on a source output changed (set, resized or dropped):
	 * the other plans pulling the same item from the same source can now draw
	 * more or less, so they are flagged too. Only reservations matter - typing a
	 * new link changes nothing for the others until the plan is solved.
	 */
	public static flagSiblings(plans: readonly Plan[], changedPlanId: string, before: readonly PlanInput[], after: readonly PlanInput[]): readonly Plan[]
	{
		const was = LinkStaleness.reservations(before);
		const now = LinkStaleness.reservations(after);
		const changed = new Set<string>();
		for (const key of new Set([...was.keys(), ...now.keys()])) {
			if ((was.get(key) ?? 0) !== (now.get(key) ?? 0)) {
				changed.add(key);
			}
		}
		if (changed.size === 0) {
			return plans;
		}
		const isStale = (plan: Plan): boolean =>
			plan.id !== changedPlanId
			&& plan.graph !== null
			&& !(plan.metadata.recalculationNeeded ?? false)
			&& plan.inputs.some(input => input.sourcePlanId !== undefined && changed.has(LinkStaleness.key(input)));

		return LinkStaleness.flag(plans, isStale);
	}

	private static flag(plans: readonly Plan[], isStale: (plan: Plan) => boolean): readonly Plan[]
	{
		return plans.some(isStale)
			? plans.map(plan => isStale(plan) ? {...plan, metadata: {...plan.metadata, recalculationNeeded: true}} : plan)
			: plans;
	}

	/** Reservation per linked (source, item) pair - the first row of a pair counts, like the resolver. */
	private static reservations(inputs: readonly PlanInput[]): Map<string, number>
	{
		const reservations = new Map<string, number>();
		inputs.forEach(input => {
			if (input.sourcePlanId !== undefined && !reservations.has(LinkStaleness.key(input))) {
				const reserve = input.reserve;
				reservations.set(LinkStaleness.key(input), typeof reserve === 'number' && isFinite(reserve) && reserve > 0 ? reserve : 0);
			}
		});
		return reservations;
	}

	private static key(input: PlanInput): string
	{
		return input.sourcePlanId + '|' + input.itemClassName;
	}

}
