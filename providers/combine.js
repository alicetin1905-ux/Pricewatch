// Run several providers together. One source failing doesn't lose the others:
// its error is attached as `warnings` on the returned offers.
export function combineProviders(providers, name) {
  return {
    name,
    demo: false,

    async fetchOffers(query) {
      const results = await Promise.allSettled(providers.map((p) => p.fetchOffers(query)));
      const ok = results.filter((r) => r.status === 'fulfilled');
      if (!ok.length) throw results[0].reason;

      const cheapestPerStore = new Map();
      const warnings = [];
      for (const r of ok) {
        warnings.push(...(r.value.warnings ?? []));
        for (const offer of r.value) {
          const key = offer.store.toLowerCase();
          const seen = cheapestPerStore.get(key);
          if (!seen || offer.price < seen.price) cheapestPerStore.set(key, offer);
        }
      }
      results.forEach((r, i) => {
        if (r.status === 'rejected') warnings.push(`${providers[i].name}: ${r.reason.message}`);
      });

      const offers = [...cheapestPerStore.values()];
      offers.warnings = warnings;
      return offers;
    },
  };
}
