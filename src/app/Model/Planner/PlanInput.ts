/**
 * A user-supplied item source the solver may draw from: up to `amount` per
 * minute, priced at `weight` per unit in the optimisation objective (a low
 * weight makes it a cheap alternative to mining or crafting).
 */
export interface PlanInput
{
	itemClassName: string;
	amount: number;
	weight: number;

	/**
	 * Fork feature (docs/capacity-planning.md § "Linking plans"). When set, the
	 * input is not a typed number: it is what that other plan outputs of this
	 * item - its products and byproducts, read from its stored graph - so the
	 * two factories stay connected. `amount` is kept (and ignored) while
	 * linked, like a typed rate under "maximise", so unlinking loses nothing.
	 */
	sourcePlanId?: string;

	/**
	 * Linked rows only: per-minute amount of the source's output held back for
	 * this plan. Under balanced sizing the other plans pulling the same output
	 * leave it alone (even before this plan has drawn it); the rest of the
	 * output is shared first come, first served. Absent or 0 = no reservation.
	 * Buffered-capacity plans see the full output regardless, so it is ignored there.
	 */
	reserve?: number;
}
