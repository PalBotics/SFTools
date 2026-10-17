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
}
