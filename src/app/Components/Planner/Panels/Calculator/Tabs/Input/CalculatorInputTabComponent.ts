import {Component, OnDestroy, ChangeDetectionStrategy, Signal, computed} from '@angular/core';
import {toObservable} from '@angular/core/rxjs-interop';
import {Subscription} from 'rxjs';
import {FormsModule} from '@angular/forms';
import {FaIconComponent} from '@fortawesome/angular-fontawesome';
import {faXmark} from '@fortawesome/free-solid-svg-icons';
import {InfoNoteComponent} from '@src/Components/Common/InfoNoteComponent';
import {ItemPickerComponent} from '@src/Components/Common/ItemPickerComponent';
import {ItemPickerOption} from '@src/Components/Common/ItemPickerOption';
import {ItemForm} from '@src/Model/API/Schema/Data/Parts/ItemForm';
import {VersionManager} from '@src/Model/Data/VersionManager';
import {LinkedInputResolver, ReservationSummary} from '@src/Model/Planner/Link/LinkedInputResolver';
import {MakeableItemsResolver} from '@src/Model/Planner/MakeableItemsResolver';
import {PlanNameResolver} from '@src/Model/Planner/PlanNameResolver';
import {RateFormatter} from '@src/Model/RateFormatter';
import {Plan} from '@src/Model/Planner/Plan';
import {PlanInput} from '@src/Model/Planner/PlanInput';
import {PlanManager} from '@src/Model/Planner/PlanManager';

/**
 * User-supplied item sources for the solver: each row makes an item available
 * up to its amount, priced by its weight in the optimisation objective (a low
 * weight makes it a cheap alternative to mining or crafting). A new input's
 * weight follows its item's sink value (points / 10, or 1 without one) until
 * edited. Consumed inputs appear in the graph as "input" nodes.
 */
@Component({
	selector: 'calculator-input-tab',
	templateUrl: './CalculatorInputTabComponent.html',
	changeDetection: ChangeDetectionStrategy.Eager,
	imports: [FormsModule, FaIconComponent, ItemPickerComponent, InfoNoteComponent],
})
export class CalculatorInputTabComponent implements OnDestroy
{

	public readonly faXmark = faXmark;

	public rows: PlanInput[] = [];

	/** Whether the input weights optimisation goal is on - the weights only matter then. */
	public readonly weightsEnabled: Signal<boolean> = computed(() =>
		this.planManager.activeSettings()?.optimisation?.inputs ?? true);

	private loadedPlanId: string | null = null;
	/** JSON of the inputs the rows were last built from or synced to - external changes rebuild the rows. */
	private loadedInputs: string | null = null;
	private readonly subscription = new Subscription();

	public constructor(
		private readonly planManager: PlanManager,
		private readonly versionManager: VersionManager,
		private readonly makeableItems: MakeableItemsResolver,
		private readonly linkedInputs: LinkedInputResolver,
		private readonly planNames: PlanNameResolver,
		public readonly rateFormatter: RateFormatter,
	)
	{
		const initial = this.planManager.activePlan();
		if (initial) {
			this.loadedPlanId = initial.id;
			this.loadRows(initial);
		}

		this.subscription.add(
			toObservable(this.planManager.activePlan).subscribe(plan => {
				// Skip echoes of this tab's own sync(); anything else (plan
				// switch, context-menu removal, undo) replaces the row drafts.
				if (!plan || (plan.id === this.loadedPlanId && JSON.stringify(plan.inputs) === this.loadedInputs)) return;
				this.loadedPlanId = plan.id;
				this.loadRows(plan);
			}),
		);
	}

	/** Any item may be an input source, subject to the unmakeable-items display setting. */
	public get itemOptions(): ItemPickerOption[]
	{
		return this.makeableItems.applyToActivePlan(
			[...(this.versionManager.activeVersionData()?.items ?? [])]
				.sort((a, b) => a.name.localeCompare(b.name))
				.map(item => ({value: item.className, label: item.name, iconHash: item.icon})),
		);
	}

	/** Picking an item resets the weight to that item's default unless the user already typed their own. */
	public onItemChange(row: PlanInput, value: string): void
	{
		if (row.weight === this.defaultWeightFor(row.itemClassName)) {
			row.weight = this.defaultWeightFor(value);
		}
		if (value !== row.itemClassName) {
			// Another plan's output is specific to the item - a new item starts typed.
			delete row.sourcePlanId;
			delete row.reserve;
		}
		row.itemClassName = value;
		this.sync();
	}

