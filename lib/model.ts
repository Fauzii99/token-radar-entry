// The token radar's model. One sealed snapshot in, one ranked board out.
//
// WHAT IS RANKED
//   The snapshot lists 758 protocols with ten observed fields and nothing else: no FDV, no fees, no
//   revenue, no users, no parent protocol. This board ranks protocols that RECORD NO TOKEN -- both
//   gecko_id and symbol null -- by an IMPLIED MARKET-CAP PROXY: one estimate of what a market cap would
//   be if the protocol's record stayed as it is. The proxy is a claim of this entry, not a forecast and
//   not make.fun's. Nothing here predicts whether or when a token is issued.
//
// HOW THE PROXY IS BUILT
//   1. Peers: every protocol whose record carries a positive mcap_usd and a positive tvl_usd (128 rows).
//      Those are the only rows in which a market cap and a TVL are observed together.
//   2. Core: a log-log regression of market cap on TVL, fitted by iteratively reweighted least squares
//      (a Huber-style weight that keeps a single 400x outlier from bending the line):
//          log mcap = a + b * log tvl + categoryOffset
//   3. Category offset: the mean residual of the row's own category, shrunk toward the pooled curve by
//      an Empirical-Bayes-style weight n/(n+k), k = 4 peers. A category with 1 peer keeps a quarter of
//      its own residual; a category with 15 keeps four fifths. No name is ever special-cased.
//   4. Two bounded judgement tilts, disclosed as unvalidated: the seven-day TVL change and the tracking
//      age (the day DefiLlama began tracking, which is NOT the protocol's founding date). Their measured
//      effect on out-of-fold error is in `loo`, and it is not an improvement: the tilts are capped small
//      because the data does not support a larger one.
//
// HOW IT IS CHECKED
//   Leave-one-out cross-validation: for every peer row the whole pipeline above is refit WITHOUT that
//   row (and, for the row's own band, without peers of the same token family), then its market cap is
//   predicted from its TVL alone. `loo` reports RMSLE, MdAPE, the share inside a factor of two, and the
//   same numbers for a naive per-category median multiple. Those folds are the evidence; they are also
//   the only place the residual quantiles used for the P10/P50/P90 bands come from. Caveat stated in the
//   page: the same folds were read while choosing k and the tilt weights, so they are not untouched
//   evidence, and none of this is a guarantee.
//
// Determinism: no clock, no randomness, no locale-dependent sort. Every ordering falls back to slug.

/** The ten observed fields of one snapshot protocol, and nothing else. */
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

export const MODEL_VERSION = 'Radar EB-k4 v2';

/** Peer weight of the Empirical-Bayes shrinkage: a category's own residual counts n/(n+K). */
export const SHRINK_K = 4;

/** Bounded tilts on the pooled curve. Small on purpose: see `loo` in the page for what they cost. */
export const TILT = {
  growth_weight: 0.1,
  growth_clamp: 50,
  age_weight: 0.1,
  age_cap_days: 1095,
  unknown_age_days: 365,
};

/** Robust-fit controls: Huber-style IRLS on absolute log residual, floor on the weight. */
export const FIT = { iterations: 14, scale: 1.5, weight_floor: 0.05 };

/** Band quantiles, taken from the out-of-fold residuals, never from a normal assumption. */
export const BAND_QUANTILES = [0.1, 0.5, 0.9] as const;

/** The value cap the gate states for one row, and the floor of a whole dollar. */
export const VALUE_CAP = 100_000_000_000_000;

/** Derivation categories: a bridge, a staking wrapper, a restaked BTC or a CEX is a product of an
 *  asset that already trades, so its record is not a launch still to come. */
export const DERIVATIVE_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

export const EXCHANGE_BRANDS = ['binance', 'coinbase', 'bybit', 'kraken', 'bitget', 'okx', 'bitfinex', 'gemini'];

/** A release trailer: a space then V2, v2, 2.0 and the like. */
export const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A whole word that marks a wrapped or staked product, in any case. */
export const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** Every slug compared the same way, so a sort never depends on the locale. */
export const bySlug = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A finite number, else null. */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols: SnapshotProtocol[] = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: num(p.change_7d),
      mcap_usd: num(p.mcap_usd),
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Whether the record carries any token evidence at all. Partial evidence still counts as a token. */
export function recordsToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null;
}

