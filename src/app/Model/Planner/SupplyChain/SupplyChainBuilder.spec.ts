import {describe, expect, it} from 'vitest';
import {Building} from '@src/Model/Data/Entities/Building';
import {Item} from '@src/Model/Data/Entities/Item';
import {Recipe} from '@src/Model/Data/Entities/Recipe';
import {SupplyChainBuilder} from '@src/Model/Planner/SupplyChain/SupplyChainBuilder';
import {ByproductNode} from '@src/Model/Planner/Solver/Response/ByproductNode';
import {InputNode} from '@src/Model/Planner/Solver/Response/InputNode';
import {MineNode} from '@src/Model/Planner/Solver/Response/MineNode';
import {Node} from '@src/Model/Planner/Solver/Response/Node';
import {ProductNode} from '@src/Model/Planner/Solver/Response/ProductNode';
import {RecipeNode} from '@src/Model/Planner/Solver/Response/RecipeNode';

/**
 * Reverse planning: read a solved graph from the final products down to the
 * raw resources, ordered so every item sits below everything that uses it.
 *
 *   ore --Ingot--> ingot --Rod--> rod --\
 *                                        Motor --> motor (product)
 *                       stator (other factory) --/
 */

const item = (className: string, name: string) => ({className, name}) as Item;
const ore = item('Desc_OreIron_C', 'Iron Ore');
const ingot = item('Desc_IronIngot_C', 'Iron Ingot');
const rod = item('Desc_IronRod_C', 'Iron Rod');
const stator = item('Desc_Stator_C', 'Stator');
const motor = item('Desc_Motor_C', 'Motor');
const junk = item('Desc_Junk_C', 'Junk');

const machine = (name: string) => ({className: `Build_${name}_C`, name, manufacturingSpeed: 1, sloopBoost: 0}) as Building;
const recipe = (name: string, ingredients: [Item, number][], products: [Item, number][]) => ({
	className: `Recipe_${name}_C`,
	name,
	time: 60,
	ingredients: ingredients.map(([i, amount]) => ({item: i, amount})),
	products: products.map(([i, amount]) => ({item: i, amount})),
}) as Recipe;

const node = (id: string, r: Recipe, m: Building, machines: number) =>
	new RecipeNode(id, machines, [{machines, clockSpeed: 100, sloops: 0}], m, r);

const ingotNode = node('ingot', recipe('Iron Ingot', [[ore, 1]], [[ingot, 1]]), machine('Smelter'), 3);
const rodNode = node('rod', recipe('Iron Rod', [[ingot, 1]], [[rod, 1]]), machine('Constructor'), 2);
const motorNode = node('motor', recipe('Motor', [[rod, 2], [stator, 2]], [[motor, 1]]), machine('Assembler'), 5);

function chain(): Node[]
{
	return [
		new MineNode('mine', 60, ore),
		ingotNode, rodNode, motorNode,
		new InputNode('stator-in', 20, stator),
		new ProductNode('motor-out', 10, motor),
	];
}

const builder = new SupplyChainBuilder();
const byName = (rows: ReturnType<SupplyChainBuilder['build']>, name: string) => rows.find(r => r.item.name === name)!;

describe('SupplyChainBuilder', () => {
	it('orders final products first and raw resources last', () => {
		const rows = builder.build(chain(), []);
		expect(rows.map(r => r.item.name)).toEqual(['Motor', 'Iron Rod', 'Stator', 'Iron Ingot', 'Iron Ore']);
		expect(rows.map(r => r.level)).toEqual([0, 1, 1, 2, 3]);
	});

	it('classifies product / intermediate / raw', () => {
		const rows = builder.build(chain(), []);
		expect(byName(rows, 'Motor').kind).toBe('product');
		expect(byName(rows, 'Iron Ingot').kind).toBe('intermediate');
		expect(byName(rows, 'Stator').kind).toBe('intermediate');
		expect(byName(rows, 'Iron Ore').kind).toBe('raw');
	});

	it('reports what each item needs and who builds it', () => {
		const rows = builder.build(chain(), []);
		const motorRow = byName(rows, 'Motor');
		expect(motorRow.output).toBe(10);
		expect(motorRow.built).toEqual([{name: 'Motor', machine: 'Assembler', machines: 5, amount: 5}]);

		// the rod recipe draws 1 ingot/min per machine-cycle x2 machines; ingot needed = rod line's draw
		expect(byName(rows, 'Iron Ingot').required).toBeCloseTo(2);
		expect(byName(rows, 'Iron Ingot').built[0]).toMatchObject({name: 'Iron Ingot', machine: 'Smelter', machines: 3});
		expect(byName(rows, 'Iron Ore').mined).toBe(60);
	});

	it('separates other-factory supply from what is built, and carries the configured cap', () => {
		const rows = builder.build(chain(), [{itemClassName: stator.className, amount: 150, weight: 0}]);
		const statorRow = byName(rows, 'Stator');
		expect(statorRow.external).toBe(20);       // what the solve actually drew
		expect(statorRow.externalCap).toBe(150);   // what is configured on the Input tab
		expect(statorRow.built).toEqual([]);
		expect(byName(rows, 'Iron Rod').externalCap).toBeNull();
	});

	it('keeps a configured input visible even when the solve drew none of it', () => {
		const withoutInputNode = chain().filter(n => n.id !== 'stator-in');
		const rows = builder.build(withoutInputNode, [{itemClassName: stator.className, amount: 150, weight: 24}]);
		const statorRow = byName(rows, 'Stator');
		expect(statorRow.external).toBe(0);
		expect(statorRow.externalCap).toBe(150);
	});

	it('sums demand across every consumer of a shared item', () => {
		const second = node('rod2', recipe('Screw', [[rod, 1]], [[item('Desc_Screw_C', 'Screw'), 4]]), machine('Constructor'), 1);
		const rows = builder.build([...chain(), second, new ProductNode('screw-out', 8, item('Desc_Screw_C', 'Screw'))], []);
		// Motor line draws 2 rod/min x 5 machines = 10 ; Screw line draws 1 rod/min x 1 machine = 1
		expect(byName(rows, 'Iron Rod').required).toBeCloseTo(11);
	});

	it('leaves out byproducts and anything that does not lead to a product', () => {
		const junkRecipe = node('junk', recipe('Junk', [[ore, 1]], [[junk, 1]]), machine('Smelter'), 1);
		const rows = builder.build([...chain(), junkRecipe, new ByproductNode('junk-out', 5, junk)], []);
		expect(rows.some(r => r.item.className === junk.className)).toBe(false);
	});

	it('merges lines running the same recipe and machine', () => {
		const twin = node('ingot2', recipe('Iron Ingot', [[ore, 1]], [[ingot, 1]]), machine('Smelter'), 4);
		const rows = builder.build([...chain(), twin], []);
		expect(byName(rows, 'Iron Ingot').built).toHaveLength(1);
		expect(byName(rows, 'Iron Ingot').built[0].machines).toBe(7);
	});

	it('terminates on a byproduct loop', () => {
		const a = node('a', recipe('A', [[ingot, 1], [rod, 1]], [[rod, 2], [ingot, 1]]), machine('Refinery'), 1);
		const rows = builder.build([...chain(), a], []);
		expect(rows.every(r => Number.isFinite(r.level) && r.level < 50)).toBe(true);
	});
});
