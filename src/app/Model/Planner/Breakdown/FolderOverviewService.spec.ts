import {describe, expect, it} from 'vitest';
import {Folder} from '@src/Model/Planner/Folder';
import {FolderOverviewService} from '@src/Model/Planner/Breakdown/FolderOverviewService';
import {PowerDraw} from '@src/Model/Planner/PowerDraw';

/**
 * Fork feature: a folder pooling raw resources in `parallel` mode treats its
 * plans as buffer-decoupled branches. The overview then reports their
 * envelope (max per recipe / resource / product), not their sum - shared
 * upstream steps (same recipe in every branch) collapse to one, divergent
 * downstream steps (different recipes) still add up.
 *
 * Worked example: one 240/min iron-ore node feeds a rod branch and a plate
 * branch. Each branch, solved on its own against the full node, is:
 *   rods:   8 Smelter (ingot) + 6 Constructor (rod)   -> 240 rod/min
 *   plates: 8 Smelter (ingot) + 12 Constructor (plate) -> 160 plate/min
 * Built together, sharing the smelting: 8 Smelter + 18 Constructor, 240 ore.
 */

const oreItem = {className: 'Desc_OreIron_C', name: 'Iron Ore'};
const rodItem = {className: 'Desc_IronRod_C', name: 'Iron Rod'};
const plateItem = {className: 'Desc_IronPlate_C', name: 'Iron Plate'};

const smelter = {className: 'Build_SmelterMk1_C', name: 'Smelter', icon: 'smelter'};
const constructor_ = {className: 'Build_ConstructorMk1_C', name: 'Constructor', icon: 'constructor'};

const ingotRecipe = {className: 'Recipe_IngotIron_C', name: 'Iron Ingot', producedIn: [smelter]};
const rodRecipe = {className: 'Recipe_IronRod_C', name: 'Iron Rod', producedIn: [constructor_]};
const plateRecipe = {className: 'Recipe_IronPlate_C', name: 'Iron Plate', producedIn: [constructor_]};

const perPlan: Record<string, {
	recipes: {recipe: unknown; machines: number}[];
	resources: {item: unknown; used: number}[];
	production: {item: unknown; kind: 'product'; amount: number}[];
	power: number;
}> = {
	rods: {
		recipes: [{recipe: ingotRecipe, machines: 8}, {recipe: rodRecipe, machines: 6}],
		resources: [{item: oreItem, used: 240}],
		production: [{item: rodItem, kind: 'product', amount: 240}],
		power: 28,
	},
	plates: {
		recipes: [{recipe: ingotRecipe, machines: 8}, {recipe: plateRecipe, machines: 12}],
		resources: [{item: oreItem, used: 240}],
		production: [{item: plateItem, kind: 'product', amount: 160}],
		power: 40,
	},
};

const plans = [
	{id: 'rods', name: 'Rods', parentPlanId: null, settings: {calculationMode: 'automatic'}, metadata: {}},
	{id: 'plates', name: 'Plates', parentPlanId: null, settings: {calculationMode: 'automatic'}, metadata: {}},
];

function folder(resourcePoolMode: Folder['resourcePoolMode']): Folder
{
	return {
		id: 'f1', name: 'Iron', parentId: null,
		settings: {calculationMode: 'automatic', resourceLimits: {[oreItem.className]: 240}} as Folder['settings'],
		fixedGroups: ['resources'], resourcePool: true, resourcePoolMode, revision: null,
	};
}

function service(): FolderOverviewService
{
	const planManager = {
		innerPlans: () => plans,
		folderGroupMode: () => 'pool',
	};
	const breakdown = {
		power: (p: {id: string}): unknown => ({
			rows: [], consumption: PowerDraw.fixed(perPlan[p.id].power), production: 0, net: PowerDraw.fixed(-perPlan[p.id].power),
		}),
		buildCost: (p: {id: string}) => ({
			rows: [], materials: [], shards: 0, sloops: 0,
			machines: perPlan[p.id].recipes.reduce((s, r) => s + r.machines, 0),
		}),
		resources: (p: {id: string}) => perPlan[p.id].resources,
		production: (p: {id: string}) => perPlan[p.id].production,
		recipes: (p: {id: string}) => perPlan[p.id].recipes,
		buildingsRecursive: (p: {id: string}) => perPlan[p.id].recipes.map(r => ({
			key: (r.recipe as typeof ingotRecipe).producedIn[0].className,
			name: (r.recipe as typeof ingotRecipe).producedIn[0].name,
			icon: null, kind: 'machine' as const, machines: r.machines, shards: 0, sloops: 0, materials: [],
		})),
	};
	const pool = {overUsed: () => []};
	const planNames = {displayName: (p: {name: string}) => p.name};
	const versionManager = {
		activeVersionData: () => ({
			resources: [oreItem.className],
			searchItemByClassName: (c: string) => (c === oreItem.className ? oreItem : undefined),
		}),
	};
	return new FolderOverviewService(
		planManager as never, breakdown as never, pool as never, planNames as never, versionManager as never,
	);
}

describe('FolderOverviewService parallel pool', () => {
	it('flags the overview as a parallel pool', () => {
		expect(service().overview(folder('parallel')).parallelPool).toBe(true);
		expect(service().overview(folder('shared')).parallelPool).toBe(false);
	});

	it('takes the envelope of raw-resource extraction, not the sum', () => {
		const parallel = service().overview(folder('parallel'));
		const shared = service().overview(folder('shared'));
		expect(parallel.resources.find(r => r.item.className === oreItem.className)?.used).toBe(240);
		expect(shared.resources.find(r => r.item.className === oreItem.className)?.used).toBe(480);
	});

	it('collapses a recipe shared by every branch, keeps divergent recipes apart', () => {
		const recipes = service().overview(folder('parallel')).recipes;
		expect(recipes.find(r => r.recipe.className === ingotRecipe.className)?.machines).toBe(8);
		expect(recipes.find(r => r.recipe.className === rodRecipe.className)?.machines).toBe(6);
		expect(recipes.find(r => r.recipe.className === plateRecipe.className)?.machines).toBe(12);
	});

	it('derives buildings from the recipe envelope: 8 Smelter, 18 Constructor', () => {
		const overview = service().overview(folder('parallel'));
		expect(overview.buildings.find(b => b.key === smelter.className)?.machines).toBe(8);
		expect(overview.buildings.find(b => b.key === constructor_.className)?.machines).toBe(18);
		expect(overview.totalBuildings).toBe(26);
	});

	it('sums buildings in shared mode (16 Smelter, 18 Constructor)', () => {
		const overview = service().overview(folder('shared'));
		expect(overview.buildings.find(b => b.key === smelter.className)?.machines).toBe(16);
		expect(overview.buildings.find(b => b.key === constructor_.className)?.machines).toBe(18);
	});

	it('keeps each branch\'s own product and takes the power envelope', () => {
		const overview = service().overview(folder('parallel'));
		const byItem = Object.fromEntries(overview.production.map(p => [p.item.className, p.amount]));
		expect(byItem[rodItem.className]).toBe(240);
		expect(byItem[plateItem.className]).toBe(160);
		expect(overview.consumption.average).toBe(40);
	});
});