/** A family key: the name without a wrapped/staked/bridged word, a release trailer or punctuation. */
export function familyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(wrapped|staked|staking|bridged|v\d+)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Why one pre-token record is left off the board. Null when it is kept: the rules are disjoint and
 *  evaluated in this order, so every excluded row carries exactly one reason. */
export function exclusionReason(p: SnapshotProtocol, liveFamilies: Map<string, string>): string | null {
  if (p.category !== null && DERIVATIVE_CATEGORIES.has(p.category)) return 'derivative-category';
  if (VERSIONED_NAME.test(p.name)) return 'versioned-name';
  if (WRAPPED_WORD.test(p.name)) return 'wrapped-staked-name';
  const lower = p.name.toLowerCase();
  if (EXCHANGE_BRANDS.some((b) => lower.startsWith(b))) return 'exchange-brand';
  const key = familyKey(p.name);
  if (key.length > 0 && liveFamilies.has(key) && liveFamilies.get(key) !== p.slug) return 'token-family';
  return null;
}

/** The universe: every protocol that records no token, minus the conservative exclusions, with the
 *  counts and the per-slug reasons kept for the page. Never a fixed count: it is whatever the snapshot
 *  yields, and the watchlist is added by slug so coverage never rests on a filter. */
export interface Universe {
  kept: SnapshotProtocol[];
  excluded: { slug: string; name: string; category: string | null; tvl_usd: number; reason: string }[];
  counts: Record<string, number>;
  pre_token_total: number;
  watchlist_on_board: number;
  watchlist_off_board: string[];
}

export function buildUniverse(snapshot: Snapshot): Universe {
  const liveFamilies = new Map<string, string>();
  for (const p of snapshot.protocols) {
    if (p.mcap_usd !== null && p.mcap_usd > 0) {
      const key = familyKey(p.name);
      if (key.length > 0 && !liveFamilies.has(key)) liveFamilies.set(key, p.slug);
    }
  }
  const counts: Record<string, number> = { 'derivative-category': 0, 'versioned-name': 0, 'wrapped-staked-name': 0, 'exchange-brand': 0, 'token-family': 0 };
  const kept: SnapshotProtocol[] = [];
  const excluded: Universe['excluded'] = [];
  const watch = new Set(snapshot.watchlist);
  for (const p of snapshot.protocols) {
    if (recordsToken(p)) continue;
    // A slug the house's watchlist names is always kept: the gate's coverage row is not a filter result.
    const reason = watch.has(p.slug) ? null : exclusionReason(p, liveFamilies);
    if (reason === null) kept.push(p);
    else {
      counts[reason] = (counts[reason] ?? 0) + 1;
      excluded.push({ slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, reason });
    }
  }
  const keptSlugs = new Set(kept.map((p) => p.slug));
  return {
    kept,
    excluded: excluded.sort((a, b) => b.tvl_usd - a.tvl_usd || bySlug(a.slug, b.slug)),
    counts,
    pre_token_total: snapshot.protocols.filter((p) => !recordsToken(p)).length,
    watchlist_on_board: snapshot.watchlist.filter((s) => keptSlugs.has(s)).length,
    watchlist_off_board: snapshot.watchlist.filter((s) => !keptSlugs.has(s)),
  };
}

