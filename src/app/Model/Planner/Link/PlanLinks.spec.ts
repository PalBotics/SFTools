import {describe, expect, it} from 'vitest';
import {Graph} from '@src/Model/Planner/Graph/Graph';
import {LinkStaleness} from '@src/Model/Planner/Link/LinkStaleness';
import {PlanDependencyOrder} from '@src/Model/Planner/Link/PlanDependencyOrder';
import {PlanOutputs} from '@src/Model/Planner/Link/PlanOutputs';
import {Plan} from '@src/Model/Planner/Plan';
import {PlanInput} from '@src/Model/Planner/PlanInput';

/** A stored graph as raw JSON: just the node fields the link logic reads. */
const graphOf = (...nodes: {type: string; itemClassName: string; amount: number}[]) => ({nodes, edges: []}) as unknown as Graph;

function plan(id: string, options: {inputs?: PlanInput[]; graph?: Graph | null; stale?: boolean} = {}): Plan
{
	return {
		id,
		name: id,
		description: '',
		folderId: null,
		parentPlanId: null,
		settings: {calculationMode: 'automatic'} as Plan['settings'],
		requests: [],
		inputs: options.inputs ?? [],
		graph: options.graph === undefined ? graphOf() : options.graph,
		metadata: {graphDirty: false, recalculationNeeded: options.stale ? true : undefined},
		revision: null,
	};
}

const link = (itemClassName: string, sourcePlanId: string): PlanInput => ({itemClassName, amount: 0, weight: 0, sourcePlanId});

describe('PlanOutputs', () => {
	it('sums products and byproducts per item from raw stored JSON', () => {
		const outputs = PlanOutputs.amounts(graphOf(
			{type: 'product', itemClassName: 'Rotor', amount: 10},
			{type: 'product', itemClassName: 'Rotor', amount: 5},
			{type: 'byproduct', itemClassName: 'Water', amount: 3},
			{type: 'mine', itemClassName: 'Ore', amount: 99},
			{type: 'input', itemClassName: 'Stator', amount: 7},
		));
		expect([...outputs.entries()].sort()).toEqual([['Rotor', 15], ['Water', 3]]);
	});

	it('reads revived nodes (item.className) the same way', () => {
		const revived = {nodes: [{type: 'product', amount: 4, item: {className: 'Rotor'}}]};
		expect(PlanOutputs.amounts(revived).get('Rotor')).toBe(4);
	});

	it('reports what a plan draws from Input rows', () => {
		const drawn = PlanOutputs.drawn(graphOf(
			{type: 'input', itemClassName: 'Stator', amount: 7},
			{type: 'product', itemClassName: 'Motor', amount: 2},
		));
		expect([...drawn.entries()]).toEqual([['Stator', 7]]);
	});

	it('handles no graph', () => {
		expect(PlanOutputs.amounts(null).size).toBe(0);
		expect(PlanOutputs.amounts(undefined).size).toBe(0);
	});

	it('compares maps to within float noise, in both directions', () => {
		const a = new Map([['Rotor', 10]]);
		expect(PlanOutputs.same(a, new Map([['Rotor', 10 + 1e-9]]))).toBe(true);
		expect(PlanOutputs.same(a, new Map([['Rotor', 10.5]]))).toBe(false);
		expect(PlanOutputs.same(a, new Map())).toBe(false);
		expect(PlanOutputs.same(new Map(), a)).toBe(false);
	});
});

describe('PlanDependencyOrder', () => {
	it('keeps the given order when nothing is linked', () => {
		expect(PlanDependencyOrder.sort([plan('a'), plan('b'), plan('c')]).map(p => p.id)).toEqual(['a', 'b', 'c']);
	});

	it('puts a source plan before the plans pulling from it', () => {
		// tree order is consumer, then its source
		const order = PlanDependencyOrder.sort([plan('motors', {inputs: [link('Stator', 'stators')]}), plan('stators')]);
		expect(order.map(p => p.id)).toEqual(['stators', 'motors']);
	});

	it('moves a source only as far as it must - the rest keep their order', () => {
		const order = PlanDependencyOrder.sort([
			plan('a'),
			plan('motors', {inputs: [link('Stator', 'stators')]}),
			plan('b'),
			plan('stators'),
		]);
		expect(order.map(p => p.id)).toEqual(['a', 'b', 'stators', 'motors']);
	});

	it('follows chains', () => {
		const order = PlanDependencyOrder.sort([
			plan('c', {inputs: [link('X', 'b')]}),
			plan('b', {inputs: [link('X', 'a')]}),
			plan('a'),
		]);
		expect(order.map(p => p.id)).toEqual(['a', 'b', 'c']);
	});

	it('ignores links to plans outside the set and to itself', () => {
		const order = PlanDependencyOrder.sort([
			plan('a', {inputs: [link('X', 'elsewhere'), link('X', 'a')]}),
			plan('b'),
		]);
		expect(order.map(p => p.id)).toEqual(['a', 'b']);
	});

	it('terminates on a cycle, keeping its members in the given order', () => {
		const order = PlanDependencyOrder.sort([
			plan('a', {inputs: [link('X', 'b')]}),
			plan('b', {inputs: [link('X', 'a')]}),
			plan('free'),
		]);
		expect(order.map(p => p.id).sort()).toEqual(['a', 'b', 'free']);
		expect(order).toHaveLength(3);
	});
});

