import {describe, expect, it} from 'vitest';
import {Building} from '@src/Model/Data/Entities/Building';
import {Item} from '@src/Model/Data/Entities/Item';
import {Recipe} from '@src/Model/Data/Entities/Recipe';
import {MachineGroupNormalizer} from '@src/Model/Planner/MachineGroupNormalizer';
import {CapacityResizeService} from '@src/Model/Planner/Capacity/CapacityResizeService';
import {InputNode} from '@src/Model/Planner/Solver/Response/InputNode';
import {RecipeNode} from '@src/Model/Planner/Solver/Response/RecipeNode';
import {SolverResponse} from '@src/Model/Planner/Solver/Response/SolverResponse';

/**
 * Regression: a plan Input the *balanced* solve found cheaper to route
 * around (a costed input vs. building the item from raw resources) never
 * gets an InputNode in the solved graph - its LP column sits at 0 and
 * nodesFromColumns drops it. Capacity sizing must still treat the plan's
 * configured input as real available supply, not silently lose it.
 */

const statorItem = {className: 'Desc_Stator_C', name: 'Stator'} as Item;
const motorItem = {className: 'Desc_Motor_C', name: 'Motor'} as Item;
const assembler = {className: 'Build_AssemblerMk1_C', manufacturingSpeed: 1} as Building;

// 60s cycle -> 1 cycle/min; 2 Stator -> 1 Motor per cycle.
const motorRecipe = {
	className: 'Recipe_Motor_C',
	time: 60,
	ingredients: [{item: statorItem, amount: 2}],
	products: [{item: motorItem, amount: 1}],
} as Recipe;

function service(): CapacityResizeService
{
	return new CapacityResizeService(new MachineGroupNormalizer());
}

describe('CapacityResizeService plan inputs', () => {
	it('sizes a recipe from a plan input the balanced solve never used', () => {
		// No InputNode in the solved graph at all - simulates the LP ignoring
		// the costed input entirely and (in this minimal graph) finding no
		// alternative either, so the motor recipe is the only node.
		const motorNode = new RecipeNode('motor', 0, [], assembler, motorRecipe);
		const response: SolverResponse = {status: 'Optimal', nodes: [motorNode]};

		const result = service().apply(response, {}, 'underclock-last', [
			{itemClassName: 'Desc_Stator_C', amount: 150, weight: 24},
		]);

		expect(result.warnings.join(' ')).not.toMatch(/no supply/);

		const resizedMotor = result.response.nodes.find((n): n is RecipeNode => n instanceof RecipeNode)!;
		expect(resizedMotor.target).toBeCloseTo(75); // 150 stator/min / 2 per machine·min

		const synthesizedInput = result.response.nodes.find((n): n is InputNode => n instanceof InputNode);
		expect(synthesizedInput?.item.className).toBe('Desc_Stator_C');
		expect(synthesizedInput?.amount).toBe(150);
	});

	it('does not add a node for a configured input nothing in the graph consumes', () => {
		const motorNode = new RecipeNode('motor', 0, [], assembler, motorRecipe);
		const response: SolverResponse = {status: 'Optimal', nodes: [motorNode]};

		const result = service().apply(response, {}, 'underclock-last', [
			{itemClassName: 'Desc_Stator_C', amount: 150, weight: 24},
			{itemClassName: 'Desc_Screw_C', amount: 999, weight: 1}, // unrelated, unused here
		]);

		expect(result.response.nodes.some(n => n instanceof InputNode && n.item.className === 'Desc_Screw_C')).toBe(false);
	});

	it('overrides an existing InputNode\'s amount to the plan\'s full configured cap', () => {
		// The balanced solve drew only 10/min from the input before finding
		// its own supply; capacity mode still offers the full 150.
		const existingInput = new InputNode('in1', 10, statorItem);
		const motorNode = new RecipeNode('motor', 0, [], assembler, motorRecipe);
		const response: SolverResponse = {status: 'Optimal', nodes: [motorNode, existingInput]};

		const result = service().apply(response, {}, 'underclock-last', [
			{itemClassName: 'Desc_Stator_C', amount: 150, weight: 24},
		]);

		const inputs = result.response.nodes.filter((n): n is InputNode => n instanceof InputNode);
		expect(inputs).toHaveLength(1);
		expect(inputs[0].amount).toBe(150);
	});
});
