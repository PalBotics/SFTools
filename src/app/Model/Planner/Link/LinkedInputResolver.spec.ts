import {describe, expect, it} from 'vitest';
import {Graph} from '@src/Model/Planner/Graph/Graph';
import {LinkedInputResolver} from '@src/Model/Planner/Link/LinkedInputResolver';
import {Plan} from '@src/Model/Planner/Plan';
import {PlanInput} from '@src/Model/Planner/PlanInput';

/**
 * Pulling ingredients from another plan's output: a linked Input row becomes
 * whatever that plan's stored graph outputs of the item.
 *
 *   "Stators" plan outputs 100 Stator/min   ->   "Motors" plan draws it.
 */

type RawNode = {type: string; itemClassName: string; amount: number};
const graphOf = (...nodes: RawNode[]) => ({nodes, edges: []}) as unknown as Graph;

function plan(id: string, options: {inputs?: PlanInput[]; graph?: Graph | null; sizing?: 'balanced' | 'capacity'; parent?: string} = {}): Plan
{
	return {
		id,
		name: id,
		description: '',
		folderId: null,
		parentPlanId: options.parent ?? null,
		settings: {calculationMode: 'automatic', sizing: options.sizing} as Plan['settings'],
		requests: [],
		inputs: options.inputs ?? [],
		graph: options.graph === undefined ? null : options.graph,
		metadata: {graphDirty: false},
		revision: null,
	};
}

const product = (itemClassName: string, amount: number): RawNode => ({type: 'product', itemClassName, amount});
const input = (itemClassName: string, amount: number): RawNode => ({type: 'input', itemClassName, amount});
const link = (itemClassName: string, sourcePlanId: string, amount = 0): PlanInput => ({itemClassName, amount, weight: 0, sourcePlanId});

/** A fresh resolver per scenario - the store here is a plain function, not a signal, so it must not outlive one. */
function resolverFor(plans: Plan[]): LinkedInputResolver
{
	return new LinkedInputResolver({plans: () => plans} as never);
}

const stators = () => plan('stators', {graph: graphOf(product('Stator', 100), {type: 'byproduct', itemClassName: 'Water', amount: 12})});

describe('LinkedInputResolver.effectiveInputs', () => {
	it('passes typed rows through untouched', () => {
		const typed: PlanInput = {itemClassName: 'Stator', amount: 40, weight: 3};
		const motors = plan('motors', {inputs: [typed]});
		expect(resolverFor([motors]).effectiveInputs(motors)[0]).toBe(typed);
	});

	it('turns a linked row into the source plan\'s output of the item', () => {
		const motors = plan('motors', {inputs: [link('Stator', 'stators')]});
		const [resolved] = resolverFor([stators(), motors]).effectiveInputs(motors);
		expect(resolved).toMatchObject({itemClassName: 'Stator', amount: 100, sourcePlanId: 'stators'});
	});

	it('also reaches the source\'s byproducts', () => {
		const pumps = plan('pumps', {inputs: [link('Water', 'stators')]});
		expect(resolverFor([stators(), pumps]).effectiveInputs(pumps)[0].amount).toBe(12);
	});

	it('keeps the typed amount underneath ignored while linked', () => {
		const motors = plan('motors', {inputs: [link('Stator', 'stators', 5)]});
		expect(resolverFor([stators(), motors]).effectiveInputs(motors)[0].amount).toBe(100);
	});

	it('supplies nothing when the source plan is gone, or is the plan itself', () => {
		const lonely = plan('lonely', {inputs: [link('Stator', 'deleted'), link('Stator', 'lonely')]});
		const [gone, self] = resolverFor([lonely]).effectiveInputs(lonely);
		expect(gone.amount).toBe(0);
		expect(self.amount).toBe(0);
	});

	it('supplies nothing when the source stopped making the item', () => {
		const motors = plan('motors', {inputs: [link('Stator', 'stators')]});
		const nothing = plan('stators', {graph: graphOf(product('Rotor', 9))});
		expect(resolverFor([nothing, motors]).effectiveInputs(motors)[0].amount).toBe(0);
	});

	it('gives a second row linking the same plan and item nothing, so the solver does not double-count', () => {
		const motors = plan('motors', {inputs: [link('Stator', 'stators'), link('Stator', 'stators')]});
		const resolved = resolverFor([stators(), motors]).effectiveInputs(motors);
		expect(resolved.map(r => r.amount)).toEqual([100, 0]);
	});
});

