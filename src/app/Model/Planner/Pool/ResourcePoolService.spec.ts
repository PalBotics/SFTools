import {describe, expect, it} from 'vitest';
import {Folder} from '@src/Model/Planner/Folder';
import {Plan} from '@src/Model/Planner/Plan';
import {ResourcePoolService} from '@src/Model/Planner/Pool/ResourcePoolService';

/**
 * Fork feature: a folder's raw-resource pool can be divided `shared` (each
 * plan gets what the others left) or `parallel` (every plan sees the full
 * budget). Only effectiveLimits() feeds the solver, so it is what matters.
 */

const IRON = 'Desc_OreIron_C';

function plan(id: string, limits: Record<string, number>, mined: Record<string, number> = {}): Plan
{
	return {
		id,
		name: id,
		description: '',
		folderId: 'f1',
		parentPlanId: null,
		settings: {calculationMode: 'automatic', resourceLimits: limits} as Plan['settings'],
		requests: [],
		inputs: [],
		graph: {
			nodes: Object.entries(mined).map(([itemClassName, amount]) => ({type: 'mine', itemClassName, amount})),
			edges: [],
		} as unknown as Plan['graph'],
		metadata: {},
		revision: null,
	};
}

function folder(resourcePoolMode: Folder['resourcePoolMode']): Folder
{
	return {
		id: 'f1',
		name: 'Iron',
		parentId: null,
		settings: {calculationMode: 'automatic', resourceLimits: {[IRON]: 240}} as Folder['settings'],
		fixedGroups: ['resources'],
		resourcePool: true,
		resourcePoolMode,
		revision: null,
	};
}

function service(theFolder: Folder | null, plans: Plan[]): ResourcePoolService
{
	const planManager = {
		poolFolderOf: () => theFolder,
		innerPlans: () => plans,
	};
	return new ResourcePoolService(planManager as never, {activeVersionData: () => null} as never);
}

describe('ResourcePoolService.effectiveLimits', () => {
	it('shared pool: a plan may only mine what its siblings left', () => {
		const rods = plan('rods', {[IRON]: 240}, {[IRON]: 200});
		const plates = plan('plates', {[IRON]: 240});
		const limits = service(folder('shared'), [rods, plates]).effectiveLimits(plates);
		expect(limits[IRON]).toBe(40);
	});

	it('parallel pool: every plan sees the folder\'s full budget regardless of siblings', () => {
		const rods = plan('rods', {[IRON]: 240}, {[IRON]: 200});
		const plates = plan('plates', {[IRON]: 240});
		const limits = service(folder('parallel'), [rods, plates]).effectiveLimits(plates);
		expect(limits[IRON]).toBe(240);
	});

	it('parallel pool: disabled resources still clamp to zero', () => {
		const rods = plan('rods', {[IRON]: 240});
		rods.settings = {...rods.settings, disabledResources: [IRON]} as Plan['settings'];
		const limits = service(folder('parallel'), [rods]).effectiveLimits(rods);
		expect(limits[IRON]).toBe(0);
	});

	it('no pool folder: limits pass through untouched', () => {
		const solo = plan('solo', {[IRON]: 120});
		const limits = service(null, [solo]).effectiveLimits(solo);
		expect(limits[IRON]).toBe(120);
	});
});
