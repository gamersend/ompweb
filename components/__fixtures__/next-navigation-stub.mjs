// Test stub for next/navigation: jsdom tests have no app router context, so
// useRouter() must return a no-op router (invariant otherwise).
const stubRouter = {
  push() {},
  replace() {},
  back() {},
  forward() {},
  refresh() {},
  prefetch() {},
};

export function useRouter() {
  return stubRouter;
}

const nextNavigationStub = { useRouter };
export default nextNavigationStub;
