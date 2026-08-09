/* Axel & Nhi — Honeymoon Award Finder. Vanilla JS, no dependencies, no external requests. */
(function () {
  "use strict";

  var ORIGIN = "SFO";
  var CABINS = ["Y", "W", "J", "F"];
  var CABIN_LABELS = { Y: "Economy", W: "Premium Economy", J: "Business", F: "First" };
  var DEFAULT_CABINS = ["J", "F"];
  var DEFAULT_MIN_SEATS = 2; // travelling as a pair
  var DEFAULT_DEST_SORT = "avail";
  // Trip length window for pairing outbound + return dates into roundtrips.
  var DEFAULT_MIN_NIGHTS = 7;
  var DEFAULT_MAX_NIGHTS = 14;
  var NIGHTS_FLOOR = 1;
  var NIGHTS_CEIL = 30;
  // Headline-cabin precedence: the most premium cabin that is both selected
  // in the filters and actually pairable (or, failing that, available).
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

  // A seat count of 0 (legacy data) or null (current refresh script) means the
  // source did NOT report a count — not "no seats": the API marks such rows
  // available, and the same flight/date/price flips between 0 and a real count
  // across refreshes. Treat both as "unknown" for the whole life of the app:
  // never excluded by the min-seats filter, flagged in the UI instead of shown
  // as a number, and worth less than a confirmed count when ranking.
  function seatsKnown(d) {
    return typeof d.seats === "number" && d.seats >= 1;
  }

  // Rows exist in BOTH directions since the refresh script started fetching
  // returns: outbound = SFO→X, return = X→SFO. Everything groups by the
  // "place" — the non-SFO end — so one destination card covers both legs.
  function isOutbound(d) { return d.from === ORIGIN; }
  function placeOf(d) { return isOutbound(d) ? d.to : d.from; }

  var STALE_MS = 36 * 60 * 60 * 1000;
  var MILES_STEP = 5000;
  var RENDER_CAP = 500; // keep the detail tables light
  var FAV_KEY = "honeymoon-favs";
  var HIDDEN_KEY = "honeymoon-hidden";
  var UNDO_MS = 10000;
  var PAIR_PREFIX = "P:"; // favorites entries for whole trips: "P:<outId>|<retId>"

  var deals = [];
  var dealsById = {};
  var baselines = {};
  var allRegions = [];
  var allMonths = [];
  var milesCeil = 200000;
  var newestFirstSeen = null;
  var destInfo = {}; // IATA (place) -> { city, region }
  var hasReturnData = false;
  var favorites = loadList(FAV_KEY);
  var hidden = loadList(HIDDEN_KEY);
  var undoTimer = null;

  // Filter/UI state
  var state = {
    q: "",
    cabins: DEFAULT_CABINS.slice(),
    regions: [],        // populated with all regions after load
    month: "",          // "" = all, else "YYYY-MM" (departure month)
    maxMiles: null,     // null = no cap (slider at max); applies per leg
    nonstop: false,
    minSeats: DEFAULT_MIN_SEATS,
    minNights: DEFAULT_MIN_NIGHTS,
    maxNights: DEFAULT_MAX_NIGHTS,
    favOnly: false,
    tab: "all",
    dest: null,         // IATA code -> detail view; null -> grid view
    destSort: DEFAULT_DEST_SORT,
    view: "trips",      // detail view mode: trips | out | ret
    sort: null,         // leg table sort; null = miles ascending default
    dir: "asc",
    tsort: null,        // trips table sort; null = total ascending default
    tdir: "asc"
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

  function pairId(pair) { return PAIR_PREFIX + pair.out.id + "|" + pair.ret.id; }

  // Legs referenced by any shortlisted trip: with "Shortlist only" on, those
  // legs must keep passing the filter or their trip could not be rebuilt.
  function favPairLegIds() {
    var set = {};
    favorites.forEach(function (f) {
      if (f.indexOf(PAIR_PREFIX) !== 0) return;
      var legs = f.slice(PAIR_PREFIX.length).split("|");
      if (legs.length === 2) { set[legs[0]] = true; set[legs[1]] = true; }
    });
    return set;
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
    deriveFacets();
    renderMeta(meta);
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
      dealsById[d.id] = d;
      if (!isOutbound(d)) hasReturnData = true;
      if (d.region) regionSet[d.region] = true;
      // Month filter means DEPARTURE month, so facet from outbound dates only.
      if (d.date && isOutbound(d)) monthSet[String(d.date).slice(0, 7)] = true;
      if (d.miles > maxMiles) maxMiles = d.miles;
      if (d.firstSeen && (!newestFirstSeen || d.firstSeen > newestFirstSeen)) {
        newestFirstSeen = d.firstSeen;
      }
      var place = placeOf(d);
      if (place && !destInfo[place]) {
        destInfo[place] = { city: d.city || null, region: d.region || null };
      } else if (place && !destInfo[place].city && d.city) {
        destInfo[place].city = d.city;
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
    if (!hasReturnData) {
      banners.appendChild(banner("warn",
        "This data set has no return-direction (→ SFO) rows yet, so roundtrips can't be paired. " +
        "Run the refresh script to fetch both directions; until then only outbound dates are shown."));
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

  function clampNights(v, fallback) {
    var n = parseInt(v, 10);
    if (isNaN(n)) return fallback;
    return Math.min(NIGHTS_CEIL, Math.max(NIGHTS_FLOOR, n));
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

    $("min-nights").addEventListener("input", function (e) {
      state.minNights = clampNights(e.target.value, DEFAULT_MIN_NIGHTS);
      if (state.maxNights < state.minNights) {
        state.maxNights = state.minNights;
        $("max-nights").value = state.maxNights;
      }
      onFilterChange();
    });

    $("max-nights").addEventListener("input", function (e) {
      state.maxNights = clampNights(e.target.value, DEFAULT_MAX_NIGHTS);
      if (state.minNights > state.maxNights) {
        state.minNights = state.maxNights;
        $("min-nights").value = state.minNights;
      }
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
      state.minNights = DEFAULT_MIN_NIGHTS;
      state.maxNights = DEFAULT_MAX_NIGHTS;
      state.sort = null;
      state.dir = "asc";
      state.tsort = null;
      state.tdir = "asc";
      applyStateToControls();
      onFilterChange();
    });

    $("tabs").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-tab]");
      if (!btn) return;
      state.tab = btn.getAttribute("data-tab");
      state.sort = null; // back to the tab's default ordering
      state.dir = "asc";
      state.tsort = null;
      state.tdir = "asc";
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

    $("view-switch").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-view]");
      if (!btn) return;
      state.view = btn.getAttribute("data-view");
      onFilterChange();
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

    document.querySelector("#trips-table thead").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-tsort]");
      if (!btn) return;
      var key = btn.getAttribute("data-tsort");
      if (state.tsort === key) {
        state.tdir = state.tdir === "asc" ? "desc" : "asc";
      } else {
        state.tsort = key;
        state.tdir = "asc";
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

    $("trips-body").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-fav]");
      if (!btn) return;
      toggleFav(btn.getAttribute("data-fav"));
      if (state.favOnly) {
        render();
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
    state.minNights = DEFAULT_MIN_NIGHTS;
    state.maxNights = DEFAULT_MAX_NIGHTS;
    state.tab = "all";
    state.dest = null;
    state.destSort = DEFAULT_DEST_SORT;
    state.view = "trips";
    state.sort = null;
    state.dir = "asc";
    state.tsort = null;
    state.tdir = "asc";
  }

  function openDest(code) {
    if (!code || !destInfo[code]) return;
    state.dest = code;
    state.view = "trips";
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
    $("min-nights").value = state.minNights;
    $("max-nights").value = state.maxNights;
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
    if (state.minNights !== DEFAULT_MIN_NIGHTS || state.maxNights !== DEFAULT_MAX_NIGHTS) {
      p.set("nights", state.minNights + "-" + state.maxNights);
    }
    if (state.tab !== "all") p.set("tab", state.tab);
    if (state.dest) p.set("dest", state.dest);
    if (state.dest && state.view !== "trips") p.set("view", state.view);
    if (state.destSort !== DEFAULT_DEST_SORT) p.set("dsort", state.destSort);
    if (state.sort) { p.set("sort", state.sort); p.set("dir", state.dir); }
    if (state.tsort) { p.set("tsort", state.tsort); p.set("tdir", state.tdir); }
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
    if (p.has("nights")) {
      var parts = String(p.get("nights")).split("-");
      var lo = clampNights(parts[0], DEFAULT_MIN_NIGHTS);
      var hi = clampNights(parts[1], DEFAULT_MAX_NIGHTS);
      state.minNights = Math.min(lo, hi);
      state.maxNights = Math.max(lo, hi);
    }
    var tab = p.get("tab");
    if (tab === "below" || tab === "new") state.tab = tab;
    var dest = p.get("dest");
    if (dest && destInfo[dest]) state.dest = dest;
    var view = p.get("view");
    if (view === "out" || view === "ret") state.view = view;
    var dsort = p.get("dsort");
    if (["avail", "miles", "saving", "dates", "city"].indexOf(dsort) >= 0) state.destSort = dsort;
    var sort = p.get("sort");
    if (sort && document.querySelector('button[data-sort="' + sort + '"]')) {
      state.sort = sort;
      state.dir = p.get("dir") === "desc" ? "desc" : "asc";
    }
    var tsort = p.get("tsort");
    if (tsort && document.querySelector('button[data-tsort="' + tsort + '"]')) {
      state.tsort = tsort;
      state.tdir = p.get("tdir") === "desc" ? "desc" : "asc";
    }
  }

  function sameSet(a, b) {
    if (a.length !== b.length) return false;
    return a.slice().sort().join(",") === b.slice().sort().join(",");
  }

  // ---------- Filtering ----------

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

  function rowIsNew(d) {
    return Boolean(newestFirstSeen && d.firstSeen === newestFirstSeen);
  }

  function matchesFilters(d, favLegs) {
    if (state.cabins.indexOf(d.cabin) < 0) return false;
    if (state.regions.indexOf(d.region) < 0) return false;
    // Month means DEPARTURE month. Return legs always pass, or a September
    // month filter would delete every October return and kill late-month trips.
    if (state.month && isOutbound(d) && String(d.date).slice(0, 7) !== state.month) return false;
    if (state.maxMiles !== null && effMiles(d) > state.maxMiles) return false;
    if (state.nonstop && !d.direct) return false;
    if (state.favOnly && !isFav(d.id) && !favLegs[d.id]) return false;
    // Unknown seat counts are always shown — only a KNOWN count below the
    // threshold excludes a row.
    if (seatsKnown(d) && d.seats < state.minSeats) return false;
    if (state.q) {
      var q = state.q.toUpperCase();
      var hay = [placeOf(d) || "", d.city || ""].concat(d.airlines || []).join(" ").toUpperCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  }

  // ---------- Grouping and roundtrip pairing ----------

  function addDaysIso(iso, n) {
    var p = String(iso).split("-");
    var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + n));
    return d.toISOString().slice(0, 10);
  }

  function newDirAgg() {
    return {
      rows: [],
      perDateBest: {},   // cabin -> { isoDate -> cheapest row (eff miles) }
      perCabinMin: {},   // cabin -> cheapest row overall
      dates: {},
      knownDates: {},    // dates with at least one CONFIRMED seat count
      anyDirect: false,
      airlines: {}
    };
  }

  function addToDirAgg(agg, d) {
    agg.rows.push(d);
    var byDate = agg.perDateBest[d.cabin] || (agg.perDateBest[d.cabin] = {});
    var cur = byDate[d.date];
    if (!cur || effMiles(d) < effMiles(cur)) byDate[d.date] = d;
    var min = agg.perCabinMin[d.cabin];
    if (!min || effMiles(d) < effMiles(min)) agg.perCabinMin[d.cabin] = d;
    if (d.date) {
      agg.dates[d.date] = true;
      if (seatsKnown(d)) agg.knownDates[d.date] = true;
    }
    if (d.direct) agg.anyDirect = true;
    (d.airlines || []).forEach(function (a) { agg.airlines[a] = true; });
  }

  /**
   * Pair outbound + return dates of the SAME cabin into roundtrips within the
   * trip-length window. One pair per (outbound date, return date), built from
   * the cheapest row of each side. total = per-person effective miles.
   */
  function buildPairs(g) {
    var pairs = [];
    CABINS.forEach(function (cabin) {
      var outDates = g.out.perDateBest[cabin];
      var retDates = g.ret.perDateBest[cabin];
      if (!outDates || !retDates) return;
      Object.keys(outDates).forEach(function (dep) {
        for (var n = state.minNights; n <= state.maxNights; n++) {
          var back = addDaysIso(dep, n);
          var retRow = retDates[back];
          if (!retRow) continue;
          var out = outDates[dep];
          var total = effMiles(out) + effMiles(retRow);
          var b = baselineFor(out); // same region+cabin both legs
          pairs.push({
            out: out,
            ret: retRow,
            cabin: cabin,
            nights: n,
            total: total,
            baseTotal: out.miles + retRow.miles,
            delta: b === null ? null : total - 2 * b,
            anyDiscount: isDiscounted(out) || isDiscounted(retRow)
          });
        }
      });
    });
    pairs.sort(function (a, b) { return a.total - b.total; });
    return pairs;
  }

  function pairIsNew(p) { return rowIsNew(p.out) || rowIsNew(p.ret); }

  function pairSeats(p) {
    var known = [];
    if (seatsKnown(p.out)) known.push(p.out.seats);
    if (seatsKnown(p.ret)) known.push(p.ret.seats);
    return {
      min: known.length ? Math.min.apply(null, known) : null,
      allKnown: known.length === 2
    };
  }

  function buildGroups(rows) {
    var map = {};
    rows.forEach(function (d) {
      var place = placeOf(d);
      if (!place || isHidden(place)) return;
      var g = map[place];
      if (!g) {
        g = map[place] = {
          to: place,
          city: d.city || null,
          region: d.region || null,
          out: newDirAgg(),
          ret: newDirAgg(),
          favCount: 0
        };
      }
      if (!g.city && d.city) g.city = d.city;
      addToDirAgg(isOutbound(d) ? g.out : g.ret, d);
      if (isFav(d.id)) g.favCount++;
    });

    return Object.keys(map).map(function (k) {
      var g = map[k];
      g.out.dateList = Object.keys(g.out.dates).sort();
      g.ret.dateList = Object.keys(g.ret.dates).sort();

      g.pairs = buildPairs(g);
      favorites.forEach(function (f) {
        if (f.indexOf(PAIR_PREFIX) === 0 && f.indexOf("|") > 0) {
          var outId = f.slice(PAIR_PREFIX.length).split("|")[0];
          var row = dealsById[outId];
          if (row && placeOf(row) === g.to) g.favCount++;
        }
      });

      // Headline: the most premium cabin with at least one bookable roundtrip;
      // its cheapest pair. Falls back to one-way (most premium cabin present)
      // when nothing pairs — those groups render in a separate section so
      // roundtrip and one-way prices are never compared side by side.
      g.emphPair = null;
      g.emphRow = null;
      for (var i = 0; i < CABIN_PRECEDENCE.length; i++) {
        var c = CABIN_PRECEDENCE[i];
        if (g.emphPair === null) {
          for (var j = 0; j < g.pairs.length; j++) {
            if (g.pairs[j].cabin === c) { g.emphPair = g.pairs[j]; break; }
          }
        }
        if (!g.emphRow && (g.out.perCabinMin[c] || g.ret.perCabinMin[c])) {
          var o = g.out.perCabinMin[c], r = g.ret.perCabinMin[c];
          g.emphRow = !o ? r : !r ? o : (effMiles(o) <= effMiles(r) ? o : r);
        }
      }

      // Trip-date coverage: distinct departure dates with a valid return.
      var tripDates = {};
      var tripMonths = {};
      var tripKnown = 0;
      var tripUnknown = 0;
      g.pairs.forEach(function (p) {
        var dep = p.out.date;
        if (!tripDates[dep]) {
          tripDates[dep] = true;
          tripMonths[dep.slice(0, 7)] = true;
          if (pairSeats(p).allKnown) tripKnown++; else tripUnknown++;
        }
      });
      g.tripDateCount = Object.keys(tripDates).length;
      g.tripDateList = Object.keys(tripDates).sort();
      g.tripMonthCount = Object.keys(tripMonths).length;

      // Availability score (default ranking). Partner award prices are close
      // to fixed in premium cabins, so price cannot discriminate; what matters
      // is how BOOKABLE a honeymoon actually is — meaning both directions.
      // Composite, higher = better:
      //   +20  per distinct month containing a pairable departure
      //   +15  if a non-stop option exists in BOTH directions
      //   +1   per pairable departure date with confirmed seats both ways
      //   +0.4 per pairable departure date with any unreported seat count
      // Destinations with no valid pair sink to a token score so one-way-only
      // space never outranks a genuinely bookable roundtrip.
      if (g.pairs.length > 0) {
        g.availScore = 20 * g.tripMonthCount +
          (g.out.anyDirect && g.ret.anyDirect ? 15 : 0) +
          tripKnown + 0.4 * tripUnknown;
      } else {
        g.availScore = 0.01 * (g.out.dateList.length + g.ret.dateList.length);
      }
      return g;
    });
  }

  function groupInTab(g, tab) {
    if (tab === "below") {
      if (g.pairs.length > 0) {
        return g.pairs.some(function (p) { return p.delta !== null && p.delta < 0; });
      }
      return g.out.rows.concat(g.ret.rows).some(function (d) {
        var delta = deltaFor(d);
        return delta !== null && delta < 0;
      });
    }
    if (tab === "new") {
      if (g.pairs.length > 0) return g.pairs.some(pairIsNew);
      return g.out.rows.concat(g.ret.rows).some(rowIsNew);
    }
    return true;
  }

  function pairsForTab(pairs, tab) {
    if (tab === "below") {
      return pairs.filter(function (p) { return p.delta !== null && p.delta < 0; });
    }
    if (tab === "new") return pairs.filter(pairIsNew);
    return pairs;
  }

  function rowsForTab(rows, tab) {
    if (tab === "below") {
      return rows.filter(function (d) {
        var delta = deltaFor(d);
        return delta !== null && delta < 0;
      });
    }
    if (tab === "new") return rows.filter(rowIsNew);
    return rows;
  }

  // ---------- Sorting ----------

  function sortGroups(groups) {
    var s = state.destSort;
    return groups.slice().sort(function (a, b) {
      if (s === "avail") {
        if (a.availScore !== b.availScore) return b.availScore - a.availScore;
        if (a.tripDateCount !== b.tripDateCount) return b.tripDateCount - a.tripDateCount;
      } else if (s === "saving") {
        var da = a.emphPair ? (a.emphPair.delta === null ? Infinity : a.emphPair.delta) : Infinity;
        var db = b.emphPair ? (b.emphPair.delta === null ? Infinity : b.emphPair.delta) : Infinity;
        if (da !== db) return da - db;
      } else if (s === "dates") {
        if (a.tripDateCount !== b.tripDateCount) return b.tripDateCount - a.tripDateCount;
        var oa = a.out.dateList.length, ob = b.out.dateList.length;
        if (oa !== ob) return ob - oa;
      } else if (s === "city") {
        var ca = (a.city || a.to).toLowerCase();
        var cb = (b.city || b.to).toLowerCase();
        if (ca !== cb) return ca < cb ? -1 : 1;
      } else {
        // "miles": cheapest roundtrip first (per-person effective total on the
        // headline cabin). Sections are single-cabin, so like-for-like; no-pair
        // groups fall back to one-way price within their own section.
        var ma = a.emphPair ? a.emphPair.total : (a.emphRow ? effMiles(a.emphRow) : Infinity);
        var mb = b.emphPair ? b.emphPair.total : (b.emphRow ? effMiles(b.emphRow) : Infinity);
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
        case "seats": return seatsKnown(d) ? d.seats : -1; // unknown sorts below known counts
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

  function sortPairs(pairs) {
    var key = state.tsort;
    var dir = state.tdir === "desc" ? -1 : 1;
    if (!key) return pairs; // already total-ascending from buildPairs
    var val = function (p) {
      switch (key) {
        case "depart": return p.out.date;
        case "return": return p.ret.date;
        case "nights": return p.nights;
        case "cabin": return CABINS.indexOf(p.cabin);
        case "total": return p.total;
        case "delta": return p.delta === null ? Infinity : p.delta;
        case "seats":
          var s = pairSeats(p);
          return s.min === null ? -1 : s.min;
        default: return 0;
      }
    };
    return pairs.slice().sort(function (a, b) {
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
    b.title = "MileagePlus cardmember + Premier discount — applies to the United-operated leg(s) only";
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

  function legLink(d, label) {
    var a = document.createElement("a");
    a.href = unitedURL(d);
    a.target = "_blank";
    a.rel = "noopener";
    a.className = "route-link";
    a.textContent = label;
    a.title = "Open " + d.from + " → " + d.to + " on united.com (new tab)";
    return a;
  }

  // ---------- Rendering ----------

  function render() {
    var favLegs = favPairLegIds();
    var filtered = deals.filter(function (d) { return matchesFilters(d, favLegs); });
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

  // ----- View 1: destination grid -----

  function renderGrid(filtered) {
    $("grid-view").hidden = false;
    $("detail-view").hidden = true;

    var groups = buildGroups(filtered);

    setTabCounts({
      all: groups.length,
      below: groups.filter(function (g) { return groupInTab(g, "below"); }).length,
      "new": groups.filter(function (g) { return groupInTab(g, "new"); }).length
    }, "Counts are destinations. Roundtrip prices are per person, " +
       state.minNights + "–" + state.maxNights + " nights.");

    var inTab = sortGroups(groups.filter(function (g) { return groupInTab(g, state.tab); }));
    var grid = $("dest-grid");
    grid.textContent = "";
    var empty = $("empty");

    if (inTab.length === 0) {
      empty.hidden = false;
      if (deals.length === 0) {
        empty.textContent = "No deals in the current data set.";
      } else if (state.favOnly && favorites.length === 0) {
        empty.textContent = "No shortlisted trips yet — open a destination and tap the heart on a trip or date to save it.";
      } else if (state.tab === "below") {
        empty.textContent = belowEmptyMessage();
      } else if (hidden.length > 0 && state.tab === "all") {
        empty.textContent = "No destinations match the current filters. (" + hidden.length +
          " hidden — restore them from the Hidden list above.)";
      } else {
        empty.textContent = "No destinations match the current filters. Try widening cabins, regions, trip length, or the miles cap.";
      }
      return;
    }
    empty.hidden = true;

    // Group cards by headline cabin so prices are only ever compared
    // like-for-like: First roundtrips together, then Business, and so on.
    // Destinations where no roundtrip pairs land in a final one-way section —
    // their prices are one-way and must not sit next to roundtrip cards.
    var buckets = {};
    var noPair = [];
    inTab.forEach(function (g) {
      if (g.emphPair) {
        var c = g.emphPair.cabin;
        (buckets[c] = buckets[c] || []).push(g);
      } else if (g.emphRow) {
        noPair.push(g);
      }
    });
    var frag = document.createDocumentFragment();
    CABIN_PRECEDENCE.forEach(function (c) {
      if (!buckets[c]) return;
      frag.appendChild(gridSection(
        cabinHeading(c) + " roundtrips · " + buckets[c].length +
          (buckets[c].length === 1 ? " destination" : " destinations"),
        null, buckets[c]));
    });
    if (noPair.length) {
      frag.appendChild(gridSection(
        "One-way space only · " + noPair.length +
          (noPair.length === 1 ? " destination" : " destinations"),
        "No outbound + return combination lines up within " + state.minNights + "–" +
          state.maxNights + " nights for these. Prices below are ONE-WAY — try widening the trip length.",
        noPair));
    }
    grid.appendChild(frag);
  }

  function gridSection(headingText, noteText, groups) {
    var section = document.createElement("section");
    section.className = "cabin-section";
    var h = document.createElement("h2");
    h.className = "cabin-heading";
    h.textContent = headingText;
    section.appendChild(h);
    if (noteText) {
      var note = document.createElement("p");
      note.className = "section-note";
      note.textContent = noteText;
      section.appendChild(note);
    }
    var wrap = document.createElement("div");
    wrap.className = "dest-grid";
    groups.forEach(function (g) { wrap.appendChild(renderCard(g)); });
    section.appendChild(wrap);
    return section;
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
    card.setAttribute("aria-label", "View trips to " + name);

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

    var price = document.createElement("div");
    price.className = "card-price";
    var cab = document.createElement("span");
    cab.className = "price-cabin";
    var amount = document.createElement("strong");
    amount.className = "price-miles";
    var unit = document.createElement("span");
    unit.className = "price-unit";

    if (g.emphPair) {
      var p = g.emphPair;
      cab.textContent = "Best " + (CABIN_LABELS[p.cabin] || p.cabin) + " roundtrip";
      amount.textContent = fmtMiles(p.total);
      unit.textContent = "miles · per person";
      price.appendChild(cab);
      price.appendChild(amount);
      price.appendChild(unit);
      // Zero delta = exactly at baseline — normal for premium cabins, not
      // worth a "0" on every card.
      if (p.delta !== null && p.delta !== 0) {
        var ds = deltaSpan(p.delta);
        ds.classList.add("price-delta");
        ds.title = "vs " + fmtMiles(p.total - p.delta) + " baseline roundtrip";
        price.appendChild(ds);
      }
      if (p.anyDiscount) {
        var discLine = document.createElement("span");
        discLine.className = "price-disc-line";
        discLine.appendChild(basePriceSpan(p.baseTotal));
        discLine.appendChild(discBadge());
        price.appendChild(discLine);
      }
    } else if (g.emphRow) {
      var r = g.emphRow;
      cab.textContent = "Best " + (CABIN_LABELS[r.cabin] || r.cabin) + " · " +
        (isOutbound(r) ? "outbound only" : "return only");
      amount.textContent = fmtMiles(effMiles(r));
      unit.textContent = "miles · one-way";
      price.appendChild(cab);
      price.appendChild(amount);
      price.appendChild(unit);
      if (isDiscounted(r)) {
        var dl = document.createElement("span");
        dl.className = "price-disc-line";
        dl.appendChild(basePriceSpan(r.miles));
        dl.appendChild(discBadge());
        price.appendChild(dl);
      }
    }
    card.appendChild(price);

    // Other cabins with roundtrip pairs (cheapest pair per cabin)
    if (g.emphPair) {
      var cheapestByCabin = {};
      g.pairs.forEach(function (pr) {
        if (!cheapestByCabin[pr.cabin]) cheapestByCabin[pr.cabin] = pr; // pairs are total-sorted
      });
      var others = CABINS.filter(function (c) {
        return cheapestByCabin[c] && c !== g.emphPair.cabin;
      });
      if (others.length) {
        var mini = document.createElement("ul");
        mini.className = "cabin-mini";
        others.forEach(function (c) {
          var li = document.createElement("li");
          li.textContent = CABIN_LABELS[c] + " " + fmtMiles(cheapestByCabin[c].total) + " RT";
          mini.appendChild(li);
        });
        card.appendChild(mini);
      }
    }

    // Meta: trip dates, range, non-stop, airlines, warnings, hearts
    var meta = document.createElement("p");
    meta.className = "card-meta";
    var bits = [];
    if (g.emphPair) {
      var n = g.tripDateCount;
      bits.push(n + (n === 1 ? " trip date" : " trip dates") +
        (n > 1 ? " across " + g.tripMonthCount + (g.tripMonthCount === 1 ? " month" : " months") : ""));
      if (n === 1) {
        bits.push("departing " + fmtShortDate(g.tripDateList[0]));
      } else if (n > 1) {
        bits.push(fmtShortDate(g.tripDateList[0]) + " – " + fmtShortDate(g.tripDateList[n - 1]));
      }
      if (g.out.anyDirect && g.ret.anyDirect) bits.push("Non-stop both ways ✓");
      else if (g.out.anyDirect || g.ret.anyDirect) bits.push("Non-stop one way");
    } else {
      bits.push(g.out.dateList.length + " outbound / " + g.ret.dateList.length + " return dates");
    }
    var airlines = {};
    Object.keys(g.out.airlines).forEach(function (a) { airlines[a] = true; });
    Object.keys(g.ret.airlines).forEach(function (a) { airlines[a] = true; });
    var airlineList = Object.keys(airlines).sort();
    if (airlineList.length) {
      bits.push(airlineList.length > 4 ?
        airlineList.slice(0, 4).join(", ") + " +" + (airlineList.length - 4) :
        airlineList.join(", "));
    }
    meta.textContent = bits.join(" · ");

    if (!g.emphPair) {
      meta.appendChild(document.createTextNode(" · "));
      var warn = document.createElement("span");
      warn.className = "unk-badge";
      if (g.ret.rows.length === 0) {
        warn.textContent = "no return space";
        warn.title = "No saver space back to SFO was found for the selected cabins. You'd need another airline or program for the way home.";
      } else if (g.out.rows.length === 0) {
        warn.textContent = "no outbound space";
        warn.title = "No saver space from SFO was found for the selected cabins — only the way home.";
      } else {
        warn.textContent = "dates don't pair";
        warn.title = "Outbound and return dates never line up within " + state.minNights + "–" +
          state.maxNights + " nights. Try widening the trip length.";
      }
      meta.appendChild(warn);
    }
    if (g.favCount > 0) {
      var fav = document.createElement("span");
      fav.className = "card-favs";
      fav.textContent = " ♥ " + g.favCount;
      fav.title = g.favCount + " shortlisted";
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
        note.textContent = "♥ " + favN + " shortlisted";
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
    favorites.forEach(function (f) {
      var id = f.indexOf(PAIR_PREFIX) === 0 ? f.slice(PAIR_PREFIX.length).split("|")[0] : f;
      var row = dealsById[id];
      if (row && placeOf(row) === code) n++;
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
    var destRows = filtered.filter(function (d) { return placeOf(d) === code; });
    var groups = buildGroupsUnhidden(destRows);
    var g = groups.length ? groups[0] : null;

    $("dest-title").textContent = name;
    var sub = $("dest-sub");
    sub.textContent = "";
    sub.appendChild(document.createTextNode(
      "SFO ⇄ " + code + (info.region ? " · " + info.region : "")));
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

    var pairs = g ? g.pairs : [];
    var outRows = g ? g.out.rows : [];
    var retRows = g ? g.ret.rows : [];

    // With no pairable trips, "Trips" would be a dead default — land on dates.
    if (state.view === "trips" && pairs.length === 0 && (outRows.length || retRows.length)) {
      state.view = outRows.length ? "out" : "ret";
    }

    var counts = state.view === "trips" ? {
      all: pairs.length,
      below: pairsForTab(pairs, "below").length,
      "new": pairsForTab(pairs, "new").length
    } : {
      all: rowsForTab(state.view === "out" ? outRows : retRows, "all").length,
      below: rowsForTab(state.view === "out" ? outRows : retRows, "below").length,
      "new": rowsForTab(state.view === "out" ? outRows : retRows, "new").length
    };
    setTabCounts(counts,
      state.view === "trips" ?
        "Counts are roundtrips for " + name + " (" + state.minNights + "–" + state.maxNights +
          " nights, per-person prices). Filters above still apply." :
        "Counts are one-way dates for " + name + ". Filters above still apply.");

    // View switcher
    var switchBtns = document.querySelectorAll("#view-switch button[data-view]");
    for (var i = 0; i < switchBtns.length; i++) {
      var v = switchBtns[i].getAttribute("data-view");
      switchBtns[i].setAttribute("aria-pressed", v === state.view ? "true" : "false");
      var label = v === "trips" ? "Trips" : v === "out" ? "Outbound dates" : "Return dates";
      var count = v === "trips" ? pairs.length : v === "out" ? outRows.length : retRows.length;
      switchBtns[i].textContent = label + " (" + count + ")";
    }

    if (state.view === "trips") renderTrips(pairs, name);
    else renderLegs(state.view === "out" ? outRows : retRows, name);
  }

  // buildGroups skips hidden destinations (right for the grid); the detail view
  // must still work for a hidden destination reached by URL.
  function buildGroupsUnhidden(rows) {
    var wasHidden = hidden;
    hidden = [];
    var groups;
    try {
      groups = buildGroups(rows);
    } finally {
      hidden = wasHidden;
    }
    return groups;
  }

  function renderTrips(pairs, name) {
    $("legs-wrap").hidden = true;
    $("trips-wrap").hidden = false;

    var rows = sortPairs(pairsForTab(pairs, state.tab));
    paintSortHeaders("#trips-table thead button[data-tsort]", "data-tsort", state.tsort, state.tdir);

    var body = $("trips-body");
    body.textContent = "";
    var table = $("trips-table");
    var empty = $("empty");
    var truncated = $("truncated");
    truncated.hidden = true;

    if (rows.length === 0) {
      table.hidden = true;
      empty.hidden = false;
      empty.textContent = state.tab === "below" ? belowEmptyMessage() :
        "No " + state.minNights + "–" + state.maxNights + "-night roundtrips for " + name +
        " match the current filters and tab. Widen the trip length, or check the one-way date views.";
      return;
    }

    empty.hidden = true;
    table.hidden = false;

    var shown = rows.length > RENDER_CAP ? rows.slice(0, RENDER_CAP) : rows;
    var frag = document.createDocumentFragment();
    shown.forEach(function (p) { frag.appendChild(renderTripRow(p)); });
    body.appendChild(frag);

    if (rows.length > RENDER_CAP) {
      truncated.textContent = "Showing the first " + RENDER_CAP + " of " +
        rows.length + " matching trips — narrow the filters to see the rest.";
      truncated.hidden = false;
    }
  }

  function renderLegs(rows, name) {
    $("trips-wrap").hidden = true;
    $("legs-wrap").hidden = false;

    var sorted = sortRows(rowsForTab(rows, state.tab));
    paintSortHeaders("#deals-table thead button[data-sort]", "data-sort", state.sort, state.dir);

    var body = $("deals-body");
    body.textContent = "";
    var table = $("deals-table");
    var empty = $("empty");
    var truncated = $("truncated");
    truncated.hidden = true;

    if (sorted.length === 0) {
      table.hidden = true;
      empty.hidden = false;
      empty.textContent = state.tab === "below" ? belowEmptyMessage() :
        "No " + (state.view === "out" ? "outbound" : "return") + " dates for " + name +
        " match the current filters and tab.";
      return;
    }

    empty.hidden = true;
    table.hidden = false;

    var shown = sorted.length > RENDER_CAP ? sorted.slice(0, RENDER_CAP) : sorted;
    var frag = document.createDocumentFragment();
    shown.forEach(function (d) { frag.appendChild(renderRow(d)); });
    body.appendChild(frag);

    if (sorted.length > RENDER_CAP) {
      truncated.textContent = "Showing the first " + RENDER_CAP + " of " +
        sorted.length + " matching dates — narrow the filters to see the rest.";
      truncated.hidden = false;
    }
  }

  function paintSortHeaders(selector, attr, activeKey, dir) {
    var btns = document.querySelectorAll(selector);
    for (var i = 0; i < btns.length; i++) {
      var k = btns[i].getAttribute(attr);
      btns[i].className = activeKey === k ? "sorted-" + dir : "";
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

  function favCell(id, ariaLabel) {
    var cFav = document.createElement("td");
    cFav.className = "fav-col";
    var favBtn = document.createElement("button");
    favBtn.type = "button";
    favBtn.className = "fav-btn";
    favBtn.setAttribute("data-fav", id);
    favBtn.setAttribute("aria-label", ariaLabel);
    paintFavButton(favBtn);
    cFav.appendChild(favBtn);
    return cFav;
  }

  function renderTripRow(p) {
    var tr = document.createElement("tr");

    tr.appendChild(favCell(pairId(p),
      "Shortlist trip departing " + p.out.date + ", returning " + p.ret.date));

    var cDep = td("Depart");
    cDep.appendChild(legLink(p.out, fmtDate(p.out.date)));
    tr.appendChild(cDep);

    var cRet = td("Return");
    cRet.appendChild(legLink(p.ret, fmtDate(p.ret.date)));
    tr.appendChild(cRet);

    var cNights = td("Nights", "num");
    cNights.textContent = p.nights;
    tr.appendChild(cNights);

    var cCabin = td("Cabin");
    cCabin.textContent = CABIN_LABELS[p.cabin] || p.cabin;
    tr.appendChild(cCabin);

    var cTotal = td("Total / person", "num");
    var eff = document.createElement("strong");
    eff.textContent = fmtMiles(p.total);
    cTotal.appendChild(eff);
    if (p.anyDiscount) {
      var sub = document.createElement("span");
      sub.className = "miles-sub";
      sub.appendChild(basePriceSpan(p.baseTotal));
      sub.appendChild(discBadge());
      cTotal.appendChild(sub);
    }
    tr.appendChild(cTotal);

    var cDelta = td("Δ vs baseline RT", "num");
    if (p.delta === null) cDelta.classList.add("delta-none");
    else cDelta.appendChild(deltaSpan(p.delta));
    tr.appendChild(cDelta);

    var cDirect = td("Non-stop");
    cDirect.textContent = p.out.direct && p.ret.direct ? "Both ways" :
      p.out.direct ? "Out only" : p.ret.direct ? "Return only" : "No";
    if (p.out.direct && p.ret.direct) cDirect.classList.add("direct-yes");
    tr.appendChild(cDirect);

    var cSeats = td("Seats", "num");
    var s = pairSeats(p);
    if (s.allKnown) {
      cSeats.textContent = s.min;
    } else {
      var unkSeat = document.createElement("span");
      unkSeat.className = "unk-badge";
      unkSeat.textContent = s.min === null ? "unknown" : "≥? (" + s.min + " one way)";
      unkSeat.title = "The source didn't report a seat count for " +
        (s.min === null ? "either leg" : "one of the legs") +
        " — verify both dates on united.com before counting on 2 seats.";
      cSeats.appendChild(unkSeat);
    }
    tr.appendChild(cSeats);

    var cAir = td("Airlines");
    var airlines = {};
    (p.out.airlines || []).forEach(function (a) { airlines[a] = true; });
    (p.ret.airlines || []).forEach(function (a) { airlines[a] = true; });
    cAir.textContent = Object.keys(airlines).sort().join(", ");
    tr.appendChild(cAir);

    return tr;
  }

  function renderRow(d) {
    var tr = document.createElement("tr");

    tr.appendChild(favCell(d.id, "Shortlist " + d.from + " to " + d.to + " on " + d.date));

    var cDate = td("Date");
    cDate.appendChild(legLink(d, fmtDate(d.date)));
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
    if (seatsKnown(d)) {
      cSeats.textContent = d.seats;
    } else {
      var unkSeat = document.createElement("span");
      unkSeat.className = "unk-badge";
      unkSeat.textContent = "unknown";
      unkSeat.title = "The source didn't report a seat count for this date — verify on united.com before counting on 2 seats.";
      cSeats.appendChild(unkSeat);
    }
    tr.appendChild(cSeats);

    var cAir = td("Airlines");
    cAir.textContent = (d.airlines || []).join(", ");
    tr.appendChild(cAir);

    return tr;
  }
})();