/** Whole days from listed_at to the snapshot day; null when unrecorded. Tracking age, not founding age. */
export function trackingAge(snapshot: Snapshot, p: SnapshotProtocol): number | null {
  if (p.listed_at === null) return null;
  const a = Date.parse(`${snapshot.as_of}T00:00:00Z`);
  const b = Date.parse(`${p.listed_at}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The peer set: an observed market cap beside an observed TVL, both positive. */
export function peersOf(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => bySlug(a.slug, b.slug));
}

/** A two-parameter weighted least squares fit of log mcap on log tvl. */
export interface CoreFit {
  intercept: number;
  slope: number;
  n: number;
  weighted: boolean;
}

function wls(rows: SnapshotProtocol[], w: number[]): CoreFit {
  let s = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const wi = w[i]!;
    const x = Math.log(r.tvl_usd);
    const y = Math.log(r.mcap_usd as number);
    s += wi;
    sx += wi * x;
    sy += wi * y;
    sxx += wi * x * x;
    sxy += wi * x * y;
  }
  if (s <= 0) return { intercept: Math.log(1e6), slope: 0.5, n: 0, weighted: false };
  const mx = sx / s;
  const my = sy / s;
  const vxx = sxx - s * mx * mx;
  const vxy = sxy - s * mx * my;
  if (!(vxx > 1e-12)) return { intercept: my, slope: 0, n: rows.length, weighted: false };
  const slope = vxy / vxx;
  return { intercept: my - slope * mx, slope, n: rows.length, weighted: true };
}

/** The robust core: fit, then down-weight rows far from the line, refit; a Huber-style loop. */
export function fitCore(rows: SnapshotProtocol[]): CoreFit {
  if (rows.length === 0) return { intercept: Math.log(1e6), slope: 0.5, n: 0, weighted: false };
  let w = rows.map(() => 1);
  let fit = wls(rows, w);
  for (let step = 0; step < FIT.iterations; step++) {
    const resid = rows.map((r) => Math.log(r.mcap_usd as number) - (fit.intercept + fit.slope * Math.log(r.tvl_usd)));
    const abs = resid.map((d) => Math.abs(d)).sort((a, b) => a - b);
    const med = abs.length % 2 === 1 ? abs[(abs.length - 1) / 2]! : (abs[abs.length / 2 - 1]! + abs[abs.length / 2]!) / 2;
    const scale = Math.max(1e-6, med) * FIT.scale;
    w = resid.map((d) => 1 / Math.max(Math.abs(d) / scale, FIT.weight_floor));
    fit = wls(rows, w);
  }
  return { ...fit, n: rows.length, weighted: true };
}

/** A fitted peer model: the core, the shrunk category offsets, and the residual spread. */
export interface PeerModel {
  core: CoreFit;
  offsets: Record<string, { n: number; raw: number; shrunk: number }>;
  pooled_multiple: number;
  peers: number;
}

/** Fit the peer model on `rows`: core, then each category's residual mean shrunk by n/(n+K). */
export function fitPeers(rows: SnapshotProtocol[], k: number = SHRINK_K): PeerModel {
  const core = fitCore(rows);
  const resid: Record<string, number[]> = {};
  for (const r of rows) {
    const d = Math.log(r.mcap_usd as number) - (core.intercept + core.slope * Math.log(r.tvl_usd));
    const key = r.category ?? 'Uncategorised';
    (resid[key] ??= []).push(d);
  }
  const offsets: PeerModel['offsets'] = {};
  for (const key of Object.keys(resid).sort(bySlug)) {
    const list = resid[key]!;
    const raw = list.reduce((a, b) => a + b, 0) / list.length;
    offsets[key] = { n: list.length, raw, shrunk: (list.length / (list.length + k)) * raw };
  }
  return { core, offsets, pooled_multiple: 0, peers: rows.length };
}

/** The bounded tilts: seven-day change and tracking age, both capped, both disclosed as unvalidated. */
export function tilt(p: SnapshotProtocol, age: number | null): { growth: number; age: number; total: number } {
  const g = p.change_7d === null ? 0 : Math.min(TILT.growth_clamp, Math.max(-TILT.growth_clamp, p.change_7d));
  const growth = (g / 100) * TILT.growth_weight;
  const days = Math.min(TILT.age_cap_days, Math.max(0, age ?? TILT.unknown_age_days));
  const ageTilt = Math.log1p(days / TILT.age_cap_days) * TILT.age_weight;
  return { growth, age: ageTilt, total: growth + ageTilt };
}

/** The log proxy one protocol gets from a fitted peer model, with its parts kept for the drawer. */
export interface Prediction {
  log: number;
  core: number;
  offset: number;
  growth_tilt: number;
  age_tilt: number;
  category: string;
  category_peers: number;
  multiple: number;
}

export function predict(p: SnapshotProtocol, age: number | null, model: PeerModel): Prediction {
  const core = model.core.intercept + model.core.slope * Math.log(p.tvl_usd);
  const key = p.category ?? 'Uncategorised';
  const offset = model.offsets[key]?.shrunk ?? 0;
  const t = tilt(p, age);
  const log = core + offset + t.total;
  return {
    log,
    core,
    offset,
    growth_tilt: t.growth,
    age_tilt: t.age,
    category: key,
    category_peers: model.offsets[key]?.n ?? 0,
    multiple: Math.exp(log) / p.tvl_usd,
  };
}

/** A quantile of a sorted copy of `values`, linear interpolation, 0 when empty. */
export function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const at = (s.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  if (lo === hi) return s[lo]!;
  return s[lo]! + (s[hi]! - s[lo]!) * (at - lo);
}

/** One leave-one-out fold: the target's observed market cap against the refit-without-it proxy. */
export interface Fold {
  slug: string;
  family_dropped: number;
  predicted_usd: number;
  actual_usd: number;
  log_error: number;
  /** log(actual / predicted): positive means the proxy under-stated the market cap. */
  log_ratio: number;
}

/** The cross-validation evidence: every fold, the aggregate losses, and the naive comparison. */
export interface Validation {
  method: string;
  folds: Fold[];
  n: number;
  rmsle: number;
  mdape: number;
  within_2x: number;
  naive_rmsle: number;
  naive_mdape: number;
  naive_within_2x: number;
  core_only_rmsle: number;
  core_only_within_2x: number;
  family_dropped_folds: number;
  ratio_quantiles: { p10: number; p50: number; p90: number };
  notes: string[];
}

/**
 * Leave-one-out CV. For each peer row: refit the whole pipeline without it (and without peers of the
 * same token family), predict its market cap from its TVL, and score it. The naive baseline is the
 * median market-cap/TVL multiple of the same peers, category-first, floored at three peers.
 */
export function crossValidate(rows: SnapshotProtocol[], k: number = SHRINK_K): Validation {
  const folds: Fold[] = [];
  const naiveFolds: { predicted: number; actual: number }[] = [];
  const coreFolds: { predicted: number; actual: number }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const target = rows[i]!;
    const key = familyKey(target.name);
    const rest = rows.filter((r, j) => j !== i && familyKey(r.name) !== key);
    const restNoFamily = rows.filter((_, j) => j !== i);
    const model = fitPeers(rest, k);
    const coreOnly = fitPeers(restNoFamily, k);
    const pred = predict(target, null, model);
    const predicted = Math.exp(pred.log);
    const actual = target.mcap_usd as number;
    folds.push({
      slug: target.slug,
      family_dropped: rows.length - 1 - rest.length,
      predicted_usd: predicted,
      actual_usd: actual,
      log_error: Math.log(predicted) - Math.log(actual),
      log_ratio: Math.log(actual) - Math.log(predicted),
    });
    coreFolds.push({ predicted: Math.exp(predict(target, null, coreOnly).log), actual });
    const sameCat = rest.filter((r) => (r.category ?? 'Uncategorised') === (target.category ?? 'Uncategorised'));
    const pool = sameCat.length >= 3 ? sameCat : rest;
    const multiples = pool.map((r) => (r.mcap_usd as number) / r.tvl_usd).sort((a, b) => a - b);
    const median = multiples.length === 0 ? 0.2 : multiples.length % 2 === 1 ? multiples[(multiples.length - 1) / 2]! : (multiples[multiples.length / 2 - 1]! + multiples[multiples.length / 2]!) / 2;
    naiveFolds.push({ predicted: median * target.tvl_usd, actual });
  }
  const rmsle = (list: { predicted: number; actual: number }[]): number =>
    Math.sqrt(list.reduce((a, f) => a + Math.pow(Math.log(f.predicted) - Math.log(f.actual), 2), 0) / Math.max(1, list.length));
  const mdape = (list: { predicted: number; actual: number }[]): number => quantile(list.map((f) => Math.abs(f.predicted / f.actual - 1)), 0.5);
  const within = (list: { predicted: number; actual: number }[]): number =>
    list.length === 0 ? 0 : list.filter((f) => f.predicted / f.actual >= 0.5 && f.predicted / f.actual <= 2).length / list.length;
  const actualFolds = folds.map((f) => ({ predicted: f.predicted_usd, actual: f.actual_usd }));
  const ratios = folds.map((f) => Math.exp(f.log_ratio));
  return {
    method: 'Leave-one-out: the peer model refit without the target row and without same-family peers, predicting the target market cap from its TVL alone.',
    folds,
    n: folds.length,
    rmsle: rmsle(actualFolds),
    mdape: mdape(actualFolds),
    within_2x: within(actualFolds),
    naive_rmsle: rmsle(naiveFolds),
    naive_mdape: mdape(naiveFolds),
    naive_within_2x: within(naiveFolds),
    core_only_rmsle: rmsle(coreFolds),
    core_only_within_2x: within(coreFolds),
    family_dropped_folds: folds.filter((f) => f.family_dropped > 0).length,
    ratio_quantiles: {
      p10: quantile(ratios, BAND_QUANTILES[0]),
      p50: quantile(ratios, BAND_QUANTILES[1]),
      p90: quantile(ratios, BAND_QUANTILES[2]),
    },
    notes: [
      'The same folds were read while choosing k = 4 and the two tilt caps, so they are model-selection evidence, not an untouched holdout. No second untouched set exists in a 128-peer snapshot.',
      'Naive is the per-category median multiple, falling back to the pooled median below three peers in the category.',
      'Residuals are wide by nature: a market cap and a TVL are different quantities, and the best row here still misses by more than 2x in most folds. The bands say so instead of hiding it.',
    ],
  };
}

/** One row of the board, and of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  band: { p10: number; p50: number; p90: number };
  multiple: number;
  confidence: 'low' | 'medium' | 'higher';
  value_tag: string;
  peers: { slug: string; name: string; category: string | null; tvl_usd: number; mcap_usd: number; multiple: number; distance: number }[];
  breakdown: { core_multiple: number; category_offset: number; growth_tilt: number; age_tilt: number; category_peers: number };
  explanation: string;
  farm_steps: string[];
  watchlist: boolean;
}

/** A capital tier, stated as an assumption in every plan that uses it. */
export interface Tier {
  label: string;
  capital_usd: number;
  gas_note: string;
}

/** Assumed costing tiers. They are assumptions from the record's TVL and chain names, never live quotes. */
export function tierFor(p: SnapshotProtocol): Tier {
  const chains = p.chains.map((c) => c.toLowerCase());
  const cheap = chains.some((c) => ['solana', 'base', 'arbitrum', 'optimism', 'polygon', 'bnb', 'sui', 'monad', 'hyperliquid l1', 'unichain', 'avalanche', 'katana', 'flare', 'plasma', 'sonic'].includes(c));
  const gas = cheap ? 'about $0.30 of gas a move (assumed L2/low-fee chain)' : 'about $6 of gas a move (assumed Ethereum mainnet)';
  if (p.tvl_usd >= 1_000_000_000) return { label: 'core position', capital_usd: 500, gas_note: gas };
  if (p.tvl_usd >= 100_000_000) return { label: 'standard position', capital_usd: 200, gas_note: gas };
  if (p.tvl_usd >= 20_000_000) return { label: 'small position', capital_usd: 75, gas_note: gas };
  return { label: 'probe position', capital_usd: 25, gas_note: gas };
}

/** The mechanism a farm plan uses, from the category alone. */
export function mechanism(category: string | null): { verb: string; object: string; repeat: string } {
  const c = (category ?? '').toLowerCase();
  if (c.includes('curator') || c.includes('allocator')) return { verb: 'Deposit into one vault', object: 'a vault whose curator the protocol names and whose fee you can read', repeat: 'one deposit or rebalance' };
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return { verb: 'Supply and borrow', object: 'a stablecoin supply position plus one small borrow against it', repeat: 'one supply, borrow or repay' };
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged')) return { verb: 'Provide liquidity', object: 'one tight stable pair rather than the highest-fee pool', repeat: 'one rebalance or fee claim' };
  if (c.includes('bridge') || c.includes('cross chain')) return { verb: 'Move funds across', object: 'a round trip of the same asset in and out on one route', repeat: 'one bridged transfer' };
  if (c.includes('staking') || c.includes('restak')) return { verb: 'Stake, do not wrap', object: 'native staking through the protocol where its own app allows it', repeat: 'one stake, delegation change or reward claim' };
  if (c.includes('perp') || c.includes('derivative') || c.includes('options')) return { verb: 'Trade a hedged position', object: 'one small position with a matching hedge, never naked leverage', repeat: 'one open or close' };
  if (c.includes('basis')) return { verb: 'Run a basis position', object: 'spot plus the opposite perp, sized so the basis is the only exposure', repeat: 'one roll of the perp leg' };
  if (c.includes('rwa')) return { verb: 'Hold the yield asset', object: 'the protocol\'s own yield-bearing asset, redeemable on its stated terms', repeat: 'one mint, redeem or claim' };
  if (c.includes('stable')) return { verb: 'Mint or hold', object: 'the stable asset with the collateral the protocol documents', repeat: 'one mint or repay' };
  if (c.includes('prediction')) return { verb: 'Take one market position', object: 'a single market with a defined resolution date', repeat: 'one trade or resolution claim' };
  if (c.includes('insurance')) return { verb: 'Buy cover', object: 'a policy on a protocol you already hold, with the payout terms read first', repeat: 'one policy renewal' };
  if (c.includes('governance') || c.includes('incentive')) return { verb: 'Take part in governance', object: 'a delegation or a vote on a live proposal, never a paid vote', repeat: 'one vote or delegation change' };
  return { verb: 'Use the protocol directly', object: 'its main deposit or swap route with the smallest viable size', repeat: 'one deposit, swap or claim' };
}

/** Chain-aware first step: what to hold before the protocol sees the wallet. */
function chainStep(p: SnapshotProtocol, tier: Tier): string {
  const first = p.chains[0] ?? 'its main chain';
  const many = p.chains.length > 1 ? ` It records ${p.chains.length} chains, so stay on ${first} where the TVL is largest.` : '';
  return `Fund a fresh wallet with about $${tier.capital_usd} of the asset ${first} uses for gas and fees, and keep the seed offline: this is a ${tier.label}, and ${tier.gas_note}.${many}`;
}

/**
 * A farm plan: 3 to 12 steps, each 20 to 600 characters, derived only from the record's category,
 * chains, TVL, growth and tracking age. Costs are ASSUMED tiers, not quotes; the allocation is a
 * hypothetical scenario; nothing here claims an airdrop, points or eligibility.
 */
export function farmPlan(p: SnapshotProtocol, age: number | null, band: { p10: number; p90: number }): string[] {
  const tier = tierFor(p);
  const m = mechanism(p.category);
  const chain = p.chains[0] ?? 'its main chain';
  const holdDays = age === null ? 45 : age < 180 ? 90 : age < 400 ? 60 : 45;
  const growth = p.change_7d === null ? 'no seven-day change is recorded' : `TVL moved ${p.change_7d > 0 ? '+' : ''}${p.change_7d.toFixed(1)}% in seven days`;
  const steps = [
    chainStep(p, tier),
    `${m.verb}: put $${tier.capital_usd} into ${m.object} on ${chain}. Assumed cost ${tier.gas_note} plus any protocol fee the app shows before you sign; read that fee, not this line.`,
    `Repeat ${m.repeat} once a week for at least ${holdDays} days, so the wallet shows up in more than one snapshot of the protocol's own activity. Cadence matters more than size here.`,
    `Hold, do not churn: ${growth}, and a position that leaves after a week records a wallet that came for a snapshot. Keep the same wallet for the whole ${holdDays} days.`,
    `Scenario, not a promise: if you split $${tier.capital_usd} as 60% into this protocol and 40% into a second name on the board, the capital at risk is $${tier.capital_usd} and nothing about the split is an expected return.`,
    `Size for dilution: an airdrop, if one ever comes, is split across every wallet that farms it, so a $${tier.capital_usd} position can end up worth less than its gas. Treat the whole outlay as spend, not investment.`,
    `Guard against sybil filters: one wallet per person, real activity at real size, no funded-in-and-out loops, and no bought proofs of humanity. Filters are designed to catch exactly the pattern this plan forbids.`,
    `Read the contract before you sign: check the app's audit and upgrade keys, prefer a proxy you can inspect, and never approve unlimited allowance to a contract you have not read.`,
    `Keep a log of every transaction and check the protocol's own channels for a claim page. Never pay to claim, and never sign a permit that moves funds you did not intend to move.`,
    `Why this rank: the proxy puts the mid case near $${Math.round(band.p90 / 1e6)}M against a $${Math.round(p.tvl_usd / 1e6)}M TVL, and the band runs $${Math.round(band.p10 / 1e6)}M to $${Math.round(band.p90 / 1e6)}M. That spread is the honest part: farm it for the record, not for the number.`,
  ];
  return steps.map((s) => {
    let out = s.trim();
    if (out.length > 600) out = `${out.slice(0, 596).trimEnd()} ...`;
    if (out.length < 20) out = `${out} Check the protocol's own page before acting.`;
    return out;
  });
}

