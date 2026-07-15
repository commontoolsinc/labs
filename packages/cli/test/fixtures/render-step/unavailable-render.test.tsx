import { computed, pattern, resultOf, wish } from "commonfabric";

export default pattern(() => {
  const profileWish = wish<{ name: string }>({
    query: "#missing-render-profile",
  });
  const missingProfile = resultOf(profileWish.result);
  const unavailableView = computed(() => <div>{missingProfile.name}</div>);

  return {
    tests: [
      { render: unavailableView },
      { assertion: computed(() => true) },
    ],
  };
});
