/* Axel & Nhi — Honeymoon Award Finder. Vanilla JS, no dependencies, no external requests. */
(function () {
  "use strict";

  var CABINS = ["Y", "W", "J", "F"];
  var CABIN_LABELS = { Y: "Economy", W: "Premium Economy", J: "Business", F: "First" };
  var DEFAULT_CABINS = ["J", "F"];
  var DEFAULT_MIN_SEATS = 2; // travelling as a pair
  var STALE_MS = 36 * 60 * 60 * 1000;
  var MILES_STEP = 5000;
  var RENDER_CAP = 500; // keep the DOM light with a few thousand rows
  var FAV_KEY = "honeymoon-favs";

  var deals = [];
  var baselines = {};
  var allRegions = [];
  var allMonths = [];
  var milesCeil = 200000;
  var newestFirstSeen = null;
  var favorites = loadFavorites();

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
    sort: null,         // null = tab default
    dir: "asc"
  };

  var $ = function (id) { return document.getElementById(id); };

  // ---------- Favorites (localStorage) ----------

  function loadFavorites() {
    try {
      var raw = localStorage.getItem(FAV_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function saveFavorites() {
    try {
      localStorage.setItem(FAV_KEY, JSON.stringify(favorites));
    } catch (e) { /* private mode etc. — favorites just won't persist */ }
  }

  function isFav(id) { return favorites.indexOf(id) >= 0; }

  function toggleFav(id) {
    var i = favorites.indexOf(id);
    if (i >= 0) favorites.splice(i, 1);
    else favorites.push(id);
    saveFavorites();
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
    writeStateToURL();
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
  }

  function setChecked(name, values) {
    var inputs = document.querySelectorAll('input[name="' + name + '"]');
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].checked = values.indexOf(inputs[i].value) >= 0;
    }
  }

  // ---------- URL state ----------

  function writeStateToURL() {
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
    if (state.sort) { p.set("sort", state.sort); p.set("dir", state.dir); }
    var qs = p.toString();
    history.replaceState(null, "", qs ? "?" + qs : location.pathname);
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

  // ---------- Filtering / sorting ----------

  function baselineFor(d) {
    var b = baselines[d.region];
    if (!b) return null;
    var v = b[d.cabin];
    return typeof v === "number" ? v : null;
  }

  function deltaFor(d) {
    var b = baselineFor(d);
    return b === null ? null : d.miles - b;
  }

  function matchesFilters(d) {
    if (state.cabins.indexOf(d.cabin) < 0) return false;
    if (state.regions.indexOf(d.region) < 0) return false;
    if (state.month && String(d.date).slice(0, 7) !== state.month) return false;
    if (state.maxMiles !== null && d.miles > state.maxMiles) return false;
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

  function sortRows(rows) {
    var key = state.sort;
    var dir = state.dir === "desc" ? -1 : 1;
    if (!key) {
      // Tab defaults
      if (state.tab === "below") {
        return rows.slice().sort(function (a, b) { return deltaFor(a) - deltaFor(b); });
      }
      return rows.slice().sort(function (a, b) { return a.miles - b.miles; });
    }
    var val = function (d) {
      switch (key) {
        case "date": return d.date || "";
        case "route": return d.to || "";
        case "cabin": return CABINS.indexOf(d.cabin);
        case "miles": return d.miles;
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

  // ---------- Rendering ----------

  function fmtMiles(n) {
    return n.toLocaleString("en-US");
  }

  function fmtDate(iso) {
    var parts = String(iso).split("-");
    if (parts.length !== 3) return iso;
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  }

  function unitedURL(d) {
    var p = new URLSearchParams({
      f: d.from, t: d.to, d: d.date, tt: "1", at: "1", sc: "7", px: "1", taxng: "1"
    });
    return "https://www.united.com/en/us/fsr/choose-flights?" + p.toString();
  }

  function render() {
    var filtered = deals.filter(matchesFilters);
    var counts = {
      all: filtered.length,
      below: tabRows("below", filtered).length,
      "new": tabRows("new", filtered).length
    };
    $("count-all").textContent = counts.all;
    $("count-below").textContent = counts.below;
    $("count-new").textContent = counts["new"];

    var tabButtons = document.querySelectorAll("#tabs button[data-tab]");
    for (var i = 0; i < tabButtons.length; i++) {
      tabButtons[i].setAttribute("aria-selected",
        tabButtons[i].getAttribute("data-tab") === state.tab ? "true" : "false");
    }

    var rows = sortRows(tabRows(state.tab, filtered));

    // Sort indicators
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
      if (deals.length === 0) {
        empty.textContent = "No deals in the current data set.";
      } else if (state.favOnly && favorites.length === 0) {
        empty.textContent = "No shortlisted deals yet — tap the heart on a row to save it for later.";
      } else if (state.tab === "below") {
        empty.textContent = "No deals below baseline match the current filters. Try widening cabins, regions, or the miles cap.";
      } else if (state.tab === "new") {
        empty.textContent = "No newly found deals match the current filters. Try widening cabins, regions, or the miles cap.";
      } else {
        empty.textContent = "No deals match the current filters. Try widening cabins, regions, or the miles cap.";
      }
      return;
    }

    empty.hidden = true;
    table.hidden = false;

    var shown = rows.length > RENDER_CAP ? rows.slice(0, RENDER_CAP) : rows;
    var frag = document.createDocumentFragment();
    shown.forEach(function (d) {
      frag.appendChild(renderRow(d));
    });
    body.appendChild(frag);

    if (rows.length > RENDER_CAP) {
      truncated.textContent = "Showing the first " + RENDER_CAP + " of " +
        rows.length + " matching deals — narrow the filters to see the rest.";
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
    btn.textContent = fav ? "♥" : "♡"; // ♥ / ♡
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
    cDate.textContent = fmtDate(d.date);
    tr.appendChild(cDate);

    var cRoute = td("Route");
    var a = document.createElement("a");
    a.href = unitedURL(d);
    a.target = "_blank";
    a.rel = "noopener";
    a.className = "route-link";
    a.textContent = d.from + " → " + d.to;
    a.title = "Open this award search on united.com (new tab)";
    cRoute.appendChild(a);
    if (d.city) {
      var city = document.createElement("span");
      city.className = "city";
      city.textContent = d.city;
      cRoute.appendChild(city);
    }
    tr.appendChild(cRoute);

    var cCabin = td("Cabin");
    cCabin.textContent = CABIN_LABELS[d.cabin] || d.cabin;
    tr.appendChild(cCabin);

    var cMiles = td("Miles", "num");
    cMiles.textContent = fmtMiles(d.miles);
    tr.appendChild(cMiles);

    var cDelta = td("Δ vs baseline", "num");
    var delta = deltaFor(d);
    if (delta === null) {
      cDelta.textContent = "";
      cDelta.classList.add("delta-none");
    } else {
      cDelta.textContent = (delta > 0 ? "+" : delta < 0 ? "−" : "") + fmtMiles(Math.abs(delta));
      cDelta.classList.add(delta < 0 ? "delta-good" : delta > 0 ? "delta-bad" : "delta-zero");
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