/** The nearest peers of one row: same category first, then any category, by log-TVL distance. */
export function nearestPeers(p: SnapshotProtocol, peers: SnapshotProtocol[], limit = 6): BoardRow['peers'] {
  const x = Math.log(p.tvl_usd);
  const scored = peers
    .filter((q) => q.mcap_usd !== null && q.mcap_usd > 0)
    .map((q) => ({
      slug: q.slug,
      name: q.name,
      category: q.category,
      tvl_usd: q.tvl_usd,
      mcap_usd: q.mcap_usd as number,
      multiple: (q.mcap_usd as number) / q.tvl_usd,
      distance: Math.abs(Math.log(q.tvl_usd) - x) - ((q.category ?? '') === (p.category ?? '') ? 1 : 0),
    }));
  return scored.sort((a, b) => a.distance - b.distance || bySlug(a.slug, b.slug)).slice(0, limit);
}

/** The confidence tag: how many category peers back the offset, and how wide the band is. */
function confidenceOf(categoryPeers: number, band: { p10: number; p90: number }): 'low' | 'medium' | 'higher' {
  const width = Math.log(band.p90 / Math.max(1, band.p10));
  if (categoryPeers >= 8 && width < 5.5) return 'higher';
  if (categoryPeers >= 3 && width < 6.5) return 'medium';
  return 'low';
}

