import {describe, expect, it, vi} from 'vitest';
import {GraphComposer} from '@src/Model/Planner/Graph/GraphComposer';

/**
 * Regression: capacity sizing's bufferedItems set has to reach
 * GraphEdgeBuilder.build on every path that rebuilds edges, not just the
 * fresh/automatic render() call - merge() (manual-upgrade) and rebuild()
 * (recalculating around locked nodes) call it too, and were silently
 * building non-buffered edges even in capacity mode. That's exactly the
 * case a locked node (e.g. a locked plan Input) puts every recalculation
 * through, so this was a real, user-visible edge-dropping bug, not a
 * theoretical gap.
 */
describe('GraphComposer threads bufferedItems into edge building', () => {
	function fakeEdgeBuilder()
	{
		return {build: vi.fn().mockReturnValue([])};
	}

	it('merge() passes bufferedItems through', () => {
		const edgeBuilder = fakeEdgeBuilder();
		const composer = new GraphComposer(edgeBuilder as never);
		const buffered = new Set(['Desc_Rotor_C']);

		composer.merge({nodes: [], edges: []}, [], buffered);

		expect(edgeBuilder.build).toHaveBeenCalledWith(expect.anything(), expect.anything(), buffered);
	});

	it('rebuild() passes bufferedItems through', () => {
		const edgeBuilder = fakeEdgeBuilder();
		const composer = new GraphComposer(edgeBuilder as never);
		const buffered = new Set(['Desc_Rotor_C']);

		composer.rebuild({nodes: [], edges: []}, [], buffered);

		expect(edgeBuilder.build).toHaveBeenCalledWith(expect.anything(), expect.anything(), buffered);
	});

	it('omitting bufferedItems still calls build (balanced mode, unaffected)', () => {
		const edgeBuilder = fakeEdgeBuilder();
		const composer = new GraphComposer(edgeBuilder as never);

		composer.rebuild({nodes: [], edges: []}, []);

		expect(edgeBuilder.build).toHaveBeenCalledWith(expect.anything(), expect.anything(), undefined);
	});
});