describe('LinkStaleness.flagSiblings', () => {
	const withReserve = (sourcePlanId: string, reserve?: number): PlanInput => ({...link('Stator', sourcePlanId), reserve});

	it('flags the other plans pulling the same output when a reservation changes', () => {
		const plans = [plan('holder'), plan('other', {inputs: [link('Stator', 'stators')]}), plan('unrelated', {inputs: [link('Stator', 'elsewhere')]})];
		const flagged = LinkStaleness.flagSiblings(plans, 'holder', [withReserve('stators')], [withReserve('stators', 30)]);
		expect(flagged.find(p => p.id === 'other')!.metadata.recalculationNeeded).toBe(true);
		expect(flagged.find(p => p.id === 'unrelated')!.metadata.recalculationNeeded).toBeUndefined();
		expect(flagged.find(p => p.id === 'holder')!.metadata.recalculationNeeded).toBeUndefined();
	});

	it('flags them when a reservation is resized or dropped as well', () => {
		const plans = [plan('other', {inputs: [link('Stator', 'stators')]})];
		expect(LinkStaleness.flagSiblings(plans, 'holder', [withReserve('stators', 30)], [withReserve('stators', 50)])[0].metadata.recalculationNeeded).toBe(true);
		expect(LinkStaleness.flagSiblings(plans, 'holder', [withReserve('stators', 30)], [withReserve('stators')])[0].metadata.recalculationNeeded).toBe(true);
	});

	it('flags them when a reserved link is removed, freeing the reservation', () => {
		const plans = [plan('other', {inputs: [link('Stator', 'stators')]})];
		expect(LinkStaleness.flagSiblings(plans, 'holder', [withReserve('stators', 30)], [])[0].metadata.recalculationNeeded).toBe(true);
	});

	it('does nothing when no reservation changed (same array back)', () => {
		const plans = [plan('other', {inputs: [link('Stator', 'stators')]})];
		expect(LinkStaleness.flagSiblings(plans, 'holder', [withReserve('stators', 30)], [withReserve('stators', 30)])).toBe(plans);
		// a brand-new link with no reservation changes nothing for the others
		expect(LinkStaleness.flagSiblings(plans, 'holder', [], [withReserve('stators')])).toBe(plans);
	});

	it('leaves plans that were never calculated or are already flagged alone', () => {
		const plans = [
			plan('fresh', {inputs: [link('Stator', 'stators')], graph: null}),
			plan('already', {inputs: [link('Stator', 'stators')], stale: true}),
		];
		expect(LinkStaleness.flagSiblings(plans, 'holder', [], [withReserve('stators', 30)])).toBe(plans);
	});
});

describe('LinkStaleness.flagDependents', () => {
	const before = graphOf({type: 'product', itemClassName: 'Stator', amount: 100});
	const same = graphOf({type: 'product', itemClassName: 'Stator', amount: 100});
	const changed = graphOf({type: 'product', itemClassName: 'Stator', amount: 150});

	it('flags the plans pulling from a source whose output changed', () => {
		const plans = [plan('stators'), plan('motors', {inputs: [link('Stator', 'stators')]}), plan('other')];
		const flagged = LinkStaleness.flagDependents(plans, 'stators', before, changed);
		expect(flagged.find(p => p.id === 'motors')!.metadata.recalculationNeeded).toBe(true);
		expect(flagged.find(p => p.id === 'other')!.metadata.recalculationNeeded).toBeUndefined();
		expect(flagged.find(p => p.id === 'stators')!.metadata.recalculationNeeded).toBeUndefined();
	});

	it('does nothing when the output is unchanged (same array back)', () => {
		const plans = [plan('stators'), plan('motors', {inputs: [link('Stator', 'stators')]})];
		expect(LinkStaleness.flagDependents(plans, 'stators', before, same)).toBe(plans);
	});

	it('does not flag a dependent that was never calculated', () => {
		const plans = [plan('motors', {inputs: [link('Stator', 'stators')], graph: null})];
		expect(LinkStaleness.flagDependents(plans, 'stators', before, changed)).toBe(plans);
	});

	it('does not re-flag a plan that is already flagged (same array back)', () => {
		const plans = [plan('motors', {inputs: [link('Stator', 'stators')], stale: true})];
		expect(LinkStaleness.flagDependents(plans, 'stators', before, changed)).toBe(plans);
	});

	it('treats a source going from nothing to something as a change', () => {
		const plans = [plan('motors', {inputs: [link('Stator', 'stators')]})];
		const flagged = LinkStaleness.flagDependents(plans, 'stators', null, changed);
		expect(flagged[0].metadata.recalculationNeeded).toBe(true);
	});
});
