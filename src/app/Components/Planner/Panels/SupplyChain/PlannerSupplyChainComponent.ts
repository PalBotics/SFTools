import {Component, ChangeDetectionStrategy, Signal, computed} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {TooltipDirective} from 'ngx-bootstrap/tooltip';
import {GameIconComponent} from '@src/Components/Common/GameIconComponent';
import {InfoNoteComponent} from '@src/Components/Common/InfoNoteComponent';
import {PlanBreakdownService} from '@src/Model/Planner/Breakdown/PlanBreakdownService';
import {LinkedInputResolver} from '@src/Model/Planner/Link/LinkedInputResolver';
import {PlanInput} from '@src/Model/Planner/PlanInput';
import {PlanNameResolver} from '@src/Model/Planner/PlanNameResolver';
import {PlanManager} from '@src/Model/Planner/PlanManager';
import {ProductionRequest} from '@src/Model/Planner/ProductionRequest';
import {SpecialClasses} from '@src/Model/Planner/SpecialClasses';
import {SupplyChainRow} from '@src/Model/Planner/SupplyChain/SupplyChainRow';
import {RateFormatter} from '@src/Model/RateFormatter';

/** How the solver treats the plan's product requests, as one switch. */
export type SolveMode = 'rate' | 'maximise' | 'mixed' | 'none';

interface Tier
{
	readonly level: number;
	readonly rows: SupplyChainRow[];
}

/**
 * Reverse plan (fork feature, docs/capacity-planning.md § "Reverse planning").
 *
 * Reads the solved graph from the requested products down to the raw
 * resources, and lets each component be switched between "build it here" and
 * "supplied by another factory" (a plan Input) - the plan recalculates around
 * that. With "Maximum output" the same view runs the other way: fix what you
 * have (other-factory supply, raw limits) and see what the products can reach.
 */
@Component({
	selector: 'planner-supply-chain',
	changeDetection: ChangeDetectionStrategy.Eager,
	templateUrl: './PlannerSupplyChainComponent.html',
	imports: [FormsModule, GameIconComponent, InfoNoteComponent, TooltipDirective],
})
export class PlannerSupplyChainComponent
{

	public readonly rows: Signal<SupplyChainRow[]> = computed(() =>
		this.breakdown.supplyChain(this.planManager.activePlan()));

	public readonly products: Signal<SupplyChainRow[]> = computed(() =>
		this.rows().filter(row => row.kind === 'product'));

	/** Components grouped by how many steps upstream of the products they sit. */
	public readonly tiers: Signal<Tier[]> = computed(() => {
		const byLevel = new Map<number, SupplyChainRow[]>();
		this.rows().filter(row => row.kind === 'intermediate').forEach(row => {
			byLevel.set(row.level, [...(byLevel.get(row.level) ?? []), row]);
		});
		return [...byLevel.entries()]
			.sort(([a], [b]) => a - b)
			.map(([level, rows]) => ({level, rows}));
	});

	public readonly raws: Signal<SupplyChainRow[]> = computed(() =>
		this.rows().filter(row => row.kind === 'raw'));

	public readonly hasPlan: Signal<boolean> = computed(() => this.planManager.activePlan() !== null);

	/** A shared plan is a frozen snapshot - looking is fine, editing is not. */
	public readonly readOnly: Signal<boolean> = computed(() => this.planManager.activePlanShared());

	public readonly solveMode: Signal<SolveMode> = computed(() => {
		const plan = this.planManager.activePlan();
		const requests = (plan?.requests ?? []).filter(request => this.isItemRequest(request));
		if (requests.length === 0) {
			return 'none';
		}
		const maximised = requests.filter(request => request.mode === 'maximise').length;
		return maximised === 0 ? 'rate' : maximised === requests.length ? 'maximise' : 'mixed';
	});

	/** The Resources group is pushed in by a folder - limits are read-only here then. */
	public readonly limitsFixed: Signal<boolean> = computed(() => {
		const plan = this.planManager.activePlan();
		return plan !== null && this.planManager.fixedGroupsOf(plan).includes('resources');
	});

	public constructor(
		private readonly planManager: PlanManager,
		private readonly breakdown: PlanBreakdownService,
		private readonly linkedInputs: LinkedInputResolver,
		private readonly planNames: PlanNameResolver,
		public readonly rateFormatter: RateFormatter,
	)
	{
	}

	// ── solve mode ──────────────────────────────────────────────────────────

	/**
	 * Flip every item request between a fixed rate (solve for the supply that
	 * needs) and maximise (solve for the most the supply allows). The typed
	 * rate is preserved while maximising, so flipping back loses nothing.
	 * Power / sink-point rows stay as they are - only one category may be
	 * maximised at a time.
	 */
	public setSolveMode(mode: 'rate' | 'maximise'): void
	{
		const plan = this.planManager.activePlan();
		if (!plan || this.readOnly()) {
			return;
		}
		this.planManager.setRequests(plan.id, plan.requests.map(request =>
			this.isItemRequest(request) ? {...request, mode} : request));
	}