describe('LinkedInputResolver sharing between plans pulling from one source', () => {
	// Two consumers of the same 100 Stator/min. The first already draws 70 per its stored graph.
	const first = () => plan('first', {inputs: [link('Stator', 'stators')], graph: graphOf(input('Stator', 70))});
	const second = (sizing?: 'balanced' | 'capacity') => plan('second', {inputs: [link('Stator', 'stators')], sizing});

	it('balanced sizing: a plan gets what the source makes minus what the others already draw', () => {
		const consumer = second('balanced');
		const resolver = resolverFor([stators(), first(), consumer]);
		expect(resolver.sharingOf(consumer)).toBe('exclusive');
		expect(resolver.effectiveInputs(consumer)[0].amount).toBe(30);
	});

	it('balanced sizing: never goes below zero', () => {
		const greedy = plan('first', {inputs: [link('Stator', 'stators')], graph: graphOf(input('Stator', 250))});
		const consumer = second();
		expect(resolverFor([stators(), greedy, consumer]).effectiveInputs(consumer)[0].amount).toBe(0);
	});

	it('capacity sizing: every plan sees the source\'s full output', () => {
		const consumer = second('capacity');
		const resolver = resolverFor([stators(), first(), consumer]);
		expect(resolver.sharingOf(consumer)).toBe('shared');
		expect(resolver.effectiveInputs(consumer)[0].amount).toBe(100);
	});

	it('only counts others pulling the same item from the same source', () => {
		const elsewhere = plan('elsewhere', {inputs: [link('Stator', 'someone-else')], graph: graphOf(input('Stator', 90))});
		const consumer = second();
		expect(resolverFor([stators(), elsewhere, consumer]).effectiveInputs(consumer)[0].amount).toBe(100);
	});

	it('does not count the plan\'s own draw against itself', () => {
		const self = plan('self', {inputs: [link('Stator', 'stators')], graph: graphOf(input('Stator', 100))});
		expect(resolverFor([stators(), self]).effectiveInputs(self)[0].amount).toBe(100);
	});
});

describe('LinkedInputResolver.options / dependents', () => {
	it('offers other top-level plans that output the item, never itself or a subplan', () => {
		const motors = plan('motors');
		const subplan = plan('sub', {graph: graphOf(product('Stator', 5)), parent: 'stators'});
		const options = resolverFor([stators(), subplan, motors, plan('rotors', {graph: graphOf(product('Rotor', 1))})])
			.options(motors, 'Stator');
		expect(options.map(o => [o.planId, o.output])).toEqual([['stators', 100]]);
	});

	it('does not offer the plan itself even though it outputs the item', () => {
		const self = plan('stators', {graph: graphOf(product('Stator', 100))});
		expect(resolverFor([self]).options(self, 'Stator')).toEqual([]);
	});

	it('keeps the current source listed after it stops making the item, and after it is deleted', () => {
		const motors = plan('motors');
		const stopped = plan('stators', {graph: graphOf(product('Rotor', 1))});
		expect(resolverFor([stopped, motors]).options(motors, 'Stator', 'stators'))
			.toMatchObject([{planId: 'stators', output: 0}]);
		expect(resolverFor([motors]).options(motors, 'Stator', 'deleted'))
			.toEqual([{plan: null, planId: 'deleted', output: 0}]);
	});

	it('lists the plans pulling from a given plan', () => {
		const motors = plan('motors', {inputs: [link('Stator', 'stators')]});
		const other = plan('other');
		expect(resolverFor([stators(), motors, other]).dependents('stators').map(p => p.id)).toEqual(['motors']);
	});

	it('names the linked plan (or null when it is typed or gone)', () => {
		const resolver = resolverFor([stators()]);
		expect(resolver.sourceOf(link('Stator', 'stators'))?.id).toBe('stators');
		expect(resolver.sourceOf(link('Stator', 'deleted'))).toBeNull();
		expect(resolver.sourceOf({itemClassName: 'Stator', amount: 1, weight: 0})).toBeNull();
	});
});
