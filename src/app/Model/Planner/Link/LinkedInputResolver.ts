import {Injectable, computed} from '@angular/core';
import {Plan} from '@src/Model/Planner/Plan';
import {PlanInput} from '@src/Model/Planner/PlanInput';
import {PlanManager} from '@src/Model/Planner/PlanManager';
import {PlanOutputs} from '@src/Model/Planner/Link/PlanOutputs';

/**
 * How a plan's linked supply is divided when several plans pull the same item
 * from the same source plan:
 *  - exclusive (balanced sizing): reservations come off the top (each plan is
 *    guaranteed its own reserve, drawn or not); the rest is a pool shared first
 *    come, first served, where a plan's draw beyond its reserve counts against
 *    the others - like the shared resource pool.
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
	/** Per-minute amount of that output other plans have reserved for themselves. */
	readonly reservedByOthers: number;
}

/** How the reservations on one source output add up, for warning when they cannot all be honoured. */
export interface ReservationSummary
{
	readonly output: number;
	/** Everything reserved on this output, this row included. */
	readonly totalReserved: number;
	/** More is reserved than the source makes, so every reservation is scaled down. */
	readonly overReserved: boolean;
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
		if (sharing === 'shared') {
			return output;
		}

		// Exclusive: reservations first (scaled down together when they exceed the
		// output), then whatever is left is a pool the plans draw from in turn.
		const others = this.pullers(plan, input);
		const mine = this.reserveOf(input);
		const totalReserved = mine + others.reduce((sum, other) => sum + other.reserve, 0);
		const scale = totalReserved > output ? output / totalReserved : 1;
		const pool = output - totalReserved * scale;
		const poolUsedByOthers = others.reduce((sum, other) => sum + Math.max(0, other.drawn - other.reserve * scale), 0);
		return Math.min(output, mine * scale + Math.max(0, pool - poolUsedByOthers));
	}

	/** How much is reserved on the row's source output, and whether that is more than it makes. */
	public reservationSummary(plan: Plan, input: PlanInput): ReservationSummary
	{
		const source = input.sourcePlanId === undefined ? undefined : this.index().get(input.sourcePlanId);
		const output = source?.outputs.get(input.itemClassName) ?? 0;
		const totalReserved = this.reserveOf(input) + this.pullers(plan, input).reduce((sum, other) => sum + other.reserve, 0);
		return {output, totalReserved, overReserved: totalReserved > output + 1e-9};
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
				options.push({plan: entry.plan, planId: entry.plan.id, output, reservedByOthers: this.reservedByOthers(plan, entry.plan.id, itemClassName)});
			}
		});
		if (currentSourceId !== undefined && !options.some(option => option.planId === currentSourceId)) {
			options.push({plan: null, planId: currentSourceId, output: 0, reservedByOthers: 0});
		}
		return options;
	}

	/** Plans with an Input row pulling from the given plan. */
	public dependents(planId: string): Plan[]
	{
		return this.planManager.plans().filter(plan =>
			plan.id !== planId && plan.inputs.some(input => input.sourcePlanId === planId));
	}

	/** Every other plan pulling the same item from the same source: its reservation and its stored draw. */
	private pullers(plan: Plan, input: PlanInput): {reserve: number; drawn: number}[]
	{
		const pullers: {reserve: number; drawn: number}[] = [];
		this.index().forEach(entry => {
			if (entry.plan.id === plan.id) {
				return;
			}
			const row = entry.plan.inputs.find(other =>
				other.sourcePlanId === input.sourcePlanId && other.itemClassName === input.itemClassName);
			if (row) {
				pullers.push({reserve: this.reserveOf(row), drawn: entry.drawn.get(input.itemClassName) ?? 0});
			}
		});
		return pullers;
	}

	/** What plans other than the given one have reserved on a source's output of an item. */
	private reservedByOthers(plan: Plan, sourcePlanId: string, itemClassName: string): number
	{
		return this.pullers(plan, {itemClassName, amount: 0, weight: 0, sourcePlanId})
			.reduce((sum, other) => sum + other.reserve, 0);
	}

	/** A usable reservation: a positive, finite number - anything else means none. */
	private reserveOf(input: PlanInput): number
	{
		const reserve = input.reserve;
		return typeof reserve === 'number' && isFinite(reserve) && reserve > 0 ? reserve : 0;
	}

}