	// ── other-factory supply ────────────────────────────────────────────────

	public isExternal(row: SupplyChainRow): boolean
	{
		return row.externalCap !== null;
	}

	/**
	 * "Source from another factory" on, starting at what the plan needs of the
	 * item right now (free to use - it already exists elsewhere); off removes
	 * the supply so the plan builds the item itself again.
	 */
	public toggleExternal(row: SupplyChainRow): void
	{
		const plan = this.planManager.activePlan();
		if (!plan || this.readOnly()) {
			return;
		}
		const others = plan.inputs.filter(input => input.itemClassName !== row.item.className);
		if (this.isExternal(row)) {
			this.planManager.setInputs(plan.id, others);
			return;
		}
		const added: PlanInput = {itemClassName: row.item.className, amount: this.roundUp(row.required), weight: 0};
		this.planManager.setInputs(plan.id, [...others, added]);
	}

	/** Edit the other-factory supply; several Input rows for one item collapse into one. */
	public setExternalAmount(row: SupplyChainRow, value: number | null): void
	{
		const plan = this.planManager.activePlan();
		if (!plan || this.readOnly() || value === null || !(value >= 0)) {
			return;
		}
		const same = plan.inputs.filter(input => input.itemClassName === row.item.className);
		const merged: PlanInput = {
			itemClassName: row.item.className,
			amount: value,
			weight: same.length > 0 ? Math.min(...same.map(input => input.weight)) : 0,
		};
		const others = plan.inputs.filter(input => input.itemClassName !== row.item.className);
		this.planManager.setInputs(plan.id, [...others, merged]);
	}

	/** Plans that could supply this item (those outputting some of it, plus the current source). */
	public linkOptions(row: SupplyChainRow): {planId: string; name: string; output: number}[]
	{
		const plan = this.planManager.activePlan();
		if (!plan) {
			return [];
		}
		return this.linkedInputs.options(plan, row.item.className, row.linkedPlanId ?? undefined)
			.map(option => ({
				planId: option.planId,
				name: option.plan ? this.planNames.displayName(option.plan) : '(plan no longer exists)',
				output: option.output,
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Pull the item from another plan's output instead of a typed amount ('' = typed again). */
	public setLink(row: SupplyChainRow, planId: string): void
	{
		const plan = this.planManager.activePlan();
		if (!plan || this.readOnly()) {
			return;
		}
		const same = plan.inputs.filter(input => input.itemClassName === row.item.className);
		const others = plan.inputs.filter(input => input.itemClassName !== row.item.className);
		const merged: PlanInput = {
			itemClassName: row.item.className,
			// The typed amount is kept while linked, so unlinking restores it.
			amount: same.length > 0 ? same.reduce((sum, input) => sum + input.amount, 0) : this.roundUp(row.required),
			weight: same.length > 0 ? Math.min(...same.map(input => input.weight)) : 0,
		};
		if (planId !== '') {
			merged.sourcePlanId = planId;
		}
		this.planManager.setInputs(plan.id, [...others, merged]);
	}

	// ── raw resource limits ─────────────────────────────────────────────────

	public limitOf(row: SupplyChainRow): number | null
	{
		return this.planManager.activeSettings()?.resourceLimits?.[row.item.className] ?? null;
	}

	/** Blank = no limit. */
	public setLimit(row: SupplyChainRow, value: number | null): void
	{
		const settings = this.planManager.activeSettings();
		if (!settings || this.readOnly() || this.limitsFixed()) {
			return;
		}
		const limits = {...(settings.resourceLimits ?? {})};
		if (value === null || !(value >= 0)) {
			delete limits[row.item.className];
		} else {
			limits[row.item.className] = value;
		}
		this.planManager.updateActiveSettings({
			...settings,
			resourceLimits: Object.keys(limits).length > 0 ? limits : undefined,
		});
	}

	// ── display helpers ─────────────────────────────────────────────────────

	/** "Rotor - 29× Assembler" lines for the recipes building the item here. */
	public builtBy(row: SupplyChainRow): string[]
	{
		return row.built.map(line => line.machine
			? `${line.name} · ${this.rateFormatter.machineCount(line.machines)}× ${line.machine}`
			: line.name);
	}

	public tierLabel(level: number): string
	{
		return level === 1 ? 'Feeds the products' : `${level - 1} step${level === 2 ? '' : 's'} further upstream`;
	}

	private isItemRequest(request: ProductionRequest): boolean
	{
		return request.itemClassName !== ''
			&& request.itemClassName !== SpecialClasses.PowerTarget
			&& request.itemClassName !== SpecialClasses.SinkPointsTarget;
	}

	/** Whole hundredths, rounded up so the supply never undershoots what the plan needs. */
	private roundUp(amount: number): number
	{
		return Math.ceil(amount * 100 - 1e-9) / 100;
	}

}
