import {describe, expect, it} from 'vitest';
import {CapacityGraph, CapacityRecipe} from '@src/Model/Planner/Capacity/CapacityGraph';
import {CapacityPropagator} from '@src/Model/Planner/Capacity/CapacityPropagator';

/**
 * Fork feature: size every line to consume 100% of its upstream buffers.
 *
 * Rates below are items/min per one machine at 100% clock
 * (= recipe amount x 60 / recipe.time x machine speed).
 *   Smelter  iron ingot : 1 ore  -> 1 ingot , 30/min
 *   Constr.  iron plate : 3 ingot-> 2 plate , 10 cycles/min -> 30 ingot / 20 plate
 *   Constr.  iron rod   : 1 ingot-> 1 rod   , 15/min
 *   Constr.  screw      : 1 rod  -> 4 screw , 10 cycles/min -> 10 rod / 40 screw
 *   Assemb.  RIP        : 6 plate + 12 screw -> 3 RIP, 5 cycles/min
 */

const r = (id: string, ingredients: [string, number][], products: [string, number][]): CapacityRecipe => ({
	id,
	ingredients: ingredients.map(([itemClassName, perMachineMinute]) => ({itemClassName, perMachineMinute})),
	products: products.map(([itemClassName, perMachineMinute]) => ({itemClassName, perMachineMinute})),
});

const ingot = r('ingot', [['ore', 30]], [['ingot', 30]]);
const plate = r('plate', [['ingot', 30]], [['plate', 20]]);
const rod = r('rod', [['ingot', 15]], [['rod', 15]]);
const screw = r('screw', [['rod', 10]], [['screw', 40]]);
const rip = r('rip', [['plate', 30], ['screw', 60]], [['rip', 15]]);

function propagate(graph: CapacityGraph) {
	return new CapacityPropagator().propagate(graph);
}

describe('CapacityPropagator', () => {
	it('sizes one line to the raw supply', () => {
		const {targets, itemCapacity} = propagate({recipes: [ingot], sources: {ore: 240}});
		expect(targets.ingot).toBeCloseTo(8);
		expect(itemCapacity.ingot).toBeCloseTo(240);
	});

	it('gives every consumer of a buffer the full buffer, not a split', () => {
		const {targets, itemCapacity, itemDemand} = propagate({
			recipes: [ingot, plate, rod],
			sources: {ore: 240},
		});
		// both plate and rod see the whole 240 ingot/min
		expect(targets.plate).toBeCloseTo(8);   // 240 / 30
		expect(targets.rod).toBeCloseTo(16);    // 240 / 15
		expect(itemCapacity.plate).toBeCloseTo(160);
		expect(itemCapacity.rod).toBeCloseTo(240);
		// the ingot buffer is overcommitted on purpose: 240 + 240 wanted vs 240 made
		expect(itemDemand.ingot).toBeCloseTo(480);
		expect(itemCapacity.ingot).toBeCloseTo(240);
	});

	it('propagates through several buffered levels', () => {
		const {targets, itemCapacity} = propagate({
			recipes: [ingot, rod, screw],
			sources: {ore: 240},
		});
		expect(itemCapacity.rod).toBeCloseTo(240);
		expect(targets.screw).toBeCloseTo(24);       // 240 rod / 10
		expect(itemCapacity.screw).toBeCloseTo(960);
	});

	it('sizes a multi-input line by its least-generous buffer (min)', () => {
		const {targets, itemCapacity} = propagate({
			recipes: [ingot, plate, rod, screw, rip],
			sources: {ore: 240},
		});
		// plate buffer 160 / 30 = 5.33 ; screw buffer 960 / 60 = 16 -> min is plate
		expect(targets.rip).toBeCloseTo(160 / 30);
		expect(itemCapacity.rip).toBeCloseTo((160 / 30) * 15);
	});

	it('sums capacity across multiple producers of the same buffer', () => {
		const ingotAlt = r('ingotAlt', [['ore', 20]], [['ingot', 40]]); // pure-ish alt
		const {itemCapacity} = propagate({
			recipes: [ingot, ingotAlt, rod],
			sources: {ore: 240},
		});
		// ingot: 8 machines x 30  +  12 machines x 40  = 240 + 480
		expect(itemCapacity.ingot).toBeCloseTo(720);
		expect(itemCapacity.rod).toBeCloseTo(720);
	});

	it('warns and zeroes a line with no supply', () => {
		const {targets, warnings} = propagate({recipes: [plate], sources: {}});
		expect(targets.plate).toBe(0);
		expect(warnings.join(' ')).toMatch(/no supply of ingot/);
	});

	it('settles a byproduct loop instead of spinning forever', () => {
		// plastic <-> heavy oil residue style loop, both fed from crude
		const refinery = r('plastic', [['oil', 30], ['residue', 10]], [['plastic', 20], ['residue', 999]]);
		const {warnings} = propagate({recipes: [refinery], sources: {oil: 300, residue: 0}});
		// must return, not hang; whether it warns depends on boundedness
		expect(Array.isArray(warnings)).toBe(true);
	});
});
