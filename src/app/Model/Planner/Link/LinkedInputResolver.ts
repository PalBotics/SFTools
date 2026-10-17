import {Injectable, computed} from '@angular/core';
import {Plan} from '@src/Model/Planner/Plan';
import {PlanInput} from '@src/Model/Planner/PlanInput';
import {PlanManager} from '@src/Model/Planner/PlanManager';
import {PlanOutputs} from '@src/Model/Planner/Link/PlanOutputs';

/**
 * How a plan's linked supply is divided when several plans pull the same item
 * from the same source plan:
 *  - exclusive (balanced sizing): a plan only gets what the source makes minus
 *    what the other pulling plans already draw - like the shared resource pool.
 *  - shared (buffered-capacity sizing): every plan sees the source's full
 *    output and is sized to be able to take all of it; storage between the
 *    factories absorbs the overlap - the same philosophy as capacity sizing
 *    inside one plan.
 */
export type InputSharing = 'exclusive' | 'shared';

/** A plan that could supply an item, and how much of it that plan outputs. */
export interface LinkOption
{
	readonly plan: Plan | null;
	readonly planId: string;
	/** The source's whole output of the item per minute (0 when it no longer makes any). */
	readonly output: number;
}

/**
 * Fork feature (docs/capacity-planning.md § "Linking plans").
 *
 * Turns Input rows that point at another plan (`PlanInput.sourcePlanId`) into
 * plain amounts for the solver: whatever that plan's stored graph outputs of
 * the item. Reads stored graphs only - never solves - so linked plans cannot
 * recurse; a cycle just settles over successive recalculations.
 */
@Injectable({providedIn: 'root'})
export class LinkedInputResolver
{

	/** Every own plan's outputs and Input draw, rebuilt only when the plan store changes. */
	private readonly index = computed(() => {
		const entries = new Map<string, {plan: Plan; outputs: Map<string, number>; drawn: Map<string, number>}>();
		this.planManager.plans().forEach(plan => entries.set(plan.id, {
			plan,
			outputs: PlanOutputs.amounts(plan.graph),
			drawn: PlanOutputs.drawn(plan.graph),
		}));
		return entries;
	});

	public constructor(private readonly planManager: PlanManager)
	{
	}

	/** Exclusive for balanced plans, shared for buffered-capacity ones. */
	public sharingOf(plan: Plan): InputSharing
	{
		return plan.settings.sizing === 'capacity' ? 'shared' : 'exclusive';
	}

	/**
	 * The plan's Input rows with linked ones turned into amounts. Typed rows
	 * pass through untouched. A link to a missing plan (or to the plan itself)
	 * supplies nothing, and a second row linking the same plan and item gets
	 * nothing either - the solver merges duplicate rows by summing them, which
	 * would double-count the one output.
	 */
	public effectiveInputs(plan: Plan, sharing: InputSharing = this.sharingOf(plan)): PlanInput[]
	{
		const seen = new Set<string>();
		return plan.inputs.map(input => {
			if (input.sourcePlanId === undefined) {
				return input;
			}
			const key = `${input.sourcePlanId}|${input.itemClassName}`;
			const duplicate = seen.has(key);
			seen.add(key);
			return {...input, amount: duplicate ? 0 : this.availableTo(plan, input, sharing)};
		});
	}

	/** What a linked row can draw per minute, under the given sharing rule. */
	public availableTo(plan: Plan, input: PlanInput, sharing: InputSharing = this.sharingOf(plan)): number
	{
		const source = input.sourcePlanId === undefined ? undefined : this.index().get(input.sourcePlanId);
		if (!source || source.plan.id === plan.id) {
			return 0;
		}
		const output = source.outputs.get(input.itemClassName) ?? 0;
		return sharing === 'shared' ? output : Math.max(0, output - this.usedByOthers(plan, input));
	}

	/** The source plan of a linked row, or null when it is typed or the plan is gone. */
	public sourceOf(input: PlanInput): Plan | null
	{
		return input.sourcePlanId === undefined ? null : this.index().get(input.sourcePlanId)?.plan ?? null;
	}

	/**
	 * Plans that could supply the item: every other top-level plan whose graph
	 * outputs some of it. The row's current source is always included, even when
	 * it has stopped making the item (or is gone), so the selection stays visible.
	 */
	public options(plan: Plan, itemClassName: string, currentSourceId?: string): LinkOption[]
	{
		const options: LinkOption[] = [];
		this.index().forEach(entry => {
			const output = entry.outputs.get(itemClassName) ?? 0;
			if (entry.plan.id === plan.id || entry.plan.parentPlanId !== null) {
				return;
			}
			if (output > 0 || entry.plan.id === currentSourceId) {
				options.push({plan: entry.plan, planId: entry.plan.id, output});
			}
		});
		if (currentSourceId !== undefined && !options.some(option => option.planId === currentSourceId)) {
			options.push({plan: null, planId: currentSourceId, output: 0});
		}
		return options;
	}

	/** Plans with an Input row pulling from the given plan. */
	public dependents(planId: string): Plan[]
	{
		return this.planManager.plans().filter(plan =>
			plan.id !== planId && plan.inputs.some(input => input.sourcePlanId === planId));
	}

	/** What the other plans pulling the same item from the same source already draw (per their stored graphs). */
	private usedByOthers(plan: Plan, input: PlanInput): number
	{
		let used = 0;
		this.index().forEach(entry => {
			if (entry.plan.id === plan.id) {
				return;
			}
			const pulls = entry.plan.inputs.some(other =>
				other.sourcePlanId === input.sourcePlanId && other.itemClassName === input.itemClassName);
			if (pulls) {
				used += entry.drawn.get(input.itemClassName) ?? 0;
			}
		});
		return used;
	}

}
