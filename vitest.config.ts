import {defineConfig} from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Fork-only: lightweight unit tests for pure model/service logic (no Angular
 * TestBed). Upstream has no test runner configured; this stays out of
 * angular.json. Run with `npm test`.
 */
export default defineConfig({
	plugins: [tsconfigPaths()],
	test: {
		include: ['src/**/*.spec.ts'],
		environment: 'node',
	},
});
