// Offline peer valuation. Inputs are observed records, not verified launch announcements.
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}
export const MODEL_VERSION = 'Radar robust peers v3';
export const SHRINK_K = 4;
export const VALUE_CAP = 100_000_000_000_000;
// Retain bounded judgment adjustments, but measure their effect on identical held-out families.
export const TILT = {
  growth_weight: 0.1,
  growth_clamp: 50,
  age_weight: 0.1,
  age_cap_days: 1095,
  unknown_age_days: 365,
};
const DAY = 86400000;
export const bySlug = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const dollars = (n: number) => Math.round(clamp(n, 1, VALUE_CAP));
const categoryOf = (p: SnapshotProtocol) => p.category ?? 'Uncategorised';
const observed = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}
function dateValue(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) return null;
  return ms;
}
export function parseSnapshot(text: string): Snapshot {
  let raw;
  try { raw = JSON.parse(text); }
  catch { throw new SnapshotError('Snapshot must be valid JSON'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SnapshotError('Snapshot must be an object');
  }
  if (dateValue(raw.as_of) === null) throw new SnapshotError('Invalid snapshot date');
  if (typeof raw.source !== 'string') throw new SnapshotError('Missing source');
  if (!Number.isSafeInteger(raw.floor_usd) || raw.floor_usd <= 0) {
    throw new SnapshotError('Invalid TVL floor');
  }
  if (!Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) {
    throw new SnapshotError('Missing protocol or watchlist array');
  }
  const seen = new Set<string>();
  const protocols: SnapshotProtocol[] = raw.protocols.map((p: any, index: number) => {
    if (!p || typeof p !== 'object') throw new SnapshotError(`Invalid protocol ${index}`);
    if (typeof p.slug !== 'string' || !/^\S{1,128}$/.test(p.slug) || seen.has(p.slug)) {
      throw new SnapshotError(`Invalid or duplicate slug at ${index}`);
    }
    if (typeof p.name !== 'string' || !p.name.trim()) throw new SnapshotError(`Missing name: ${p.slug}`);
    if (observed(p.tvl_usd) === null || p.tvl_usd <= 0) {
      throw new SnapshotError(`Nonpositive or missing TVL: ${p.slug}`);
    }
    seen.add(p.slug);
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? [...new Set(p.chains.filter((c: unknown) => typeof c === 'string'))] as string[] : [],
      tvl_usd: p.tvl_usd,
      change_7d: observed(p.change_7d),
      mcap_usd: observed(p.mcap_usd),
      listed_at: dateValue(p.listed_at) !== null ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  const watchlist: string[] = raw.watchlist;
  if (watchlist.some(s => typeof s !== 'string' || !seen.has(s))) {
    throw new SnapshotError('Watchlist contains unknown slugs');
  }
  if (new Set(watchlist).size !== watchlist.length) throw new SnapshotError('Duplicate watchlist slug');
  return { as_of: raw.as_of, source: raw.source, floor_usd: raw.floor_usd, protocols, watchlist };
}
export function recordsToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null;
}
export function familyKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(wrapped|staked|staking|bridged|v\d+)\b/g, ' ').replace(/\s+/g, ' ').trim();
}
const derivative = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const exchanges = ['binance', 'coinbase', 'bybit', 'kraken', 'bitget', 'okx', 'bitfinex', 'gemini'];
export function exclusionReason(p: SnapshotProtocol, families: Map<string, string>): string | null {
  if (derivative.has(p.category ?? '')) return 'derivative-category';
  if (/\s(v\d+(\.\d+)?|\d+\.\d+)$/i.test(p.name)) return 'versioned-name';
  if (/\b(wrapped|staked|staking)\b/i.test(p.name)) return 'wrapped-staked-name';
  if (exchanges.some(x => p.name.toLowerCase().startsWith(x))) return 'exchange-brand';
  const key = familyKey(p.name);
  if (key && families.has(key) && families.get(key) !== p.slug) return 'token-family';
  return null;
}
export function buildUniverse(snapshot: Snapshot) {
  const families = new Map<string, string>();
  for (const p of snapshot.protocols) {
    if (p.mcap_usd !== null && p.mcap_usd > 0 && familyKey(p.name)) {
      families.set(familyKey(p.name), p.slug);
    }
  }
  const watch = new Set(snapshot.watchlist);
  const kept: SnapshotProtocol[] = [];
  const excluded: Array<{slug: string; name: string; category: string | null; tvl_usd: number; reason: string}> = [];
  const counts: Record<string, number> = {};
  let preToken = 0;
  for (const p of snapshot.protocols) {
    if (recordsToken(p)) continue;
    preToken++;
    const reason = watch.has(p.slug) ? null : exclusionReason(p, families);
    if (reason === null) kept.push(p);
    else {
      counts[reason] = (counts[reason] ?? 0) + 1;
      excluded.push({ slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, reason });
    }
  }
  const slugs = new Set(kept.map(p => p.slug));
  return {
    kept,
    excluded: excluded.sort((a, b) => b.tvl_usd - a.tvl_usd || bySlug(a.slug, b.slug)),
    counts,
    pre_token_total: preToken,
    watchlist_on_board: snapshot.watchlist.filter(s => slugs.has(s)).length,
    watchlist_off_board: snapshot.watchlist.filter(s => !slugs.has(s)),
  };
}
export function trackingAge(snapshot: Snapshot, p: SnapshotProtocol): number | null {
  const listed = dateValue(p.listed_at);
  return listed === null ? null : Math.max(0, Math.floor((dateValue(snapshot.as_of)! - listed) / DAY));
}
export function peersOf(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter(p => p.tvl_usd > 0 && p.mcap_usd !== null && p.mcap_usd > 0)
    .sort((a, b) => bySlug(a.slug, b.slug));
}
export function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const index = clamp(q, 0, 1) * (ordered.length - 1);
  const lower = Math.floor(index);
  return ordered[lower] + (ordered[Math.ceil(index)] - ordered[lower]) * (index - lower);
}
interface CoreFit {
  intercept: number;
  slope: number;
  n: number;
  weighted: boolean;
}
// Center before accumulating covariance to avoid cancellation on very large dollar scales.
function weightedFit(x: number[], y: number[], weights: number[]): CoreFit {
  const mass = weights.reduce((sum, w) => sum + w, 0);
  const meanX = x.reduce((sum, v, i) => sum + v * weights[i], 0) / mass;
  const meanY = y.reduce((sum, v, i) => sum + v * weights[i], 0) / mass;
  let variance = 0;
  let covariance = 0;
  for (let i = 0; i < x.length; i++) {
    const dx = x[i] - meanX;
    variance += weights[i] * dx * dx;
    covariance += weights[i] * dx * (y[i] - meanY);
  }
  const slope = variance > 1e-12 ? covariance / variance : 0;
  return { intercept: meanY - slope * meanX, slope, n: x.length, weighted: true };
}
export function fitCore(rows: SnapshotProtocol[]): CoreFit {
  if (!rows.length) throw new SnapshotError('Cannot fit a market-cap proxy without observed peers');
  const x = rows.map(p => Math.log(p.tvl_usd));
  const y = rows.map(p => Math.log(p.mcap_usd!));
  let fit = weightedFit(x, y, rows.map(() => 1));
  for (let iteration = 0; iteration < 14; iteration++) {
    const residual = y.map((v, i) => v - fit.intercept - fit.slope * x[i]);
    const scale = Math.max(1e-6, quantile(residual.map(Math.abs), 0.5)) * 1.5;
    // Huber weights are bounded above by one; small residuals never gain 20x influence.
    const weights = residual.map(r => Math.max(0.05, Math.min(1, scale / Math.max(1e-12, Math.abs(r)))));
    fit = weightedFit(x, y, weights);
  }
  return fit;
}
export interface PeerModel {
  core: CoreFit;
  offsets: Record<string, { n: number; raw: number; shrunk: number }>;
  peers: number;
}
export function fitPeers(rows: SnapshotProtocol[], k = SHRINK_K): PeerModel {
  const core = fitCore(rows);
  const categories = new Map<string, number[]>();
  for (const p of rows) {
    const key = categoryOf(p);
    const residual = Math.log(p.mcap_usd!) - core.intercept - core.slope * Math.log(p.tvl_usd);
    categories.set(key, [...(categories.get(key) ?? []), residual]);
  }
  const offsets: PeerModel['offsets'] = Object.create(null);
  for (const key of [...categories.keys()].sort(bySlug)) {
    const residuals = categories.get(key)!;
    const n = residuals.length;
    const raw = residuals.reduce((a, b) => a + b, 0) / n;
    offsets[key] = { n, raw, shrunk: raw * n / (n + k) };
  }
  return { core, offsets, peers: rows.length };
}
export function tilt(p: SnapshotProtocol, age: number | null) {
  const growth = clamp(p.change_7d ?? 0, -TILT.growth_clamp, TILT.growth_clamp) * TILT.growth_weight / 100;
  const days = clamp(age ?? TILT.unknown_age_days, 0, TILT.age_cap_days);
  const ageTilt = Math.log1p(days / TILT.age_cap_days) * TILT.age_weight;
  return { growth, age: ageTilt, total: growth + ageTilt };
}
export function predict(p: SnapshotProtocol, age: number | null, model: PeerModel) {
  const core = model.core.intercept + model.core.slope * Math.log(p.tvl_usd);
  const category = categoryOf(p);
  const offset = model.offsets[category]?.shrunk ?? 0;
  const adjustment = tilt(p, age);
  const log = core + offset + adjustment.total;
  return {
    log, core, offset, category,
    growth_tilt: adjustment.growth,
    age_tilt: adjustment.age,
    category_peers: model.offsets[category]?.n ?? 0,
    multiple: Math.exp(log) / p.tvl_usd,
  };
}
interface Observation { predicted: number; actual: number }
function loss(observations: Observation[]) {
  const n = observations.length;
  if (!n) throw new SnapshotError('No validation folds');
  const errors = observations.map(f => Math.log(f.predicted / f.actual));
  return {
    rmsle: Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / n),
    mdape: quantile(observations.map(f => Math.abs(f.predicted / f.actual - 1)), 0.5),
    within: errors.filter(e => Math.abs(e) <= Math.log(2)).length / n,
  };
}
export function crossValidate(rows: SnapshotProtocol[], k = SHRINK_K, snapshot?: Snapshot) {
  const folds = [];
  const naive: Observation[] = [];
  const untilted: Observation[] = [];
  for (const target of rows) {
    const family = familyKey(target.name);
    const train = rows.filter(p => p.slug !== target.slug && (!family || familyKey(p.name) !== family));
    if (!train.length) throw new SnapshotError(`No independent training peers for ${target.slug}`);
    const model = fitPeers(train, k);
    const prediction = predict(target, snapshot ? trackingAge(snapshot, target) : null, model);
    const predicted = Math.exp(prediction.log);
    const actual = target.mcap_usd!;
    folds.push({
      slug: target.slug,
      family_dropped: rows.length - train.length - 1,
      predicted_usd: predicted,
      actual_usd: actual,
      log_ratio: Math.log(actual / predicted),
    });
    untilted.push({ predicted: Math.exp(prediction.core + prediction.offset), actual });
    const categoryPeers = train.filter(p => categoryOf(p) === categoryOf(target));
    const pool = categoryPeers.length >= 3 ? categoryPeers : train;
    const multiple = quantile(pool.map(p => p.mcap_usd! / p.tvl_usd), 0.5);
    naive.push({ predicted: multiple * target.tvl_usd, actual });
  }
  const fullLoss = loss(folds.map(f => ({ predicted: f.predicted_usd, actual: f.actual_usd })));
  const naiveLoss = loss(naive);
  const baseLoss = loss(untilted);
  const ratios = folds.map(f => Math.exp(f.log_ratio));
  return {
    method: 'Leave-one-family-out: refit core and category offsets without the target or same-name family; observed TVL, category, growth and tracking age predict observed market cap.',
    folds,
    n: folds.length,
    rmsle: fullLoss.rmsle,
    mdape: fullLoss.mdape,
    within_2x: fullLoss.within,
    naive_rmsle: naiveLoss.rmsle,
    naive_mdape: naiveLoss.mdape,
    naive_within_2x: naiveLoss.within,
    core_only_rmsle: baseLoss.rmsle,
    core_only_within_2x: baseLoss.within,
    family_dropped_folds: folds.filter(f => f.family_dropped > 0).length,
    ratio_quantiles: { p10: quantile(ratios, 0.1), p50: quantile(ratios, 0.5), p90: quantile(ratios, 0.9) },
    notes: [
      `These ${folds.length} folds informed model choices. They are validation, not an untouched holdout.`,
      'Naive uses the category median market-cap/TVL multiple with at least three training peers, otherwise the pooled median.',
      `Same-fold RMSLE without growth/age tilts: ${baseLoss.rmsle.toFixed(3)}; with tilts: ${fullLoss.rmsle.toFixed(3)}. Lower is better; no temporal forecasting claim follows.`,
      'Name families are inferred, not observed ownership. The residual band is descriptive and has no future coverage guarantee.',
    ],
  };
}
const lowFee = new Set(['solana', 'base', 'arbitrum', 'optimism', 'polygon', 'bnb', 'sui', 'monad', 'hyperliquid l1', 'unichain', 'avalanche', 'katana', 'flare', 'plasma', 'sonic']);
export function tierFor(p: SnapshotProtocol) {
  const capital = p.tvl_usd >= 1e9 ? 500 : p.tvl_usd >= 1e8 ? 200 : p.tvl_usd >= 2e7 ? 75 : 25;
  const first = p.chains[0]?.toLowerCase();
  const fee = first && lowFee.has(first) ? '$0.30' : first === 'ethereum' ? '$6' : '$6 contingency';
  return { capital_usd: capital, gas_note: `${fee} per transaction, planning assumption only` };
}
export function mechanism(category: string | null) {
  const label = (category ?? '').toLowerCase();
  if (/curator|allocator|yield/.test(label)) return 'Inspect one vault, its manager, withdrawal queue and fees; consider a small deposit only if supported.';
  if (/lend|cdp|collateral/.test(label)) return 'Inspect a supported supply market; avoid borrowing unless collateral and liquidation mechanics are understood.';
  if (/dex/.test(label)) return 'Inspect one liquid swap pair; account for spread, slippage and any liquidity-position loss before use.';
  if (/perp|derivative|option|basis/.test(label)) return 'Inspect margin, funding and liquidation rules; use a documented sandbox first if available, without leverage assumptions.';
  if (/rwa|stable/.test(label)) return 'Check eligibility, collateral, issuer and redemption terms before considering a supported mint or hold.';
  if (/staking|restak/.test(label)) return 'Inspect validator or delegation terms, slashing exposure and the exit queue before considering a stake.';
  if (/bridge|cross chain/.test(label)) return 'Check the official route, receiving chain and recovery terms; test only a small supported transfer.';
  if (/prediction/.test(label)) return 'Read resolution rules and settlement dates before considering a small position in a supported market.';
  return 'Confirm the documented product and supported action in the official app before considering a small test position.';
}
export function farmPlan(p: SnapshotProtocol, age: number | null, band: {p10: number; p90: number}): string[] {
  const tier = tierFor(p);
  const chain = p.chains[0] ?? 'an officially supported chain';
  const reviewDays = age !== null && age < 180 ? 90 : 45;
  return [
    `Verify ${p.name} through its official documentation. The snapshot records no token; that does not establish a future launch, points program or airdrop.`,
    `Plan at most $${tier.capital_usd} of total exposure on ${chain}, reserving fees within that budget. This is a hypothetical capital tier from TVL, not a recommended investment or a gas-token purchase amount.`,
    mechanism(p.category) + ` Category in this record: ${categoryOf(p)}. Confirm that the action exists before funding.`,
    `Budget ${tier.gas_note}. Six transactions would use an assumed ${p.chains[0] && lowFee.has(p.chains[0].toLowerCase()) ? '$1.80' : '$36'} gas allowance; get actual quotes and add protocol fees, spread and bridge costs before deciding.`,
    `Review weekly over a ${reviewDays}-day planning horizon. Only transact for a real product need; repeated activity and holding time do not establish eligibility. Keep a transaction and cost log.`,
    'Use one genuine identity and follow published eligibility rules. Do not create artificial activity, circular transfers or identity proofs to evade sybil filters; no reward is assumed.',
    `Risk check: inspect audits, upgrade authority, approvals and withdrawal restrictions. Test the exit with a small position; stop if total costs or contract risk exceed your budget.`,
    `Allocation scenario only: a 60/40 split of the $${tier.capital_usd} budget is $${tier.capital_usd * 0.6} here and $${tier.capital_usd * 0.4} elsewhere before fees. Both positions can lose value and any allocation can be diluted to zero.`,
    `Valuation context: observed TVL $${Math.round(p.tvl_usd).toLocaleString('en-US')}; empirical P10-P90 proxy range $${Math.round(band.p10).toLocaleString('en-US')} to $${Math.round(band.p90).toLocaleString('en-US')}. P90 is an upper residual quantile, not a mid case or expected payout.`,
    'Exit or pause when the product no longer serves a need. Verify any claim through official channels; inspect every signature and never assume a claim page is safe because it names this protocol.',
  ];
}
export function nearestPeers(p: SnapshotProtocol, peers: SnapshotProtocol[], limit = 6) {
  return peers.map(q => ({
    slug: q.slug,
    name: q.name,
    category: q.category,
    tvl_usd: q.tvl_usd,
    mcap_usd: q.mcap_usd!,
    multiple: q.mcap_usd! / q.tvl_usd,
    distance: Math.abs(Math.log(q.tvl_usd / p.tvl_usd)),
  })).sort((a, b) =>
    Number(categoryOf(p) !== (a.category ?? 'Uncategorised')) - Number(categoryOf(p) !== (b.category ?? 'Uncategorised')) ||
    a.distance - b.distance || bySlug(a.slug, b.slug)
  ).slice(0, limit);
}
export function buildBoard(snapshot: Snapshot) {
  const universe = buildUniverse(snapshot);
  const peers = peersOf(snapshot);
  const model = fitPeers(peers);
  const validation = crossValidate(peers, SHRINK_K, snapshot);
  const watch = new Set(snapshot.watchlist);
  const rows = universe.kept.map(p => {
    const age = trackingAge(snapshot, p);
    const pred = predict(p, age, model);
    const implied = dollars(Math.exp(pred.log));
    const q = validation.ratio_quantiles;
    const band = {
      p10: Math.min(implied, dollars(Math.exp(pred.log) * q.p10)),
      p50: dollars(Math.exp(pred.log) * q.p50),
      p90: Math.max(implied, dollars(Math.exp(pred.log) * q.p90)),
    };
    band.p50 = clamp(band.p50, band.p10, band.p90);
    const width = Math.log(band.p90 / band.p10);
    const confidence = pred.category_peers >= 8 && width < 5.5 ? 'higher' : pred.category_peers >= 3 && width < 6.5 ? 'medium' : 'low';
    const coreMultiple = Math.exp(pred.core) / p.tvl_usd;
    const valueTag = Math.abs(pred.growth_tilt) > 0.03 ? (pred.growth_tilt > 0 ? 'TVL up' : 'TVL down') :
      p.tvl_usd >= 1e9 ? 'large TVL' : p.tvl_usd < 25e6 ? 'small TVL' : pred.offset > 0.5 ? 'cat. strong' : pred.offset < -0.5 ? 'cat. weak' : 'on curve';
    return {
      rank: 0,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      age_days: age,
      implied_value_usd: implied,
      band,
      multiple: Number((implied / p.tvl_usd).toFixed(4)),
      confidence,
      value_tag: valueTag,
      peers: nearestPeers(p, peers),
      breakdown: {
        core_multiple: coreMultiple,
        category_offset: pred.offset,
        growth_tilt: pred.growth_tilt,
        age_tilt: pred.age_tilt,
        category_peers: pred.category_peers,
      },
      explanation: `Observed TVL times pooled ${coreMultiple.toFixed(3)}x, category ${Math.exp(pred.offset).toFixed(3)}x, growth ${Math.exp(pred.growth_tilt).toFixed(3)}x and tracking-age ${Math.exp(pred.age_tilt).toFixed(3)}x gives a market-cap proxy of $${implied}; not FDV or an allocation estimate.`,
      farm_steps: farmPlan(p, age, band),
      watchlist: watch.has(p.slug),
    };
  });
  rows.sort((a, b) => b.implied_value_usd - a.implied_value_usd || bySlug(a.slug, b.slug));
  rows.forEach((row, index) => { row.rank = index + 1; });
  return { rows, model, validation, universe, snapshot, excluded_count: universe.excluded.length };
}
export type BoardRow = ReturnType<typeof buildBoard>['rows'][number];
export function buildRadar(snapshot: Snapshot) {
  const build = buildBoard(snapshot);
  const { rows, universe, model, validation } = build;
  const radar = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    shrink_k: SHRINK_K,
    tilt: TILT,
    counts: {
      protocols: snapshot.protocols.length,
      peers: model.peers,
      pre_token: universe.pre_token_total,
      on_board: rows.length,
      watchlist: snapshot.watchlist.length,
      watchlist_covered: universe.watchlist_on_board,
      excluded: universe.excluded.length,
      early_below_floor: rows.filter(r => !r.watchlist && r.tvl_usd < snapshot.floor_usd).length,
      live_with_mcap: snapshot.protocols.filter(p => p.mcap_usd !== null && p.mcap_usd > 0).length,
    },
    exclusions: universe.excluded,
    exclusion_counts: universe.counts,
    validation,
    rows,
    excluded_watchlist: universe.watchlist_off_board,
    peer_points: peersOf(snapshot).map(p => ({ slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd })),
    fit: { ...model.core, shrink_k: SHRINK_K },
  };
  return { build, radar };
}
export type RadarData = ReturnType<typeof buildRadar>['radar'];
export function boardIssue(rows: BoardRow[], snapshot: Snapshot): string | null {
  if (rows.length < 100 || rows.length > 4000) return `Row count outside 100..4000: ${rows.length}`;
  const source = new Map(snapshot.protocols.map(p => [p.slug, p]));
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (!source.has(row.slug) || seen.has(row.slug)) return `Unknown or duplicate slug: ${row.slug}`;
    seen.add(row.slug);
    if (recordsToken(source.get(row.slug)!)) return `Token evidence on ranked row: ${row.slug}`;
    if (row.rank !== index + 1) return `Nonsequential rank: ${row.slug}`;
    if (!row.name.trim()) return `Empty name: ${row.slug}`;
    if (!Number.isSafeInteger(row.implied_value_usd) || row.implied_value_usd < 1 || row.implied_value_usd > VALUE_CAP) {
      return `Invalid implied dollars: ${row.slug}`;
    }
    if (index && rows[index - 1].implied_value_usd < row.implied_value_usd) return `Value order: ${row.slug}`;
    const band = row.band;
    if (![band.p10, band.p50, band.p90].every(Number.isSafeInteger) ||
        band.p10 > band.p50 || band.p50 > band.p90 || band.p10 > row.implied_value_usd || band.p90 < row.implied_value_usd) {
      return `Invalid band: ${row.slug}`;
    }
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) return `Plan count: ${row.slug}`;
    if (row.farm_steps.some(step => step.trim().length < 20 || step.trim().length > 600)) return `Plan length: ${row.slug}`;
  }
  if (rows[0].implied_value_usd === rows.at(-1)!.implied_value_usd) return 'Flat valuation';
  const missing = snapshot.watchlist.filter(slug => !seen.has(slug));
  return missing.length ? `Missing watchlist: ${missing.join(', ')}` : null;
}
export function dataScript(radar: RadarData): string {
  // Escape JS line separators; all text is subsequently rendered with textContent.
  return 'window.RADAR=' + JSON.stringify(radar).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + ';\n';
}