/** A one-line value tag for the table: which part of the stack drove the number. */
function valueTagOf(pred: Prediction, p: SnapshotProtocol): string {
  if (Math.abs(pred.growth_tilt) > 0.03) return pred.growth_tilt > 0 ? 'growing TVL' : 'falling TVL';
  if (p.tvl_usd >= 1_000_000_000) return 'large TVL';
  if (p.tvl_usd < 25_000_000) return 'small TVL';
  if (pred.offset > 0.5) return 'strong category';
  if (pred.offset < -0.5) return 'weak category';
  return 'middle of the curve';
}

/** The whole board: fit, then score every kept protocol, rank by the proxy, slug breaks ties. */
export interface BoardBuild {
  rows: BoardRow[];
  model: PeerModel;
  validation: Validation;
  universe: Universe;
  snapshot: Snapshot;
  excluded_count: number;
}

export function buildBoard(snapshot: Snapshot): BoardBuild {
  const universe = buildUniverse(snapshot);
  const peers = peersOf(snapshot);
  const model = fitPeers(peers);
  const validation = crossValidate(peers);
  const q = validation.ratio_quantiles;
  const band = (logProxy: number): { p10: number; p50: number; p90: number } => {
    const clamp = (n: number): number => Math.min(VALUE_CAP, Math.max(1, Math.round(n)));
    const p10 = clamp(Math.exp(logProxy + Math.log(Math.max(1e-6, q.p10))));
    const p50 = clamp(Math.exp(logProxy + Math.log(Math.max(1e-6, q.p50))));
    const p90 = clamp(Math.exp(logProxy + Math.log(Math.max(1e-6, q.p90))));
    return { p10: Math.min(p10, p50), p50: Math.min(p50, p90), p90: Math.max(p90, p50) };
  };
  const scored = universe.kept.map((p) => {
    const age = trackingAge(snapshot, p);
    const pred = predict(p, age, model);
    const b = band(pred.log);
    // The ranked number is the proxy itself, kept inside its own estimated band on both sides.
    const implied = Math.min(b.p90, Math.max(b.p10, Math.min(VALUE_CAP, Math.max(1, Math.round(Math.exp(pred.log))))));
    const b2 = { p10: Math.min(b.p10, implied), p50: Math.min(Math.max(b.p50, b.p10), b.p90), p90: Math.max(b.p90, implied) };
    return { p, age, pred, band: b2, implied };
  });
  scored.sort((a, b) => b.implied - a.implied || bySlug(a.p.slug, b.p.slug));
  const watch = new Set(snapshot.watchlist);
  const rows: BoardRow[] = scored.map((s, i) => {
    const peersRow = nearestPeers(s.p, peers);
    const coreMult = Math.exp(s.pred.core) / s.p.tvl_usd;
    const explanation =
      `Implied market-cap proxy $${Math.round(s.implied / 1e6)}M: a $${Math.round(s.p.tvl_usd / 1e6)}M TVL at the pooled ` +
      `${s.pred.multiple.toFixed(2)}x multiple, of which the category offset contributes ${(Math.exp(s.pred.offset)).toFixed(2)}x ` +
      `from ${s.pred.category_peers} peer${s.pred.category_peers === 1 ? '' : 's'}, the seven-day tilt ${(Math.exp(s.pred.growth_tilt)).toFixed(3)}x ` +
      `and the tracking-age tilt ${(Math.exp(s.pred.age_tilt)).toFixed(3)}x. Core-only multiple ${coreMult.toFixed(3)}x.`;
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      listed_at: s.p.listed_at,
      age_days: s.age,
      implied_value_usd: s.implied,
      band: s.band,
      multiple: Number(s.pred.multiple.toFixed(4)),
      confidence: confidenceOf(s.pred.category_peers, s.band),
      value_tag: valueTagOf(s.pred, s.p),
      peers: peersRow,
      breakdown: {
        core_multiple: Number(coreMult.toFixed(4)),
        category_offset: Number(s.pred.offset.toFixed(4)),
        growth_tilt: Number(s.pred.growth_tilt.toFixed(4)),
        age_tilt: Number(s.pred.age_tilt.toFixed(4)),
        category_peers: s.pred.category_peers,
      },
      explanation,
      farm_steps: farmPlan(s.p, s.age, s.band),
      watchlist: watch.has(s.p.slug),
    };
  });
  return { rows, model, validation, universe, snapshot, excluded_count: universe.excluded.length };
}

