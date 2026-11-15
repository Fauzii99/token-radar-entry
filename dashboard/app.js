// Token Radar's page. Everything it shows is read from window.RADAR, the one script main.ts writes from
// the same board.json it hands the gate: there is no fetch, no import and no second copy of the numbers.
// The scatter, the leave-one-out proof panel and every drawer are drawn from that one object.
(function () {
  'use strict';

  var D = window.RADAR;
  var root = document.getElementById('board');
  if (!D) {
    root.textContent = 'data.js did not load: open the page through /output/dashboard so ../data.js resolves.';
    return;
  }

  // ---------------------------------------------------------------- state
  var state = {
    q: '',
    category: 'all',
    chain: 'all',
    confidence: 'all',
    tag: 'all',
    sort: [{ key: 'rank', dir: 1 }],
    open: null,
    detailTab: 'valuation',
    view: 'board',
    theme: 'dark',
  };
  try {
    var savedTheme = window.localStorage.getItem('radar-theme');
    if (savedTheme === 'light' || savedTheme === 'dark') state.theme = savedTheme;
  } catch (e) { /* file:// may refuse storage; the default stands */ }

  var CONF_ORDER = { low: 0, medium: 1, higher: 2 };

  // ---------------------------------------------------------------- format
  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var a = Math.abs(n);
    if (a >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function exact(n) {
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function pct(n, digits) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n * 100).toFixed(digits === undefined ? 0 : digits) + '%';
  }
  function signed(n, digits) {
    if (n === null || n === undefined || !isFinite(n)) return 'no record';
    return (n > 0 ? '+' : '') + n.toFixed(digits === undefined ? 1 : digits) + '%';
  }
  function age(days) {
    if (days === null || days === undefined) return 'not tracked';
    if (days >= 730) return (days / 365).toFixed(1) + 'y';
    if (days >= 60) return Math.round(days / 30) + 'mo';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function mult(n) { return n.toFixed(n >= 10 ? 0 : n >= 1 ? 2 : 3) + 'x'; }

  // ---------------------------------------------------------------- dom
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) node.appendChild(x); });
      else if (typeof c === 'string' || typeof c === 'number') node.appendChild(document.createTextNode(String(c)));
      else node.appendChild(c);
    }
    return node;
  }

  // ---------------------------------------------------------------- integrity
  // The page never trusts its own copy blindly: the counts it prints are recomputed from the rows, and a
  // mismatch is shown to the reader instead of hidden. This is the "KPI totals and rounding exact" check.
  var checks = [];
  function check(label, ok, detail) { checks.push({ label: label, ok: !!ok, detail: detail }); return ok; }
  (function integrity() {
    var rows = D.rows;
    var ranks = rows.map(function (r) { return r.rank; }).sort(function (a, b) { return a - b; });
    var monotone = true;
    for (var i = 1; i < rows.length; i++) if (rows[i].implied_value_usd > rows[i - 1].implied_value_usd) monotone = false;
    var rankOk = ranks.every(function (r, i) { return r === i + 1; });
    var covered = rows.filter(function (r) { return r.watchlist; }).length;
    var exclSum = Object.keys(D.exclusion_counts).reduce(function (a, k) { return a + D.exclusion_counts[k]; }, 0);
    check('row count matches the model count', rows.length === D.counts.on_board, rows.length + ' vs ' + D.counts.on_board);
    check('ranks are 1..N once each', rankOk, rows.length + ' rows');
    check('implied value never rises with rank', monotone, 'descending');
    check('watchlist fully covered', covered === D.counts.watchlist, covered + '/' + D.counts.watchlist);
    check('exclusions add up', exclSum === D.counts.excluded, exclSum + ' exclusion records');
    check('pre-token rows add up', D.counts.on_board + D.counts.excluded === D.counts.pre_token, D.counts.on_board + ' + ' + D.counts.excluded + ' = ' + D.counts.pre_token);
    check('every drawer row has a plan', rows.every(function (r) { return r.farm_steps.length >= 3 && r.farm_steps.length <= 12; }), '3-12 steps each');
    check('board is not one flat value', rows[0].implied_value_usd !== rows[rows.length - 1].implied_value_usd, money(rows[0].implied_value_usd) + ' to ' + money(rows[rows.length - 1].implied_value_usd));
  })();
  var failed = checks.filter(function (c) { return !c.ok; });

  // ---------------------------------------------------------------- theme
  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.theme);
    try { window.localStorage.setItem('radar-theme', state.theme); } catch (e) { /* fine */ }
  }

  // ---------------------------------------------------------------- filtering
  var CATEGORIES = Array.from(new Set(D.rows.map(function (r) { return r.category || 'Uncategorised'; }))).sort();
  var CHAINS = Array.from(new Set(D.rows.reduce(function (a, r) { return a.concat(r.chains); }, []))).sort();
  var TAGS = Array.from(new Set(D.rows.map(function (r) { return r.value_tag; }))).sort();

  function haystack(r) {
    return [r.name, r.slug, r.category || '', r.chains.join(' '), r.value_tag, r.confidence, r.symbol || '', String(r.rank)].join(' ').toLowerCase();
  }
  function visible() {
    var q = state.q.trim().toLowerCase();
    var terms = q.length === 0 ? [] : q.split(/\s+/);
    return D.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Uncategorised') !== state.category) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) < 0) return false;
      if (state.confidence !== 'all' && CONF_ORDER[r.confidence] < CONF_ORDER[state.confidence]) return false;
      if (state.tag !== 'all' && r.value_tag !== state.tag) return false;
      if (terms.length === 0) return true;
      var h = haystack(r);
      return terms.every(function (t) { return h.indexOf(t) >= 0; });
    });
  }

  var SORT_VALUE = {
    rank: function (r) { return r.rank; },
    name: function (r) { return r.name.toLowerCase(); },
    implied: function (r) { return r.implied_value_usd; },
    tvl: function (r) { return r.tvl_usd; },
    multiple: function (r) { return r.multiple; },
    growth: function (r) { return r.change_7d === null ? -Infinity : r.change_7d; },
    age: function (r) { return r.age_days === null ? -1 : r.age_days; },
    peers: function (r) { return r.breakdown.category_peers; },
    confidence: function (r) { return CONF_ORDER[r.confidence]; },
    p90: function (r) { return r.band.p90; },
  };

  function sorted(list) {
    var stack = state.sort;
    return list.slice().sort(function (a, b) {
      for (var i = 0; i < stack.length; i++) {
        var s = stack[i];
        var f = SORT_VALUE[s.key];
        var av = f(a), bv = f(b);
        if (av < bv) return -s.dir;
        if (av > bv) return s.dir;
      }
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }
  function toggleSort(key, additive) {
    var at = -1;
    for (var i = 0; i < state.sort.length; i++) if (state.sort[i].key === key) at = i;
    if (!additive) {
      if (at === 0) state.sort[0].dir = -state.sort[0].dir;
      else state.sort = [{ key: key, dir: key === 'name' ? 1 : key === 'rank' ? 1 : -1 }];
    } else if (at >= 0) {
      state.sort[at].dir = -state.sort[at].dir;
    } else {
      state.sort = state.sort.concat([{ key: key, dir: key === 'name' ? 1 : -1 }]).slice(0, 3);
    }
    render();
  }

  // ---------------------------------------------------------------- scatter (canvas, retina aware)
  function log10(n) { return Math.log(n) / Math.LN10; }
  function drawScatter(canvas, mode) {
    var rect = canvas.getBoundingClientRect();
    if (rect.width < 40) return;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    var g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, rect.width, rect.height);
    var css = getComputedStyle(document.documentElement);
    var ink = css.getPropertyValue('--ink').trim() || '#e8ece9';
    var muted = css.getPropertyValue('--muted').trim() || '#9aa8a1';
    var accent = css.getPropertyValue('--accent').trim() || '#4ade80';
    var line = css.getPropertyValue('--border').trim() || '#2a3833';
    var inkDim = css.getPropertyValue('--ink-2').trim() || '#b9c7c0';
    var W = rect.width, H = rect.height;
    var pad = { l: 52, r: 16, t: 16, b: 44 };
    var points = mode === 'loo'
      ? D.validation.folds.map(function (f) { return { x: f.predicted_usd, y: f.actual_usd, slug: f.slug }; })
      : D.peer_points.map(function (p) { return { x: p.tvl_usd, y: p.mcap_usd, slug: p.slug }; });
    if (points.length === 0) return;
    var xs = points.map(function (p) { return log10(p.x); });
    var ys = points.map(function (p) { return log10(p.y); });
    var x0 = Math.floor(Math.min.apply(null, xs)) - 0.2, x1 = Math.ceil(Math.max.apply(null, xs)) + 0.2;
    var y0 = Math.floor(Math.min.apply(null, ys)) - 0.2, y1 = Math.ceil(Math.max.apply(null, ys)) + 0.2;
    if (mode === 'loo') { var lo = Math.min(x0, y0), hi = Math.max(x1, y1); x0 = lo; x1 = hi; y0 = lo; y1 = hi; }
    function px(v) { return pad.l + ((v - x0) / (x1 - x0)) * (W - pad.l - pad.r); }
    function py(v) { return H - pad.b - ((v - y0) / (y1 - y0)) * (H - pad.t - pad.b); }
    function tick(v) {
      var power = Math.pow(10, v);
      if (v >= 12) return '$' + power / 1e12 + 'T';
      if (v >= 9) return '$' + power / 1e9 + 'B';
      if (v >= 6) return '$' + power / 1e6 + 'M';
      if (v >= 3) return '$' + power / 1e3 + 'K';
      return '$' + power;
    }
    function tickText(v) {
      var t = tick(v);
      return /\.\d{2,}/.test(t) ? t.replace(/(\.\d)\d+/, '$1') : t;
    }

    g.strokeStyle = line;
    g.lineWidth = 1;
    g.fillStyle = inkDim;
    g.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    var stepY = (y1 - y0) > 8 ? 2 : 1;
    for (var t = Math.ceil(y0); t <= y1; t += stepY) {
      var yy = py(t);
      g.beginPath(); g.moveTo(pad.l, yy); g.lineTo(W - pad.r, yy); g.stroke();
      g.fillText(tickText(t), pad.l - 7, yy);
    }
    g.textAlign = 'center';
    g.textBaseline = 'top';
    var stepX = (x1 - x0) > 8 ? 2 : 1;
    for (var tx = Math.ceil(x0); tx <= x1; tx += stepX) {
      var xx = px(tx);
      g.beginPath(); g.moveTo(xx, pad.t); g.lineTo(xx, H - pad.b); g.stroke();
      g.fillText(tickText(tx), xx, H - pad.b + 7);
    }
    g.fillStyle = ink;
    g.textAlign = 'center';
    g.font = '11px ui-sans-serif, system-ui, sans-serif';
    g.fillText(mode === 'loo' ? 'Predicted market cap, out of fold' : 'Observed TVL in the snapshot', pad.l + (W - pad.l - pad.r) / 2, H - 15);

    if (mode === 'loo') {
      g.strokeStyle = accent;
      g.lineWidth = 2;
      g.setLineDash([5, 4]);
      g.beginPath(); g.moveTo(px(x0), py(x0)); g.lineTo(px(x1), py(x1)); g.stroke();
      g.setLineDash([]);
      g.lineWidth = 1;
      g.strokeStyle = muted;
      g.globalAlpha = 0.45;
      [-Math.log10(2), Math.log10(2)].forEach(function (d) {
        g.beginPath(); g.moveTo(px(x0), py(x0 + d)); g.lineTo(px(x1), py(x1 + d)); g.stroke();
      });
      g.globalAlpha = 1;
    } else {
      // The pooled core line, log mcap = a + b log tvl, in decades: y = a/ln10 + b x.
      var fit = D.fit;
      var aDec = fit.intercept / Math.LN10;
      g.strokeStyle = accent;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(px(x0), py(aDec + fit.slope * x0));
      g.lineTo(px(x1), py(aDec + fit.slope * x1));
      g.stroke();
      g.lineWidth = 1;
    }

    points.forEach(function (p) {
      var x = log10(p.x), y = log10(p.y);
      g.beginPath();
      g.arc(px(x), py(y), 2.6, 0, Math.PI * 2);
      g.fillStyle = accent;
      g.globalAlpha = mode === 'loo' ? 0.55 : 0.8;
      g.fill();
      g.globalAlpha = 1;
    });
  }

  // ---------------------------------------------------------------- sections
  function header() {
    var themeBtn = el('button', { class: 'ghost', type: 'button', 'aria-label': 'Switch between dark and light', onclick: function () { state.theme = state.theme === 'dark' ? 'light' : 'dark'; applyTheme(); render(); } }, state.theme === 'dark' ? 'Light theme' : 'Dark theme');
    return el('header', { class: 'top' },
      el('div', { class: 'brand' },
        el('span', { class: 'mark', 'aria-hidden': 'true' }),
        el('div', null,
          el('h1', { text: 'Token Radar' }),
          el('p', { class: 'sub', text: 'Pre-token protocols, ranked by an implied market-cap proxy' })
        )
      ),
      el('div', { class: 'top-meta' },
        el('span', { class: 'pill', text: 'snapshot ' + D.as_of }),
        el('span', { class: 'pill', text: 'Empirical Bayes, k=' + D.shrink_k }),
        themeBtn
      )
    );
  }

  function kpis() {
    var top = D.rows[0];
    var medianValues = D.rows.map(function (row) { return row.implied_value_usd; }).sort(function (a, b) { return a - b; });
    var middle = Math.floor(medianValues.length / 2);
    var median = { implied_value_usd: medianValues.length % 2 ? medianValues[middle] : (medianValues[middle - 1] + medianValues[middle]) / 2 };
    var q = D.validation.ratio_quantiles;
    var items = [
      ['Top implied proxy', money(top.implied_value_usd), '#' + top.rank + ' ' + top.name + ' - band ' + money(top.band.p10) + ' to ' + money(top.band.p90)],
      ['Pre-token protocols ranked', String(D.counts.on_board), D.counts.early_below_floor + ' below the $' + Math.round(D.floor_usd / 1e6) + 'M floor'],
      ['Watchlist covered', D.counts.watchlist_covered + ' / ' + D.counts.watchlist, 'the floor, never the ceiling'],
      ['Excluded, one reason each', String(D.counts.excluded), 'of ' + D.counts.pre_token + ' records with no token'],
      ['Observed peers fitted', String(D.counts.peers), 'market cap and TVL both seen'],
      ['Out-of-fold band', q.p10.toFixed(2) + 'x to ' + q.p90.toFixed(2) + 'x', 'P10-P90 of ' + D.validation.n + ' folds'],
      ['Within 2x: model / naive', pct(D.validation.within_2x) + ' / ' + pct(D.validation.naive_within_2x), 'median proxy ' + money(median.implied_value_usd)],
    ];
    return el('section', { class: 'kpis', 'aria-label': 'Key figures' }, items.map(function (it) {
      return el('div', { class: 'kpi' },
        el('span', { class: 'kpi-label', text: it[0] }),
        el('b', { class: 'kpi-value', text: it[1] }),
        el('span', { class: 'kpi-note', text: it[2] })
      );
    }));
  }

  function lede() {
    return el('section', { class: 'lede' },
      el('div', { class: 'lede-copy' },
        el('h2', { text: 'What a token would be worth if the record stayed as it is' }),
        el('p', { text: 'Every row records no token: no market cap, no CoinGecko id, no symbol. The number beside it is an implied market-cap proxy, fitted on the ' + D.counts.peers + ' protocols in this snapshot where a market cap and a TVL are both observed. It is this board\'s claim, not a forecast, and it says nothing about whether or when a token is issued.' })
      ),
      el('div', { class: 'lede-side' },
        el('div', { class: 'band-box' },
          el('span', { class: 'kpi-label', text: 'How to read the ranking' }),
          el('p', { class: 'sub', text: 'Rank orders protocols by the proxy, high to low. The band is the honest part: out-of-fold, only ' + pct(D.validation.within_2x) + ' of predictions land within a factor of two, so treat the order as a reading list and the dollar figure as a wide range.' })
        )
      ),
      el('p', { class: 'source-line', text: 'Source: ' + D.source + '. The snapshot carries ten fields and no ranking, no implied value, no farm plan: all three are derived here, from those fields only.' })
    );
  }

  function proofPanel() {
    var v = D.validation;
    var scatter = el('canvas', { class: 'scatter', role: 'img', 'aria-label': 'Scatter of observed TVL against observed market cap, log scale, with the pooled fit line' });
    var loo = el('canvas', { class: 'scatter', role: 'img', 'aria-label': 'Scatter of predicted against actual market cap for every leave-one-out fold, with the parity line' });
    var metrics = [
      ['RMSLE', v.rmsle.toFixed(2), v.naive_rmsle.toFixed(2)],
      ['MdAPE', pct(v.mdape), pct(v.naive_mdape)],
      ['Within 2x', pct(v.within_2x), pct(v.naive_within_2x)],
    ];
    setTimeout(function () { drawScatter(scatter, 'fit'); drawScatter(loo, 'loo'); }, 0);
    window.addEventListener('resize', function () {
      if (!scatter.isConnected) return;
      drawScatter(scatter, 'fit');
      drawScatter(loo, 'loo');
    });
    return el('section', { class: 'proof', id: 'proof' },
      el('div', { class: 'proof-head' },
        el('div', null,
          el('h2', { text: 'The evidence, and what it costs to believe it' }),
          el('p', { class: 'sub', text: v.method })
        ),
        el('div', { class: 'proof-stats' }, metrics.map(function (m) {
          var better = m[0] === 'RMSLE' || m[0] === 'MdAPE' ? parseFloat(m[1]) <= parseFloat(m[2]) : parseFloat(m[1]) >= parseFloat(m[2]);
          return el('div', { class: 'stat' },
            el('span', { class: 'kpi-label', text: m[0] }),
            el('b', { class: 'stat-value', text: m[1] }),
            el('span', { class: 'kpi-note' }, 'naive ' + m[2] + ' ', el('span', { class: better ? 'pos' : 'neg', text: better ? 'better' : 'worse' }))
          );
        }))
      ),
      el('div', { class: 'charts' },
        el('figure', { class: 'chart' }, scatter,
          el('div', { class: 'legend' }, el('span', null, el('i', { class: 'dot' }), 'observed peer'), el('span', null, el('i', null), 'pooled fit: ' + D.fit.slope.toFixed(2) + 'x slope'), el('span', { class: 'sub', text: 'y: market cap, log scale' })),
          el('figcaption', null,
            el('b', { text: 'Observed peers and the pooled curve. ' }),
            D.fit.n + ' rows with both a market cap and a TVL, log-log. Slope ' + D.fit.slope.toFixed(3) + ', so a $100M-TVL protocol sits near ' + money(Math.exp(D.fit.intercept) * Math.pow(1e8, D.fit.slope)) + ' at the pooled curve before its category offset.'
          )),
        el('figure', { class: 'chart' }, loo,
          el('div', { class: 'legend' }, el('span', null, el('i', { class: 'dot' }), 'one fold'), el('span', null, el('i', { class: 'dash' }), 'parity'), el('span', null, el('i', { class: 'gray' }), 'factor of 2'), el('span', { class: 'sub', text: 'y: actual market cap, log scale' })),
          el('figcaption', null,
            el('b', { text: 'Leave-one-out, every fold. ' }),
            v.n + ' refits, each without its own row and without same-family peers; ' + v.family_dropped_folds + ' folds had a family peer to drop.'
          ))
      ),
      el('ul', { class: 'caveats' }, v.notes.map(function (n) { return el('li', { text: n }); })),
      el('p', { class: 'sub caveat-line', text: 'A proxy of this width is a reading order, not a price. The board ranks by it because a reading order is what a reader needs; it does not promise that rank 1 launches first, or at all.' })
    );
  }

  // ---------------------------------------------------------------- controls
  function select(id, label, options, value, onChange) {
    var node = el('select', { id: id, 'aria-label': label, onchange: function () { onChange(node.value); } },
      options.map(function (o) { return el('option', { value: o[0], text: o[1], selected: o[0] === value ? 'selected' : null }); }));
    return el('div', { class: 'field' }, el('label', { for: id, text: label }), node);
  }

  function controls() {
    var catOpts = [['all', 'All categories (' + CATEGORIES.length + ')']].concat(CATEGORIES.map(function (c) {
      var n = D.rows.filter(function (r) { return (r.category || 'Uncategorised') === c; }).length;
      return [c, c + ' (' + n + ')'];
    }));
    var chainOpts = [['all', 'All chains (' + CHAINS.length + ')']].concat(CHAINS.map(function (c) {
      var n = D.rows.filter(function (r) { return r.chains.indexOf(c) >= 0; }).length;
      return [c, c + ' (' + n + ')'];
    }));
    var confOpts = [['all', 'All confidence'], ['higher', 'Higher only'], ['medium', 'Medium and up']];
    var tagOpts = [['all', 'All value tags']].concat(TAGS.map(function (t) { return [t, t]; }));
    var search = el('input', { type: 'search', id: 'q', value: state.q, placeholder: 'Search board', 'aria-label': 'Search the board', oninput: function () { state.q = search.value; render(); } });
    var reset = el('button', { class: 'ghost', type: 'button', text: 'Reset filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.confidence = 'all'; state.tag = 'all'; state.sort = [{ key: 'rank', dir: 1 }]; render(); } });
    var list = visible();
    return el('section', { class: 'controls', 'aria-label': 'Filters' },
      el('div', { class: 'field grow' }, el('label', { for: 'q', text: 'Search' }), search),
      select('category', 'Category', catOpts, state.category, function (v) { state.category = v; render(); }),
      select('chain', 'Chain', chainOpts, state.chain, function (v) { state.chain = v; render(); }),
      select('confidence', 'Confidence', confOpts, state.confidence, function (v) { state.confidence = v; render(); }),
      select('tag', 'Value tag', tagOpts, state.tag, function (v) { state.tag = v; render(); }),
      el('div', { class: 'field shown' },
        el('span', { class: 'lbl', text: 'Shown' }),
        el('div', { class: 'shown-row' }, el('div', { class: 'count' }, el('b', { text: String(list.length) }), ' of ' + D.rows.length), reset)
      )
    );
  }

  // ---------------------------------------------------------------- table
  var COLUMNS = [
    { key: 'rank', label: '#', cls: 'num' },
    { key: 'name', label: 'Protocol' },
    { key: 'implied', label: 'Implied proxy', cls: 'num' },
    { key: 'p90', label: 'Band P10-P90', cls: 'num' },
    { key: 'multiple', label: 'Multiple', cls: 'num' },
    { key: 'tvl', label: 'TVL', cls: 'num' },
    { key: 'growth', label: '7d TVL', cls: 'num' },
    { key: 'age', label: 'Tracked', cls: 'num' },
    { key: 'peers', label: 'Peers', cls: 'num' },
    { key: 'confidence', label: 'Conf.' },
    { key: null, label: 'Value tag' },
  ];

  function headCell(col) {
    if (!col.key) return el('th', { scope: 'col' }, col.label);
    var at = -1;
    for (var i = 0; i < state.sort.length; i++) if (state.sort[i].key === col.key) at = i;
    var marker = at < 0 ? '' : (state.sort[at].dir === 1 ? ' ^' : ' v') + (at > 0 ? String(at + 1) : '');
    return el('th', { scope: 'col', class: col.cls || null, 'aria-sort': at === 0 ? (state.sort[0].dir === 1 ? 'ascending' : 'descending') : 'none' },
      el('button', { type: 'button', class: 'sort', onclick: function (e) { toggleSort(col.key, e.shiftKey); }, title: 'Click to sort, shift-click to add a second key' }, col.label + marker)
    );
  }

  function rowNode(r) {
    var growthClass = r.change_7d === null ? 'muted' : r.change_7d >= 0 ? 'pos' : 'neg';
    return el('tr', {
      tabindex: '0', 'data-slug': r.slug, 'data-open': state.open === r.slug ? 'true' : 'false',
      onclick: function () { openDrawer(r.slug); },
      onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(r.slug); } }
    },
      el('td', { class: 'num rank', text: String(r.rank) }),
      el('td', null,
        el('div', { class: 'name' }, el('b', { text: r.name }), r.watchlist ? el('span', { class: 'tag watch', text: 'watchlist' }) : null),
        el('div', { class: 'sub', text: (r.category || 'Uncategorised') + ' - ' + (r.chains.length > 2 ? r.chains.slice(0, 2).join(', ') + ' +' + (r.chains.length - 2) : r.chains.join(', ') || 'chain unnamed') })
      ),
      el('td', { class: 'num' },
        el('b', { class: 'money', text: money(r.implied_value_usd) }),
        el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(2, Math.round((r.implied_value_usd / D.rows[0].implied_value_usd) * 100)) + '%' }))
      ),
      el('td', { class: 'num sub', text: money(r.band.p10) + ' - ' + money(r.band.p90) }),
      el('td', { class: 'num', text: mult(r.multiple) }),
      el('td', { class: 'num', text: money(r.tvl_usd) }),
      el('td', { class: 'num ' + growthClass, text: r.change_7d === null ? '-' : signed(r.change_7d) }),
      el('td', { class: 'num', text: age(r.age_days) }),
      el('td', { class: 'num', text: String(r.breakdown.category_peers) }),
      el('td', { class: 'c-conf' }, el('span', { class: 'tag conf-' + r.confidence, text: r.confidence })),
      el('td', { class: 'c-tag' }, el('span', { class: 'tag tag-val', title: r.value_tag, text: r.value_tag }))
    );
  }

  function boardTable() {
    var list = sorted(visible());
    if (list.length === 0) {
      return el('section', { class: 'panel empty' },
        el('h3', { text: 'No protocol matches these filters' }),
        el('p', { class: 'sub', text: 'Loosen one facet: the board holds ' + D.rows.length + ' rows across ' + CATEGORIES.length + ' categories and ' + CHAINS.length + ' chains.' }),
        el('button', { class: 'primary', type: 'button', text: 'Clear every filter', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.confidence = 'all'; state.tag = 'all'; render(); } })
      );
    }
    var body = el('tbody');
    list.forEach(function (r) { body.appendChild(rowNode(r)); });
    return el('section', { class: 'panel' },
      el('div', { class: 'table-head' },
        el('h2', { text: 'The board' }),
        el('p', { class: 'sub', text: 'Sorted by ' + state.sort.map(function (s) { return s.key + (s.dir === 1 ? ' asc' : ' desc'); }).join(', then ') + '. Click a column to sort; shift-click to add a second key. Select any row for its peers, breakdown, band and farm plan.' })
      ),
      el('div', { class: 'table-wrap' },
        el('table', { class: 'board' },
          el('caption', { class: 'sr' }, 'Pre-token protocols ranked by implied market-cap proxy'),
          el('thead', null, el('tr', null, COLUMNS.map(headCell))),
          body
        )
      ),
      el('p', { class: 'foot-note', text: 'Showing ' + list.length + ' of ' + D.rows.length + '. Implied proxy is an estimate from this snapshot only; the band is the out-of-fold P10-P90 residual range, not a confidence promise.' })
    );
  }

  // ---------------------------------------------------------------- drawer
  function valuationDrawer() {
    if (!state.open) return null;
    var r = null;
    for (var i = 0; i < D.rows.length; i++) if (D.rows[i].slug === state.open) r = D.rows[i];
    if (!r) return null;
    // The band is drawn on a log axis from a decade below P10 to a decade above P90, so the pin sits
    // where the value really is on a distribution that spans factors, not dollars.
    var lo = Math.log10(Math.max(1, r.band.p10)) - 1;
    var hi = Math.log10(Math.max(10, r.band.p90)) + 1;
    function where(n) { return Math.min(100, Math.max(0, ((Math.log10(Math.max(1, n)) - lo) / (hi - lo)) * 100)); }
    var band = el('div', { class: 'band' },
      el('div', { class: 'band-track', 'aria-hidden': 'true' },
        el('i', { class: 'band-fill', style: 'left:' + where(r.band.p10).toFixed(1) + '%;width:' + Math.max(2, (where(r.band.p90) - where(r.band.p10))).toFixed(1) + '%' }),
        el('i', { class: 'band-mid', style: 'left:' + where(r.band.p50).toFixed(1) + '%' }),
        el('i', { class: 'band-pin', style: 'left:' + where(r.implied_value_usd).toFixed(1) + '%' })
      ),
      el('div', { class: 'band-labels' },
        el('span', null, el('span', { class: 'sub', text: 'P10 ' }), el('b', { text: money(r.band.p10) })),
        el('span', null, el('span', { class: 'sub', text: 'P50 ' }), el('b', { text: money(r.band.p50) })),
        el('span', null, el('span', { class: 'sub', text: 'P90 ' }), el('b', { text: money(r.band.p90) }))
      ),
      el('div', { class: 'legend band-legend' },
        el('span', null, el('i', { class: 'band-swatch' }), 'P10-P90 out-of-fold range'),
        el('span', null, el('i', { class: 'dash' }), 'P50'),
        el('span', null, el('i', { class: 'accent-swatch' }), 'this row: ' + money(r.implied_value_usd))
      ),
      el('p', { class: 'sub band-note', text: 'Log axis. The shaded span is where 80% of out-of-fold actual market caps fell relative to their prediction; the dashed mark is the median residual and the solid line is this row\'s proxy.' })
    );
    var breakdown = el('dl', { class: 'breakdown' },
      el('div', { class: 'key' }, el('dt', { text: 'Whole multiple of TVL' }), el('dd', { text: mult(r.multiple) })),
      el('div', null, el('dt', { text: 'Pooled curve multiple' }), el('dd', { text: mult(r.breakdown.core_multiple) })),
      el('div', null, el('dt', { text: 'Category offset' }), el('dd', { class: r.breakdown.category_offset < 0 ? 'neg' : null, text: (r.breakdown.category_offset >= 0 ? '+' : '') + mult(Math.exp(r.breakdown.category_offset)) })),
      el('div', null, el('dt', { text: 'Seven-day tilt' }), el('dd', { class: r.breakdown.growth_tilt < 0 ? 'neg' : null, text: mult(Math.exp(r.breakdown.growth_tilt)) })),
      el('div', null, el('dt', { text: 'Tracking-age tilt' }), el('dd', { text: mult(Math.exp(r.breakdown.age_tilt)) })),
      el('div', null, el('dt', { text: 'Category peers' }), el('dd', { text: r.breakdown.category_peers + ' shrunk ' + r.breakdown.category_peers + '/(' + r.breakdown.category_peers + '+' + D.shrink_k + ')' }))
    );
    var comps = el('div', { class: 'comps' },
      el('div', { class: 'comp-head' }, el('span', { text: 'Observed peer' }), el('span', { text: 'TVL / market cap / multiple' })));
    var compRows = el('div', { class: 'comps' }, r.peers.map(function (p) {
      return el('div', { class: 'comp' },
        el('div', { class: 'comp-name' }, el('b', { text: p.name }), el('span', { class: 'sub', text: p.category || 'Uncategorised' })),
        el('div', { class: 'comp-nums' }, el('span', { text: money(p.tvl_usd) }), el('span', { text: money(p.mcap_usd) }), el('b', { text: mult(p.multiple) }))
      );
    }));
    var compsBox = el('div', { class: 'comps-box' }, comps, compRows,
      el('p', { class: 'sub', text: 'This row\'s multiple is ' + mult(r.multiple) + ' of TVL. The peers are what the curve learned from; they are not comparables a buyer would accept.' }));

    return el('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'false', 'aria-label': r.name + ' detail' },
      el('div', { class: 'drawer-head' },
        el('div', null,
          el('span', { class: 'sub', text: 'Rank ' + r.rank + ' of ' + D.rows.length + (r.watchlist ? ' - on the house watchlist' : ' - below the floor, found by the radar') }),
          el('h2', { text: r.name }),
          el('p', { class: 'sub', text: (r.category || 'Uncategorised') + ' - ' + r.chains.join(', ') + ' - tracked ' + age(r.age_days) + (r.listed_at ? ' since ' + r.listed_at : ' (no listing date recorded)') })
        ),
        el('button', { class: 'ghost', type: 'button', 'aria-label': 'Close detail', text: 'Close', onclick: function () { state.open = null; render(); } })
      ),
      el('div', { class: 'drawer-body' },
        el('section', null,
          el('h3', { text: 'Implied market-cap proxy' }),
          el('div', { class: 'hero-line' }, el('b', { class: 'hero-value', text: money(r.implied_value_usd) }), el('span', { class: 'sub', text: exact(r.implied_value_usd) + ' as written to board.json' })),
          band,
          el('ul', { class: 'explain' },
            el('li', null, el('b', { text: money(r.tvl_usd) + ' TVL ' }), 'at the pooled ' + mult(r.breakdown.core_multiple) + ' curve multiple.'),
            el('li', null, el('b', { text: 'Category offset ' + mult(Math.exp(r.breakdown.category_offset)) + ' ' }), 'from ' + r.breakdown.category_peers + ' observed peer' + (r.breakdown.category_peers === 1 ? '' : 's') + ' in ' + (r.category || 'Uncategorised') + ', shrunk by n/(n+' + D.shrink_k + ').'),
            el('li', null, el('b', { text: 'Tilts ' }), 'seven-day ' + mult(Math.exp(r.breakdown.growth_tilt)) + ' and tracking age ' + mult(Math.exp(r.breakdown.age_tilt)) + ', both bounded and both unvalidated.'),
            el('li', null, el('b', { text: 'Product ' }), mult(r.multiple) + ' of TVL, written to board.json as ' + exact(r.implied_value_usd) + '.')
          )
        ),
        el('section', null, el('h3', { text: 'Breakdown' }), breakdown),
        el('section', null,
          el('h3', { text: 'Nearest observed peers' }),
          el('p', { class: 'sub', text: 'Same category first, then by log-TVL distance. Their market cap is observed; this row\'s is not.' }),
          compsBox
        )
      )
    );
  }

  // Detail tabs keep the complete plan reachable without scrolling past every valuation section.
  function drawer() {
    var panel = valuationDrawer();
    if (!panel) return null;
    var row = D.rows.find(function (item) { return item.slug === state.open; });
    var head = panel.querySelector('.drawer-head');
    var body = panel.querySelector('.drawer-body');
    var tabs = el('nav', { class: 'detail-tabs', 'aria-label': 'Detail sections' });
    ['valuation', 'plan'].forEach(function (name) {
      tabs.appendChild(el('button', {
        type: 'button',
        class: state.detailTab === name ? 'primary' : 'ghost',
        'aria-pressed': String(state.detailTab === name),
        text: name === 'plan' ? 'Farm plan · ' + row.farm_steps.length + ' steps' : 'Valuation & peers',
        onclick: function () {
          state.detailTab = name;
          render();
          document.querySelector('.detail-tabs button[aria-pressed="true"]').focus();
        }
      }));
    });
    head.appendChild(tabs);
    if (state.detailTab === 'plan') {
      panel.classList.add('plan-view');
      body.textContent = '';
      body.appendChild(el('section', { class: 'plan-summary' },
        el('h3', { text: row.name + ' · research before funding' }),
        el('p', { class: 'sub', text: 'Implied proxy ' + money(row.implied_value_usd) + ' · observed TVL ' + money(row.tvl_usd) + ' · ' + row.confidence + ' confidence' }),
        el('p', { class: 'sub', text: 'All costs are assumptions. No observed token, eligibility or reward is established by this snapshot.' })
      ));
      body.appendChild(el('ol', { class: 'steps plan-grid' }, row.farm_steps.map(function (text) {
        return el('li', null, el('span', { text: text }));
      })));
    }
    return panel;
  }

  // ---------------------------------------------------------------- methodology
  function method() {
    var e = D.exclusion_counts;
    var order = ['derivative-category', 'versioned-name', 'wrapped-staked-name', 'exchange-brand', 'token-family'];
    var label = {
      'derivative-category': 'Bridge, canonical bridge, liquid staking, liquid restaking, restaked BTC or CEX: a product of an asset that already trades',
      'versioned-name': 'A release trailer in the name (V2, v2, 2.0 and the like): a pool of another protocol',
      'wrapped-staked-name': 'A whole word wrapped, staked or staking in the name',
      'exchange-brand': 'A name that begins with an exchange brand',
      'token-family': 'A name that reduces to the family of a protocol whose token already trades',
    };
    var rowsList = el('tbody');
    order.forEach(function (k) {
      rowsList.appendChild(el('tr', null,
        el('td', null, el('b', { text: String(e[k] || 0) })),
        el('td', null, el('span', { text: label[k] })),
        el('td', { class: 'num sub', text: (e[k] || 0) === 0 ? 'none in this snapshot' : 'counted once, first match wins' })
      ));
    });
    return el('section', { class: 'method' },
      el('div', { class: 'method-grid' },
        el('article', { class: 'panel' },
          el('h2', { text: 'The model, in order' }),
          el('ol', { class: 'method-list' },
            el('li', { text: 'Peers: the ' + D.counts.peers + ' records where a positive market cap and a positive TVL are both observed. No other row can teach the model anything, because no other row has both numbers.' }),
            el('li', { text: 'Core: log(mcap) = a + b log(tvl), fitted by iteratively reweighted least squares so one extreme row cannot bend the line. Fitted here: intercept ' + D.fit.intercept.toFixed(3) + ', slope ' + D.fit.slope.toFixed(3) + '.' }),
            el('li', { text: 'Category offset: each category\'s mean residual, shrunk toward the pooled curve by n/(n+' + D.shrink_k + '). A category with one peer keeps a fifth of its own residual; one with fifteen keeps four fifths. That is why two Risk Curators rows sit near the curve rather than on a single peer\'s multiple.' }),
            el('li', { text: 'Two bounded tilts: the seven-day TVL change (weight ' + D.tilt.growth_weight + ', clamped to +/-' + D.tilt.growth_clamp + '%) and the tracking age (weight ' + D.tilt.age_weight + ', capped at ' + D.tilt.age_cap_days + ' days). Both are disclosed as unvalidated: the leave-one-out panel shows they do not improve the loss, so they are capped small and never decide a rank on their own.' }),
            el('li', { text: 'Band: the out-of-fold P10, P50 and P90 of actual/predicted, applied to the row\'s own proxy. The arithmetic is ordered P10 <= implied <= P90 and clamped to a whole dollar, between 1 and the gate\'s $100T cap.' })
          )
        ),
        el('article', { class: 'panel' },
          el('h2', { text: 'What was left out, and why' }),
          el('p', { class: 'sub', text: 'Every pre-token record (' + D.counts.pre_token + ') is either on the board (' + D.counts.on_board + ') or in this table (' + D.counts.excluded + '). The rules are disjoint and evaluated in this order, so no record is counted twice.' }),
          el('table', { class: 'mini' }, el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Count' }), el('th', { scope: 'col', text: 'Rule' }), el('th', { scope: 'col', text: 'Note' }))), rowsList),
          el('p', { class: 'sub', text: 'This is an inference from the ten observed fields, not a claim about reality. A name can reduce to another protocol\'s family by coincidence, so the rule is conservative: it says the record "records no token", never that a token does not exist. A protocol on the watchlist is always kept, even if a rule would have caught it.' })
        )
      ),
      el('article', { class: 'panel' },
        el('h2', { text: 'Excluded records, largest first' }),
        el('p', { class: 'sub', text: 'Every record this board did not score, with its one reason. A protocol here may still be worth a look; it is out of the ranking, not out of the world.' }),
        el('div', { class: 'table-wrap narrow' },
          el('table', null,
            el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'Category' }), el('th', { scope: 'col', class: 'num', text: 'TVL' }), el('th', { scope: 'col', text: 'Reason' }))),
            el('tbody', null, D.exclusions.map(function (x) {
              return el('tr', null, el('td', { text: x.name }), el('td', { class: 'sub', text: x.category || 'Uncategorised' }), el('td', { class: 'num', text: money(x.tvl_usd) }), el('td', null, el('span', { class: 'tag', text: x.reason })));
            }))
          )
        )
      ),
      el('article', { class: 'panel disclaimer' },
        el('h2', { text: 'Disclaimer and limits' }),
        el('ul', null,
          el('li', { text: 'An implied market-cap proxy is this entry\'s own claim. It is not make.fun\'s, not a price, and not a forecast of a launch. A protocol that records no token may still have one its DefiLlama record does not carry.' }),
          el('li', { text: 'Tracking age is the day DefiLlama began tracking the protocol. It is not the protocol\'s founding date and not proof of how long it has run.' }),
          el('li', { text: 'The leave-one-out folds were also read while choosing the shrinkage weight and the tilt caps, so they are model-selection evidence, not an untouched holdout. The snapshot has no second untouched set to offer.' }),
          el('li', { text: 'Capital tiers and gas figures in a farm plan are assumptions from TVL and chain names. They are not live quotes, and no plan predicts a reward.' }),
          el('li', { text: 'Nothing here connects a wallet, signs a transaction or promises eligibility, points or an allocation. Dilution, sybil filters and contract risk are stated in every plan because they are the risks a farmer actually meets.' })
        )
      ),
      el('article', { class: 'panel' },
        el('h2', { text: 'Page integrity, checked at load' }),
        el('p', { class: 'sub', text: failed.length === 0 ? 'Every assertion below passed on this render: the counts you see are recomputed from the same rows the board.json carries.' : failed.length + ' assertion(s) failed: the numbers below may not match the data.' }),
        el('ul', { class: 'checks' }, checks.map(function (c) {
          return el('li', { class: c.ok ? 'ok' : 'fail' }, el('b', { text: (c.ok ? 'pass ' : 'FAIL ') + c.label }), el('span', { class: 'sub', text: ' ' + c.detail }));
        }))
      )
    );
  }

  // ---------------------------------------------------------------- render
  function render() {
    var scrollY = window.scrollY;
    root.textContent = '';
    root.appendChild(el('div', { class: 'shell' },
      header(),
      kpis(),
      lede(),
      controls(),
      boardTable(),
      proofPanel(),
      method()
    ));
    var d = drawer();
    if (d) root.appendChild(el('div', { class: 'drawer-scrim', onclick: function (ev) { if (ev.target === ev.currentTarget) { state.open = null; render(); } } }, d));
    root.setAttribute('aria-busy', 'false');
    if (state.open) scrollY = window.scrollY;
    window.scrollTo(0, scrollY);
  }

  function openDrawer(slug) { state.open = slug; state.detailTab = 'valuation'; render(); }

  applyTheme();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.open) { state.open = null; render(); }
  });
})();
