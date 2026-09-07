import {Injectable} from '@angular/core';
import {Item} from '@src/Model/Data/Entities/Item';
import {VersionManager} from '@src/Model/Data/VersionManager';
import {FolderBuildingRow} from '@src/Model/Planner/Breakdown/FolderBuildingRow';
import {FolderOverview} from '@src/Model/Planner/Breakdown/FolderOverview';
import {FolderPlanRow} from '@src/Model/Planner/Breakdown/FolderPlanRow';
import {FolderProductionRow} from '@src/Model/Planner/Breakdown/FolderProductionRow';
import {FolderRecipeRow} from '@src/Model/Planner/Breakdown/FolderRecipeRow';
import {FolderResourceRow} from '@src/Model/Planner/Breakdown/FolderResourceRow';
import {PlanAmount} from '@src/Model/Planner/Breakdown/PlanAmount';
import {PlanBreakdownService} from '@src/Model/Planner/Breakdown/PlanBreakdownService';
import {Folder} from '@src/Model/Planner/Folder';
import {Plan} from '@src/Model/Planner/Plan';
import {PlanManager} from '@src/Model/Planner/PlanManager';
import {PlanNameResolver} from '@src/Model/Planner/PlanNameResolver';
import {PowerDraw} from '@src/Model/Planner/PowerDraw';
import {ResourcePoolService} from '@src/Model/Planner/Pool/ResourcePoolService';
import {SettingsGroups} from '@src/Model/Planner/SettingsGroups';

/**
 * Folder-wide overview: the per-plan breakdowns of every top-level plan in
 * the folder and its subfolders (subplans folded into their parent), summed
 * per resource, item, building and recipe with the per-plan split kept for
 * expansion. Limits follow the folder's resources mode - the shared pool
 * when pooled, the per-plan cap when fixed, nothing when plans set their own.
 */
@Injectable({providedIn: 'root'})
export class FolderOverviewService
{

	public constructor(
		private readonly planManager: PlanManager,
		private readonly breakdown: PlanBreakdownService,
		private readonly pool: ResourcePoolService,
		private readonly planNames: PlanNameResolver,
		private readonly versionManager: VersionManager,
	)
	{
	}

	public overview(folder: Folder): FolderOverview
	{
		const plans = this.planManager.innerPlans(folder.id).filter(plan => plan.parentPlanId === null);
		const resourcesMode = this.planManager.folderGroupMode(folder, 'resources');

		const planRows: FolderPlanRow[] = plans.map(plan => {
			const power = this.breakdown.power(plan);
			const cost = this.breakdown.buildCost(plan);
			return {
				planId: plan.id,
				name: this.planNames.displayName(plan),
				manual: (plan.settings.calculationMode ?? 'automatic') !== 'automatic' || (plan.metadata.graphDirty ?? false),
				outdated: (plan.metadata.recalculationNeeded ?? false) || this.pool.overUsed(plan).length > 0,
				consumption: power.consumption,
				production: power.production,
				net: power.net,
				shards: cost.shards,
				sloops: cost.sloops,
				buildings: cost.machines,
			};
		});

		// Parallel pool: sibling plans are buffer-decoupled branches that never
		// peak at once, so the folder totals are their envelope (the hungriest
		// single branch per recipe / resource / product), not their sum. Shared
		// upstream steps run the same recipe in every branch and collapse to
		// one; divergent downstream steps run different recipes and stay apart.
		const parallel = resourcesMode === 'pool' && folder.resourcePoolMode === 'parallel';

		const recipes = this.recipes(plans, parallel);
		const buildings = parallel ? this.buildingsFromRecipes(recipes) : this.buildings(plans);

		return {
			plans: planRows,
			fixedSummary: folder.fixedGroups
				.map(group => group === 'resources' && folder.resourcePool
					? `Resources (${parallel ? 'parallel' : 'shared'} pool)`
					: SettingsGroups.labelOf(group))
				.join(', '),
			resourcesMode,
			parallelPool: parallel,
			resources: this.resources(folder, plans, resourcesMode !== 'default', parallel),
			production: this.production(plans, parallel),
			buildings,
			totalBuildings: buildings.reduce((sum, row) => sum + row.machines, 0),
			recipes,
			consumption: parallel ? this.envelope(planRows.map(row => row.consumption)) : PowerDraw.sum(planRows.map(row => row.consumption)),
			powerProduction: parallel
				? planRows.reduce((max, row) => Math.max(max, row.production), 0)
				: planRows.reduce((sum, row) => sum + row.production, 0),
			netPower: parallel ? this.envelope(planRows.map(row => row.net)) : PowerDraw.sum(planRows.map(row => row.net)),
			shards: parallel
				? planRows.reduce((max, row) => Math.max(max, row.shards), 0)
				: planRows.reduce((sum, row) => sum + row.shards, 0),
			sloops: parallel
				? planRows.reduce((max, row) => Math.max(max, row.sloops), 0)
				: planRows.reduce((sum, row) => sum + row.sloops, 0),
		};
	}