	/**
	 * Plans that could supply this row's item: those whose stored graph outputs
	 * some of it, plus the row's current source even if it no longer does.
	 */
	public sourceOptions(row: PlanInput): {planId: string; name: string; output: number; reservedByOthers: number}[]
	{
		const plan = this.planManager.activePlan();
		if (!plan || row.itemClassName === '') {
			return [];
		}
		return this.linkedInputs.options(plan, row.itemClassName, row.sourcePlanId)
			.map(option => ({
				planId: option.planId,
				name: option.plan ? this.planNames.displayName(option.plan) : '(plan no longer exists)',
				output: option.output,
				reservedByOthers: option.reservedByOthers,
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Link the row to another plan's output, or back to a typed amount (''). The typed amount is kept either way. */
	public setSource(row: PlanInput, planId: string): void
	{
		if (planId === '') {
			delete row.sourcePlanId;
			delete row.reserve;
			// Supply that already exists elsewhere starts free; back to typed, back to the item's default price.
			if (row.weight === 0) {
				row.weight = this.defaultWeightFor(row.itemClassName);
			}
		} else {
			if (row.weight === this.defaultWeightFor(row.itemClassName)) {
				row.weight = 0;
			}
			row.sourcePlanId = planId;
		}
		this.sync();
	}

	/** Hold part of the source's output for this plan (blank or 0 = none). */
	public setReserve(row: PlanInput, value: number | null): void
	{
		if (value === null || !(value > 0)) {
			delete row.reserve;
		} else {
			row.reserve = value;
		}
		this.sync();
	}

	/** Reservations only bind plans that share a source exclusively - buffered-capacity plans see the full output. */
	public reservationsApply(): boolean
	{
		const plan = this.planManager.activePlan();
		return plan !== null && this.linkedInputs.sharingOf(plan) === 'exclusive';
	}

	/** The reservations on this row's source output add up to more than it makes. */
	public overReserved(row: PlanInput): ReservationSummary | null
	{
		const plan = this.planManager.activePlan();
		if (!plan || row.sourcePlanId === undefined || !this.reservationsApply()) {
			return null;
		}
		const summary = this.linkedInputs.reservationSummary(plan, row);
		return summary.overReserved ? summary : null;
	}

	/** What a linked row can draw right now, under the plan's sizing rule. */
	public linkedAvailable(row: PlanInput): number
	{
		const plan = this.planManager.activePlan();
		return plan ? this.linkedInputs.availableTo(plan, row) : 0;
	}

	/** The linked plan is gone, or no longer makes this item. */
	public linkBroken(row: PlanInput): boolean
	{
		const plan = this.planManager.activePlan();
		if (!plan || row.sourcePlanId === undefined) {
			return false;
		}
		const option = this.linkedInputs.options(plan, row.itemClassName, row.sourcePlanId).find(o => o.planId === row.sourcePlanId);
		return !option || option.plan === null || option.output <= 0;
	}

	public addRow(): void
	{
		this.rows.push({itemClassName: '', amount: 10, weight: this.defaultWeightFor('')});
		this.sync();
	}

	/** Sink points / 10 for items with a sink value; 1 otherwise (fluids cannot be sunk, zero-point items, no item yet). */
	public defaultWeightFor(itemClassName: string): number
	{
		const item = this.versionManager.activeVersionData()?.searchItemByClassName(itemClassName);
		return item && item.form === ItemForm.Solid && item.sinkPoints > 0 ? item.sinkPoints / 10 : 1;
	}

	public removeRow(index: number): void
	{
		this.rows.splice(index, 1);
		this.sync();
	}

	public sync(): void
	{
		const plan = this.planManager.activePlan();
		if (plan) {
			this.loadedInputs = JSON.stringify(this.rows);
			this.planManager.setInputs(plan.id, this.rows);
		}
	}

	public ngOnDestroy(): void
	{
		this.subscription.unsubscribe();
	}

	private loadRows(plan: Plan): void
	{
		this.loadedInputs = JSON.stringify(plan.inputs);
		this.rows = plan.inputs.map(input => ({...input}));
	}

}
