import {describe, expect, it, vi} from 'vitest';
import {NodeContextMenu} from '@src/Components/Planner/ContextMenu/NodeContextMenu';
import {Building} from '@src/Model/Data/Entities/Building';
import {Item} from '@src/Model/Data/Entities/Item';
import {Recipe} from '@src/Model/Data/Entities/Recipe';
import {RecipeNode} from '@src/Model/Planner/Solver/Response/RecipeNode';

/**
 * Reverse planning: right-click a line in the graph -> take its main product
 * from another factory instead of building it here.
 */

const item = (className: string, name: string) => ({className, name}) as Item;
const rotor = item('Desc_Rotor_C', 'Rotor');
const scrap = item('Desc_Scrap_C', 'Scrap');

// 60 s cycle = 1/min: 1 Rotor and 1 Scrap per cycle... Rotor weighted 4x so it is clearly the main product.
const recipe = {
	className: 'Recipe_Rotor_C',
	name: 'Rotor',
	time: 60,
	ingredients: [{item: item('Desc_IronRod_C', 'Iron Rod'), amount: 5}],
	products: [{item: scrap, amount: 1}, {item: rotor, amount: 4}],
} as Recipe;
const assembler = {className: 'Build_AssemblerMk1_C', name: 'Assembler', manufacturingSpeed: 1, sloopBoost: 0} as Building;

function menuFor(node: RecipeNode)
{
	const actions = {requestInputAdd: vi.fn()};
	const menu = new NodeContextMenu(node, {} as never, actions as never, {} as never, {} as never);
	const entry = menu.getItems().find(i => i.label.startsWith('Source '));
	return {actions, entry};
}

describe('NodeContextMenu "Source from another factory"', () => {
	it('offers the line\'s main (largest) product and requests exactly what the line makes', () => {
		const node = new RecipeNode('n1', 3, [{machines: 3, clockSpeed: 100, sloops: 0}], assembler, recipe);
		const {actions, entry} = menuFor(node);

		expect(entry?.label).toBe('Source Rotor from another factory');
		expect(entry?.disabled).toBe(false);

		entry!.action();
		// 3 machines x 4 Rotor/cycle x 1 cycle/min
		expect(actions.requestInputAdd).toHaveBeenCalledWith({itemClassName: 'Desc_Rotor_C', amount: 12});
	});

	it('is disabled for a locked node (a fixed column the solver must keep)', () => {
		const node = new RecipeNode('n1', 3, [{machines: 3, clockSpeed: 100, sloops: 0}], assembler, recipe);
		node.locked = true;
		expect(menuFor(node).entry?.disabled).toBe(true);
	});
});
