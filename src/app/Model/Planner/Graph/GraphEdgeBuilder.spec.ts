import {describe, expect, it} from 'vitest';
import {GraphEdgeBuilder} from '@src/Model/Planner/Graph/GraphEdgeBuilder';
import {Item} from '@src/Model/Data/Entities/Item';
import {NodeIO} from '@src/Model/Planner/Solver/Response/NodeIO';
import {Node} from '@src/Model/Planner/Solver/Response/Node';

const item = (className: string) => ({className, name: className}) as Item;

function node(id: string, inputs: [string, number][], outputs: [string, number][]): Node
{
	return {
		id,
		inputs: inputs.map(([c, a]) => new NodeIO(item(c), a)),
		outputs: outputs.map(([c, a]) => new NodeIO(item(c), a)),
	} as unknown as Node;
}

describe('GraphEdgeBuilder buffered items', () => {
	const builder = new GraphEdgeBuilder();

	it('splits a normal item to meet summed demand (no overcommit)', () => {
		const ingot = node('ingot', [], [['ingot', 240]]);
		const plate = node('plate', [['ingot', 100]], [['plate', 66]]);
		const rod = node('rod', [['ingot', 140]], [['rod', 140]]);
		const edges = builder.build([ingot, plate, rod]);
		const total = edges.filter(e => e.itemClassName === 'ingot').reduce((s, e) => s + e.amount, 0);
		expect(total).toBeCloseTo(240);
	});

	it('gives every consumer of a buffered item its full draw', () => {
		const ingot = node('ingot', [], [['ingot', 240]]);
		const plate = node('plate', [['ingot', 240]], [['plate', 160]]);
		const rod = node('rod', [['ingot', 240]], [['rod', 240]]);
		const edges = builder.build([ingot, plate, rod], [], new Set(['ingot']));

		const toPlate = edges.find(e => e.targetId === 'plate' && e.itemClassName === 'ingot');
		const toRod = edges.find(e => e.targetId === 'rod' && e.itemClassName === 'ingot');
		expect(toPlate?.amount).toBeCloseTo(240);
		expect(toRod?.amount).toBeCloseTo(240);
		// deliberately over the 240 produced
		expect((toPlate!.amount) + (toRod!.amount)).toBeCloseTo(480);
	});

	it('splits a buffered item across multiple producers pro rata', () => {
		const a = node('a', [], [['ingot', 180]]);
		const b = node('b', [], [['ingot', 60]]);
		const rod = node('rod', [['ingot', 240]], [['rod', 240]]);
		const edges = builder.build([a, b, rod], [], new Set(['ingot']));
		const fromA = edges.find(e => e.sourceId === 'a')!.amount;
		const fromB = edges.find(e => e.sourceId === 'b')!.amount;
		expect(fromA).toBeCloseTo(180);
		expect(fromB).toBeCloseTo(60);
	});
});
