/**
 * How a folder's shared raw-resource pool is divided among its inner plans
 * (only meaningful when `Folder.resourcePool` is on):
 *
 * - `shared` (default): the folder's limits are one budget; each plan may
 *   only mine what the other plans have left. Steady-state balance.
 * - `parallel`: every plan sees the folder's full limit, as if it alone
 *   owned every node. Sibling plans are treated as buffer-decoupled branches
 *   that never peak at once, so each is provisioned to run at 100%. The
 *   folder overview then aggregates the branches by their envelope (the
 *   hungriest single branch per resource / building / recipe), not their sum.
 */
export type ResourcePoolMode = 'shared' | 'parallel';
