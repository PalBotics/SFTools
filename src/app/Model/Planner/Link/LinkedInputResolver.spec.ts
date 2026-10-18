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

describe('LinkedInputResolver reservations (balanced sizing)', () => {
	// One 100 Stator/min source; plans pull it with an optional reservation and an optional stored draw.
	const puller = (id: string, options: {reserve?: number; drawn?: number; sizing?: 'balanced' | 'capacity'} = {}) => plan(id, {
		inputs: [{...link('Stator', 'stators'), reserve: options.reserve}],
		graph: options.drawn === undefined ? null : graphOf(input('Stator', options.drawn)),
		sizing: options.sizing,
	});
	const availableTo = (target: Plan, ...everyone: Plan[]) =>
		resolverFor([stators(), ...everyone]).effectiveInputs(target)[0].amount;

	it('holds the reservation back from the others even though the holder has drawn nothing', () => {
		const holder = puller('holder', {reserve: 60});
		const other = puller('other');
		expect(availableTo(other, holder, other)).toBe(40);
	});

	it('gives the holder its reservation plus a share of what is left', () => {
		const holder = puller('holder', {reserve: 60});
		const other = puller('other', {drawn: 30});
		// 60 reserved + (40 pool - 30 the other already draws)
		expect(availableTo(holder, holder, other)).toBe(70);
	});

	it('counts only the part of a holder draw that is beyond its reservation against the shared pool', () => {
		const holder = puller('holder', {reserve: 20, drawn: 50});
		const other = puller('other');
		// 100 - 20 reserved = 80 pool, the holder uses 30 of it beyond its reserve
		expect(availableTo(other, holder, other)).toBe(50);
	});

	it('is the same as no reservations when nobody reserves anything', () => {
		const first = puller('first', {drawn: 70});
		const second = puller('second');
		expect(availableTo(second, first, second)).toBe(30);
	});

	it('scales every reservation down together when they add up to more than the source makes', () => {
		const a = puller('a', {reserve: 80});
		const b = puller('b', {reserve: 80});
		expect(availableTo(a, a, b)).toBe(50);
		expect(availableTo(b, a, b)).toBe(50);
	});

	it('never lets one over-sized reservation exceed the output', () => {
		const greedy = puller('greedy', {reserve: 150});
		expect(availableTo(greedy, greedy)).toBe(100);
	});

	it('ignores a reservation that is not a positive number', () => {
		const odd = puller('odd', {reserve: -5});
		const nan = puller('nan', {reserve: Number.NaN});
		const other = puller('other');
		expect(availableTo(other, odd, nan, other)).toBe(100);
	});

	it('does not apply to buffered-capacity plans, which see the full output', () => {
		const holder = puller('holder', {reserve: 60});
		const capacity = puller('capacity', {sizing: 'capacity'});
		expect(availableTo(capacity, holder, capacity)).toBe(100);
	});

	it('only counts the first row of a plan for one source and item, like the resolver does', () => {
		const twice = plan('twice', {inputs: [{...link('Stator', 'stators'), reserve: 10}, {...link('Stator', 'stators'), reserve: 70}]});
		const other = puller('other');
		expect(availableTo(other, twice, other)).toBe(90);
	});

	it('summarises how much is reserved and whether it is too much', () => {
		const a = puller('a', {reserve: 80});
		const b = puller('b', {reserve: 80});
		const resolver = resolverFor([stators(), a, b]);
		expect(resolver.reservationSummary(a, a.inputs[0])).toEqual({output: 100, totalReserved: 160, overReserved: true});
		const fine = puller('fine', {reserve: 20});
		expect(resolverFor([stators(), fine]).reservationSummary(fine, fine.inputs[0]).overReserved).toBe(false);
	});

	it('shows how much the other plans have reserved on each option', () => {
		const holder = puller('holder', {reserve: 35});
		const me = plan('me');
		const [option] = resolverFor([stators(), holder, me]).options(me, 'Stator');
		expect(option).toMatchObject({planId: 'stators', output: 100, reservedByOthers: 35});
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
			.toEqual([{plan: null, planId: 'deleted', output: 0, reservedByOthers: 0}]);
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
