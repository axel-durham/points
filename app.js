/* Axel & Nhi — Honeymoon Award Finder. Vanilla JS, no dependencies, no external requests. */
(function () {
  "use strict";

  var CABINS = ["Y", "W", "J", "F"];
  var CABIN_LABELS = { Y: "Economy", W: "Premium Economy", J: "Business", F: "First" };
  var DEFAULT_CABINS = ["J", "F"];
  var DEFAULT_MIN_SEATS = 2; // travelling as a pair
  var DEFAULT_DEST_SORT = "avail";
  // Headline-cabin precedence: the most premium cabin that is both selected
  // in the filters and actually available for the destination.
  var CABIN_PRECEDENCE = ["F", "J", "W", "Y"];

  // Chase United Club Infinite + MileagePlus Premier status gives a flat 15%
  // cardmember discount off the base award price (this is the Premier +
  // cardmember tier; effective price = base × 0.85). It applies ONLY to
  // United-/United Express-operated flights: Star Alliance partner-operated
  // award space is excluded, so a row qualifies only when every carrier is UA
  // (airlines exactly ["UA"]). Mixed itineraries like ["LH","UA"] contain
  // partner-operated segments and are treated as ineligible.
  // Single edit point if the rate ever changes.
  var CARDMEMBER_DISCOUNT = 0.15;

  function isDiscounted(d) {
    var a = d.airlines || [];
    return a.length === 1 && a[0] === "UA";
  }

  // Effective price: what the user would actually pay. Used consistently for
  // display, sorting, the max-miles filter, and baseline deltas.
  function effMiles(d) {
    return isDiscounted(d) ? Math.round(d.miles * (1 - CARDMEMBER_DISCOUNT)) : d.miles;
  }
  var STALE_MS = 36 * 60 * 60 * 1000;
  var MILES_STEP = 5000;
  var RENDER_CAP = 500; // keep the detail table light
  var FAV_KEY = "honeymoon-favs";
  var HIDDEN_KEY = "honeymoon-hidden";
  var UNDO_MS = 10000;

  var deals = [];
  var baselines = {};
  var allRegions = [];
  var allMonths = [];
  var milesCeil = 200000;
  var newestFirstSeen = null;
  var destInfo = {}; // IATA -> { city, region }
  var favorites = loadList(FAV_KEY);
  var hidden = loadList(HIDDEN_KEY);
  var undoTimer = null;

  // Filter/UI state
  var state = {
    q: "",
    cabins: DEFAULT_CABINS.slice(),
    regions: [],        // populated with all regions after load
    month: "",          // "" = all, else "YYYY-MM"
    maxMiles: null,     // null = no cap (slider at max)
    nonstop: false,
    minSeats: DEFAULT_MIN_SEATS,
    favOnly: false,
    tab: "all",
    dest: null,         // IATA code -> detail view; null -> grid view
    destSort: DEFAULT_DEST_SORT,
    sort: null,         // detail table sort; null = miles ascending default
    dir: "asc"
  };

  var $ = function (id) { return document.getElementById(id); };

  // ---------- Persistence (localStorage lists) ----------

  function loadList(key) {
    try {
      var raw = localStorage.getItem(key);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function saveList(key, arr) {
    try {
      localStorage.setItem(key, JSON.stringify(arr));
    } catch (e) { /* private mode etc. — just won't persist */ }
  }

  function isFav(id) { return favorites.indexOf(id) >= 0; }

  function toggleFav(id) {
    var i = favorites.indexOf(id);
    if (i >= 0) favorites.splice(i, 1);
    else favorites.push(id);
    saveList(FAV_KEY, favorites);
  }

  function isHidden(code) { return hidden.indexOf(code) >= 0; }

  function hideDest(code) {
    if (!isHidden(code)) {
      hidden.push(code);
      saveList(HIDDEN_KEY, hidden);
    }
    showUndo(code);
    render();
  }

  function unhideDest(code) {
    var i = hidden.indexOf(code);
    if (i >= 0) {
      hidden.splice(i, 1);
      saveList(HIDDEN_KEY, hidden);
    }
  }

  function destName(code) {
    return (destInfo[code] && destInfo[code].city) || code;
  }

  // ---------- Data loading ----------

  function fetchJSON(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error(url + " returned HTTP " + res.status);
      return res.json().catch(function () {
        throw new Error(url + " is not valid JSON");
      });
    });
  }

  function showError(msg) {
    var el = $("error");
    el.textContent = msg;
    el.hidden = false;
  }

  Promise.all([
    fetchJSON("./data/deals.json"),
    fetchJSON("./data/meta.json"),
    fetchJSON("./config/baselines.json")
  ]).then(function (results) {
    if (!Array.isArray(results[0])) throw new Error("data/deals.json is not an array");
    deals = results[0];
    var meta = results[1] || {};
    baselines = (results[2] && results[2].baselines) || {};
    init(meta);
  }).catch(function (err) {
    showError("Could not load deal data: " + err.message +
      ". Try reloading; if it persists, the data files may be missing or malformed.");
  });

  // ---------- Init ----------

  function init(meta) {
    renderMeta(meta);
    deriveFacets();
    buildFilterControls();
    readStateFromURL();
    applyStateToControls();
    bindEvents();
    $("filters").hidden = false;
    $("tabs").hidden = false;
    $("tabs-note").hidden = false;
    render();
  }

  function deriveFacets() {
    var regionSet = {};
    var monthSet = {};
    var maxMiles = 0;
    deals.forEach(function (d) {
      if (d.region) regionSet[d.region] = true;
      if (d.date) monthSet[String(d.date).slice(0, 7)] = true;
      if (d.miles > maxMiles) maxMiles = d.miles;
      if (d.firstSeen && (!newestFirstSeen || d.firstSeen > newestFirstSeen)) {
        newestFirstSeen = d.firstSeen;
      }
      if (d.to && !destInfo[d.to]) {
        destInfo[d.to] = { city: d.city || null, region: d.region || null };
      } else if (d.to && !destInfo[d.to].city && d.city) {
        destInfo[d.to].city = d.city;
      }
    });
    allRegions = Object.keys(regionSet).sort();
    allMonths = Object.keys(monthSet).sort();
    milesCeil = Math.max(MILES_STEP, Math.ceil(maxMiles / MILES_STEP) * MILES_STEP);
    state.regions = allRegions.slice();
  }

  function renderMeta(meta) {
    var banners = $("banners");
    if (meta.refreshedAt) {
      var t = Date.parse(meta.refreshedAt);
      if (!isNaN(t)) {
        var el = $("refreshed");
        el.textContent = "Last refreshed " + relativeTime(t);
        el.title = new Date(t).toLocaleString();
        el.hidden = false;
        if (Date.now() - t > STALE_MS) {
          banners.appendChild(banner("warn",
            "Data is stale: last refreshed " + relativeTime(t) +
            ". The refresh job may have failed."));
        }
      }
    }
    if (meta.isFixture === true) {
      banners.appendChild(banner("notice", "Showing sample data — this is a fixture, not live award availability."));
    }
  }

  function banner(kind, text) {
    var div = document.createElement("div");
    div.className = "banner banner-" + kind;
    div.textContent = text;
    return div;
  }

  function relativeTime(ts) {
    var diff = Date.now() - ts;
    if (diff < 0) diff = 0;
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + (mins === 1 ? " minute ago" : " minutes ago");
    var hours = Math.floor(mins / 60);
    if (hours < 48) return hours + (hours === 1 ? " hour ago" : " hours ago");
    var days = Math.floor(hours / 24);
    return days + " days ago";
  }

  // ---------- Controls ----------

  function buildFilterControls() {
    var cabinRow = $("cabin-toggles");
    CABINS.forEach(function (c) {
      cabinRow.appendChild(toggle("cabin", c, CABIN_LABELS[c]));
    });

    var regionRow = $("region-toggles");
    allRegions.forEach(function (r) {
      regionRow.appendChild(toggle("region", r, r));
    });

    var monthSel = $("month");
    var optAll = document.createElement("option");
    optAll.value = "";
    optAll.textContent = "All months";
    monthSel.appendChild(optAll);
    allMonths.forEach(function (m) {
      var opt = document.createElement("option");
      opt.value = m;
      opt.textContent = monthLabel(m);
      monthSel.appendChild(opt);
    });

    var slider = $("max-miles");
    slider.min = MILES_STEP;
    slider.max = milesCeil;
    slider.step = MILES_STEP;
    slider.value = milesCeil;
  }

  function toggle(name, value, label) {
    var lab = document.createElement("label");
    lab.className = "toggle";
    var input = document.createElement("input");
    input.type = "checkbox";
    input.name = name;
    input.value = value;
    var span = document.createElement("span");
    span.textContent = label;
    lab.appendChild(input);
    lab.appendChild(span);
    return lab;
  }

  function monthLabel(ym) {
    var parts = ym.split("-");
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
    return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }

  function bindEvents() {
    $("search").addEventListener("input", function (e) {
      state.q = e.target.value.trim();
      onFilterChange();
    });

    $("cabin-toggles").addEventListener("change", function () {
      state.cabins = checkedValues("cabin");
      onFilterChange();
    });

    $("region-toggles").addEventListener("change", function () {
      state.regions = checkedValues("region");
      onFilterChange();
    });

    $("month").addEventListener("change", function (e) {
      state.month = e.target.value;
      onFilterChange();
    });

    $("max-miles").addEventListener("input", function (e) {
      var v = Number(e.target.value);
      state.maxMiles = v >= milesCeil ? null : v;
      updateMilesOutput();
      onFilterChange();
    });

    $("nonstop").addEventListener("change", function (e) {
      state.nonstop = e.target.checked;
      onFilterChange();
    });

    $("fav-only").addEventListener("change", function (e) {
      state.favOnly = e.target.checked;
      onFilterChange();
    });

    $("min-seats").addEventListener("input", function (e) {
      var v = parseInt(e.target.value, 10);
      state.minSeats = isNaN(v) || v < 1 ? 1 : v;
      onFilterChange();
    });

    $("reset").addEventListener("click", function () {
      state.q = "";
      state.cabins = DEFAULT_CABINS.slice();
      state.regions = allRegions.slice();
      state.month = "";
      state.maxMiles = null;
      state.nonstop = false;
      state.favOnly = false;
      state.minSeats = DEFAULT_MIN_SEATS;
      state.sort = null;
      state.dir = "asc";
      applyStateToControls();
      onFilterChange();
    });

    $("tabs").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-tab]");
      if (!btn) return;
      state.tab = btn.getAttribute("data-tab");
      state.sort = null; // back to the tab's default ordering
      state.dir = "asc";
      onFilterChange();
    });

    $("dest-sort").addEventListener("change", function (e) {
      state.destSort = e.target.value;
      onFilterChange();
    });

    // Grid interactions: open a card, or hide a destination
    $("dest-grid").addEventListener("click", function (e) {
      var hideBtn = e.target.closest("button[data-hide]");
      if (hideBtn) {
        e.stopPropagation();
        hideDest(hideBtn.getAttribute("data-hide"));
        return;
      }
      var card = e.target.closest(".dest-card");
      if (card) openDest(card.getAttribute("data-dest"));
    });
    $("dest-grid").addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      var card = e.target.closest(".dest-card");
      if (card && e.target === card) {
        e.preventDefault();
        openDest(card.getAttribute("data-dest"));
      }
    });

    $("back-btn").addEventListener("click", function () {
      state.dest = null;
      writeStateToURL(true);
      render();
    });

    $("undo-btn").addEventListener("click", function () {
      var code = this.getAttribute("data-undo");
      if (code) unhideDest(code);
      dismissUndo();
      render();
    });

    $("hidden-chip").addEventListener("click", function () {
      var panel = $("hidden-panel");
      panel.hidden = !panel.hidden;
      this.setAttribute("aria-expanded", panel.hidden ? "false" : "true");
      if (!panel.hidden) renderHiddenPanel();
    });

    $("hidden-panel").addEventListener("click", function (e) {
      var restore = e.target.closest("button[data-restore]");
      if (restore) {
        unhideDest(restore.getAttribute("data-restore"));
        render();
        return;
      }
      if (e.target.closest("#restore-all")) {
        hidden = [];
        saveList(HIDDEN_KEY, hidden);
        render();
      }
    });

    document.querySelector("#deals-table thead").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-sort]");
      if (!btn) return;
      var key = btn.getAttribute("data-sort");
      if (state.sort === key) {
        state.dir = state.dir === "asc" ? "desc" : "asc";
      } else {
        state.sort = key;
        state.dir = "asc";
      }
      onFilterChange();
    });

    $("deals-body").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-fav]");
      if (!btn) return;
      toggleFav(btn.getAttribute("data-fav"));
      if (state.favOnly) {
        render(); // row may drop out of the shortlist view
      } else {
        paintFavButton(btn);
      }
    });

    $("detail-view").addEventListener("click", function (e) {
      var unhide = e.target.closest("button[data-unhide]");
      if (unhide) {
        unhideDest(unhide.getAttribute("data-unhide"));
        render();
      }
    });

    window.addEventListener("popstate", function () {
      resetStateToDefaults();
      readStateFromURL();
      applyStateToControls();
      render();
    });
  }

  function resetStateToDefaults() {
    state.q = "";
    state.cabins = DEFAULT_CABINS.slice();
    state.regions = allRegions.slice();
    state.month = "";
    state.maxMiles = null;
    state.nonstop = false;
    state.favOnly = false;
    state.minSeats = DEFAULT_MIN_SEATS;
    state.tab = "all";
    state.dest = null;
    state.destSort = DEFAULT_DEST_SORT;
    state.sort = null;
    state.dir = "asc";
  }

  function openDest(code) {
    if (!code || !destInfo[code]) return;
    state.dest = code;
    writeStateToURL(true);
    render();
    window.scrollTo(0, 0);
  }

  function checkedValues(name) {
    var out = [];
    var inputs = document.querySelectorAll('input[name="' + name + '"]');
    for (var i = 0; i < inputs.length; i++) {
      if (inputs[i].checked) out.push(inputs[i].value);
    }
    return out;
  }

  function onFilterChange() {
    writeStateToURL(false);
    render();
  }

  function updateMilesOutput() {
    $("max-miles-out").textContent =
      state.maxMiles === null ? "no limit" : fmtMiles(state.maxMiles);
  }

  function applyStateToControls() {
    $("search").value = state.q;
    setChecked("cabin", state.cabins);
    setChecked("region", state.regions);
    $("month").value = allMonths.indexOf(state.month) >= 0 ? state.month : "";
    $("max-miles").value = state.maxMiles === null ? milesCeil : state.maxMiles;
    updateMilesOutput();
    $("nonstop").checked = state.nonstop;
    $("fav-only").checked = state.favOnly;
    $("min-seats").value = state.minSeats;
    $("dest-sort").value = state.destSort;
  }

  function setChecked(name, values) {
    var inputs = document.querySelectorAll('input[name="' + name + '"]');
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].checked = values.indexOf(inputs[i].value) >= 0;
    }
  }

  // ---------- Undo bar ----------

  function showUndo(code) {
    var bar = $("undo-bar");
    $("undo-text").textContent = destName(code) + " hidden.";
    $("undo-btn").setAttribute("data-undo", code);
    bar.hidden = false;
    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = setTimeout(dismissUndo, UNDO_MS);
  }

  function dismissUndo() {
    $("undo-bar").hidden = true;
    $("undo-btn").removeAttribute("data-undo");
    if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }
  }

  // ---------- URL state ----------
  // The hidden-destinations list is deliberately NOT in the URL:
  // it is a durable personal preference, not shareable view state.

  function writeStateToURL(push) {
    var p = new URLSearchParams();
    if (state.q) p.set("q", state.q);
    if (!sameSet(state.cabins, DEFAULT_CABINS)) p.set("cabins", state.cabins.join(",") || "none");
    if (!sameSet(state.regions, allRegions)) p.set("regions", state.regions.join(",") || "none");
    if (state.month) p.set("month", state.month);
    if (state.maxMiles !== null) p.set("max", String(state.maxMiles));
    if (state.nonstop) p.set("nonstop", "1");
    if (state.favOnly) p.set("fav", "1");
    if (state.minSeats !== DEFAULT_MIN_SEATS) p.set("seats", String(state.minSeats));
    if (state.tab !== "all") p.set("tab", state.tab);
    if (state.dest) p.set("dest", state.dest);
    if (state.destSort !== DEFAULT_DEST_SORT) p.set("dsort", state.destSort);
    if (state.sort) { p.set("sort", state.sort); p.set("dir", state.dir); }
    var qs = p.toString();
    var url = qs ? "?" + qs : location.pathname;
    if (push) history.pushState(null, "", url);
    else history.replaceState(null, "", url);
  }

  function readStateFromURL() {
    var p = new URLSearchParams(location.search);
    if (p.has("q")) state.q = p.get("q");
    if (p.has("cabins")) {
      var c = p.get("cabins");
      state.cabins = c === "none" ? [] : c.split(",").filter(function (x) {
        return CABINS.indexOf(x) >= 0;
      });
    }
    if (p.has("regions")) {
      var r = p.get("regions");
      state.regions = r === "none" ? [] : r.split(",").filter(function (x) {
        return allRegions.indexOf(x) >= 0;
      });
    }
    if (p.has("month")) state.month = p.get("month");
    if (p.has("max")) {
      var m = parseInt(p.get("max"), 10);
      if (!isNaN(m) && m > 0 && m < milesCeil) state.maxMiles = m;
    }
    if (p.get("nonstop") === "1") state.nonstop = true;
    if (p.get("fav") === "1") state.favOnly = true;
    if (p.has("seats")) {
      var s = parseInt(p.get("seats"), 10);
      if (!isNaN(s) && s >= 1) state.minSeats = s;
    }
    var tab = p.get("tab");
    if (tab === "below" || tab === "new") state.tab = tab;
    var dest = p.get("dest");
    if (dest && destInfo[dest]) state.dest = dest;
    var dsort = p.get("dsort");
    if (["avail", "miles", "saving", "dates", "city"].indexOf(dsort) >= 0) state.destSort = dsort;
    var sort = p.get("sort");
    if (sort && document.querySelector('button[data-sort="' + sort + '"]')) {
      state.sort = sort;
      state.dir = p.get("dir") === "desc" ? "desc" : "asc";
    }
  }

  function sameSet(a, b) {
    if (a.length !== b.length) return false;
    return a.slice().sort().join(",") === b.slice().sort().join(",");
  }

  // ---------- Filtering / grouping / sorting ----------

  function baselineFor(d) {
    var b = baselines[d.region];
    if (!b) return null;
    var v = b[d.cabin];
    return typeof v === "number" ? v : null;
  }

  function deltaFor(d) {
    var b = baselineFor(d);
    // Compared on the EFFECTIVE price: baselines are undiscounted observed
    // prices, so discounted UA-only rows legitimately land below baseline —
    // that is real savings for this cardholder, not an artifact.
    return b === null ? null : effMiles(d) - b;
  }

  function matchesFilters(d) {
    if (state.cabins.indexOf(d.cabin) < 0) return false;
    if (state.regions.indexOf(d.region) < 0) return false;
    if (state.month && String(d.date).slice(0, 7) !== state.month) return false;
    if (state.maxMiles !== null && effMiles(d) > state.maxMiles) return false;
    if (state.nonstop && !d.direct) return false;
    if (state.favOnly && !isFav(d.id)) return false;
    if ((d.seats || 0) < state.minSeats) return false;
    if (state.q) {
      var q = state.q.toUpperCase();
      var hay = [d.to || "", d.city || ""].concat(d.airlines || []).join(" ").toUpperCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  }

  function tabRows(tab, filtered) {
    if (tab === "below") {
      return filtered.filter(function (d) {
        var delta = deltaFor(d);
        return delta !== null && delta < 0;
      });
    }
    if (tab === "new") {
      return filtered.filter(function (d) {
        return newestFirstSeen && d.firstSeen === newestFirstSeen;
      });
    }
    return filtered;
  }

  function buildGroups(rows) {
    var map = {};
    rows.forEach(function (d) {
      if (!d.to || isHidden(d.to)) return;
      var g = map[d.to];
      if (!g) {
        g = map[d.to] = {
          to: d.to,
          city: d.city || null,
          region: d.region || null,
          rows: [],
          perCabin: {},        // cabin -> row with min miles
          minMiles: Infinity,
          dates: {},
          anyDirect: false,
          airlines: {},
          favCount: 0
        };
      }
      g.rows.push(d);
      if (!g.city && d.city) g.city = d.city;
      var pc = g.perCabin[d.cabin];
      if (!pc || effMiles(d) < effMiles(pc)) g.perCabin[d.cabin] = d;
      if (effMiles(d) < g.minMiles) g.minMiles = effMiles(d);
      if (d.date) g.dates[d.date] = true;
      if (d.direct) g.anyDirect = true;
      (d.airlines || []).forEach(function (a) { g.airlines[a] = true; });
      if (isFav(d.id)) g.favCount++;
    });
    return Object.keys(map).map(function (k) {
      var g = map[k];
      g.dateList = Object.keys(g.dates).sort();
      var monthSeen = {};
      g.dateList.forEach(function (d) { monthSeen[d.slice(0, 7)] = true; });
      g.monthCount = Object.keys(monthSeen).length;
      // Headline cabin: the most premium cabin present among the matching rows
      // (rows already passed the cabin filter). Cards are only ever compared
      // against cards with the SAME headline cabin — never Y miles vs J miles.
      g.emph = null;
      for (var i = 0; i < CABIN_PRECEDENCE.length; i++) {
        if (g.perCabin[CABIN_PRECEDENCE[i]]) { g.emph = g.perCabin[CABIN_PRECEDENCE[i]]; break; }
      }
      // Delta used for display AND for the "biggest saving" sort — always the
      // headline cabin's best row, so ranking matches what the card shows.
      g.emphDelta = deltaFor(g.emph);
      // Availability score (default ranking). Partner award prices are close to
      // fixed in premium cabins, so price cannot discriminate; what matters is
      // how bookable a destination genuinely is. Composite, higher = better:
      //   +20 per distinct month with space  (breadth beats a cluster: space in
      //        5 months easily outranks 20 dates crammed into one week)
      //   +15 if any non-stop option exists  (worth more than a few extra dates)
      //   +1  per distinct date              (volume as the fine-grained tiebreak)
      // Distinct dates already respect the min-seats filter upstream.
      g.availScore = 20 * g.monthCount + (g.anyDirect ? 15 : 0) + g.dateList.length;
      return g;
    });
  }

  function sortGroups(groups) {
    var s = state.destSort;
    return groups.slice().sort(function (a, b) {
      if (s === "avail") {
        if (a.availScore !== b.availScore) return b.availScore - a.availScore;
        if (a.dateList.length !== b.dateList.length) return b.dateList.length - a.dateList.length;
      } else if (s === "saving") {
        var da = a.emphDelta === null ? Infinity : a.emphDelta;
        var db = b.emphDelta === null ? Infinity : b.emphDelta;
        if (da !== db) return da - db;
      } else if (s === "dates") {
        if (a.dateList.length !== b.dateList.length) return b.dateList.length - a.dateList.length;
      } else if (s === "city") {
        var ca = (a.city || a.to).toLowerCase();
        var cb = (b.city || b.to).toLowerCase();
        if (ca !== cb) return ca < cb ? -1 : 1;
      } else {
        // "miles": cheapest first, compared on the headline cabin's EFFECTIVE
        // price only (sections are already single-cabin, so like-for-like).
        var ma = effMiles(a.emph), mb = effMiles(b.emph);
        if (ma !== mb) return ma - mb;
      }
      return a.to < b.to ? -1 : a.to > b.to ? 1 : 0;
    });
  }

  function sortRows(rows) {
    var key = state.sort;
    var dir = state.dir === "desc" ? -1 : 1;
    if (!key) {
      if (state.tab === "below") {
        return rows.slice().sort(function (a, b) { return deltaFor(a) - deltaFor(b); });
      }
      return rows.slice().sort(function (a, b) { return effMiles(a) - effMiles(b); });
    }
    var val = function (d) {
      switch (key) {
        case "date": return d.date || "";
        case "cabin": return CABINS.indexOf(d.cabin);
        case "miles": return effMiles(d);
        case "delta":
          var dl = deltaFor(d);
          return dl === null ? Infinity : dl;
        case "direct": return d.direct ? 0 : 1;
        case "seats": return d.seats || 0;
        case "airlines": return (d.airlines || []).join(",");
        default: return 0;
      }
    };
    return rows.slice().sort(function (a, b) {
      var va = val(a), vb = val(b);
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
  }

  // ---------- Formatting ----------

  function fmtMiles(n) {
    return n.toLocaleString("en-US");
  }

  function fmtDate(iso) {
    var parts = String(iso).split("-");
    if (parts.length !== 3) return iso;
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  }

  function fmtShortDate(iso) {
    var parts = String(iso).split("-");
    if (parts.length !== 3) return iso;
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function unitedURL(d) {
    var p = new URLSearchParams({
      f: d.from, t: d.to, d: d.date, tt: "1", at: "1", sc: "7", px: "1", taxng: "1"
    });
    return "https://www.united.com/en/us/fsr/choose-flights?" + p.toString();
  }

  function discBadge() {
    var b = document.createElement("span");
    b.className = "disc-badge";
    b.textContent = "−15% card";
    b.title = "MileagePlus cardmember + Premier discount — United-operated flights only";
    return b;
  }

  function basePriceSpan(miles) {
    var s = document.createElement("span");
    s.className = "price-base";
    s.textContent = "normally " + fmtMiles(miles);
    return s;
  }

  function deltaSpan(delta) {
    var span = document.createElement("span");
    if (delta === null) return span;
    span.textContent = (delta > 0 ? "+" : delta < 0 ? "−" : "") + fmtMiles(Math.abs(delta));
    span.className = delta < 0 ? "delta-good" : delta > 0 ? "delta-bad" : "delta-zero";
    return span;
  }

  // ---------- Rendering ----------

  function render() {
    var filtered = deals.filter(matchesFilters);
    if (state.dest) renderDetail(filtered);
    else renderGrid(filtered);
    renderHiddenChip();
    var panel = $("hidden-panel");
    if (!panel.hidden) renderHiddenPanel();
  }

  function setTabCounts(counts, noteText) {
    $("count-all").textContent = counts.all;
    $("count-below").textContent = counts.below;
    $("count-new").textContent = counts["new"];
    $("tabs-note").textContent = noteText;
    var tabButtons = document.querySelectorAll("#tabs button[data-tab]");
    for (var i = 0; i < tabButtons.length; i++) {
      tabButtons[i].setAttribute("aria-selected",
        tabButtons[i].getAttribute("data-tab") === state.tab ? "true" : "false");
    }
  }

  function visibleDestCount(rows) {
    var seen = {};
    var n = 0;
    rows.forEach(function (d) {
      if (d.to && !seen[d.to] && !isHidden(d.to)) { seen[d.to] = true; n++; }
    });
    return n;
  }

  // ----- View 1: destination grid -----

  function renderGrid(filtered) {
    $("grid-view").hidden = false;
    $("detail-view").hidden = true;

    setTabCounts({
      all: visibleDestCount(tabRows("all", filtered)),
      below: visibleDestCount(tabRows("below", filtered)),
      "new": visibleDestCount(tabRows("new", filtered))
    }, "Counts are destinations. Pick a place to see its dates.");

    var groups = sortGroups(buildGroups(tabRows(state.tab, filtered)));
    var grid = $("dest-grid");
    grid.textContent = "";
    var empty = $("empty");

    if (groups.length === 0) {
      empty.hidden = false;
      if (deals.length === 0) {
        empty.textContent = "No deals in the current data set.";
      } else if (state.favOnly && favorites.length === 0) {
        empty.textContent = "No shortlisted dates yet — open a destination and tap the heart on a date to save it.";
      } else if (state.tab === "below") {
        empty.textContent = belowEmptyMessage();
      } else if (hidden.length > 0 && state.tab === "all") {
        empty.textContent = "No destinations match the current filters. (" + hidden.length +
          " hidden — restore them from the Hidden list above.)";
      } else {
        empty.textContent = "No destinations match the current filters. Try widening cabins, regions, or the miles cap.";
      }
      return;
    }
    empty.hidden = true;

    // Group cards by headline cabin so prices are only ever compared
    // like-for-like: First cards together, then Business, and so on.
    var buckets = {};
    groups.forEach(function (g) {
      var c = g.emph.cabin;
      (buckets[c] = buckets[c] || []).push(g);
    });
    var frag = document.createDocumentFragment();
    CABIN_PRECEDENCE.forEach(function (c) {
      if (!buckets[c]) return;
      var section = document.createElement("section");
      section.className = "cabin-section";
      var h = document.createElement("h2");
      h.className = "cabin-heading";
      h.textContent = cabinHeading(c) +
        " · " + buckets[c].length + (buckets[c].length === 1 ? " destination" : " destinations");
      section.appendChild(h);
      var wrap = document.createElement("div");
      wrap.className = "dest-grid";
      buckets[c].forEach(function (g) { wrap.appendChild(renderCard(g)); });
      section.appendChild(wrap);
      frag.appendChild(section);
    });
    grid.appendChild(frag);
  }

  function belowEmptyMessage() {
    // Premium-cabin award prices are essentially fixed (see config/baselines.json
    // _caveat), so an empty below-baseline view for J/F/W is expected, not broken.
    if (state.cabins.length > 0 && state.cabins.indexOf("Y") < 0) {
      var names = state.cabins.slice().sort(function (a, b) {
        return CABINS.indexOf(a) - CABINS.indexOf(b);
      }).map(function (c) { return CABIN_LABELS[c]; }).join(" and ");
      return "Nothing below baseline — " + names +
        " award prices are essentially fixed, so bargains only really appear in Economy. " +
        "Add Economy to the cabin filter to hunt for them.";
    }
    return "Nothing below baseline matches the current filters. " +
      "Economy is where prices actually vary — try widening regions or the miles cap.";
  }

  function cabinHeading(c) {
    if (c === "F") return "First class";
    if (c === "J") return "Business class";
    if (c === "W") return "Premium Economy";
    return "Economy";
  }

  function renderCard(g) {
    var name = g.city || g.to;
    var card = document.createElement("article");
    card.className = "dest-card";
    card.setAttribute("data-dest", g.to);
    card.setAttribute("tabindex", "0");
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", "View dates for " + name);

    var hide = document.createElement("button");
    hide.type = "button";
    hide.className = "hide-btn";
    hide.setAttribute("data-hide", g.to);
    hide.setAttribute("aria-label", "Hide " + name);
    hide.title = "Hide " + name;
    hide.textContent = "×";
    card.appendChild(hide);

    var top = document.createElement("div");
    top.className = "card-top";
    var h3 = document.createElement("h3");
    h3.textContent = name;
    top.appendChild(h3);
    var code = document.createElement("p");
    code.className = "dest-code";
    code.textContent = g.to + (g.region ? " · " + g.region : "");
    top.appendChild(code);
    card.appendChild(top);

    // Headline price (best Business when present)
    var price = document.createElement("div");
    price.className = "card-price";
    var cab = document.createElement("span");
    cab.className = "price-cabin";
    cab.textContent = "Best " + (CABIN_LABELS[g.emph.cabin] || g.emph.cabin);
    price.appendChild(cab);
    var amount = document.createElement("strong");
    amount.className = "price-miles";
    amount.textContent = fmtMiles(effMiles(g.emph));
    price.appendChild(amount);
    var unit = document.createElement("span");
    unit.className = "price-unit";
    unit.textContent = "miles";
    price.appendChild(unit);
    var delta = deltaFor(g.emph);
    if (delta !== null) {
      var ds = deltaSpan(delta);
      ds.classList.add("price-delta");
      price.appendChild(ds);
    }
    if (isDiscounted(g.emph)) {
      var discLine = document.createElement("span");
      discLine.className = "price-disc-line";
      discLine.appendChild(basePriceSpan(g.emph.miles));
      discLine.appendChild(discBadge());
      price.appendChild(discLine);
    }
    card.appendChild(price);

    // Other cabins present
    var others = CABINS.filter(function (c) {
      return g.perCabin[c] && c !== g.emph.cabin;
    });
    if (others.length) {
      var mini = document.createElement("ul");
      mini.className = "cabin-mini";
      others.forEach(function (c) {
        var li = document.createElement("li");
        var row = g.perCabin[c];
        li.textContent = CABIN_LABELS[c] + " " + fmtMiles(effMiles(row));
        if (isDiscounted(row)) {
          li.appendChild(document.createTextNode(" "));
          var was = document.createElement("span");
          was.className = "price-base";
          was.textContent = "(normally " + fmtMiles(row.miles) + ")";
          li.appendChild(was);
        }
        mini.appendChild(li);
      });
      card.appendChild(mini);
    }

    // Meta: dates, range, non-stop, airlines, hearts
    var meta = document.createElement("p");
    meta.className = "card-meta";
    var nDates = g.dateList.length;
    var bits = [nDates + (nDates === 1 ? " date" : " dates") +
      (nDates > 1 ? " across " + g.monthCount + (g.monthCount === 1 ? " month" : " months") : "")];
    if (nDates === 1) {
      bits.push(fmtShortDate(g.dateList[0]));
    } else if (nDates > 1) {
      bits.push(fmtShortDate(g.dateList[0]) + " – " + fmtShortDate(g.dateList[nDates - 1]));
    }
    if (g.anyDirect) bits.push("Non-stop ✓");
    var airlines = Object.keys(g.airlines).sort();
    if (airlines.length) {
      bits.push(airlines.length > 4 ?
        airlines.slice(0, 4).join(", ") + " +" + (airlines.length - 4) :
        airlines.join(", "));
    }
    meta.textContent = bits.join(" · ");
    if (g.favCount > 0) {
      var fav = document.createElement("span");
      fav.className = "card-favs";
      fav.textContent = " ♥ " + g.favCount;
      fav.title = g.favCount + " shortlisted " + (g.favCount === 1 ? "date" : "dates");
      meta.appendChild(fav);
    }
    card.appendChild(meta);

    return card;
  }

  // ----- Hidden destinations chip + panel -----

  function renderHiddenChip() {
    var chip = $("hidden-chip");
    if (hidden.length === 0) {
      chip.hidden = true;
      $("hidden-panel").hidden = true;
      chip.setAttribute("aria-expanded", "false");
      return;
    }
    chip.hidden = false;
    chip.textContent = "Hidden (" + hidden.length + ")";
  }

  function renderHiddenPanel() {
    var panel = $("hidden-panel");
    panel.textContent = "";
    if (hidden.length === 0) { panel.hidden = true; return; }

    var list = document.createElement("ul");
    list.className = "hidden-list";
    hidden.slice().sort(function (a, b) {
      return destName(a).toLowerCase() < destName(b).toLowerCase() ? -1 : 1;
    }).forEach(function (code) {
      var li = document.createElement("li");
      var label = document.createElement("span");
      label.textContent = destName(code) + " (" + code + ")";
      li.appendChild(label);
      var favN = favCountForDest(code);
      if (favN > 0) {
        var note = document.createElement("span");
        note.className = "hidden-fav-note";
        note.textContent = "♥ " + favN + " shortlisted " + (favN === 1 ? "date" : "dates");
        li.appendChild(note);
      }
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "restore-btn";
      btn.setAttribute("data-restore", code);
      btn.textContent = "Restore";
      li.appendChild(btn);
      list.appendChild(li);
    });
    panel.appendChild(list);

    var all = document.createElement("button");
    all.type = "button";
    all.id = "restore-all";
    all.className = "restore-btn restore-all";
    all.textContent = "Restore all";
    panel.appendChild(all);
  }

  function favCountForDest(code) {
    var n = 0;
    deals.forEach(function (d) {
      if (d.to === code && isFav(d.id)) n++;
    });
    return n;
  }

  // ----- View 2: destination detail -----

  function renderDetail(filtered) {
    $("grid-view").hidden = true;
    $("detail-view").hidden = false;

    var code = state.dest;
    var info = destInfo[code] || {};
    var name = info.city || code;
    var destRows = filtered.filter(function (d) { return d.to === code; });

    setTabCounts({
      all: tabRows("all", destRows).length,
      below: tabRows("below", destRows).length,
      "new": tabRows("new", destRows).length
    }, "Counts are dates for " + name + " (" + code + "). Filters above still apply.");

    $("dest-title").textContent = name;
    var sub = $("dest-sub");
    sub.textContent = "";
    sub.appendChild(document.createTextNode(
      code + (info.region ? " · " + info.region : "") + " · from SFO"));
    if (isHidden(code)) {
      var note = document.createElement("span");
      note.className = "hidden-note";
      note.textContent = " Hidden from your grid. ";
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "restore-btn";
      btn.setAttribute("data-unhide", code);
      btn.textContent = "Unhide";
      note.appendChild(btn);
      sub.appendChild(note);
    }

    var rows = sortRows(tabRows(state.tab, destRows));

    var headBtns = document.querySelectorAll("#deals-table thead button[data-sort]");
    for (var h = 0; h < headBtns.length; h++) {
      var k = headBtns[h].getAttribute("data-sort");
      headBtns[h].className = state.sort === k ? "sorted-" + state.dir : "";
    }

    var body = $("deals-body");
    body.textContent = "";
    var table = $("deals-table");
    var empty = $("empty");
    var truncated = $("truncated");
    truncated.hidden = true;

    if (rows.length === 0) {
      table.hidden = true;
      empty.hidden = false;
      empty.textContent = state.tab === "below" ?
        belowEmptyMessage() :
        "No dates for " + name +
        " match the current filters and tab. Adjust the filters or go back to all destinations.";
      return;
    }

    empty.hidden = true;
    table.hidden = false;

    var shown = rows.length > RENDER_CAP ? rows.slice(0, RENDER_CAP) : rows;
    var frag = document.createDocumentFragment();
    shown.forEach(function (d) { frag.appendChild(renderRow(d)); });
    body.appendChild(frag);

    if (rows.length > RENDER_CAP) {
      truncated.textContent = "Showing the first " + RENDER_CAP + " of " +
        rows.length + " matching dates — narrow the filters to see the rest.";
      truncated.hidden = false;
    }
  }

  function td(label, className) {
    var cell = document.createElement("td");
    cell.setAttribute("data-label", label);
    if (className) cell.className = className;
    return cell;
  }

  function paintFavButton(btn) {
    var fav = isFav(btn.getAttribute("data-fav"));
    btn.textContent = fav ? "♥" : "♡";
    btn.classList.toggle("is-fav", fav);
    btn.setAttribute("aria-pressed", fav ? "true" : "false");
    btn.title = fav ? "Remove from shortlist" : "Add to shortlist";
  }

  function renderRow(d) {
    var tr = document.createElement("tr");

    var cFav = document.createElement("td");
    cFav.className = "fav-col";
    var favBtn = document.createElement("button");
    favBtn.type = "button";
    favBtn.className = "fav-btn";
    favBtn.setAttribute("data-fav", d.id);
    favBtn.setAttribute("aria-label", "Shortlist " + d.from + " to " + d.to + " on " + d.date);
    paintFavButton(favBtn);
    cFav.appendChild(favBtn);
    tr.appendChild(cFav);

    var cDate = td("Date");
    var a = document.createElement("a");
    a.href = unitedURL(d);
    a.target = "_blank";
    a.rel = "noopener";
    a.className = "route-link";
    a.textContent = fmtDate(d.date);
    a.title = "Open this award search on united.com (new tab)";
    cDate.appendChild(a);
    tr.appendChild(cDate);

    var cCabin = td("Cabin");
    cCabin.textContent = CABIN_LABELS[d.cabin] || d.cabin;
    tr.appendChild(cCabin);

    var cMiles = td("Miles", "num");
    var eff = document.createElement("strong");
    eff.textContent = fmtMiles(effMiles(d));
    cMiles.appendChild(eff);
    if (isDiscounted(d)) {
      var sub = document.createElement("span");
      sub.className = "miles-sub";
      sub.appendChild(basePriceSpan(d.miles));
      sub.appendChild(discBadge());
      cMiles.appendChild(sub);
    }
    tr.appendChild(cMiles);

    var cDelta = td("Δ vs baseline", "num");
    var delta = deltaFor(d);
    if (delta === null) {
      cDelta.classList.add("delta-none");
    } else {
      cDelta.appendChild(deltaSpan(delta));
    }
    tr.appendChild(cDelta);

    var cDirect = td("Non-stop");
    cDirect.textContent = d.direct ? "Yes" : "No";
    if (d.direct) cDirect.classList.add("direct-yes");
    tr.appendChild(cDirect);

    var cSeats = td("Seats", "num");
    cSeats.textContent = d.seats;
    tr.appendChild(cSeats);

    var cAir = td("Airlines");
    cAir.textContent = (d.airlines || []).join(", ");
    tr.appendChild(cAir);

    return tr;
  }
})();
