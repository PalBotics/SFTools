import {Graph} from '@src/Model/Planner/Graph/Graph';
import {PlanOutputs} from '@src/Model/Planner/Link/PlanOutputs';
import {Plan} from '@src/Model/Planner/Plan';

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

		return plans.some(isStale)
			? plans.map(plan => isStale(plan) ? {...plan, metadata: {...plan.metadata, recalculationNeeded: true}} : plan)
			: plans;
	}

}