	/** Sum, or (parallel pool) the largest single share - the envelope of the branches. */
	private combine(shares: readonly PlanAmount[], parallel: boolean): number
	{
		return parallel
			? shares.reduce((max, share) => Math.max(max, share.amount), 0)
			: shares.reduce((sum, share) => sum + share.amount, 0);
	}

	/** Element-wise max of power draws - the envelope of buffer-decoupled branches. */
	private envelope(draws: readonly PowerDraw[]): PowerDraw
	{
		return draws.reduce(
			(max, draw) => new PowerDraw(Math.max(max.average, draw.average), Math.max(max.min, draw.min), Math.max(max.max, draw.max)),
			PowerDraw.ZERO,
		);
	}

	/**
	 * Parallel-pool buildings: derived from the already-enveloped recipe rows
	 * (grouped by their producing building) so a machine type shared by two
	 * branches through the same recipe is counted once, while the same machine
	 * type used for different recipes in different branches still adds up.
	 * Generators are not recipe-driven and are omitted from this view.
	 */
	private buildingsFromRecipes(recipes: FolderRecipeRow[]): FolderBuildingRow[]
	{
		const rows = new Map<string, {key: string; name: string; icon: string | null; machines: number; plans: PlanAmount[]}>();
		recipes.forEach(recipeRow => {
			const building = recipeRow.recipe.producedIn[0];
			if (!building) {
				return;
			}
			const entry = rows.get(building.className)
				?? {key: building.className, name: building.name, icon: building.icon, machines: 0, plans: []};
			entry.machines += recipeRow.machines;
			recipeRow.plans.forEach(share => {
				const existing = entry.plans.find(p => p.planId === share.planId);
				if (existing) {
					entry.plans = entry.plans.map(p => p.planId === share.planId ? {...p, amount: p.amount + share.amount} : p);
				} else {
					entry.plans.push({...share});
				}
			});
			rows.set(building.className, entry);
		});
		return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	private resources(folder: Folder, plans: Plan[], folderLimits: boolean, parallel: boolean): FolderResourceRow[]
	{
		const data = this.versionManager.activeVersionData();
		if (!data) {
			return [];
		}
		const limits = folderLimits ? folder.settings?.resourceLimits ?? {} : {};
		const disabled = new Set(folderLimits ? folder.settings?.disabledResources ?? [] : []);
		const perPlan = plans.map(plan => ({plan, rows: this.breakdown.resources(plan)}));

		return data.resources
			.map(className => data.searchItemByClassName(className))
			.filter((item): item is Item => item !== undefined)
			.sort((a, b) => a.name.localeCompare(b.name))
			.map(item => {
				const shares = perPlan
					.map(({plan, rows}) => this.share(plan, rows.find(row => row.item.className === item.className)?.used ?? 0))
					.filter(share => share.amount > 0);
				return {
					item,
					used: this.combine(shares, parallel),
					limit: folderLimits ? limits[item.className] ?? null : null,
					disabled: disabled.has(item.className),
					plans: shares,
				};
			});
	}

	private production(plans: Plan[], parallel: boolean): FolderProductionRow[]
	{
		const rows = new Map<string, {item: Item; kind: 'product' | 'byproduct'; plans: PlanAmount[]}>();
		plans.forEach(plan => this.breakdown.production(plan).forEach(row => {
			const key = `${row.kind}:${row.item.className}`;
			const entry = rows.get(key) ?? {item: row.item, kind: row.kind, plans: []};
			entry.plans.push(this.share(plan, row.amount));
			rows.set(key, entry);
		}));
		return [...rows.values()]
			.map(entry => ({...entry, amount: this.combine(entry.plans, parallel)}))
			.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'product' ? -1 : 1) || a.item.name.localeCompare(b.item.name));
	}

	private buildings(plans: Plan[]): FolderBuildingRow[]
	{
		const rows = new Map<string, {key: string; name: string; icon: string | null; plans: PlanAmount[]}>();
		plans.forEach(plan => this.breakdown.buildingsRecursive(plan).forEach(row => {
			const entry = rows.get(row.key) ?? {key: row.key, name: row.name, icon: row.icon, plans: []};
			entry.plans.push(this.share(plan, row.machines));
			rows.set(row.key, entry);
		}));
		return [...rows.values()]
			.map(entry => ({...entry, machines: entry.plans.reduce((sum, share) => sum + share.amount, 0)}))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	private recipes(plans: Plan[], parallel: boolean): FolderRecipeRow[]
	{
		const rows = new Map<string, {recipe: FolderRecipeRow['recipe']; plans: PlanAmount[]}>();
		plans.forEach(plan => this.breakdown.recipes(plan).forEach(row => {
			const entry = rows.get(row.recipe.className) ?? {recipe: row.recipe, plans: []};
			entry.plans.push(this.share(plan, row.machines));
			rows.set(row.recipe.className, entry);
		}));
		return [...rows.values()]
			.map(entry => ({...entry, machines: this.combine(entry.plans, parallel)}))
			.sort((a, b) => a.recipe.name.localeCompare(b.recipe.name));
	}

	private share(plan: Plan, amount: number): PlanAmount
	{
		return {planId: plan.id, name: this.planNames.displayName(plan), amount};
	}

}
