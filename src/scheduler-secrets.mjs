export const HIDDEN_SCHEDULER_SECRET = "<hidden>";

export function redactSchedulerSecrets(config = {}) {
  return {
    ...config,
    countries: Object.fromEntries(Object.entries(config.countries || {}).map(([code, country]) => {
      const tokenConfigured = Boolean(String(country?.token || "").trim());
      return [code, {
        ...country,
        token: tokenConfigured ? HIDDEN_SCHEDULER_SECRET : "",
        tokenConfigured,
      }];
    })),
  };
}

export function preserveSchedulerSecrets(next = {}, previous = {}) {
  const countries = Object.fromEntries(Object.entries(next.countries || {}).map(([code, country]) => {
    const submitted = String(country?.token || "").trim();
    const previousToken = String(previous.countries?.[code]?.token || "");
    return [code, {
      ...country,
      token: !submitted || submitted === HIDDEN_SCHEDULER_SECRET ? previousToken : submitted,
    }];
  }));
  return { ...next, countries };
}