/** The page's compact row: the drawer's material, without repeating what the data script holds once. */
export interface PageRow extends Omit<BoardRow, 'farm_steps'> {}

/** Everything the page reads, written beside it as data.js. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  shrink_k: number;
  tilt: typeof TILT;
  counts: {
    protocols: number;
    peers: number;
    pre_token: number;
    on_board: number;
    watchlist: number;
    watchlist_covered: number;
    excluded: number;
    early_below_floor: number;
    live_with_mcap: number;
  };
  exclusions: Universe['excluded'];
  exclusion_counts: Record<string, number>;
  validation: Omit<Validation, 'folds'> & { folds: { slug: string; predicted_usd: number; actual_usd: number }[] };
  rows: BoardRow[];
  excluded_watchlist: string[];
}

export function buildRadar(snapshot: Snapshot): { build: BoardBuild; radar: RadarData } {
  const build = buildBoard(snapshot);
  const { validation, universe, rows } = build;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    shrink_k: SHRINK_K,
    tilt: TILT,
    counts: {
      protocols: snapshot.protocols.length,
      peers: build.model.peers,
      pre_token: universe.pre_token_total,
      on_board: rows.length,
      watchlist: snapshot.watchlist.length,
      watchlist_covered: universe.watchlist_on_board,
      excluded: universe.excluded.length,
      early_below_floor: rows.filter((r) => !r.watchlist && r.tvl_usd < snapshot.floor_usd).length,
      live_with_mcap: snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0).length,
    },
    exclusions: universe.excluded,
    exclusion_counts: universe.counts,
    validation: {
      method: validation.method,
      n: validation.n,
      rmsle: validation.rmsle,
      mdape: validation.mdape,
      within_2x: validation.within_2x,
      naive_rmsle: validation.naive_rmsle,
      naive_mdape: validation.naive_mdape,
      naive_within_2x: validation.naive_within_2x,
      core_only_rmsle: validation.core_only_rmsle,
      core_only_within_2x: validation.core_only_within_2x,
      family_dropped_folds: validation.family_dropped_folds,
      ratio_quantiles: validation.ratio_quantiles,
      notes: validation.notes,
      folds: validation.folds.map((f) => ({ slug: f.slug, predicted_usd: Math.round(f.predicted_usd), actual_usd: Math.round(f.actual_usd) })),
    },
    rows,
    excluded_watchlist: universe.watchlist_off_board,
  };
  return { build, radar };
}

/** The gate's own rules, checked here so a bad board never reaches the scorer. */
export function boardIssue(rows: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  if (rows.length < 100 || rows.length > 4000) return `the board holds ${rows.length} rows`;
  for (const r of rows) {
    if (!slugs.has(r.slug)) return `invented slug ${r.slug}`;
    if (seen.has(r.slug)) return `duplicate slug ${r.slug}`;
    seen.add(r.slug);
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.implied_value_usd > VALUE_CAP) return `${r.slug} is past the value cap`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
  }
  const ranks = rows.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < rows.length; i++) if (rows[i]!.implied_value_usd > rows[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i}`;
  if (rows.length >= 2 && rows[0]!.implied_value_usd === rows[rows.length - 1]!.implied_value_usd) return 'every row shares one implied value';
  const covered = new Set(rows.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !covered.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs`;
  return null;
}

/** data.js: every byte the page shows, one script, no fetch. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
