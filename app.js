// OCTIVE website: home, global ranking (rankings), player profiles (u/<playerId or link>), workshop, crews… (no # since 2.2.2)
// (#/download), sign-in and profile editing (#/account) and password resets (#/reset). Reads the ranking
// and releases from the Worker. No build step, no dependencies.
(() => {
  "use strict";

  // an empty slot (null, undefined or false) adds nothing, instead of the text "null"
  for (const proto of [Element.prototype, DocumentFragment.prototype]) {
    for (const fn of ["append", "prepend", "replaceChildren"]) {
      const orig = proto[fn];
      if (orig) proto[fn] = function (...kids) { return orig.apply(this, kids.filter((k) => k !== null && k !== undefined && k !== false)); };
    }
  }

  /** The official OCTIVE account: never ranked, always level 1000. */
  const OFFICIAL_ID = "o2quUJmLzZujIpPomajHJ7oW07aI";
  /** The check beside a name ("official" or "verified"), from the server or the built-in list. */
  const checkOf = (p) => p ? (p.check || (p.id === OFFICIAL_ID ? "official" : ROLES[p.id]?.badge === "DEV" ? "verified" : null)) : null;
  const INF = "∞";
  const isOfficial = (p) => !!p && (p.id === OFFICIAL_ID || p.official === true);
  // the official account's status: "Octive • v1.5.0 • 8 players online", a new number every 12 s (the same for everyone)
  let offStat = null, offStatAt = 0, offClock = 0;
  function loadOfficialStatus() {
    if (!worker || Date.now() - offStatAt < 60_000) return;
    offStatAt = Date.now();
    fetch(worker + "/official/status", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (!d) return; offStat = d; if (d.now) offClock = d.now - Date.now();
    }).catch(() => {});
  }
  function officialText() {
    loadOfficialStatus();
    const head = `Octive \u2022 v${(offStat && offStat.version) || (release && release.version) || ""}`.replace(/ v$/, "");
    const st = offStat && offStat.stats && offStat.stats.length ? offStat.stats[Math.floor((Date.now() + offClock) / (offStat.rotateMs || 12000)) % offStat.stats.length] : null;
    return st ? `${head} \u2022 ${fmt0.format(st.value)} ${st.label}` : head;
  }
  /** A player from the ranking, or the official account (which isn't ranked). */
  const findPlayer = (id) => (data && data.players.find((x) => x.id === id)) || (data && data.official && data.official.id === id ? data.official : null);
  const checkEl = (p) => { const c = checkOf(p); return c ? h("span.check." + c, { title: c === "official" ? "Official OCTIVE account" : "Verified: this is really them", role: "img", "aria-label": c }) : null; };

  /** Built-in special accounts by Unity player ID (same list as the game's PlayerRoles). */
  const ROLES = {
    "PlwcYVKV9y7NBFWfUaC263XpCFbE": { badge: "DEV", title: "OCTIVE developer" }, // Senterra
  };
  /** Badges developers can give in the game. */
  const GRANTED = {
    MOD: { badge: "MOD", title: "OCTIVE moderator", cls: "role-mod" },
    TESTER: { badge: "TESTER", title: "OCTIVE tester", cls: "role-tester" },
    VIP: { badge: "VIP", title: "OCTIVE VIP", cls: "role-vip" },
    CREATOR: { badge: "CREATOR", title: "Content creator", cls: "role-creator" },
    CHARTER: { badge: "CHARTER", title: "OCTIVE charter", cls: "role-charter" },
  };
  /**
   * The rankings Worker (Cloudflare) address, e.g. "https://octive-rankings.yourname.workers.dev".
   * Empty: the site reads data/leaderboard.json instead.
   */
  const WORKER_URL = "https://octive-rankings-api.lunalazum18.workers.dev/";

  const app = document.getElementById("app");
  const fmt0 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
// profile tile counts: 999, then 1.00k, then 1.00m (rounded down)
const fmtCount = (n) => n >= 1e6 ? (Math.floor(n / 1e4) / 100).toFixed(2) + "m" : n >= 1000 ? (Math.floor(n / 10) / 100).toFixed(2) + "k" : fmt0.format(n);
  const fmt2 = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let data = null;

  // the game's level curve: level 1 → 2 takes 10,000 xp, every level after takes 7% more
  const xpFor = (lv) => lv <= 1 ? 0 : Math.round(100000 * (Math.pow(1.07, lv - 1) - 1) / 0.07);

  const worker = WORKER_URL.replace(/\/+$/, "");
  const SITE_URL = "https://senterraslays.github.io/octive/";
  // the site's folder (index.html has <base href="/octive/">): profiles are at BASE_PATH + "u/<key>"
  const BASE_PATH = new URL(document.baseURI).pathname.replace(/[^/]*$/, "");
  /** A profile's address (relative to the site's folder): u/<player id or link>. */
  const profileHref = (key) => "u/" + encodeURIComponent(key || "");
  // (2.2.2) every page has an address without a #: senterraslays.github.io/octive/workshop/<id>, …/crew/<id>,
  // …/account?tab=preferences. GitHub Pages serves the page's own file (written by the Worker, with its picture for
  // link previews) or 404.html (this same site). The site's in-page download page is "downloads" (download.html is
  // the search engines' page). Old #/ links still open and move to the new address.
  /** The page's route as "#/workshop/…?…", which is what the pages read. */
  function routeHash() {
    if (location.pathname.startsWith(BASE_PATH)) {
      const rest = location.pathname.slice(BASE_PATH.length).replace(/\.html$/, "").replace(/\/+$/, "");
      if (rest && rest !== "index" && rest !== "404") return "#/" + (rest === "downloads" ? "download" : rest) + location.search;
    }
    return location.hash.startsWith("#/") ? location.hash : "#/";
  }
  /** A route ("#/download", "account?tab=x") as the part of the address after the site's folder. */
  const routePath = (to) => {
    let rest = String(to || "").replace(/^#\/?/, "").replace(/^\/+/, "");
    if (rest === "download" || rest.startsWith("download?")) rest = "downloads" + rest.slice(8);
    return rest;
  };
  /** Opens a page of the site without loading the site again. */
  function go(to) {
    const url = BASE_PATH + routePath(to);
    if (url === location.pathname + location.search) history.replaceState(history.state, "", url);
    else history.pushState(null, "", url);
    route(true);
  }
  // (2.2.2) supporters' own profile links (u/Senterra): link (lower case) → player id ("" when nobody has it)
  const linkIds = {};
  /** The link to share for a profile: it shows their card in Discord and others, and opens the profile here. */
  const shareLink = (key) => SITE_URL + profileHref(key);
  const PENCIL_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M13.5 6.5l4 4" stroke="currentColor" stroke-width="2"/></svg>';


  async function load() {
    let error = null;
    try {
      const res = await fetch(worker ? worker + "/leaderboard" : "data/leaderboard.json", { cache: "no-cache" });
      data = await res.json();
      if (!res.ok || data.error && !data.players) throw new Error(data.error || res.status);
    } catch (e) {
      error = e.message || String(e);
      data = { players: [] };
    }
    data.error = error || data.error;
    data.players = (data.players || []).slice().sort((a, b) => a.rank - b.rank);
    // avatars come from the Worker (by picture version) or from the avatars folder
    for (const p of data.official ? [...data.players, data.official] : data.players) // the official account isn't ranked
      if (worker && p.avatarHash) p.avatar = `${worker}/avatar/${encodeURIComponent(p.id)}?v=${encodeURIComponent(p.avatarHash)}`;
    if (data.updated) {
      const when = new Date(data.updated);
      const upd = document.getElementById("updated");
      if (upd) upd.textContent = "Updated " + when.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    }
    paintSideStatus();
    if (app && ["home", "rankings", "player", "ranked"].includes(page())) route();
  }

  function clone(id) { return document.getElementById(id).content.cloneNode(true); }

  /** (3.0) A player's own colour for the placeholder behind their picture (the same every time). */
  const AV_TINTS = ["#ff4d9d", "#ff9a3d", "#ffd23f", "#3ee089", "#36d6ff", "#5b7cff", "#a764ff", "#2fe0c0", "#ff5a6e"];
  function avatarTint(key) {
    let n = 0;
    for (const ch of String(key || "")) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
    return AV_TINTS[n % AV_TINTS.length];
  }
  /** The picture fades in over the first letter once it has loaded; the letter stays if it can't load. */
  function waitForPicture(box, img, initial, src) {
    if (!src || img.getAttribute("src") === src && !box.classList.contains("av-wait")) return;
    box.classList.add("av-wait");
    img.hidden = false; if (initial) initial.hidden = false;
    // it fades in over the letter, then the letter goes
    img.onload = () => { box.classList.add("av-in"); setTimeout(() => { box.classList.remove("av-wait", "av-in"); if (initial) initial.hidden = true; }, 380); };
    img.onerror = () => { box.classList.remove("av-wait"); img.hidden = true; if (initial) initial.hidden = false; };
    img.src = src;
  }
  /** (3.0) A shimmer where a picture will be, until it has loaded (then it fades in); nothing is left blank. */
  function waitPic(holder, img) {
    if (!img) return img;
    holder.classList.add("pic-wait");
    const done = () => holder.classList.remove("pic-wait");
    img.addEventListener("load", done, { once: true });
    img.addEventListener("error", () => { done(); img.remove(); holder.classList.add("pic-none"); }, { once: true });
    if (img.complete && img.naturalWidth) done();
    return img;
  }

  function setAvatar(box, p) {
    const img = box.querySelector("img"), initial = box.querySelector(".initial");
    initial.textContent = (p.name || "?").charAt(0).toUpperCase();
    box.style.setProperty("--av", avatarTint(p.id || p.name));
    const gif = isSupporter(p) && p.supporter.gif ? avatarUrl(p) : null;
    if (gif || p.avatar) {
      // (3.0) their first letter, in a colour of their own, stays until the picture has arrived (no blank box)
      waitForPicture(box, img, initial, gif || (p.avatar.includes("?") || !p.avatarHash ? p.avatar : p.avatar + "?v=" + encodeURIComponent(p.avatarHash)));
    }
    const dot = box.querySelector(".dot");
    if (dot) {
      dot.hidden = false;
      dot.classList.toggle("on", !!p.online);
      dot.title = statusText(p);
      dot.classList.toggle("site", !!p.online && p.status === "site");
      liveDots.set(dot, p);
      paintLiveDot(dot, p);
    }
  }

  // (2.1.2) who's live on Twitch right now: the play mark stands in for their online dot everywhere (checked every minute)
  let LIVE_NOW = {};
  const liveDots = new Map(); // dot -> its player (dots that left the page are dropped on the next check)
  function paintLiveDot(dot, p) {
    const lv = p && LIVE_NOW[p.id];
    if (lv) {
      dot.hidden = false; dot.classList.add("live"); dot.innerHTML = LIVE_SVG;
      dot.title = "Live on Twitch" + (lv.title ? ": " + lv.title : "");
    } else if (dot.classList.contains("live") && !dot.dataset.profileLive) {
      dot.classList.remove("live"); dot.innerHTML = ""; dot.title = statusText(p);
    }
  }
  async function loadLiveNow() {
    try {
      const r = await fetch(WORKER_URL.replace(/\/+$/, "") + "/social/live");
      if (r.ok) LIVE_NOW = (await r.json()).live || {};
    } catch { /* keep the last answer */ }
    for (const [dot, p] of liveDots) { if (!dot.isConnected) { liveDots.delete(dot); continue; } paintLiveDot(dot, p); }
    paintLiveStrip();
  }
  loadLiveNow();
  setInterval(loadLiveNow, 60_000);

  function roleOf(p) {
    if (ROLES[p.id]) return { ...ROLES[p.id], cls: "dev" };
    return p.role && GRANTED[p.role] ? GRANTED[p.role] : null;
  }

  function setRole(root, badgeEl, p) {
    const role = roleOf(p);
    if (!role) return null;
    root.classList.add(role.cls);
    badgeEl.textContent = role.badge;
    badgeEl.hidden = false;
    // the player's other badges (a player can have several, e.g. TESTER and VIP)
    let after = badgeEl;
    for (const b of (p.badges || [])) {
      if (b === role.badge || !GRANTED[b]) continue;
      const extra = document.createElement("span");
      extra.className = "badge extra " + GRANTED[b].cls;
      extra.textContent = b;
      extra.title = GRANTED[b].title;
      after.after(extra);
      after = extra;
    }
    return role;
  }

  // ---------------------------------------------------------------- content creators' socials (same rules as the game)
  const SOCIALS = [
    ["youtube", "YouTube", "https://www.youtube.com/@{0}"],
    ["tiktok", "TikTok", "https://www.tiktok.com/@{0}"], ["x", "X (Twitter)", "https://x.com/{0}"],
    ["instagram", "Instagram", "https://www.instagram.com/{0}"], ["bluesky", "Bluesky", "https://bsky.app/profile/{0}"],
    ["discord", "Discord", null], ["website", "Website", null],
  ];
  function socialUrl(format, value) {
    const v = String(value || "").trim();
    if (!v || v.length > 200) return null;
    const safe = (s) => { try { const u = new URL(s); return (u.protocol === "https:" || u.protocol === "http:") && u.host ? u.href : null; } catch { return null; } };
    if (/^https?:\/\//i.test(v)) return safe(v);
    if (!format) return v.includes(".") && !v.includes(" ") ? safe("https://" + v) : null;
    const h = v.replace(/^@+/, "");
    return /^[A-Za-z0-9._-]{1,60}$/.test(h) ? format.replace("{0}", h) : null;
  }
  function renderSocials(box, socials) {
    box.textContent = "";
    let n = 0;
    for (const [id, name, format] of SOCIALS) {
      const url = socialUrl(format, socials && socials[id]);
      if (!url) continue;
      const a = document.createElement("a");
      a.className = "social"; a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer";
      const label = document.createElement("span"); label.className = "social-name"; label.textContent = name;
      const handle = document.createElement("span"); handle.className = "social-handle";
      handle.textContent = /^https?:/i.test(socials[id]) ? socials[id].replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "") : socials[id];
      a.append(label, handle);
      box.appendChild(a);
      n++;
    }
    return n;
  }

  function ago(iso) {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 120) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " minutes ago";
    if (s < 86400) { const h = Math.floor(s / 3600); return h + (h === 1 ? " hour ago" : " hours ago"); }
    const d = Math.floor(s / 86400); return d + (d === 1 ? " day ago" : " days ago");
  }

  function playTime(ms) {
    const m = Math.floor((ms || 0) / 60000);
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
  }

  // ---------------------------------------------------------------- bios (the game's formatting codes)

  const COLOURS = { 0: "000000", 1: "0000AA", 2: "00AA00", 3: "00AAAA", 4: "AA0000", 5: "AA00AA", 6: "FFAA00", 7: "AAAAAA",
    8: "555555", 9: "5555FF", a: "55FF55", b: "55FFFF", c: "FF5555", d: "FF55FF", e: "FFFF55", f: "FFFFFF" };
  const isHex = (c) => /[0-9a-fA-F]/.test(c);

  /** Renders a bio into an element: #0-#f colours, #RRGGBB, #l bold, #o italic, #n underline, #m strike, #k scrambled, #g rainbow, #r reset. */
  function renderBio(el, src) {
    el.textContent = "";
    src = (src || "").replace(/\r/g, "").replace(/^\n+/, "").trimEnd().slice(0, 400).split("\n").slice(0, 8).join("\n");
    let cur = {};
    let text = "";
    const animated = [];
    const flush = () => {
      if (!text) return;
      const span = document.createElement("span");
      span.textContent = text;
      if (cur.colour) span.style.color = "#" + cur.colour;
      if (cur.bold) span.style.fontWeight = "800";
      if (cur.italic) span.style.fontStyle = "italic";
      const deco = [cur.underline && "underline", cur.strike && "line-through"].filter(Boolean).join(" ");
      if (deco) span.style.textDecoration = deco;
      if (cur.rainbow) span.classList.add("rainbow-text");
      if (cur.scramble) { span.dataset.text = text; animated.push(span); }
      el.appendChild(span);
      text = "";
    };
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (ch !== "#" || i + 1 >= src.length) { text += ch; continue; }
      const n = src[i + 1];
      if (n === "#") { text += "#"; i++; continue; }
      if (n === "[" && src[i + 8] === "]" && /^[0-9a-fA-F]{6}$/.test(src.slice(i + 2, i + 8))) { flush(); cur = { ...cur, colour: src.slice(i + 2, i + 8), rainbow: false }; i += 8; continue; }
      if (/^[0-9a-fA-F]{6}$/.test(src.slice(i + 1, i + 7))) { flush(); cur = { ...cur, colour: src.slice(i + 1, i + 7), rainbow: false }; i += 6; continue; }
      const c = n.toLowerCase();
      if (COLOURS[c] !== undefined) { flush(); cur = { colour: COLOURS[c] }; i++; continue; }
      const style = { l: "bold", o: "italic", n: "underline", m: "strike", k: "scramble", g: "rainbow" }[c];
      if (style) { flush(); cur = { ...cur, [style]: true }; i++; continue; }
      if (c === "r") { flush(); cur = {}; i++; continue; }
      text += ch;
    }
    flush();
    if (animated.length) {
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#$%&@?!";
      const tick = () => {
        if (!el.isConnected) return;
        for (const s of animated) s.textContent = s.dataset.text.replace(/\S/g, () => chars[Math.floor(Math.random() * chars.length)]);
        setTimeout(tick, 70);
      };
      tick();
    }
  }

  // ---------------------------------------------------------------- pages

  /** One of the top three on a podium: big picture in a medal ring, name and badges, the main number and a line under it.
   *  (3.0) It stands on a step with its place on it, like the Discord card's podium. */
  function lbPod(p, place, value, sub, extra, color) {
    const a = h("a.lb-pod", { href: profileHref(p.id), "data-place": place, style: color ? `--pc:${color}` : null },
      h("span.lb-place", { text: ["", "1st", "2nd", "3rd"][place] || "#" + place }),
      h("span.avatar", {}, h("img", { alt: "", loading: "lazy", hidden: true }), h("span.initial"), h("span.dot", { hidden: true })),
      h("span.lb-pod-name", {}, h("span.name"), h("span.badge", { hidden: true })),
      extra || null,
      h("b.lb-pod-value", { text: value }),
      sub ? h("span.lb-pod-sub", { text: sub }) : null,
      h("span.lb-step", { "aria-hidden": "true" }, h("span", { text: String(place) })));
    nameInto(a.querySelector(".name"), p);
    addLbIcon(a.querySelector(".name"), p.id);
    setAvatar(a.querySelector(".avatar"), p);
    setRole(a, a.querySelector(".badge"), p);
    return a;
  }

  // ---------------------------------------------------------------- 3.2: the top three without a podium
  // The user: "I'm not a fan of the podium thing". The leader gets a big card on the left and second and third a card each
  // beside it, in gold, silver and bronze, with the number that matters big on the right of each (Rankings, Countries,
  // Ranked and Crews all use it).
  /** One card. x: { place, href, art, name, tags, sub, value, note, extra, color, stats: [[label, value]], onCard(el) } */
  function t3Card(x, lead) {
    const el = h("a.t3-card" + (lead ? ".t3-lead" : ""), { href: x.href, "data-place": x.place, style: x.color ? `--ac:${x.color}` : null },
      h("span.t3-num", { "aria-hidden": "true", text: String(x.place) }),
      x.art ? h("span.t3-art", {}, x.art) : null,
      h("span.t3-main", {},
        h("span.t3-place", { text: ["", "1st", "2nd", "3rd"][x.place] || "#" + x.place }),
        h("span.t3-name", {}, x.name),
        x.tags || null,
        x.sub ? h("span.t3-sub", { text: x.sub }) : null,
        lead && x.stats && x.stats.length ? h("span.t3-stats", {}, ...x.stats.map(([k, v]) => h("span", {}, h("small", { text: k }), h("b", { text: v })))) : null),
      h("span.t3-val", {}, x.extra || null, h("b", { text: x.value }), x.note ? h("small", { text: x.note }) : null));
    if (x.onCard) x.onCard(el);
    return el;
  }
  /** The top three ([first, second, third]): the leader's card, and the other two beside it. */
  function topThree(list) {
    if (!list.length) return null;
    return h("div.t3" + (list.length === 1 ? ".t3-solo" : ""), {}, t3Card(list[0], true),
      list.length > 1 ? h("div.t3-rest", {}, ...list.slice(1, 3).map((x) => t3Card(x, false))) : null);
  }
  /** A player for topThree: their picture, coloured name and badges (x: the rest of the card). */
  function t3Player(p, x) {
    const art = h("span.avatar", {}, h("img", { alt: "", loading: "lazy", hidden: true }), h("span.initial"), h("span.dot", { hidden: true }));
    setAvatar(art, p);
    const name = h("span.name");
    nameInto(name, p);
    addLbIcon(name, p.id);
    const badge = h("span.badge", { hidden: true });
    const tags = h("span.t3-tags", {}, badge);
    if (isSupporter(p) || wasSupporter(p)) tags.append(supporterPill(p, true));
    return { href: profileHref(p.id), art, name, tags, ...x,
      onCard: (el) => { setRole(el, badge, p); if (![...tags.children].some((c) => !c.hidden)) tags.remove(); } };
  }

  /** (3.0) Players | Countries, above the ranking. */
  function rankTabs(view) {
    return h("nav.rk-tabs", { "aria-label": "Ranking" },
      h("a.ws-tab" + (view === "players" ? ".on" : ""), { href: "rankings" }, "Players"),
      h("a.ws-tab" + (view === "countries" ? ".on" : ""), { href: "rankings?view=countries" }, "Countries"));
  }

  function rankings() {
    const q = hashQuery();
    if (q.get("view") === "countries") { countriesPage(); return; }
    // (3.0) rankings?country=US: that country's players, with their place in it
    const country = /^[A-Z]{2}$/.test(q.get("country") || "") ? q.get("country") : "";
    const pool = country ? data.players.filter((p) => p.country === country && !isOfficial(p)) : data.players;
    const view = clone("tpl-rankings");
    const rows = view.querySelector("[data-rows]");
    const search = view.querySelector("[data-search]");
    view.querySelector("[data-count]").textContent = fmt0.format(pool.length);
    view.querySelector("[data-online]").textContent = fmt0.format(pool.filter((p) => p.online).length);
    view.querySelector(".hero > div").prepend(h("p.eyebrow", { text: country ? "Country ranking" : "Global ranking" }));
    if (country) {
      view.querySelector(".hero h1").textContent = regionName(country);
      view.querySelector(".hero .sub").textContent = `Every player from ${regionName(country)}, ranked by total performance rating (PR). Their place in the world is beside their name.`;
    }
    const notice = view.querySelector("[data-sample]");
    if (data.error) {
      notice.textContent = data.players.length
        ? "The ranking couldn't be refreshed just now; showing the last known one."
        : "The ranking couldn't be loaded right now: " + data.error;
      notice.hidden = false;
    } else notice.hidden = !data.sample;
    const empty = view.querySelector("[data-empty]");
    const table = view.querySelector(".table");
    const bar = h("div.rk-bar", {}, rankTabs("players"),
      country ? h("a.rk-filter", { href: "rankings", title: "Show every country" }, h("span.flag-chip", { text: country }), regionName(country), h("span.rk-x", { text: "✕" })) : null);
    view.querySelector(".hero").after(bar);
    // (3.2) the top three on cards, then the ranking with "Climbing this week" beside it
    const podium = h("div.t3-wrap");
    const layout = h("div.rk-layout");
    table.before(layout);
    layout.before(podium);
    const topPR = Math.max(1, ...pool.map((p) => p.pp || 0));
    // (2.2.0) the players who gained the most PR in the last 7 days. (3.0) One row you can scroll, so on phones the ranking
    // starts right after it instead of under a tall box.
    const gainList = h("div.gain-list", {}, h("p.gain-empty", { text: "Loading…" }));
    const gainers = h("aside.gainers", {}, h("div.gain-head", {}, h("h2", {}, h("span.gain-arrow", { text: "▲" }), "Climbing this week"), h("small", { text: "Most PR gained in the last 7 days" })), gainList);
    layout.append(h("div.rk-main", {}, table, empty), gainers);
    if (worker && !country) fetch(worker + "/play/gainers?limit=10", { cache: "no-cache" }).then((r) => r.json()).then((g) => {
      const list = (g && g.players) || [];
      if (!list.length) { gainList.replaceChildren(h("p.gain-empty", { text: "Nobody has gained PR this week yet." })); return; }
      gainList.replaceChildren(...list.map((p) => h("a.gain-row", { href: profileHref(p.playerId) },
        h("span.gain-rank", { text: "#" + p.rank }), smallAvatar(p.playerId, p.name),
        h("span.gain-who", {}, h("span.gain-name", { text: p.name || "Player" }), h("small.gain-total", { text: fmt0.format(p.pp || 0) + " PR" })),
        h("b.gain-amt", { text: "+" + fmt0.format(p.gain || 0) }))));
    }).catch(() => gainList.replaceChildren(h("p.gain-empty", { text: "Couldn't load this week's gainers." })));
    else { gainers.hidden = true; layout.classList.add("solo"); }

    function render(filter) {
      rows.textContent = "";
      const qq = (filter || "").trim().toLowerCase();
      const top = qq ? [] : pool.slice(0, 3);
      const t3 = topThree(top.map((p, i) => {
        const other = top[i === 0 ? 1 : 0], gap = other ? Math.abs((p.pp || 0) - (other.pp || 0)) : 0;
        const where = /^[A-Z]{2}$/.test(p.country || "") ? regionName(p.country) : "";
        return t3Player(p, { place: country ? i + 1 : p.rank, value: fmt0.format(p.pp || 0) + " PR",
          sub: i === 0 ? (country ? `#${fmt0.format(p.rank)} in the world` : where) : `${fmt2.format(p.accuracy || 0)}% · Lv${p.level || 1}${country ? ` · #${fmt0.format(p.rank)} in the world` : ""}`,
          note: other ? (i === 0 ? `+${fmt0.format(gap)} PR ahead` : `${fmt0.format(gap)} PR behind first`) : "",
          stats: [["Accuracy", fmt2.format(p.accuracy || 0) + "%"], ["Level", String(p.level || 1)], ["Plays", fmt0.format(p.playCount || 0)]] });
      }));
      podium.replaceChildren(...(t3 ? [t3] : []));
      podium.hidden = !t3;
      const list = qq ? pool.filter((p) => (p.name || "").toLowerCase().includes(qq)) : pool.slice(3);
      if (qq && !country && data.official && ("octive".includes(qq) || (data.official.name || "").toLowerCase().includes(qq))) list.unshift(data.official);
      table.hidden = !list.length && !qq;
      empty.hidden = list.length > 0 || top.length > 0;
      if (!list.length && qq) empty.textContent = `Nobody called "${filter.trim()}" is ranked${country ? " in " + regionName(country) : ""}.`;
      for (const p of list) {
        const r = clone("tpl-row").firstElementChild;
        const place = country ? pool.indexOf(p) + 1 : p.rank;
        r.href = profileHref(p.id);
        r.dataset.place = String(place);
        r.querySelector(".rank").textContent = isOfficial(p) ? INF : "#" + fmt0.format(place);
        if (country) r.querySelector(".rank").title = `#${fmt0.format(p.rank)} in the world`;
        nameInto(r.querySelector(".name"), p);
        addLbIcon(r.querySelector(".name"), p.id);
        setAvatar(r.querySelector(".avatar"), p);
        setRole(r, r.querySelector(".badge"), p);
        if (isSupporter(p)) { r.classList.add("supporter"); const pill = supporterPill(p); pill.classList.add("rank"); r.querySelector(".player").append(pill); }
        else if (wasSupporter(p)) { const pill = supporterPill(p); pill.classList.add("rank"); r.querySelector(".player").append(pill); } // the badge they earned stays
        // name and badges together; on phones the badges go on their own line under the name
        {
          const player = r.querySelector(".player"), nameEl = r.querySelector(".name");
          const who = h("span.who"), tags = h("span.tags");
          nameEl.replaceWith(who);
          who.append(nameEl, tags);
          for (const el of [...player.children]) if (el.matches(".badge, .sup-pill")) tags.append(el);
          const gp = gifterPill(p);
          if (gp) tags.append(gp);
          if (![...tags.children].some((el) => !el.hidden)) tags.remove();
        }
        r.querySelector(".acc").textContent = isOfficial(p) ? "100.00%" : fmt2.format(p.accuracy || 0) + "%";
        r.querySelector(".lvl").textContent = "Lv" + (isOfficial(p) ? 1000 : p.level || 1);
        r.querySelector(".plays").textContent = isOfficial(p) ? INF : fmt0.format(p.playCount || 0);
        r.querySelector(".pp").textContent = (isOfficial(p) ? INF : fmt0.format(p.pp || 0)) + " PR";
        if (!isOfficial(p)) r.querySelector(".pp").append(h("span.lb-prbar", {}, h("span", { style: `width:${Math.max(2, Math.round((p.pp || 0) / topPR * 100))}%` })));
        if (isOfficial(p)) r.classList.add("official-row");
        if ((p.ppVersion || 2) < 3) {
          r.classList.add("pp-old");
          r.querySelector(".pp").title = "PR from before the rework. It updates the next time this player opens OCTIVE.";
          r.querySelector(".pp").append(h("span.pp-old-tag", { text: "before rework" }));
        }
        rows.appendChild(r);
      }
    }
    search.addEventListener("input", () => render(search.value));
    render("");
    app.replaceChildren(view);
    document.title = country ? `${regionName(country)} · OCTIVE Rankings` : "OCTIVE Rankings";
  }

  // ---------------------------------------------------------------- 3.0: countries, ranked by their players' PR
  let countrySort = "total";
  function countriesPage() {
    document.title = "Countries · OCTIVE Rankings";
    const groups = new Map();
    for (const p of data.players) {
      if (isOfficial(p) || !/^[A-Z]{2}$/.test(p.country || "")) continue;
      if (!groups.has(p.country)) groups.set(p.country, []);
      groups.get(p.country).push(p);
    }
    const rowsData = [...groups].map(([code, ps]) => {
      ps.sort((a, b) => a.rank - b.rank);
      const total = ps.reduce((s, p) => s + (p.pp || 0), 0);
      return { code, name: regionName(code), players: ps, total, avg: total / ps.length,
        acc: ps.reduce((s, p) => s + (p.accuracy || 0), 0) / ps.length, online: ps.filter((p) => p.online).length, best: ps[0] };
    });
    const sorters = { total: (a, b) => b.total - a.total, avg: (a, b) => b.avg - a.avg, players: (a, b) => b.players.length - a.players.length || b.total - a.total };
    const placed = data.players.filter((p) => !isOfficial(p) && /^[A-Z]{2}$/.test(p.country || "")).length;
    const head = h("section.hero", {},
      h("div", {}, h("p.eyebrow", { text: "Around the world" }), h("h1", { text: "Countries" }),
        h("p.sub", { text: "Every country with an OCTIVE player, ranked by its players' PR added up. Pick one to see its own ranking." })),
      h("div.hero-side", {},
        h("div.stat", {}, h("span.stat-label", { text: "Countries" }), h("span.stat-value", { text: fmt0.format(rowsData.length) })),
        h("div.stat", {}, h("span.stat-label", { text: "Players" }), h("span.stat-value", { text: fmt0.format(placed) }))));
    const sortBar = h("div.ct-sort");
    const podium = h("div.t3-wrap");
    const list = h("div.ct-list", { role: "table", "aria-label": "Countries" });
    const pr = (n) => fmt0.format(Math.round(n)) + " PR";
    function paint() {
      const sorted = rowsData.slice().sort(sorters[countrySort]);
      const what = (c) => countrySort === "avg" ? pr(c.avg) : countrySort === "players" ? `${fmt0.format(c.players.length)} player${c.players.length === 1 ? "" : "s"}` : pr(c.total);
      sortBar.replaceChildren(h("span.ct-sort-cap", { text: "Ranked by" }), ...[["total", "Total PR"], ["avg", "PR per player"], ["players", "Players"]].map(([k, label]) =>
        h("button.chip" + (k === countrySort ? ".on" : ""), { type: "button", onclick: () => { countrySort = k; paint(); } }, label)));
      // (3.2) the top three on cards
      const t3 = topThree(sorted.slice(0, 3).map((c, i) => ({ place: i + 1, href: "rankings?country=" + c.code,
        art: h("span.t3-code", { text: c.code }), name: h("span", { text: c.name }),
        sub: `${fmt0.format(c.players.length)} player${c.players.length === 1 ? "" : "s"} · best: ${c.best.name || "Player"}`,
        value: what(c), note: c.online ? `${fmt0.format(c.online)} online now` : "",
        stats: [["Players", fmt0.format(c.players.length)], ["Accuracy", fmt2.format(c.acc) + "%"], ["PR per player", fmt0.format(Math.round(c.avg))]] })));
      podium.replaceChildren(...(t3 ? [t3] : []));
      const max = Math.max(1, ...sorted.map((c) => countrySort === "avg" ? c.avg : countrySort === "players" ? c.players.length : c.total));
      list.replaceChildren(
        h("div.ct-head", { role: "row" }, ...["#", "Country", "Players", "Accuracy", "Best player", countrySort === "avg" ? "PR per player" : countrySort === "players" ? "Players" : "Total PR"].map((t) => h("span", { role: "columnheader", text: t }))),
        ...sorted.map((c, i) => {
          const v = countrySort === "avg" ? c.avg : countrySort === "players" ? c.players.length : c.total;
          return h("a.ct-row", { href: "rankings?country=" + c.code, role: "row", "data-place": i + 1 },
            h("span.ct-rank", { text: "#" + (i + 1) }),
            h("span.ct-name", {}, h("span.flag-chip", { text: c.code }), h("b", { text: c.name }), c.online ? h("small.ct-on", { text: `${c.online} online` }) : null),
            h("span.ct-num", { text: fmt0.format(c.players.length) }),
            h("span.ct-num", { text: fmt2.format(c.acc) + "%" }),
            h("span.ct-best", {}, smallAvatar(c.best.id, c.best.name, c.best.avatarHash), h("span", { text: c.best.name || "Player" })),
            h("span.ct-val", {}, h("b", { text: what(c) }), h("span.lb-prbar", {}, h("span", { style: `width:${Math.max(3, Math.round(v / max * 100))}%` }))));
        }));
    }
    paint();
    app.replaceChildren(h("div.ct-page", {}, head, h("div.rk-bar", {}, rankTabs("countries"), sortBar), podium, list,
      rowsData.length ? null : h("p.empty", { text: "No countries yet." })));
  }


  // ---------------------------------------------------------------- Ranked (2.0): this season's ranked board

  const RK_NAMES = ["Rookie", "Contender I", "Contender II", "Contender III", "Challenger I", "Challenger II", "Challenger III",
    "Rockstar I", "Rockstar II", "Rockstar III", "Superstar I", "Superstar II", "Superstar III", "Elite I", "Elite II", "Elite III", "Champion", "Legend"];
  // each rank's colour (the game's): Rookie, Contender … Elite, Champion, Legend
  const RK_COLORS = ["#99A3B8", "#E08F54", "#CCDBF2", "#FFCC4D", "#54DEF5", "#B880FF", "#FF6180", "#FFE894"];
  const RK_GROUPS = [["Contender", 1, "2-3★"], ["Challenger", 4, "3-4★"], ["Rockstar", 7, "4-5★"], ["Superstar", 10, "5-5.5★"], ["Elite", 13, "5.5-6★"], ["Champion", 16, "6-6.5★"], ["Legend", 17, "6.5★ and up"]];
  const rkGroup = (t) => (t <= 0 ? 0 : t <= 15 ? Math.floor((t - 1) / 3) + 1 : t === 16 ? 6 : 7);
  const mixHex = (a, b, t) => {
    const rgb = (x) => [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16));
    const A = rgb(a), Bc = rgb(b);
    return "#" + A.map((v, i) => Math.round(v + (Bc[i] - v) * t).toString(16).padStart(2, "0")).join("");
  };

  /**
   * A rank's emblem, the game's own drawing: a hexagon in the rank's colour with its mark inside (a diamond for Contender
   * up to an eight-point star for Elite, a crown for Champion, a crowned star for Legend), 1-3 pips for the division, and
   * more around it the higher the rank (studs, rays, wings). Small ones leave the extras out.
   */
  function rankEmblem(tier, size) {
    const g = rkGroup(tier), col = RK_COLORS[g], detail = size >= 34;
    const f = (n) => +n.toFixed(3);
    const pts = (arr) => arr.map(([x, y]) => `${f(x)},${f(y)}`).join(" ");
    const hexPts = (rad) => Array.from({ length: 6 }, (_, i) => { const a = Math.PI / 3 * i - Math.PI / 2; return [Math.cos(a) * rad, Math.sin(a) * rad]; });
    const star = (cx, cy, outer, inner, n) => Array.from({ length: n * 2 }, (_, i) => { const a = Math.PI / n * i - Math.PI / 2, r = i % 2 === 0 ? outer : inner; return [cx + Math.cos(a) * r, cy + Math.sin(a) * r]; });
    const poly = (arr, fill, extra = "") => `<polygon points="${pts(arr)}" fill="${fill}"${extra}/>`;
    let s = "";
    if (g === 0) s = `<circle r="0.78" fill="${col}" fill-opacity="0.15" stroke="${col}" stroke-opacity="0.8" stroke-width="0.14"/>`;
    else {
      const hex = detail ? (g >= 5 ? 0.7 : g >= 4 ? 0.8 : 0.88) : 0.94;
      if (detail) {
        s += `<circle r="0.99" fill="${col}" fill-opacity="${f(0.05 + 0.025 * g)}"/><circle r="${f(hex * 1.02)}" fill="${col}" fill-opacity="${f(0.05 + 0.02 * g)}"/>`;
        if (g >= 4) {
          const n = g >= 6 ? 12 : 6;
          for (let i = 0; i < n; i++) {
            const a = Math.PI * 2 * i / n, w = g >= 6 ? 0.075 : 0.11, len = g >= 6 && i % 2 === 1 ? 0.86 : 0.99;
            s += poly([[Math.cos(a - w) * hex * 0.8, Math.sin(a - w) * hex * 0.8], [Math.cos(a) * len, Math.sin(a) * len], [Math.cos(a + w) * hex * 0.8, Math.sin(a + w) * hex * 0.8]], col, ' fill-opacity="0.7"');
          }
        }
        if (g >= 5) for (const k of [-1, 1]) s += poly([[k * 0.58, -0.3], [k * 0.99, -0.56], [k * 0.84, -0.22], [k * 1.0, -0.12], [k * 0.82, 0.06], [k * 0.93, 0.2], [k * 0.58, 0.24]], mixHex(col, "#ffffff", 0.15));
      }
      s += poly(hexPts(hex), mixHex("#0d0f17", col, 0.22));
      s += poly(hexPts(hex * 0.79), col, ' fill-opacity="0.16"');
      if (detail) { const fc = hexPts(hex * 0.79); s += poly([[fc[5][0], 0], fc[5], fc[0], fc[1], [fc[1][0], 0]], "#ffffff", ' fill-opacity="0.06"'); }
      s += `<polygon points="${pts(hexPts(hex * 0.96))}" fill="none" stroke="${col}" stroke-width="${detail ? 0.13 : 0.15}" stroke-linejoin="round"/>`;
      if (detail && g >= 2) s += `<polygon points="${pts(hexPts(hex * 0.79))}" fill="none" stroke="${col}" stroke-opacity="${g >= 6 ? 0.6 : 0.35}" stroke-width="0.05" stroke-linejoin="round"/>`;
      if (detail && g >= 3) for (const [x, y] of hexPts(hex * 0.96)) s += `<circle cx="${f(x)}" cy="${f(y)}" r="0.07" fill="${mixHex(col, "#ffffff", 0.35)}"/>`;
      const k2 = hex / 0.94, my = tier <= 15 ? -0.1 * k2 : 0.02;
      if (g === 1) s += poly([[0, my - 0.4 * k2], [0.3 * k2, my], [0, my + 0.4 * k2], [-0.3 * k2, my]], col);
      else if (g === 2) s += poly(star(0, my, 0.44 * k2, 0.15 * k2, 4), col);
      else if (g === 3) s += poly(star(0, my + 0.03 * k2, 0.46 * k2, 0.2 * k2, 5), col);
      else if (g === 4) s += poly(star(0, my, 0.46 * k2, 0.22 * k2, 6), col);
      else if (g === 5) s += poly(star(0, my, 0.47 * k2, 0.24 * k2, 8), col);
      else if (g === 6) s += poly([[-0.46 * k2, 0.26 * k2], [-0.46 * k2, -0.16 * k2], [-0.24 * k2, 0.04 * k2], [0, -0.38 * k2], [0.24 * k2, 0.04 * k2], [0.46 * k2, -0.16 * k2], [0.46 * k2, 0.26 * k2]], col)
        + `<circle cx="0" cy="${f(-0.38 * k2)}" r="${f(0.07 * k2)}" fill="${mixHex(col, "#ffffff", 0.5)}"/>`;
      else s += poly(star(0, 0.12 * k2, 0.42 * k2, 0.19 * k2, 5), col)
        + poly([[-0.22 * k2, -0.36 * k2], [-0.22 * k2, -0.56 * k2], [-0.11 * k2, -0.46 * k2], [0, -0.62 * k2], [0.11 * k2, -0.46 * k2], [0.22 * k2, -0.56 * k2], [0.22 * k2, -0.36 * k2]], col);
      if (tier >= 1 && tier <= 15) {
        const pips = (tier - 1) % 3 + 1, gap = 0.2 * k2, start = -(pips - 1) * gap / 2;
        for (let i = 0; i < pips; i++) { const x = start + i * gap; s += poly([[x - 0.07 * k2, 0.5 * k2], [x, 0.42 * k2], [x + 0.07 * k2, 0.5 * k2], [x, 0.58 * k2]], col); }
      }
    }
    const el = document.createElement("span");
    el.className = "rk-emblem";
    el.innerHTML = `<svg viewBox="-1 -1 2 2" width="${size}" height="${size}" aria-hidden="true">${s}</svg>`;
    return el;
  }

  // the boards of the two ladders, 4K and 7K (a minute's cache each: they change as matches end)
  let rankedMode = 4;
  const rankedBoards = { 4: null, 7: null }, rankedBoardsAt = { 4: 0, 7: 0 }, rankedLoads = { 4: null, 7: null };
  function loadRankedBoard(mode = rankedMode) {
    if (rankedBoards[mode] && Date.now() - rankedBoardsAt[mode] < 60_000) return Promise.resolve(rankedBoards[mode]);
    rankedLoads[mode] ??= fetch(`${worker}/play/ranked/public-board${mode === 7 ? "?mode=7" : ""}`, { cache: "no-cache" })
      .then(async (r) => {
        const j = await r.json().catch(() => null);
        if (!r.ok || !j || !j.players) throw new Error((j && j.error) || `the server didn't answer (${r.status})`);
        rankedBoards[mode] = j; rankedBoardsAt[mode] = Date.now();
        return j;
      })
      .finally(() => { rankedLoads[mode] = null; });
    return rankedLoads[mode];
  }

  function rankedPage() {
    document.title = "OCTIVE Ranked";
    const stat = (label, attr) => h("div.stat", {}, h("span.stat-label", { text: label }), h("span.stat-value", { [attr]: true, text: "–" }));
    const col = (text, cls) => h("span" + (cls || ""), { role: "columnheader", text });
    const view = h("div.ranked-page", {},
      h("section.hero", {},
        h("div", {}, h("h1", { text: "Ranked" }),
          h("p.sub", { text: "1v1 matches in OCTIVE 2.0, best of 3, on a 4K and a 7K ladder: climb from Contender to Legend. Everyone placed this season, best first." })),
        h("div.hero-side", {}, stat("Season", "data-rk-season"), stat("Placed", "data-rk-count"), stat("Season ends", "data-rk-ends"))),
      h("nav.rk-tabs.rk-modes", { "aria-label": "Ladder" }, ...[4, 7].map((m) => h("button.ws-tab" + (m === rankedMode ? ".on" : ""),
        { type: "button", "aria-pressed": String(m === rankedMode), onclick: () => { if (rankedMode !== m) { rankedMode = m; rankedPage(); } } }, `${m}K ladder`))),
      // (3.2) the ranks as a ladder, lowest first, with how many players are on each this season
      h("ol.rk-ladder", { "aria-label": "The ranks, lowest first" }, ...RK_GROUPS.map(([name, t, stars]) =>
        h("li.rk-step", { title: `${name}: charts around ${stars}`, style: `--rc:${RK_COLORS[rkGroup(t)]}` },
          rankEmblem(t >= 16 ? t : t + 2, 44),
          h("span.rk-step-name", { text: name }),
          h("small", { text: stars }),
          h("b.rk-step-n", { "data-rk-n": String(rkGroup(t)), text: "–" })))),
      h("div.notice", { "data-rk-error": true, hidden: true }),
      h("div.t3-wrap", { "data-rk-podium": true, hidden: true }),
      h("div.table.ranked-table", { role: "table", "aria-label": "Ranked board" },
        h("div.thead", { role: "row" }, col("Rank"), col("Player"), col("Division", ".num"), col("Matches", ".num.hide-sm"), col("Win rate", ".num.hide-sm"), col("Progress", ".num")),
        h("div", { "data-rows": true }, h("p.empty", { text: "Loading the ranked board…" }))));
    app.replaceChildren(view);
    const mode = rankedMode;
    loadRankedBoard(mode).then((b) => { if (page() === "ranked" && view.isConnected && mode === rankedMode) fillRanked(view, b); }).catch((e) => {
      if (page() !== "ranked" || !view.isConnected) return;
      const n = view.querySelector("[data-rk-error]");
      n.textContent = "The ranked board couldn't be loaded right now: " + (e.message || e);
      n.hidden = false;
      view.querySelector("[data-rows]").replaceChildren();
    });
  }

  function fillRanked(view, b) {
    const list = b.players || [];
    view.querySelector("[data-rk-season]").textContent = String(b.season ?? "–");
    view.querySelector("[data-rk-count]").textContent = fmt0.format(b.total ?? list.length);
    const left = (b.ends || 0) - Date.now();
    view.querySelector("[data-rk-ends]").textContent = !b.ends ? "–" : left <= 0 ? "now" : left >= 2 * 86400e3 ? `in ${Math.floor(left / 86400e3)} days` : left >= 3600e3 ? `in ${Math.floor(left / 3600e3)} h` : "soon";
    const rows = view.querySelector("[data-rows]");
    rows.replaceChildren();
    // how many players are on each rank
    const per = new Map();
    for (const x of list) per.set(rkGroup(x.tier), (per.get(rkGroup(x.tier)) || 0) + 1);
    view.querySelectorAll("[data-rk-n]").forEach((el) => {
      const n = per.get(Number(el.dataset.rkN)) || 0;
      el.textContent = n ? `${fmt0.format(n)} player${n === 1 ? "" : "s"}` : "nobody yet";
      el.closest(".rk-step").classList.toggle("none", !n);
    });
    if (!list.length) { rows.append(h("p.empty", { text: "Nobody is placed this season yet: play your three placement songs in OCTIVE 2.0 to be the first." })); return; }
    // the same rows as the global ranking: picture, name, badges, supporter look
    const byId = new Map(((data && data.players) || []).map((p) => [p.id, p]));
    // (3.2) the top three on cards, with their rank's emblem and colour
    const podium = view.querySelector("[data-rk-podium]");
    const t3 = topThree(list.slice(0, 3).map((x, i) => {
      const wins = x.wins || 0, games = wins + (x.losses || 0), pct = Math.max(0, Math.min(100, x.progress || 0));
      return t3Player(byId.get(x.id) || { id: x.id, name: x.name }, { place: x.place, color: RK_COLORS[rkGroup(x.tier)],
        value: (x.rank || RK_NAMES[x.tier] || "") + (x.legend ? " #" + x.legend : ""), extra: rankEmblem(x.tier, i === 0 ? 64 : 46),
        sub: `${fmt0.format(wins)}W ${fmt0.format(x.losses || 0)}L${games ? " · " + Math.round(100 * wins / games) + "% won" : ""}`,
        note: x.tier >= 17 ? "ordered by rating" : `${pct}% to ${RK_NAMES[x.tier + 1] || "the next rank"}`,
        stats: [["Matches", fmt0.format(games)], ["Wins", fmt0.format(wins)], ["Win rate", games ? Math.round(100 * wins / games) + "%" : "–"]] });
    }));
    podium.replaceChildren(...(t3 ? [t3] : []));
    podium.hidden = !t3;
    view.querySelector(".ranked-table").hidden = list.length <= 3;
    for (const x of list.slice(3)) {
      const known = byId.get(x.id);
      const p = known || { id: x.id, name: x.name };
      const r = clone("tpl-row").firstElementChild;
      r.href = profileHref(x.id);
      r.dataset.place = String(x.place);
      r.querySelector(".rank").textContent = "#" + fmt0.format(x.place);
      nameInto(r.querySelector(".name"), p);
      addLbIcon(r.querySelector(".name"), x.id);
      setAvatar(r.querySelector(".avatar"), p);
      setRole(r, r.querySelector(".badge"), p);
      if (isSupporter(p)) { r.classList.add("supporter"); const pill = supporterPill(p); pill.classList.add("rank"); r.querySelector(".player").append(pill); }
        else if (wasSupporter(p)) { const pill = supporterPill(p); pill.classList.add("rank"); r.querySelector(".player").append(pill); } // the badge they earned stays
      {
        const player = r.querySelector(".player"), nameEl = r.querySelector(".name");
        const who = h("span.who"), tags = h("span.tags");
        nameEl.replaceWith(who);
        who.append(nameEl, tags);
        for (const el of [...player.children]) if (el.matches(".badge, .sup-pill")) tags.append(el);
        const gp = gifterPill(p);
        if (gp) tags.append(gp);
        if (![...tags.children].some((el) => !el.hidden)) tags.remove();
      }
      const color = RK_COLORS[rkGroup(x.tier)];
      const div = r.querySelector(".acc");
      div.classList.add("rk-cell");
      div.style.color = color;
      div.replaceChildren(rankEmblem(x.tier, 28), h("span.rk-name", { text: (x.rank || RK_NAMES[x.tier] || "") + (x.legend ? " #" + x.legend : "") }));
      div.title = (x.rank || RK_NAMES[x.tier] || "") + (x.legend ? " #" + x.legend : "");
      const games = (x.wins || 0) + (x.losses || 0);
      r.querySelector(".lvl").textContent = `${fmt0.format(x.wins || 0)}W ${fmt0.format(x.losses || 0)}L`;
      r.querySelector(".plays").textContent = games ? Math.round(100 * (x.wins || 0) / games) + "%" : "–";
      const pr = r.querySelector(".pp");
      const pct = Math.max(0, Math.min(100, x.progress || 0));
      pr.replaceChildren(x.tier >= 17 ? h("span.rk-legend", { text: "rating" + (x.legend ? " #" + x.legend : "") })
        : h("span.rk-prog", {}, h("span.rk-prog-bar", {}, h("span.rk-prog-fill", { style: `width:${pct}%;background:${color}` })), h("span", { text: pct + "%" })));
      pr.title = x.tier >= 17 ? "Legends are ordered by their rating" : `${pct}% of the way to ${RK_NAMES[x.tier + 1] || "the next rank"}`;
      rows.append(r);
    }
  }

  // ---- the points shop's looks: titles and showcases (the same list the game uses)
  let cosmeticsLoad = null;
  function loadCosmetics() {
    if (!cosmeticsLoad) cosmeticsLoad = Promise.all([
      fetch(`${worker}/play/cosmetics`, { cache: "no-cache" }).then((r) => r.ok ? r.json() : null).catch(() => null),
      fetch(`${worker}/play/shop?all=1`, { cache: "no-cache" }).then((r) => r.ok ? r.json() : null).catch(() => null),
    ]).then(([c, shop]) => {
      const titles = {}, icons = {}, colors = {};
      for (const it of (shop && shop.items) || []) {
        if (it.kind === "title") titles[it.id] = it.name;
        else if (it.kind === "icon") icons[it.id] = it;
        else if (it.kind === "iconcolor") colors[it.id] = it;
      }
      return { players: (c && c.players) || {}, titles, icons, colors };
    });
    return cosmeticsLoad;
  }

  // ---- leaderboard icons from the points shop: a shape before the name, white or in the player's icon colour
  // (the same shapes the game draws)
  const LB_SHAPES = {
    star: '<path fill="currentColor" d="M12 2.6l2.9 6 6.6.8-4.9 4.5 1.3 6.6L12 17.3l-5.9 3.2 1.3-6.6-4.9-4.5 6.6-.8z"/>',
    heart: '<path fill="currentColor" d="M12 20.5s-7.6-4.6-9.4-9.3C1.4 8 3.4 4.5 6.8 4.5c2 0 3.4 1.1 5.2 3.1 1.8-2 3.2-3.1 5.2-3.1 3.4 0 5.4 3.5 4.2 6.7-1.8 4.7-9.4 9.3-9.4 9.3z"/>',
    note: '<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M9 17.5V5.2l10.5-2v12"/><circle fill="currentColor" cx="6.3" cy="17.6" r="3"/><circle fill="currentColor" cx="16.8" cy="15.4" r="3"/>',
    shield: '<path fill="currentColor" d="M12 2.2l8 3v6.1c0 5-3.4 9.1-8 10.6-4.6-1.5-8-5.6-8-10.6V5.2z"/>',
    tapnote: '<rect fill="currentColor" x="2.5" y="8.5" width="19" height="7" rx="3.5"/>',
    holdnote: '<rect fill="currentColor" opacity=".5" x="7.5" y="2.5" width="9" height="14" rx="1.5"/><rect fill="currentColor" x="2.5" y="14.5" width="19" height="7" rx="3.5"/>',
    keyboard: '<rect fill="none" stroke="currentColor" stroke-width="2" x="2" y="5.5" width="20" height="13" rx="2.5"/><path fill="currentColor" d="M5.5 9h2v2h-2zM9 9h2v2H9zM12.5 9h2v2h-2zM16 9h2.5v2H16zM7 14.5h10v1.8H7z"/>',
    mic: '<rect fill="currentColor" x="8.5" y="2" width="7" height="12" rx="3.5"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M5 11a7 7 0 0 0 14 0M12 18v3.5M8.5 21.5h7"/>',
    palette: '<path fill="currentColor" fill-rule="evenodd" d="M12 3a9 9 0 1 0 0 18c1.5 0 2-1 2-2 0-1.5-1-2 0-3s3 0 5-1 2-4 2-4c0-4.5-4-8-9-8zM7.5 12.2a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6zm3.5-4a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6zm5 1.6a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6z"/>',
    globe: '<circle fill="none" stroke="currentColor" stroke-width="2" cx="12" cy="12" r="9"/><path fill="none" stroke="currentColor" stroke-width="1.8" d="M3 12h18M12 3c3.2 3.2 3.2 14.8 0 18M12 3c-3.2 3.2-3.2 14.8 0 18"/>',
  };
  function lbIconEl(id, cz) {
    const e = cz && cz.players && cz.players[id];
    const it = e && e.icon && cz.icons[e.icon];
    if (!it) return null;
    const col = e.iconColor ? cz.colors[e.iconColor] : null;
    const s = document.createElement("span");
    s.className = "lb-icon" + (col && col.anim === "rainbow" ? " rainbow" : "");
    s.title = it.name || "Leaderboard icon";
    s.setAttribute("aria-hidden", "true");
    s.innerHTML = `<svg viewBox="0 0 24 24">${LB_SHAPES[it.shape] || LB_SHAPES.star}</svg>`;
    if (col && col.anim !== "rainbow" && col.color) s.style.color = col.color;
    return s;
  }
  /** Puts the player's leaderboard icon in front of their name (once the shop's list is in). */
  function addLbIcon(nameEl, id) {
    if (!nameEl || !id || !worker) return;
    loadCosmetics().then((cz) => {
      nameEl.querySelector(".lb-icon")?.remove();
      const ic = lbIconEl(id, cz);
      if (ic) nameEl.prepend(ic);
    });
  }
  const JUDGEMENTS = [["Marvelous", "#9ef0ff"], ["Perfect", "#ffe08a"], ["Great", "#7ee39a"], ["Good", "#7fb6ff"], ["Bad", "#c79bff"], ["Miss", "#ff6b7a"]];
  function showcaseLink(s) {
    if (s.workshopId) return { href: `workshop/${encodeURIComponent(s.workshopId)}`, text: "View in the Workshop" };
    if (s.osuSet) return { href: `https://osu.ppy.sh/beatmapsets/${encodeURIComponent(s.osuSet)}`, text: "View on osu!", target: "_blank", rel: "noopener" };
    return null;
  }
  function coverStyle(el, url) { if (url) el.style.backgroundImage = `url("${String(url).replace(/["\\]/g, "")}")`; }
  function showcaseCard(s) {
    const pic = h("div.sc-pic");
    coverStyle(pic, s.cover);
    if (s.grade) pic.append(h("span.sc-grade", { text: s.grade }));
    const stats = h("div.sc-stats");
    if (s.score != null) stats.append(h("b", { text: fmt0.format(s.score) }));
    if (s.acc != null) stats.append(h("span", { text: fmt2.format(s.acc) + "%" }));
    if (s.pp != null) stats.append(h("span.sc-pr", { text: fmt0.format(s.pp) + " PR" }));
    const link = showcaseLink(s);
    const body = h("div.sc-body", {}, h("div.sc-title", { text: s.title || "Song" }), h("div.sc-diff", { text: s.difficulty || "" }), stats);
    if (s.mods) body.append(h("div.sc-mods", { text: s.mods }));
    if (link) { const a = h("a.sc-view", { href: link.href, target: link.target || null, rel: link.rel || null }, "View"); a.addEventListener("click", (e) => e.stopPropagation()); body.append(a); }
    const card = h("div.sc-card", { tabindex: "0", role: "button", title: "Details" }, pic, body);
    const open = () => showcaseDetails(s);
    card.addEventListener("click", open);
    card.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
    return card;
  }
  function showcaseDetails(s) {
    const onKey = (e) => { if (e.key === "Escape") close(); };
    const banner = h("div.scd-banner", {}, h("div.scd-shade"), h("div.scd-cap", {}, h("h2", { text: s.title || "Song" }),
      h("p", { text: [s.artist, s.difficulty, s.keys ? s.keys + "K" : null, s.stars ? "\u2605 " + fmt2.format(s.stars) : null].filter(Boolean).join("  \u00b7  ") })));
    if (s.grade) banner.append(h("span.scd-grade", { text: s.grade }));
    coverStyle(banner, s.cover);
    const tile = (label, value, cls) => h("div.scd-tile" + (cls || ""), {}, h("span", { text: label }), h("b", { text: value }));
    const tiles = h("div.scd-tiles"), judg = h("div.scd-judg", { hidden: true });
    // (2.2.2) painted again when a play's score and judgements arrive after the popup opened (see playsSection)
    const paint = () => {
      tiles.replaceChildren();
      if (s.score != null) tiles.append(tile("Score", fmt0.format(s.score)));
      else if (s.loading) tiles.append(tile("Score", "…"));
      if (s.acc != null) tiles.append(tile("Accuracy", fmt2.format(s.acc) + "%"));
      if (s.pp != null) tiles.append(tile("Rating", fmt0.format(s.pp) + " PR", ".pr"));
      if (s.maxCombo != null) tiles.append(tile("Max combo", fmt0.format(s.maxCombo) + "x" + (s.fullCombo ? "  FC" : ""), s.fullCombo ? ".fc" : ""));
      judg.replaceChildren();
      judg.hidden = !(Array.isArray(s.counts) && s.counts.length === 6);
      if (!judg.hidden) JUDGEMENTS.forEach(([n, c], i) => { const b = h("div", {}, h("span", { text: n }), h("b", { text: fmt0.format(s.counts[i] || 0) })); b.style.setProperty("--j", c); judg.append(b); });
    };
    paint();
    const box = h("div.scd-modal", { role: "dialog", "aria-modal": "true", "aria-label": "Showcase play" }, banner, tiles, judg);
    box.append(h("p.scd-mods", {}, h("span", { text: "Mods" }), s.mods ? s.mods : "None"));
    if (s.date && !isNaN(Date.parse(s.date))) box.append(h("p.scd-when", { text: "Played " + new Date(s.date).toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" }) }));
    const link = showcaseLink(s);
    const actions = h("div.scd-actions");
    if (link) actions.append(h("a.btn", { href: link.href, target: link.target || null, rel: link.rel || null }, link.text));
    const closeBtn = h("button.btn.ghost", { type: "button" }, "Close");
    actions.append(closeBtn);
    box.append(actions);
    const layer = h("div.modal-layer", {}, box);
    function close() { layer.remove(); document.removeEventListener("keydown", onKey); }
    closeBtn.addEventListener("click", close);
    layer.addEventListener("click", (e) => { if (e.target === layer) close(); });
    // a link inside closes the popup too (the Workshop opens on this site)
    box.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => { if (!a.target) close(); }));
    document.body.append(layer);
    document.addEventListener("keydown", onKey);
    return { update: (more) => { Object.assign(s, more, { loading: false }); paint(); } };
  }

  // (2.1) a profile laid out like a rhythm game profile usually is: a cover with the picture over its edge, the ranks
  // and a rank graph, a stats panel, the level, then everything else in sections
  const regionName = (() => { try { const dn = new Intl.DisplayNames(["en"], { type: "region" }); return (c) => { try { return dn.of(c); } catch { return c; } }; } catch { return (c) => c; } })();

  /** Global rank over the kept days (rank 1 at the top), with the day under the pointer. */
  function rankGraph(days) {
    const NS = "http://www.w3.org/2000/svg", W = 600, H = 80, pad = 6;
    const ranks = days.map((d) => d[3]);
    const lo = Math.min(...ranks), hi = Math.max(...ranks);
    const y = (r) => hi === lo ? H / 2 : pad + (r - lo) / (hi - lo) * (H - pad * 2);
    const x = (i) => i / (days.length - 1) * W;
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("preserveAspectRatio", "none"); svg.setAttribute("aria-hidden", "true");
    const defs = document.createElementNS(NS, "defs");
    defs.innerHTML = `<linearGradient id="pf-rank-line" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${W}" y2="0"><stop offset="0" stop-color="#a764ff"/><stop offset=".5" stop-color="#ff4d9d"/><stop offset="1" stop-color="#ffd23f"/></linearGradient>`
      + '<linearGradient id="pf-rank-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff4d9d" stop-opacity=".3"/><stop offset="1" stop-color="#ff4d9d" stop-opacity="0"/></linearGradient>';
    const pts = days.map((d, i) => `${x(i).toFixed(1)},${y(d[3]).toFixed(1)}`).join(" ");
    const area = document.createElementNS(NS, "polygon");
    area.setAttribute("points", `0,${H} ${pts} ${W},${H}`);
    const line = document.createElementNS(NS, "polyline");
    line.setAttribute("points", pts);
    line.setAttribute("vector-effect", "non-scaling-stroke");
    svg.append(defs, area, line);
    const dot = h("span.pf-dot", { hidden: true }), tip = h("span.pf-tip", { hidden: true });
    const box = h("div.pf-chart", { title: "Global rank, day by day" }, svg, dot, tip);
    const dayText = (s) => new Date(s + "T12:00:00Z").toLocaleDateString(undefined, { day: "numeric", month: "short" });
    box.addEventListener("pointermove", (e) => {
      const r = box.getBoundingClientRect();
      const i = Math.max(0, Math.min(days.length - 1, Math.round((e.clientX - r.left) / r.width * (days.length - 1))));
      const d = days[i], px = x(i) / W * r.width, py = y(d[3]) / H * r.height;
      dot.hidden = tip.hidden = false;
      dot.style.left = px + "px"; dot.style.top = py + "px";
      tip.textContent = `#${fmt0.format(d[3])} · ${fmt0.format(d[1])} PR · ${dayText(d[0])}`;
      tip.style.left = Math.max(0, Math.min(r.width - tip.offsetWidth, px - tip.offsetWidth / 2)) + "px";
    });
    box.addEventListener("pointerleave", () => { dot.hidden = tip.hidden = true; });
    return box;
  }

  // (3.0) answers the profile asks for more than once (plays, progress, Workshop picks), kept a few minutes so the page
  // can redraw (it does every 90 s while you're at the top) without asking the server again
  const jsonCache = new Map();
  function cachedJson(url, ttl = 300_000) {
    const hit = jsonCache.get(url);
    if (hit && Date.now() - hit.at < ttl) return hit.p;
    const p = fetch(url, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    jsonCache.set(url, { at: Date.now(), p });
    return p;
  }
  const playsOf = (id) => (worker ? cachedJson(`${worker}/play/plays?player=${encodeURIComponent(id)}`) : Promise.resolve(null));
  const progressOf = (id) => (worker ? cachedJson(`${worker}/play/progress?player=${encodeURIComponent(id)}`) : Promise.resolve(null));
  /** A profile's link to share (a supporter's own link when they have one). */
  async function profileLinkKey(p) {
    try { const d = await fetch(`${worker}/links/of/${encodeURIComponent(p.id)}`).then((r) => (r.ok ? r.json() : null)); if (d && d.link) return d.link; } catch { /* their id */ }
    return p.id;
  }
  const ICON = (paths) => { const s = document.createElement("span"); s.className = "ic"; s.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`; return s; };

  function player(id) {
    const p = findPlayer(id) || (linkIds[String(id).toLowerCase()] ? findPlayer(linkIds[String(id).toLowerCase()]) : null);
    // (2.2.2) a supporter's own link (u/Senterra): asked who it is once, then their profile shows at that address
    if (!p && worker && id && String(id).length <= 20 && !(String(id).toLowerCase() in linkIds)) {
      app.replaceChildren(h("p.empty", { text: "Loading…" }));
      fetch(`${worker}/links/${encodeURIComponent(id)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((d) => {
        linkIds[String(id).toLowerCase()] = (d && d.id) || "";
        if (profileKey() === id) player(id);
      });
      return;
    }
    if (!p) {
      app.innerHTML = '<a class="back" href="rankings">← All players</a><p class="empty">That player isn\'t in the ranking (yet).</p>';
      setTimeout(giftPopup, 400);
      return;
    }
    // (3.0) u/<player>?vs=<other>: the two side by side
    const vs = hashQuery().get("vs");
    if (vs != null) { comparePage(p, vs); return; }
    const official = isOfficial(p);
    const players = data ? data.players : [];
    setCrumb(p.name || "Player");

    // the head: cover, picture, name, country and crew
    const avatar = h("div.card-avatar", {}, h("img", { alt: "", hidden: true }), h("span.initial"), h("span.dot", { hidden: true }));
    const nameEl = h("h1.card-name");
    const nameRow = h("div.card-name-row", {}, nameEl, h("span.badge", { hidden: true }));
    const titleEl = h("div.card-title", { hidden: true });
    const sub = h("div.pf-sub", {}, p.country && /^[A-Z]{2}$/.test(p.country) ? h("a.pf-country", { href: "rankings?country=" + p.country, title: "Their country's ranking" }, h("span.flag-chip", { text: p.country }), regionName(p.country)) : null);
    const status = h("div.card-status");
    const card = h("article.card.pf-head", {}, h("div.pf-cover"), h("div.pf-id", {}, avatar, h("div.pf-idtext", {}, nameRow, titleEl, sub, status)));
    nameInto(nameEl, p);
    setAvatar(avatar, p);
    const role = setRole(card, nameRow.querySelector(".badge"), p);
    if (role) { titleEl.textContent = role.title; titleEl.hidden = false; }
    status.textContent = p.online ? "● " + statusText(p) : statusText(p);
    status.classList.toggle("on", !!p.online);
    if (official) {
      // its status line keeps changing while the page is open
      const tick = setInterval(() => { if (!status.isConnected) { clearInterval(tick); return; } status.textContent = "● " + statusText(p); }, 1000);
    }
    decorateCard(card, p);
    // (2.2.2) your own profile: a pencil on the picture (and on the banner, a supporter perk) to change it, shown when
    // the pointer is over it
    if (me && me.playerId === p.id && !me.banned && !official) {
      const pencil = (title, onPick) => {
        const b = h("button.pf-edit", { type: "button", title, "aria-label": title });
        b.innerHTML = PENCIL_SVG;
        b.addEventListener("click", async (e) => {
          e.preventDefault(); e.stopPropagation();
          if (b.classList.contains("busy")) return;
          const out = msg();
          b.classList.add("busy");
          try { await onPick(out); } finally { b.classList.remove("busy"); }
          if (out.textContent) toast(out.textContent);
        });
        return b;
      };
      if (!me.avatarLocked) avatar.append(pencil("Change your picture", async (out) => {
        const full = await newPicture(out);
        if (!full) return;
        const img = avatar.querySelector("img"); img.src = "data:image/jpeg;base64," + full; img.hidden = false;
        avatar.querySelector(".initial").hidden = true;
      }));
      if (me.supporter && me.supporter.active) card.querySelector(".pf-cover").append(pencil("Change your banner", async (out) => {
        const b64 = await newBanner(out);
        if (!b64) return;
        card.style.setProperty("--banner", `url("data:image/jpeg;base64,${b64}")`);
        card.classList.add("has-banner");
      }));
    }
    // (2.2.2) the link to share: it shows their card (rank, PR, accuracy) where it's pasted, like Discord
    const shareBtn = h("button.pf-act", { type: "button", title: "Copy a link to this profile. Pasted in Discord (and other apps) it shows a card with their stats." },
      ICON('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'), h("span", { text: "Share" }));
    shareBtn.addEventListener("click", async () => {
      const url = shareLink(await profileLinkKey(p));
      try { await navigator.clipboard.writeText(url); toast("Link copied. Paste it in Discord to show their card."); }
      catch { prompt("Copy this link:", url); }
    });
    // (3.0) their card as a picture for forums, READMEs and stream panels
    const embedBtn = h("button.pf-act", { type: "button", title: "Their card as a picture: a link, Markdown, BBCode or HTML", onclick: () => embedModal(p) },
      ICON('<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>'), h("span", { text: "Embed" }));
    // (3.0) the two side by side: you and them when you're signed in, else pick someone
    const vsKey = me && me.playerId && me.playerId !== p.id && findPlayer(me.playerId) ? me.playerId : "";
    const compareBtn = h("a.pf-act.pf-act-vs", { href: profileHref(p.id) + "?vs=" + encodeURIComponent(vsKey), title: vsKey ? "Compare them with you" : "Compare them with another player" },
      ICON(QS_ICON.vs), h("span", { text: vsKey ? "Compare with you" : "Compare" }));
    // (2.0.2) their crew, a link to its page
    loadCosmetics().then((cs) => {
      const cr = cs && cs.players && cs.players[p.id] && cs.players[p.id].crew;
      if (!cr || !cr.id || !card.isConnected) return;
      sub.append(h("a.crew-chip", { href: "crew/" + encodeURIComponent(cr.id), title: "Their crew" }, crewTag(cr), h("span", { text: "Crew →" })));
    });

    // (3.0) their place, big, in the head: the world and their country, like the Discord card
    const ranked = players.filter((x) => !isOfficial(x));
    const countryRank = p.country ? ranked.filter((x) => x.country === p.country).sort((a, b) => a.rank - b.rank).findIndex((x) => x.id === p.id) + 1 : 0;
    const topPct = !official && ranked.length ? Math.max(1, Math.ceil(p.rank / ranked.length * 100)) : 0;
    const rankBox = (label, value, col, extra) => h("div.pf-rk", { style: `--s:${col}` }, h("small", { text: label }), h("b", { text: value }), extra || null);
    const ranks = h("div.pf-ranks", {},
      rankBox("Global rank", official ? INF : "#" + fmt0.format(p.rank), "var(--yellow)", topPct ? h("span.pf-top", { text: `Top ${topPct}%` }) : null),
      countryRank > 0 && !official ? rankBox("Country rank", "#" + fmt0.format(countryRank), "var(--cyan)", h("span.pf-top", { text: regionName(p.country) })) : null);
    card.querySelector(".pf-id").append(ranks);

    // the numbers, in one row of tiles
    const achN = h("small.prof-tab-n", { text: fmt0.format(Object.keys(p.achievements || {}).length) });
    // (2.2.2) achievements count the ones the game has now, like the achievements section
    if (!official) loadAchDefs().then((defs) => { if (defs.length) achN.textContent = fmt0.format(defs.filter((d) => (p.achievements || {})[d.id]).length); });
    const tile = (label, value, col) => h("div.pf-tile", { style: `--s:${col}` }, h("small", { text: label }), typeof value === "string" ? h("b", { text: value }) : value);
    const strip = h("section.pf-strip", {},
      tile("Performance", official ? INF + " PR" : fmt0.format(p.pp || 0) + " PR", "var(--pink)"),
      tile("Accuracy", official ? "100.00%" : fmt2.format(p.accuracy || 0) + "%", "var(--cyan)"),
      tile("Play count", official ? INF : fmt0.format(p.playCount || 0), "var(--green)"),
      tile("Play time", official ? INF : p.playTimeMs ? playTime(p.playTimeMs) : "—", "var(--orange)"),
      tile("Max combo", official ? INF + "x" : p.maxCombo ? fmt0.format(p.maxCombo) + "x" : "—", "var(--yellow)"),
      // (3.2) the level here (the graph and the level box are on the Stats tab now)
      tile("Level", h("span.pf-tlv", { title: official ? "Max level" : `${fmt0.format(Math.round((xpFor((p.level || 1) + 1) - xpFor(p.level || 1)) * (1 - Math.max(0, Math.min(1, p.levelProgress || 0)))))} xp to level ${(p.level || 1) + 1}` },
        h("b", { text: official ? "1000" : String(p.level || 1) }),
        h("i.pf-tlvbar", {}, h("i", { style: `width:${official ? 100 : Math.round(Math.max(0, Math.min(1, p.levelProgress || 0)) * 100)}%` }))), "var(--purple)"));

    // the graph, and the level beside it
    const graph = h("div.pf-graph");
    const lv = official ? 1000 : (p.level || 1);
    const prog = official ? 1 : Math.max(0, Math.min(1, p.levelProgress || 0));
    const toNext = Math.round((xpFor(lv + 1) - xpFor(lv)) * (1 - prog));
    const level = h("div.pf-level", { title: official ? "Max level" : `${fmt0.format(toNext)} xp to level ${lv + 1}` },
      h("div.pf-oct", {}, h("span", { text: String(lv) })),
      h("div.pf-lvtext", {}, h("small", { text: "Level" }), h("b", { text: official ? "Max level" : `${fmt0.format(toNext)} xp to level ${lv + 1}` })),
      h("div.pf-lvbar", {}, h("div.pf-lvfill", { style: `width:${Math.round(prog * 100)}%` }), h("span", { text: Math.round(prog * 100) + "%" })));
    const row = (label, value) => h("div", {}, h("dt", { text: label }), h("dd", { text: value }));
    const panel = h("dl.pf-panel", {},
      row("Total score", official ? INF : fmt0.format(p.totalScore || 0)),
      row("Full combos", official ? INF : fmt0.format(p.fullCombos || 0)),
      row("Experience", official ? INF : fmt0.format(p.xp || 0)));
    const stats = h("section.pf-stats", {}, h("div.pf-main", {}, graph), h("div.pf-lvcol", {}, level, panel));
    const skillsSlot = h("div.pf-skills-slot");
    let skillsAsked = false;
    if (worker && !official) {
      progressOf(p.id).then((d) => {
        const days = ((d && d.days) || []).filter((x) => Array.isArray(x) && x[3] > 0).slice(-90);
        graph.replaceChildren(days.length >= 2 ? progressGraphs(days) : h("p.pf-graph-none", { text: "The graphs fill in after a couple of days on the ranking." }));
        const sk = d && d.skills;
        skillsAsked = true;
        if (sk && (sk.axes || []).length >= 3 && sk.plays > 0) skillsSlot.replaceChildren(skillsSection(sk));
      });
    } else graph.replaceChildren(h("p.pf-graph-none", { text: official ? "The official OCTIVE account isn't ranked." : "" }));

    // followers and their links; their linked Discord and live box sit in the head
    const dcSlot = h("div.pf-discord");
    card.querySelector(".pf-id").append(h("div.pf-side", {}, h("div.pf-liveslot"), h("div.pf-acts", {}, worker && !official ? shareBtn : null, worker && !official ? embedBtn : null, !official ? compareBtn : null), dcSlot));
    const social = socialRow(p, (s) => markLive(card, avatar, s.twitch), dcSlot);
    const bar = h("section.pf-bar", {}, social);

    // (3.2) the profile in tabs, so it isn't one long scroll (the user: "it requires too much scrolling"): Profile (about,
    // showcase, their five best plays, rivals), Plays, Stats (skills and play stats), Achievements (with their support),
    // Workshop (what they shared), and who they follow / are followed by / are friends with. "Charts for them" is gone (the
    // user didn't like it).
    const mainCol = h("div.pf-col-main"), sideCol = h("aside.pf-col-side");
    const overview = h("div.prof-overview.pf-two", {}, mainCol, sideCol);
    if (p.devFriend && !ROLES[p.id]) mainCol.append(h("div.devfriend", {}, h("span.heart", { text: "♥" }), " Friends with DEV ", h("span.devfriend-sub", { text: "· friends with the developer of OCTIVE" })));
    if (p.bio && p.bio.trim()) {
      const text = h("p.bio-text");
      renderBio(text, p.bio);
      mainCol.append(h("section.bio", {}, h("h2", { text: "About me" }), text));
    }
    // the title bought in the points shop (under the name) and the showcase
    const showcase = h("section.showcase", { hidden: true }, h("h2", { text: "Showcase" }), h("div.sc-row"));
    mainCol.append(showcase);
    // their five best plays here; every play on the Plays tab
    if (!official) mainCol.append(playsSection(p, { limit: 5, more: () => { openTab("plays"); tabs.scrollIntoView({ behavior: "smooth", block: "start" }); } }));
    loadCosmetics().then((cz) => {
      const mine = cz.players[p.id] || {};
      const title = mine.title && cz.titles[mine.title];
      if (title) nameRow.after(h("div.shop-title", { text: title }));
      if (official) return;
      const songs = (mine.showcase || []).filter((x) => x && x.kind !== "ach").slice(0, 3);
      if (!mine.hasShowcase && !songs.length) return; // they haven't unlocked one
      const scRow = showcase.querySelector(".sc-row");
      for (let i = 0; i < 3; i++) scRow.append(songs[i] ? showcaseCard(songs[i]) : h("div.sc-empty", { text: "Empty" }));
      showcase.hidden = false;
    });
    if (!official) { const rv = rivalsSection(p); if (rv) sideCol.append(rv); }
    if (!mainCol.children.length && !sideCol.children.length) mainCol.append(h("p.empty", { text: "Nothing here yet." }));
    // what they shared to the Workshop (asked for now, so its tab can say how many)
    const uploads = worker && !official ? cachedJson(`${worker}/api/items?creator=${encodeURIComponent(p.id)}`) : Promise.resolve(null);
    // the other tabs are made the first time they're opened
    const makers = {
      plays: () => playsSection(p),
      stats: () => {
        const none = h("p.empty.pf-stats-none", { text: "Their stats show up after a few plays on the ranking.", hidden: true });
        const ps = playStatsSection(p);
        const box = h("div.pf-stats-wrap", {}, stats, h("div.pf-two.pf-stats-tab", {}, h("div.pf-col-main", {}, skillsSlot, none), h("aside.pf-col-side", {}, ps)));
        setTimeout(() => { none.hidden = !(skillsAsked && !skillsSlot.children.length && ps.hidden); }, 2500);
        return box;
      },
      achievements: () => h("div.pf-ach-tab", {}, supporterSection(p) || "", achievementsSection(p)),
      workshop: () => pfWorkshop(p, uploads),
    };
    const built = {};
    const pane = h("div.prof-pane");
    const tabBtns = {};
    const TABS = [["overview", "Profile"], ...(official ? [] : [["plays", "Plays"], ["stats", "Stats"]]), ["achievements", "Achievements"], ...(official ? [] : [["workshop", "Workshop"]]),
      ["followers", "Followers"], ["following", "Following"], ["friends", "Friends"]];
    const tabs = h("nav.prof-tabs", { role: "tablist", "aria-label": "Profile" }, ...TABS.map(([k, label]) =>
      (tabBtns[k] = h("button.prof-tab", { type: "button", role: "tab", onclick: () => openTab(k) }, label))));
    if (!official) tabBtns.achievements.append(achN);
    uploads.then((d) => { const n = ((d && d.items) || []).length; if (n && tabBtns.workshop) tabBtns.workshop.append(h("small.prof-tab-n", { text: fmt0.format(n) })); });
    function openTab(k) {
      for (const [key, b] of Object.entries(tabBtns)) { b.classList.toggle("active", key === k); b.setAttribute("aria-selected", String(key === k)); }
      if (k === "overview") pane.replaceChildren(overview);
      else if (makers[k]) { built[k] = built[k] || makers[k](); pane.replaceChildren(built[k]); }
      else pane.replaceChildren(peopleList(p, k));
    }
    openTab("overview");
    social.addEventListener("open-list", (e) => { openTab(e.detail); tabs.scrollIntoView({ behavior: "smooth", block: "start" }); });
    app.replaceChildren(h("a.back", { href: "rankings" }, "← All players"), h("div.pf", {}, card, strip, bar), tabs, pane);
    document.title = `${p.name} · OCTIVE`;
    setTimeout(giftPopup, 400);
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------- 3.0: rivals, play stats and charts picked for a player
  /** The players just above and below on the ranking, how far apart they are, and where this player stands. */
  function rivalsSection(p) {
    const list = (data ? data.players : []).filter((x) => !isOfficial(x));
    const i = list.findIndex((x) => x.id === p.id);
    if (i < 0 || list.length < 2) return null;
    const n = list.length;
    const pct = Math.max(1, Math.ceil(p.rank / n * 100));
    const near = list.slice(Math.max(0, i - 2), Math.min(n, i + 3));
    const above = i > 0 ? list[i - 1] : null;
    const pace = h("p.rv-pace");
    const rowsEl = h("div.rv-list", {}, ...near.map((x) => {
      const self = x.id === p.id;
      const gap = (x.pp || 0) - (p.pp || 0);
      const txt = self ? "" : gap > 0 ? `+${fmt0.format(Math.max(1, Math.ceil(gap)))}` : `−${fmt0.format(Math.ceil(-gap))}`;
      const rowEl = h(self ? "div.rv-row.self" : "a.rv-row", self ? {} : { href: profileHref(x.id) },
        h("span.rv-rank", { text: "#" + fmt0.format(x.rank) }), smallAvatar(x.id, x.name, x.avatarHash),
        h("span.rv-name", {}, h("b", { text: x.name || "Player" }), h("small", { text: fmt0.format(x.pp || 0) + " PR" })),
        self ? h("span.rv-you", { text: "here" }) : h("span.rv-gap" + (gap > 0 ? ".up" : ".down"), { text: txt, title: gap > 0 ? `${p.name} needs ${fmt0.format(Math.max(1, Math.ceil(gap)))} PR more to pass them` : `${fmt0.format(Math.ceil(-gap))} PR behind ${p.name}` }));
      return h("div.rv-item", {}, rowEl, self ? null : h("a.rv-vs", { href: profileHref(p.id) + "?vs=" + encodeURIComponent(x.id), title: `Compare ${p.name} and ${x.name}` }, "vs"));
    }));
    const box = h("section.pf-rivals.side-card", {},
      h("div.side-card-head", {}, h("h2", { text: "Rivals" }), h("span.rv-pct", { text: p.rank === 1 ? "#1 in the world" : `Top ${pct}%` })),
      h("p.rv-sub", { text: `#${fmt0.format(p.rank)} of ${fmt0.format(n)} ranked players · PR gap beside each` }),
      rowsEl, pace);
    // at this week's pace, when would they pass the next one up?
    if (above) progressOf(p.id).then((d) => {
      const days = ((d && d.days) || []).filter((x) => Array.isArray(x) && x[1] > 0);
      if (days.length < 2 || !pace.isConnected) return;
      const last = days[days.length - 1], weekAgo = days[Math.max(0, days.length - 8)];
      const span = Math.max(1, Math.round((Date.parse(last[0]) - Date.parse(weekAgo[0])) / 86400000));
      const perDay = ((last[1] || 0) - (weekAgo[1] || 0)) / span;
      const gap = (above.pp || 0) - (p.pp || 0);
      if (perDay <= 0.5) { pace.textContent = "No PR gained in the last week."; return; }
      const dd = Math.ceil(gap / perDay);
      pace.replaceChildren("At this week's pace ", h("b", { text: `(+${fmt0.format(perDay)} PR a day)` }), `, ${above.name} is about ${dd <= 1 ? "a day" : fmt0.format(dd) + " days"} away.`);
    });
    return box;
  }

  /** SS/S/A… counts, and how their best plays spread over star ratings and accuracy (from every chart's best play). */
  function playStatsSection(p) {
    const box = h("section.pf-pstats.side-card", { hidden: true });
    playsOf(p.id).then((d) => {
      const top = (d && d.top) || [];
      if (!top.length) return;
      const grades = ["SS", "S", "A", "B", "C", "D"];
      const count = (g) => top.filter((t) => t.grade === g).length;
      const fcs = top.filter((t) => t.fc).length;
      const starB = Array.from({ length: 10 }, (_, i) => top.filter((t) => Math.min(9, Math.floor(Number(t.stars) || 0)) === i).length);
      const firstStar = Math.max(0, starB.findIndex((c) => c > 0)), lastStar = 9 - [...starB].reverse().findIndex((c) => c > 0);
      const accB = [[99, 100.01, "99%+"], [98, 99, "98–99%"], [97, 98, "97–98%"], [95, 97, "95–97%"], [90, 95, "90–95%"], [0, 90, "under 90%"]].map(([lo, hi, label]) =>
        [label, top.filter((t) => (Number(t.acc) || 0) >= lo && (Number(t.acc) || 0) < hi).length]);
      const maxStar = Math.max(1, ...starB), maxAcc = Math.max(1, ...accB.map((x) => x[1]));
      const avgAcc = top.reduce((s, t) => s + (Number(t.acc) || 0), 0) / top.length;
      box.replaceChildren(
        h("div.side-card-head", {}, h("h2", { text: "Play stats" }), h("span.ps-n", { text: `${fmt0.format(top.length)} charts` })),
        h("div.ps-grades", {}, ...grades.map((g) => h("div.ps-grade", { style: `--g:${GRADE_COL[g]}` }, h("b", { text: g }), h("span", { text: fmt0.format(count(g)) })))),
        h("p.ps-line", {}, h("b", { text: fmt0.format(fcs) }), ` full combo${fcs === 1 ? "" : "s"} · `, h("b", { text: fmt2.format(avgAcc) + "%" }), " average accuracy"),
        h("h3.ps-cap", { text: "Star ratings" }),
        h("div.ps-stars", {}, ...starB.slice(firstStar, lastStar + 1).map((c, k) => {
          const st = firstStar + k;
          return h("div.ps-col", { title: `${c} chart${c === 1 ? "" : "s"} at ${st}–${st + 1}★` },
            h("span.ps-colbar", {}, h("i", { style: `height:${Math.max(c ? 8 : 0, Math.round(c / maxStar * 100))}%;background:${starColor(st + 0.5)}` })),
            h("small", { text: st + "★" }), h("b", { text: String(c) }));
        })),
        h("h3.ps-cap", { text: "Accuracy" }),
        h("div.ps-acc", {}, ...accB.map(([label, c]) => h("div.ps-arow", {}, h("span", { text: label }), h("span.ps-abar", {}, h("i", { style: `width:${Math.round(c / maxAcc * 100)}%` })), h("b", { text: String(c) })))));
      box.hidden = false;
    });
    return box;
  }

  /** (3.2) A profile's Workshop tab: everything they shared, newest first, as the Workshop's cards (one kind at a time
   *  when they shared several kinds). */
  function pfWorkshop(p, uploads) {
    const box = h("section.pf-ws", {}, h("div.wk-grid", {}, ...wkGhosts(2)));
    uploads.then((d) => {
      const items = ((d && d.items) || []).slice().sort((x, y) => (y.at || 0) - (x.at || 0));
      if (!items.length) {
        box.replaceChildren(h("div.wk-empty", {}, h("b", { text: "Nothing shared yet" }), h("p", { text: "When they share a chart, skin, theme or style from the game, it shows up here." })));
        return;
      }
      const kinds = WS_TYPES.filter(([t]) => items.some((it) => it.type === t));
      let kind = "";
      const grid = h("div.wk-grid");
      const chips = h("div.pf-ws-kinds");
      const paint = () => {
        chips.replaceChildren(...(kinds.length > 1 ? [["", "All"], ...kinds].map(([t, name]) =>
          h("button.wk-chip" + (kind === t ? ".on" : ""), { type: "button", "aria-pressed": String(kind === t), onclick: () => { kind = t; paint(); } },
            `${name} · ${fmt0.format(t ? items.filter((it) => it.type === t).length : items.length)}`)) : []));
        grid.replaceChildren(...items.filter((it) => !kind || it.type === kind).map(wkCard));
      };
      paint();
      const likes = items.reduce((n, it) => n + (it.likes || 0), 0), dls = items.reduce((n, it) => n + (it.downloads || 0), 0);
      box.replaceChildren(
        h("div.pf-ws-head", {}, h("h2.section-title", { text: "Workshop" }),
          h("span.pf-ws-sum", { text: `${fmt0.format(items.length)} shared · ${fmt0.format(dls)} download${dls === 1 ? "" : "s"} · ♥ ${fmt0.format(likes)}` }), chips),
        grid);
    });
    return box;
  }

  // ---------------------------------------------------------------- 3.0: a profile's card as a picture (forums, READMEs, stream panels)
  async function embedModal(p) {
    const close = () => { layer.remove(); document.removeEventListener("keydown", esc); };
    const esc = (e) => { if (e.key === "Escape") close(); };
    const pic = `${worker}/card/${encodeURIComponent(p.id)}.png`;
    const rows = h("div.embed-rows", {}, h("p.empty", { text: "…" }));
    const shot = h("div.embed-pic");
    shot.append(waitPic(shot, h("img", { src: pic, alt: `${p.name}'s OCTIVE card`, width: 600, height: 300 })));
    const layer = h("div.modal-layer", { onmousedown: (e) => { if (e.target === layer) close(); } },
      h("div.embed-modal", { role: "dialog", "aria-modal": "true", "aria-label": "Embed this profile" },
        h("div.embed-head", {}, h("div", {}, h("p.eyebrow", { text: "Embed" }), h("h2", { text: `${p.name}'s card, anywhere` })), h("button.btn.small.ghost", { type: "button", onclick: close }, "Close")),
        h("p.embed-sub", { text: "The picture keeps itself up to date: the rank, PR and accuracy change on it as they play. Paste it in a forum signature, a GitHub README or a Twitch panel." }),
        shot, rows));
    document.body.append(layer);
    document.addEventListener("keydown", esc);
    const link = shareLink(await profileLinkKey(p));
    const name = String(p.name || "Player").replace(/[[\]<>"]/g, "");
    const codes = [["Link", link], ["Picture", pic], ["Markdown", `[![${name} on OCTIVE](${pic})](${link})`],
      ["BBCode", `[url=${link}][img]${pic}[/img][/url]`], ["HTML", `<a href="${link}"><img src="${pic}" alt="${name} on OCTIVE" width="600"></a>`]];
    rows.replaceChildren(...codes.map(([label, value]) => {
      const input = h("input.embed-code", { readonly: true, value, "aria-label": label, onfocus: (e) => e.currentTarget.select() });
      const btn = h("button.btn.small", { type: "button" }, "Copy");
      btn.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(value); btn.textContent = "Copied"; } catch { input.select(); btn.textContent = "Press Ctrl C"; }
        setTimeout(() => { btn.textContent = "Copy"; }, 1600);
      });
      return h("div.embed-row", {}, h("span.embed-cap", { text: label }), input, btn);
    }));
  }

  // ---------------------------------------------------------------- 3.0: two players side by side
  function comparePage(a, bKey) {
    document.title = `Compare · ${a.name} · OCTIVE`;
    setCrumb("Compare players");
    const b = bKey && bKey !== "pick" ? (findPlayer(bKey) || findByName(bKey)[0] || null) : null;
    const picker = comparePicker(a, b);
    if (!b || b.id === a.id) {
      app.replaceChildren(h("a.back", { href: profileHref(a.id) }, `← ${a.name}`),
        h("section.page-head", {}, h("p.eyebrow", { text: "Compare players" }), h("h1", { text: `${a.name} vs …` }), h("p.sub", { text: "Pick a player to put beside them: their stats, graphs and skills side by side, and every chart they've both played." })),
        picker);
      picker.querySelector("input")?.focus();
      return;
    }
    const side = (p, cls) => {
      const av = h("div.card-avatar", {}, h("img", { alt: "", hidden: true }), h("span.initial"), h("span.dot", { hidden: true }));
      setAvatar(av, p);
      const nm = h("span.cmp-name"); nameInto(nm, p);
      return h("a.cmp-side." + cls, { href: profileHref(p.id) }, av, h("div.cmp-who", {}, nm,
        h("small", { text: isOfficial(p) ? "Official account" : `#${fmt0.format(p.rank)} · ${fmt0.format(p.pp || 0)} PR` + (p.country ? ` · ${regionName(p.country)}` : "") })));
    };
    const tally = h("span.cmp-tally", { text: "" });
    const head = h("section.cmp-head.feature-card", {}, side(a, "a"), h("div.cmp-vs", {}, h("b", { text: "VS" }), tally), side(b, "b"));
    // stat by stat: the better one lights up
    const achOf = (p) => Object.keys(p.achievements || {}).length;
    const STATS = [
      ["Global rank", (p) => isOfficial(p) ? null : p.rank, (v) => "#" + fmt0.format(v), true],
      ["Performance", (p) => p.pp || 0, (v) => fmt0.format(v) + " PR"],
      ["Accuracy", (p) => p.accuracy || 0, (v) => fmt2.format(v) + "%"],
      ["Level", (p) => p.level || 1, (v) => "Lv" + fmt0.format(v)],
      ["Play count", (p) => p.playCount || 0, (v) => fmt0.format(v)],
      ["Play time", (p) => p.playTimeMs || 0, (v) => playTime(v)],
      ["Max combo", (p) => p.maxCombo || 0, (v) => fmt0.format(v) + "x"],
      ["Full combos", (p) => p.fullCombos || 0, (v) => fmt0.format(v)],
      ["Total score", (p) => p.totalScore || 0, (v) => fmtCount(v)],
      ["Achievements", achOf, (v) => fmt0.format(v)],
    ];
    let winsA = 0, winsB = 0;
    const duelRow = (label, va, vb, fmt, lowerBetter) => {
      if (va == null || vb == null) return null;
      const better = va === vb ? 0 : (lowerBetter ? va < vb : va > vb) ? -1 : 1;
      if (better < 0) winsA++; else if (better > 0) winsB++;
      const sa = lowerBetter ? 1 / Math.max(1, va) : va, sb = lowerBetter ? 1 / Math.max(1, vb) : vb, mx = Math.max(sa, sb) || 1;
      return h("div.cmp-row", {},
        h("b.cmp-v.a" + (better < 0 ? ".win" : ""), { text: fmt(va) }),
        h("span.cmp-bar.a", {}, h("i", { style: `width:${Math.round(sa / mx * 100)}%` })),
        h("span.cmp-label", { text: label }),
        h("span.cmp-bar.b", {}, h("i", { style: `width:${Math.round(sb / mx * 100)}%` })),
        h("b.cmp-v.b" + (better > 0 ? ".win" : ""), { text: fmt(vb) }));
    };
    const duel = h("section.cmp-duel.side-card", {}, ...STATS.map(([label, get, fmt, low]) => duelRow(label, get(a), get(b), fmt, low)));
    const skillRow = h("div.cmp-skillrow");
    duel.append(skillRow);
    const paintTally = () => { tally.textContent = winsA === winsB ? `Level on stats, ${winsA}–${winsB}` : `${winsA > winsB ? a.name : b.name} leads ${Math.max(winsA, winsB)}–${Math.min(winsA, winsB)}`; };
    paintTally();
    const graphs = h("section.cmp-graphs.side-card", {}, h("div.side-card-head", {}, h("h2", { text: "Over time" })), h("p.empty", { text: "Loading…" }));
    const skills = h("section.cmp-skills.side-card", { hidden: true });
    const common = h("section.cmp-common.side-card", {}, h("div.side-card-head", {}, h("h2", { text: "Charts they've both played" })), h("p.empty", { text: "Loading…" }));
    app.replaceChildren(h("a.back", { href: profileHref(a.id) }, `← ${a.name}`), head, picker, h("div.cmp-grid", {}, duel, h("div.cmp-col", {}, graphs, skills)), common);
    window.scrollTo(0, 0);
    // graphs and skills
    Promise.all([progressOf(a.id), progressOf(b.id)]).then(([pa, pb]) => {
      if (!graphs.isConnected) return;
      const da = ((pa && pa.days) || []).filter((x) => Array.isArray(x) && x[3] > 0).slice(-90), db = ((pb && pb.days) || []).filter((x) => Array.isArray(x) && x[3] > 0).slice(-90);
      if (da.length + db.length < 3) graphs.replaceChildren(h("div.side-card-head", {}, h("h2", { text: "Over time" })), h("p.empty", { text: "Not enough days on the ranking to draw yet." }));
      else graphs.replaceChildren(h("div.side-card-head", {}, h("h2", { text: "Over time" }), h("span.cmp-key", {}, h("i.a"), a.name, h("i.b"), b.name)), duoGraphs(da, db));
      const ka = pa && pa.skills, kb = pb && pb.skills;
      if (ka && kb && (ka.axes || []).length >= 3 && (kb.axes || []).length >= 3) {
        skills.replaceChildren(h("div.side-card-head", {}, h("h2", { text: "Skills" }), h("span.cmp-key", {}, h("i.a"), a.name, h("i.b"), b.name)), duoRadar(ka, kb));
        skills.hidden = false;
        const r = duelRow("Skill level", Number(ka.overall) || 0, Number(kb.overall) || 0, (v) => "★" + v.toFixed(1));
        if (r) { skillRow.replaceWith(r); paintTally(); }
      }
    });
    // the charts both played (their best play on each), who did better
    Promise.all([playsOf(a.id), playsOf(b.id)]).then(([pa, pb]) => {
      if (!common.isConnected) return;
      const mb = new Map(((pb && pb.top) || []).map((t) => [t.board, t]));
      const both = ((pa && pa.top) || []).filter((t) => t.board && mb.has(t.board)).map((t) => [t, mb.get(t.board)]).sort((x, y) => (y[0].stars || 0) - (x[0].stars || 0));
      const head2 = h("div.side-card-head", {}, h("h2", { text: "Charts they've both played" }));
      if (!both.length) { common.replaceChildren(head2, h("p.empty", { text: "No charts in common yet." })); return; }
      let wa = 0, wb = 0;
      const rowsEl = both.map(([ta, tb]) => {
        const win = (ta.pp || 0) === (tb.pp || 0) ? 0 : (ta.pp || 0) > (tb.pp || 0) ? -1 : 1;
        if (win < 0) wa++; else if (win > 0) wb++;
        const thumb = h("span.cm-pic");
        if (ta.pic) thumb.append(waitPic(thumb, h("img", { src: ta.pic, alt: "", loading: "lazy" })));
        const cell = (t, w) => h("span.cm-play" + (w ? ".win" : ""), {}, h("b", { text: fmt0.format(t.pp || 0) + " PR" }), h("small", { text: `${fmt2.format(t.acc || 0)}% · ${t.grade || "–"}${t.fc ? " · FC" : ""}` }));
        return h("div.cm-row", {}, cell(ta, win < 0), h("span.cm-song", {}, thumb, h("span", {}, h("b", { text: ta.title, title: ta.title }),
          h("small", { text: [ta.difficulty, ta.keys ? ta.keys + "K" : "", "★ " + (ta.stars || 0).toFixed(2)].filter(Boolean).join(" · ") }))), cell(tb, win > 0));
      });
      head2.append(h("span.cmp-key", {}, h("i.a"), `${a.name} ${wa}`, h("i.b"), `${b.name} ${wb}`));
      common.replaceChildren(head2, h("div.cm-list", {}, ...rowsEl));
    });
  }
  /** "Compare with…": type a name, pick from the list (or a player near them on the ranking). */
  function comparePicker(a, b) {
    const input = h("input", { type: "search", placeholder: b ? "Compare with someone else…" : "Type a player's name", autocomplete: "off", "aria-label": "Player to compare with" });
    const list = h("div.cmp-sugg");
    const near = () => { const l = (data ? data.players : []).filter((x) => !isOfficial(x)); const i = l.findIndex((x) => x.id === a.id); return l.slice(Math.max(0, i - 3), i + 4).filter((x) => x.id !== a.id && (!b || x.id !== b.id)); };
    const paint = () => {
      const q = input.value.trim();
      const found = (q ? findByName(q) : near()).filter((x) => x.id !== a.id && !isOfficial(x)).slice(0, 6);
      list.replaceChildren(...(found.length ? [h("span.cmp-sugg-cap", { text: q ? "Players" : "Near them on the ranking" })] : []), ...found.map((x) => h("a.cmp-pick", { href: profileHref(a.id) + "?vs=" + encodeURIComponent(x.id) }, smallAvatar(x.id, x.name, x.avatarHash), h("span", {}, h("b", { text: x.name }), h("small", { text: `#${fmt0.format(x.rank)} · ${fmt0.format(x.pp || 0)} PR` })))));
    };
    input.addEventListener("input", paint);
    paint();
    return h("section.cmp-picker", {}, h("label.search", {}, (() => { const s = document.createElement("span"); s.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>'; return s.firstChild; })(), input), list);
  }
  /** Two players' days in one graph: PR, rank or accuracy, on the same dates. */
  function duoGraphs(da, db) {
    const host = h("div.duo-graphs"), tabs = h("div.pf-gtabs");
    const metrics = [["PR", 1], ["Rank", 3], ["Accuracy", 2]];
    let cur = 1;
    const paint = () => {
      tabs.replaceChildren(...metrics.map(([label, k]) => h("button" + (k === cur ? ".on" : ""), { type: "button", onclick: () => { cur = k; paint(); } }, label)));
      host.replaceChildren(tabs, duoGraph(da, db, cur));
    };
    paint();
    return host;
  }
  function duoGraph(da, db, k) {
    const NS = "http://www.w3.org/2000/svg", W = 600, H = 170, pad = 10;
    const dates = [...new Set([...da, ...db].map((d) => d[0]))].sort();
    const x = (date) => dates.length < 2 ? W / 2 : dates.indexOf(date) / (dates.length - 1) * W;
    const vals = [...da, ...db].map((d) => Number(d[k]) || 0);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const up = k !== 3;
    const y = (v) => hi === lo ? H / 2 : up ? H - pad - (v - lo) / (hi - lo) * (H - pad * 2) : pad + (v - lo) / (hi - lo) * (H - pad * 2);
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("preserveAspectRatio", "none"); svg.setAttribute("class", "duo-svg");
    let inner = "";
    for (let i = 1; i < 4; i++) inner += `<line class="duo-grid" x1="0" x2="${W}" y1="${(H / 4 * i).toFixed(1)}" y2="${(H / 4 * i).toFixed(1)}"/>`;
    const line = (days, cls) => days.length ? `<polyline class="duo-line ${cls}" vector-effect="non-scaling-stroke" points="${days.map((d) => `${x(d[0]).toFixed(1)},${y(Number(d[k]) || 0).toFixed(1)}`).join(" ")}"/>` : "";
    svg.innerHTML = inner + line(da, "a") + line(db, "b");
    const fmtV = (v) => k === 3 ? "#" + fmt0.format(v) : k === 1 ? fmt0.format(v) + " PR" : (Number(v) || 0).toFixed(2) + "%";
    const day = (s) => new Date(s + "T12:00:00Z").toLocaleDateString(undefined, { day: "numeric", month: "short" });
    return h("div.duo-chart", {}, svg, h("div.duo-axis", {}, h("span", { text: dates.length ? day(dates[0]) : "" }), h("span", { text: `${fmtV(up ? hi : lo)} at best` }), h("span", { text: dates.length ? day(dates[dates.length - 1]) : "" })));
  }
  /** Two skill radars laid over each other (the first player's axes; the second's matched by name). */
  function duoRadar(ka, kb) {
    const axes = ka.axes || [];
    const lb = new Map((kb.axes || []).map((x) => [x.key, Number(x.level) || 0]));
    const la = axes.map((x) => Number(x.level) || 0), lbv = axes.map((x) => lb.get(x.key) || 0);
    const S = 260, C = S / 2, R = 92, max = Math.max(2, Math.ceil(Math.max(0, ...la, ...lbv) + 0.4));
    const ang = (i) => -Math.PI / 2 + i * 2 * Math.PI / axes.length;
    const pt = (i, r) => [C + Math.cos(ang(i)) * r, C + Math.sin(ang(i)) * r];
    const poly = (vals) => vals.map((v, i) => pt(i, R * Math.min(1, v / max)).map((n) => n.toFixed(1)).join(",")).join(" ");
    let inner = "";
    for (let st = 1; st <= max; st += max > 6 ? 2 : 1) inner += `<polygon class="sk-ring" points="${axes.map((_, i) => pt(i, R * st / max).map((n) => n.toFixed(1)).join(",")).join(" ")}"/>`;
    axes.forEach((_, i) => { const [x2, y2] = pt(i, R); inner += `<line class="sk-spoke" x1="${C}" y1="${C}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`; });
    inner += `<polygon class="duo-shape a" points="${poly(la)}"/><polygon class="duo-shape b" points="${poly(lbv)}"/>`;
    axes.forEach((a, i) => {
      const [lx, ly] = pt(i, R + 20);
      const anchor = Math.abs(lx - C) < 8 ? "middle" : lx < C ? "end" : "start";
      inner += `<text class="sk-label" x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="${anchor}">${String(a.name).replace(/[<&]/g, "")}</text>`;
    });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `-62 -10 ${S + 124} ${S + 20}`); svg.setAttribute("class", "sk-radar duo-radar"); svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Skills of both players");
    svg.innerHTML = inner;
    return svg;
  }


  // ---------------------------------------------------------------- top plays and recent plays (2.1.4)
  const GRADE_COL = { SS: "#ffd23f", S: "#ffb13b", A: "#5ee08a", B: "#5ab8ff", C: "#b69bff", D: "#ff6b8b", F: "#8a8aa0" };
  const shortDate = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  /**
   * A profile's Top plays (the PR the global ranking counts per chart, best first, with what each counts for in their total)
   * and Recent plays (the plays the server checked, newest first), from /play/plays. Hidden when they have none.
   */
  /** A player's plays. opts.limit: how many show at first; opts.more: what "see all" does (else "Show more" adds 20). */
  function playsSection(p, opts = {}) {
    const limit = opts.limit || 10;
    const list = h("div.pl-list");
    const tabBtns = {};
    const tabs = h("div.pl-tabs", {}, ...[["top", "Top plays"], ["recent", "Recent plays"]].map(([k, label]) =>
      (tabBtns[k] = h("button.pl-tab", { type: "button", onclick: () => { mode = k; shown = limit; paint(); } }, label))));
    const box = h("section.pl-section", { hidden: true }, h("div.section-head", {}, h("h2.section-title", { text: opts.more ? "Best plays" : "Plays" }), tabs), list);
    let data = null, mode = "top", shown = limit;
    // (2.2.1) a play's details, in the showcase's popup. A play without its score and judgements (kept before 2.2.1 and
    // not filled in yet) gets them from the player's board score when that's the same play (same accuracy and mods).
    // (2.2.2) the popup opens at once and fills in when the board answers (it waited for the board before); the board is
    // asked for when the pointer comes over the row, so it's usually there by the click
    const missing = (t) => (t.score == null || !Array.isArray(t.counts)) && t.board && worker;
    const boardAsks = new Map();
    const boardOf = (t) => {
      if (!boardAsks.has(t.board)) {
        const [song, chart] = t.board.split("/");
        boardAsks.set(t.board, fetch(`${worker}/scores/${encodeURIComponent(song)}/${encodeURIComponent(chart)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
      }
      return boardAsks.get(t.board);
    };
    const openPlay = (t) => {
      const s = { title: t.title, difficulty: t.difficulty, keys: t.keys, stars: t.stars, grade: t.grade, cover: t.pic, score: t.score, acc: t.acc,
        pp: t.pp, maxCombo: t.maxCombo, fullCombo: t.fc, counts: t.counts, mods: t.mods, date: t.at, workshopId: t.item, loading: !!missing(t) };
      const popup = showcaseDetails(s);
      if (!s.loading) return;
      boardOf(t).then((d) => {
        const e = d && (d.entries || []).find((x) => x.playerId === p.id);
        const same = e && Math.abs((Number(e.accuracy) || 0) - (Number(t.acc) || 0)) < 0.02 && String(e.mods || "") === String(t.mods || "");
        popup.update(same ? { score: e.score, counts: e.counts, maxCombo: e.maxCombo ?? s.maxCombo } : {});
      });
    };
    const row = (t, i) => {
      const top = mode === "top";
      const meta = [t.difficulty, t.keys ? t.keys + "K" : "", t.mods, t.at ? (top ? shortDate(t.at) : ago(t.at)) : ""].filter(Boolean).join(" · ");
      // (2.2.1) the song's picture; the row opens the play's details (like a showcase play), with a link to its Workshop page
      const thumb = h("span.pl-thumb", { "aria-hidden": "true" });
      if (t.pic) { const img = h("img", { src: t.pic, alt: "", loading: "lazy" }); img.onerror = () => img.remove(); thumb.append(img); }
      if (t.item) thumb.append(playBtn({ id: t.item, title: t.title, preview: t.pic, type: "charts" }, "small"));
      return h("div.pl-row.linked", { "data-place": top ? i + 1 : null, role: "button", tabindex: "0", title: "Details",
        onclick: () => openPlay(t), onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPlay(t); } },
        onpointerenter: () => { if (missing(t)) boardOf(t); }, onfocus: () => { if (missing(t)) boardOf(t); } },
        h("span.pl-rank", { text: top ? "#" + (i + 1) : "" }),
        h("span.pl-grade", { text: t.grade || "–", style: `--g:${GRADE_COL[t.grade] || "#8a8aa0"}`, title: t.fc ? "Full combo" : null }, t.fc ? h("i", { text: "FC" }) : null),
        thumb,
        h("div.pl-song", {},
          h("b", { text: t.title, title: t.title }),
          h("small", {}, h("span.pl-star", { text: "★ " + (t.stars || 0).toFixed(2), style: `--s:${starColor(t.stars || 0)}` }), h("span", { text: meta }),
            h("span.pl-acc-m", { text: fmt2.format(t.acc || 0) + "%" }))),
        h("span.pl-acc", { text: fmt2.format(t.acc || 0) + "%" }),
        h("div.pl-pr", { title: t.verified ? null : "Not verified: a third of the play's PR counts toward the ranking" },
          h("b", { text: fmt0.format(t.pp || 0) + " PR" }),
          top ? h("small", { text: `${t.earned ?? t.weight}% earned`, title: "How much of this chart's PR the accuracy earned. Every play adds its full PR to the total." })
            : !t.verified ? h("small", { text: "not verified" }) : null));
    };
    const paint = () => {
      for (const [k, b] of Object.entries(tabBtns)) b.classList.toggle("active", k === mode);
      tabBtns.top.textContent = data && data.total ? `Top plays · ${fmt0.format(data.total)}` : "Top plays";
      const rows = (data && data[mode]) || [];
      list.replaceChildren(
        ...(rows.length ? rows.slice(0, shown).map(row) : [h("p.empty", { text: mode === "top" ? "No plays on the ranking yet." : "No recent plays yet." })]),
        rows.length > shown ? (opts.more
          ? h("button.btn.small.pl-more", { type: "button", onclick: opts.more }, `See all ${fmt0.format(rows.length)} ${mode === "top" ? "top" : "recent"} plays`)
          : h("button.btn.small.pl-more", { type: "button", onclick: () => { shown += 20; paint(); } }, `Show more (${fmt0.format(rows.length - shown)})`)) : null);
    };
    playsOf(p.id).then((d) => {
      if (!d || !box.isConnected && !box.parentNode) return;
      if (!((d.top || []).length || (d.recent || []).length)) return;
      data = d;
      paint();
      box.hidden = false;
    });
    return box;
  }

  // ---------------------------------------------------------------- small DOM helper
  /** h("div.class", {attr}, ...children) */
  function h(tag, attrs, ...kids) {
    const [name, ...cls] = tag.split(".");
    const el = document.createElement(name || "div");
    if (cls.length) el.className = cls.join(" ");
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "text") el.textContent = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) el.append(k instanceof Node ? k : String(k));
    return el;
  }

  // ---------------------------------------------------------------- releases (latest.json)
  let release = null, releasePromise = null;
  function loadRelease() {
    if (!worker) return Promise.resolve(null);
    releasePromise ??= fetch(worker + "/releases/latest.json", { cache: "no-cache" })
      .then((r) => r.ok ? r.json() : null).catch(() => null).then((m) => { release = m; return m; });
    return releasePromise;
  }
  const mb = (bytes) => (bytes / 1048576).toFixed(0) + " MB";
  const isAndroid = /Android/i.test(navigator.userAgent);

  // ---------------------------------------------------------------- home

  /** The emblem from the game: nested octagons that turn slowly. */
  function emblemSvg(size) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 100 100"); svg.setAttribute("class", "emblem"); svg.setAttribute("aria-hidden", "true");
    if (size) { svg.style.width = size + "px"; svg.style.height = size + "px"; }
    const R = 43;
    const pts = (r, rot) => Array.from({ length: 8 }, (_, i) => {
      const a = (i * 45 + 22.5 + rot) * Math.PI / 180;
      return `${(50 + Math.cos(a) * r).toFixed(2)},${(50 + Math.sin(a) * r).toFixed(2)}`;
    }).join(" ");
    const poly = (cls, r, rot, extra) => {
      const p = document.createElementNS(NS, "polygon");
      p.setAttribute("points", pts(r, rot)); p.setAttribute("class", cls);
      for (const [k, v] of Object.entries(extra || {})) p.setAttribute(k, v);
      return p;
    };
    const g = (cls, ...kids) => { const e = document.createElementNS(NS, "g"); e.setAttribute("class", cls); kids.forEach((k) => e.appendChild(k)); return e; };
    svg.appendChild(poly("e-fill", R * 0.92, 0));
    svg.appendChild(g("spin-a", poly("e-outer", R * 0.95, 0)));
    svg.appendChild(g("spin-b", poly("e-mid", R * 0.80, 22.5)));
    svg.appendChild(g("spin-c", poly("e-inner", R * 0.67, 0)));
    const ticks = g("spin-a");
    for (let i = 0; i < 8; i++) {
      const a = i * 45 * Math.PI / 180, l = document.createElementNS(NS, "line");
      l.setAttribute("x1", 50 + Math.cos(a) * R); l.setAttribute("y1", 50 + Math.sin(a) * R);
      l.setAttribute("x2", 50 + Math.cos(a) * R * 1.08); l.setAttribute("y2", 50 + Math.sin(a) * R * 1.08);
      l.setAttribute("class", "e-tick"); ticks.appendChild(l);
    }
    svg.appendChild(ticks);
    const w = R * 0.19, hh = R * 0.13, gap = R * 0.04, x0 = 50 - (4 * w + 3 * gap) / 2;
    ["e-p", "e-c", "e-c", "e-p"].forEach((cls, i) => {
      const r = document.createElementNS(NS, "rect");
      r.setAttribute("x", x0 + i * (w + gap)); r.setAttribute("y", 50 + R * 0.27 - i * R * 0.18 - hh / 2);
      r.setAttribute("width", w); r.setAttribute("height", hh); r.setAttribute("rx", hh * 0.35);
      r.setAttribute("class", cls + " e-note"); r.style.animationDelay = (i * 0.18) + "s";
      svg.appendChild(r);
    });
    return svg;
  }

  // ---------------------------------------------------------------- the front page
  const ABOUT = [
    ["Your osu!mania maps", "Point OCTIVE at your osu! folder and your mania maps show up, collections included. Maps from other modes get converted."],
    ["The Workshop", "Charts, skins, themes and styles other players made. Get them here or from inside the game."],
    ["Ranking", "Every chart has a star rating. Good plays earn performance rating (PR), and your PR decides your place."],
    ["Daily charts", "Three new charts every day: easy, normal and hard. One try at each, points for playing, and a streak to keep going."],
    ["Multiplayer and crews", "Make a room and share the code, talk over voice chat, watch friends play live, or join a crew."],
    ["Practice", "Loop the part you keep missing and slow it down to 0.5x until it sticks."],
    ["Chart editor", "Waveform, scrub bar and test play, for anything from 1 to 20 keys."],
    ["Skins and replays", "Bars, arrows, circles or your own osu! skin. Every play is saved as a replay you can scrub through."],
  ];

  // the short summary line under an announcement's title ("**Crews get a big update**, your skills…")
  function releaseSummary(x) {
    const lines = String(x.announcement || "").split("\n").map((l) => l.trim());
    const s = lines.find((l) => l.length > 20 && !/^(#|•|-|\*\s|>|---)/.test(l));
    return (s || x.notes || "").replace(/\*\*/g, "").replace(/<@\d+>/g, "").trim();
  }

  // (3.0) what's in the game, each with its own icon
  const ABOUT_ICONS = [
    '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM17 6h3v2a3 3 0 0 1-3 3M7 6H4v2a3 3 0 0 0 3 3"/>',
    '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    '<circle cx="9" cy="8" r="3.5"/><path d="M2 20v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1"/><path d="M16 4.2a3.5 3.5 0 0 1 0 6.6M22 20v-1a5 5 0 0 0-3-4.6"/>',
    '<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v4h4"/><path d="M12 8v4l3 2"/>',
    '<path d="M3 17h18M6 13l3-6 3 4 3-7 3 9"/>',
    '<path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 7v5h5"/><circle cx="18.5" cy="5.5" r="2.5"/>',
  ];

  // ---------------------------------------------------------------- the front page: a title screen and a song wheel (3.0 arcade)
  function home() {
    const players = data ? data.players : [];
    const online = players.filter((p) => p.online).length;
    // the counters, like a game's HUD
    const hud = (tag, attrs, label, value, col) => h(tag + ".ar-hud-cell", { ...attrs, style: `--s:${col}` }, h("small", { text: label }), h("b", { text: value }), h("i.ar-hud-bar"));
    const onCell = hud("div", {}, "Online now", data ? fmt0.format(online) : "…", "var(--green)");
    onCell.querySelector("small").prepend(h("i.hm3-live"));
    const verCell = hud("a", { href: "updates" }, "Version", "…", "var(--pink)");
    const verified = hud("a", { href: "workshop?verified=1", title: "Charts checked by OCTIVE: global leaderboards and full PR" }, "Verified charts", "…", "var(--orange)");
    const hudRow = h("section.ar-hud", {}, onCell, hud("a", { href: "rankings" }, "Ranked players", data ? fmt0.format(players.length) : "…", "var(--cyan)"), verified, verCell);

    // the title screen
    const title = h("div.ar-title", {},
      h("p.ar-kicker", {}, h("span", { text: "Free rhythm game" }), h("span", { text: "1 to 20 keys" }), h("span", { text: "Windows · Android · Browser" })),
      h("h1.ar-logo", {}, h("img", { src: "logo.svg", alt: "", width: 84, height: 84 }), h("span.ar-word", { text: "OCTIVE", "data-text": "OCTIVE" })),
      h("p.ar-lead", { text: "A vertical scrolling rhythm game. Bring your osu!mania maps, grab charts other players made in the Workshop, or make your own." }),
      h("div.ar-start", {},
        h("a.btn.primary.big.ar-go", { href: "downloads" }, h("span.ar-tri"), "Download free"),
        h("a.btn.big", { href: "play/" }, "Play in browser")),
      h("p.ar-press", { text: "Press start" }));

    // the song wheel: the Workshop's newest charts; pointing at one shows it big (and it moves on by itself until you do)
    const jacketImg = h("img", { alt: "" });
    const jacket = h("a.ar-jacket", { href: "workshop" },
      h("span.ar-jacket-pic", {}, jacketImg),
      h("span.ar-jacket-tags"),
      h("span.ar-jacket-plate", {}, h("b"), h("small")));
    const bars = h("ol.ar-bars", {}, h("li.ar-bar-wait", { text: "Loading the Workshop…" }));
    const jacketPlay = h("span.ar-jacket-play");
    const wheel = h("div.ar-wheel", {}, h("div.ar-wheel-head", {}, h("span", { text: "Song select" }), h("a", { href: "workshop" }, "All charts")), h("div.ar-jacket-wrap", {}, jacket, jacketPlay), bars);
    const hero = h("section.ar-hero", {}, title, wheel);
    let wheelItems = [], at = 0, cycle = null, touched = false;
    function pick(i) {
      if (!wheelItems.length) return;
      at = (i + wheelItems.length) % wheelItems.length;
      const it = wheelItems[at];
      [...bars.children].forEach((li, k) => li.classList.toggle("on", k === at));
      jacket.href = "workshop/" + it.id;
      jacket.classList.remove("in"); void jacket.offsetWidth; jacket.classList.add("in");
      const holder = jacket.querySelector(".ar-jacket-pic");
      if (it.preview) { jacketImg.hidden = false; waitPic(holder, jacketImg); jacketImg.src = it.preview; } else jacketImg.hidden = true;
      jacket.querySelector(".ar-jacket-tags").replaceChildren(
        it.topStars > 0 ? h("span.ar-star", { text: "★ " + it.topStars.toFixed(2), style: `--s:${starColor(it.topStars)}` }) : null,
        it.verified ? h("span.ar-ver", { text: "Verified" }) : null,
        (it.keys || []).length ? h("span.ar-keys", { text: it.keys.map((k) => k + "K").join(" ") }) : null);
      jacket.querySelector(".ar-jacket-plate b").textContent = it.title;
      jacketPlay.replaceChildren(playBtn(it, "big") || "");
      jacket.querySelector(".ar-jacket-plate small").textContent = ["by " + (it.creator || "someone"), it.topPR > 0 ? fmt0.format(Math.round(it.topPR)) + " PR" : ""].filter(Boolean).join(" · ");
    }
    const stopCycle = () => { touched = true; clearInterval(cycle); };
    wheel.addEventListener("pointerenter", stopCycle);
    wheel.addEventListener("focusin", stopCycle);

    // the news ticker: the latest update, rolling along
    const ticker = h("a.ar-ticker", { href: "updates" }, h("span.ar-ticker-tag", { text: "News" }), h("span.ar-ticker-run", {}, h("span", { text: "Loading the latest update…" })));

    // (2.1.2) the charts players like most, and (3.0) who's climbing
    const liked = h("ol.hm-top.hm-liked", {}, h("p.empty", { text: "Loading…" }));
    const board = h("div.hm-col.hm3-col", {},
      h("div.section-head", {}, h("h2.section-title", { text: "Most liked" }), h("a.more", { href: "workshop?sort=liked" }, "Workshop")),
      liked);
    fetch(worker + "/api/items?type=charts&sort=liked", { cache: "no-cache" }).then((r) => r.ok ? r.json() : null).catch(() => null).then((d) => {
      verified.querySelector("b").textContent = d && Number.isFinite(d.verifiedCharts) ? fmt0.format(d.verifiedCharts) : "—";
      if (!liked.isConnected) return;
      const items = ((d && d.items) || []).filter((x) => (x.likes || 0) > 0).slice(0, 6);
      if (!items.length) { liked.replaceChildren(h("p.empty", { text: "No likes yet: like a chart in the Workshop, here or in the game." })); return; }
      liked.replaceChildren(...items.map((x, i) => {
        const pic = h("span.hm-cover");
        if (x.preview) pic.append(waitPic(pic, h("img", { src: x.preview, alt: "", loading: "lazy" })));
        return h("li", {}, h("a", { href: "workshop/" + x.id, "data-place": i + 1 },
          h("span.hm-rank", { text: String(i + 1) }), pic,
          h("span.hm-who", {}, h("span.name", { text: x.title, title: x.title }),
            h("span.hm-by", { text: [x.creator ? "by " + x.creator : "", x.topStars > 0 ? "★ " + x.topStars.toFixed(2) : "", x.verified ? "verified" : ""].filter(Boolean).join(" · ") })),
          h("span.hm-pr.hm-likes", { title: `${fmt0.format(x.likes)} like${x.likes === 1 ? "" : "s"}` }, "♥ " + fmt0.format(x.likes))));
      }));
    });
    const climb = h("ol.hm-top.hm3-climb", {}, h("p.empty", { text: "Loading…" }));
    const climbCol = h("div.hm-col.hm3-col.hm3-climbcol", {},
      h("div.section-head", {}, h("h2.section-title", { text: "Climbing this week" }), h("a.more", { href: "rankings" }, "Rankings")),
      climb);
    if (worker) fetch(worker + "/play/gainers?limit=6", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((g) => {
      if (!climb.isConnected) return;
      const list = ((g && g.players) || []).slice(0, 6);
      if (!list.length) { climb.replaceChildren(h("p.empty", { text: "Nobody has gained PR this week yet." })); return; }
      climb.replaceChildren(...list.map((x, i) => h("li", {}, h("a", { href: profileHref(x.playerId), "data-place": i + 1 },
        h("span.hm-rank", { text: String(i + 1) }), smallAvatar(x.playerId, x.name),
        h("span.hm-who", {}, h("span.name", { text: x.name || "Player" }), h("span.hm-by", { text: `#${fmt0.format(x.rank || 0)} · ${fmt0.format(x.pp || 0)} PR` })),
        h("span.hm-pr.hm3-gain", { text: "+" + fmt0.format(x.gain || 0) })))));
    });

    // mode select: what's in the game
    const modes = h("section.hm-sec.ar-modes", {},
      h("div.section-head", {}, h("h2.section-title", { text: "Mode select" }), h("a.more", { href: "about.html" }, "About OCTIVE")),
      h("div.hm3-feat-grid", {}, ...ABOUT.map(([t, d], i) => {
        const ic = h("span.hm3-ic"); ic.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ABOUT_ICONS[i] || ABOUT_ICONS[0]}</svg>`;
        return h("article.hm3-f", { style: `--c:var(--${["pink", "cyan", "yellow", "orange", "green", "blue", "purple", "teal"][i % 8]})` },
          h("span.ar-mode-n", { text: String(i + 1).padStart(2, "0") }), ic, h("h3", { text: t }), h("p", { text: d }));
      })));

    const liveStrip = h("section.hm-sec.hm-live", { hidden: true });
    const dailyRow = h("section.hm-sec.hm-daily", {},
      h("div.section-head", {}, h("h2.section-title", { text: "Daily challenge" }), h("a.more", { href: "daily" }, "Scores")),
      h("div.hm-daily-row", {}, h("p.empty", { text: "Loading today's charts…" })));
    const owner = findPlayer(ROLE_OWNER);
    const discord = owner && owner.socials ? socialUrl(null, owner.socials.discord) : null;
    const cta = h("section.ar-cta", {},
      h("div", {}, h("p.ar-press.on", { text: "Press start" }), h("h2", { text: "Ready?" }),
        h("p", { text: "Free on Windows, Android and in your browser. Your scores, friends and Workshop follow you everywhere." })),
      h("div.ar-start", {}, h("a.btn.primary.big", { href: "downloads" }, h("span.ar-tri"), "Get OCTIVE"),
        discord ? h("a.btn.big", { href: discord, target: "_blank", rel: "noopener" }, "Join the Discord") : h("a.btn.big", { href: "play/" }, "Play in browser")));
    app.replaceChildren(hero, ticker, hudRow, liveStrip, dailyRow, h("section.hm-sec.hm-two.hm3-two", {}, board, climbCol), modes, cta);
    paintLiveStrip();
    loadDailyRow(dailyRow);
    document.title = "OCTIVE";

    loadRelease().then((m) => { if (m && hero.isConnected) verCell.querySelector("b").textContent = "v" + m.version; });
    fetch(worker + "/releases/history.json", { cache: "no-cache" }).then((r) => r.ok ? r.json() : []).catch(() => []).then((hist) => {
      if (!ticker.isConnected) return;
      const x = (Array.isArray(hist) ? hist : []).find((y) => y && y.version && !/test/i.test(y.version));
      if (!x) { ticker.hidden = true; return; }
      const when = x.published ? new Date(x.published).toLocaleDateString(undefined, { day: "numeric", month: "long" }) : "";
      ticker.href = "updates/" + x.version;
      const msg = `OCTIVE ${x.version}${when ? " · " + when : ""} — ${releaseSummary(x)} — Read the patch notes`;
      // the text twice, so it rolls on without a gap
      ticker.querySelector(".ar-ticker-run").replaceChildren(h("span", { text: msg }), h("span", { text: msg, "aria-hidden": "true" }));
    });
    fetch(worker + "/api/items?type=charts&sort=new", { cache: "no-cache" }).then((r) => r.ok ? r.json() : null).catch(() => null).then((d) => {
      if (!bars.isConnected) return;
      wheelItems = ((d && d.items) || []).slice(0, 8);
      if (!wheelItems.length) { bars.replaceChildren(h("li.ar-bar-wait", { text: "Nothing shared yet. Share yours from the game: Play → Workshop." })); return; }
      bars.replaceChildren(...wheelItems.map((it, i) => {
        const pic = h("span.ar-bar-pic");
        if (it.preview) pic.append(waitPic(pic, h("img", { src: it.preview, alt: "", loading: "lazy" })));
        const a = h("a.ar-bar", { href: "workshop/" + it.id, onpointerenter: () => pick(i), onfocus: () => pick(i) },
          pic, h("span.ar-bar-text", {}, h("b", { text: it.title }), h("small", { text: "by " + (it.creator || "someone") })),
          it.topStars > 0 ? h("span.ar-bar-star", { text: "★" + it.topStars.toFixed(1), style: `--s:${starColor(it.topStars)}` }) : null);
        return h("li", { style: `--i:${i}` }, a, playBtn(it, "small"));
      }));
      pick(0);
      if (!matchMedia("(prefers-reduced-motion: reduce)").matches) cycle = setInterval(() => { if (!bars.isConnected) { clearInterval(cycle); return; } if (!touched && !document.hidden) pick(at + 1); }, 4200);
    });
  }

  /** (3.0) A Workshop item on the front page's shelf: its picture, big, with the title over it. */
  function shelfCard(it) {
    const pic = h("span.sh-pic");
    if (it.preview) pic.append(waitPic(pic, h("img", { src: it.preview, alt: "", loading: "lazy" })));
    else pic.append(h("span.sh-type", { text: WS_LABEL[it.type] || "" }));
    return h("a.sh-card", { href: "workshop/" + it.id, title: it.title },
      pic,
      h("span.sh-chips", {},
        it.type === "charts" && it.topStars > 0 ? h("span.sh-star", { text: "★ " + it.topStars.toFixed(2), style: `background:${starColor(it.topStars)}` }) : null,
        it.verified && it.type === "charts" ? h("span.sh-ver", { text: "✓ Verified" }) : null,
        it.type !== "charts" ? h("span.sh-kind", { text: WS_LABEL[it.type] || it.type }) : null),
      h("span.sh-body", {},
        h("b", { text: it.title }),
        h("small", { text: ["by " + (it.creator || "someone"), it.type === "charts" && it.topPR > 0 ? fmt0.format(Math.round(it.topPR)) + " PR" : "", (it.keys || []).length ? it.keys.map((k) => k + "K").join(" ") : ""].filter(Boolean).join(" · ") })));
  }

  // ---------------------------------------------------------------- #/workshop: charts, skins, themes and styles players shared
  const WS_TYPES = [["charts", "Charts"], ["skins", "Skins"], ["themes", "Themes"], ["styles", "Styles"]];
  const WS_LABEL = { charts: "Chart", skins: "Skin", themes: "Theme", styles: "Style" };
  let wsType = "charts", wsSort = "new", wsQuery = ""; let wsVerified = "", wsCustom = false;
  // every Workshop filter (the same as the game's Filters panel)
  const wsF = { builtin: false, by: "", charter: "", keys: new Set(), minStars: "", maxStars: "", tags: new Set() };
  const WS_TAGS = [["stream", "Stream"], ["jumpstream", "Jumpstream"], ["handstream", "Handstream"], ["chordjack", "Chordjack"], ["jacks", "Jacks"], ["speedjack", "Speedjack"],
    ["technical", "Technical"], ["ln", "LN (long notes)"], ["hybrid", "Hybrid"], ["sv", "SV"], ["stamina", "Stamina"], ["speed", "Speed"], ["dump", "Dump"],
    ["trills", "Trills"], ["vibro", "Vibro"], ["gimmick", "Gimmick"], ["modchart", "Modchart"], ["fnf", "FNF"], ["osu", "osu! map"], ["pack", "Pack"], ["easy", "Beginner friendly"], ["marathon", "Marathon"]];
  const wsTagName = (t) => (WS_TAGS.find((x) => x[0] === t) || [, t])[1];
  // (2.0.1) the uploader's tags, then the ones worked out from the charts' notes ("auto"; its uploader can take off wrong ones in the game)
  function wsTagChips(it) {
    const own = (it.tags || []).slice(0, 4);
    const auto = [...new Set((it.songs || []).flatMap((sg) => (sg.charts || []).flatMap((c) => c.autoTags || [])))].filter((t) => !own.includes(t)).slice(0, Math.max(0, 5 - own.length));
    if (!own.length && !auto.length) return null;
    return h("div.ws-tags", {}, [
      ...own.map((t) => h("span.ws-tag", { text: wsTagName(t), title: "Tagged by the uploader" })),
      ...auto.map((t) => h("span.ws-tag.auto", { text: wsTagName(t), title: "Auto-tag: worked out from the charts' notes" })),
    ]);
  }
  function wsQueryString() {
    const q = [`type=${wsType}`, `sort=${wsSort}`];
    if (wsQuery) q.push("q=" + encodeURIComponent(wsQuery));
    if (wsVerified && wsType === "charts") q.push("verified=" + wsVerified);
    if (wsCustom && (wsType === "skins" || wsType === "styles")) q.push("customizable=1");
    if (wsF.builtin) q.push("builtin=1");
    if (wsF.by) q.push("by=" + encodeURIComponent(wsF.by));
    if (wsType === "charts") {
      if (wsF.charter) q.push("charter=" + encodeURIComponent(wsF.charter));
      if (wsF.keys.size) q.push("keys=" + [...wsF.keys].sort((a, b) => a - b).join(","));
      if (Number(wsF.minStars) > 0) q.push("minStars=" + Number(wsF.minStars));
      if (Number(wsF.maxStars) > 0) q.push("maxStars=" + Number(wsF.maxStars));
      if (wsF.tags.size) q.push("tags=" + [...wsF.tags].join(","));
    }
    return q.join("&");
  }
  const wsActive = () => (wsVerified && wsType === "charts" ? 1 : 0) + (wsCustom && (wsType === "skins" || wsType === "styles") ? 1 : 0) + (wsF.builtin ? 1 : 0) + (wsF.by ? 1 : 0)
    + (wsType === "charts" ? (wsF.charter ? 1 : 0) + (wsF.keys.size ? 1 : 0) + (Number(wsF.minStars) > 0 || Number(wsF.maxStars) > 0 ? 1 : 0) + (wsF.tags.size ? 1 : 0) : 0);

  // ---------------------------------------------------------------- 3.0: listen to a chart's song first (the little player)
  // The ▶ on a chart's picture plays its song (the server pulls it out of the package: /api/audio/<id>). A little player
  // shows at the bottom right: the picture (it opens the chart's page), the title, pause, a bar to scrub, the volume and
  // close. One song at a time; it keeps playing while you move around the site.
  const MP = { el: null, audio: null, it: null, loading: false, failed: false, dragAt: null };
  const PLAY_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="pv-i-play" d="M8 5.2v13.6L19 12z"/><path class="pv-i-pause" d="M6.5 5h4v14h-4zM13.5 5h4v14h-4z"/></svg>';
  const mmss = (s) => { s = Math.max(0, Math.floor(Number(s) || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  /** The ▶ on a chart's picture. it: { id, title, creator, preview, version } (charts only). */
  function playBtn(it, size) {
    if (!it || !it.id || (it.type && it.type !== "charts")) return null;
    const b = h("button.pv-play" + (size ? "." + size : ""), { type: "button", "data-play-id": it.id, "aria-label": `Listen to ${it.title || "the song"}`, title: "Listen to the song" });
    b.innerHTML = PLAY_SVG;
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); playSong(it); });
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    if (MP.it && MP.it.id === it.id) { b.classList.toggle("on", !!(MP.audio && !MP.audio.paused)); b.classList.toggle("loading", MP.loading); }
    return b;
  }
  /** Every ▶ of the song that's on shows whether it plays. */
  function paintPlayButtons() {
    const id = MP.it && MP.it.id, on = !!(MP.audio && !MP.audio.paused && !MP.failed);
    document.querySelectorAll(".pv-play").forEach((b) => { const mine = b.dataset.playId === id; b.classList.toggle("on", mine && on); b.classList.toggle("loading", mine && MP.loading); });
    if (MP.el) {
      MP.el.classList.toggle("playing", on);
      MP.el.classList.toggle("loading", MP.loading);
      MP.el.classList.toggle("failed", MP.failed);
      const t = MP.el.querySelector(".mp-toggle");
      if (t) t.setAttribute("aria-label", on ? "Pause" : "Play");
    }
  }
  function stopSong() {
    if (MP.audio) { MP.audio.pause(); MP.audio.removeAttribute("src"); MP.audio.load(); }
    MP.audio = null; MP.it = null; MP.loading = false; MP.failed = false;
    if (MP.el) { const el = MP.el; MP.el = null; el.classList.add("out"); setTimeout(() => el.remove(), 260); }
    document.body.classList.remove("mp-on");
    if ("mediaSession" in navigator) { try { navigator.mediaSession.metadata = null; } catch { /* old browser */ } }
    paintPlayButtons();
  }
  function playSong(it) {
    // the same song: pause or go on
    if (MP.it && MP.it.id === it.id && MP.audio && !MP.failed) { MP.audio.paused ? MP.audio.play().catch(() => {}) : MP.audio.pause(); paintPlayButtons(); return; }
    if (MP.audio) { MP.audio.pause(); MP.audio.removeAttribute("src"); MP.audio.load(); }
    const audio = new Audio();
    audio.preload = "auto";
    audio.volume = Math.max(0, Math.min(1, Number(store.get("octive.previewVolume") ?? 0.7)));
    MP.audio = audio; MP.it = it; MP.loading = true; MP.failed = false;
    buildPlayer(it);
    const paintTime = () => { if (MP.audio === audio) paintPosition(); };
    audio.addEventListener("loadedmetadata", paintTime);
    audio.addEventListener("timeupdate", paintTime);
    audio.addEventListener("durationchange", paintTime);
    audio.addEventListener("waiting", () => { if (MP.audio === audio) { MP.loading = true; paintPlayButtons(); } });
    audio.addEventListener("playing", () => { if (MP.audio === audio) { MP.loading = false; paintPlayButtons(); } });
    audio.addEventListener("pause", () => { if (MP.audio === audio) paintPlayButtons(); });
    audio.addEventListener("ended", () => { if (MP.audio === audio) { audio.currentTime = 0; paintPlayButtons(); paintPosition(); } });
    audio.addEventListener("error", () => {
      if (MP.audio !== audio) return;
      MP.loading = false; MP.failed = true; paintPlayButtons();
      const sub = MP.el && MP.el.querySelector(".mp-sub");
      if (sub) sub.textContent = "This song can't be played here right now.";
    });
    audio.src = it.src || `${worker}/api/audio/${encodeURIComponent(it.id)}?v=${encodeURIComponent(it.version || 1)}`;
    audio.play().catch(() => { /* waits for the file; the ▶ in the player starts it */ });
    // the computer's own media keys and lock screen show it too
    if ("mediaSession" in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({ title: it.title || "Song", artist: it.creator ? "by " + it.creator : "OCTIVE Workshop", album: "OCTIVE Workshop", artwork: it.preview ? [{ src: it.preview }] : [] });
        navigator.mediaSession.setActionHandler("play", () => MP.audio && MP.audio.play());
        navigator.mediaSession.setActionHandler("pause", () => MP.audio && MP.audio.pause());
        navigator.mediaSession.setActionHandler("stop", stopSong);
      } catch { /* not supported */ }
    }
    paintPlayButtons();
  }
  function paintPosition() {
    if (!MP.el || !MP.audio || MP.dragAt != null) return;
    const a = MP.audio, d = Number.isFinite(a.duration) ? a.duration : 0, t = a.currentTime || 0;
    const f = d ? Math.min(1, t / d) : 0;
    MP.el.style.setProperty("--mp", f.toFixed(4));
    MP.el.querySelector(".mp-time").textContent = `${mmss(t)} / ${d ? mmss(d) : "–:––"}`;
    const bar = MP.el.querySelector(".mp-bar");
    bar.setAttribute("aria-valuemax", String(Math.round(d)));
    bar.setAttribute("aria-valuenow", String(Math.round(t)));
    bar.setAttribute("aria-valuetext", `${mmss(t)} of ${mmss(d)}`);
  }
  function buildPlayer(it) {
    const open = "workshop/" + it.id;
    MP.dragAt = null;
    const pic = h("a.mp-pic", { href: open, title: "Open the chart's page" });
    if (it.preview) pic.append(waitPic(pic, h("img", { src: it.preview, alt: "" })));
    const toggle = h("button.mp-toggle", { type: "button", "aria-label": "Pause", onclick: () => playSong(it) });
    toggle.innerHTML = PLAY_SVG;
    const bar = h("div.mp-bar", { role: "slider", tabindex: "0", "aria-label": "Where in the song", "aria-valuemin": "0" }, h("i.mp-fill"), h("i.mp-knob"));
    // while you drag, the bar and the time follow you; the song jumps there when you let go (no stutter from many jumps)
    const fracAt = (clientX) => { const r = bar.getBoundingClientRect(); return r.width ? Math.max(0, Math.min(1, (clientX - r.left) / r.width)) : 0; };
    const showAt = (f) => {
      const a = MP.audio, d = a && Number.isFinite(a.duration) ? a.duration : 0;
      if (!MP.el) return;
      MP.el.style.setProperty("--mp", f.toFixed(4));
      MP.el.querySelector(".mp-time").textContent = `${mmss(f * d)} / ${d ? mmss(d) : "–:––"}`;
    };
    bar.addEventListener("pointerdown", (e) => {
      if (e.button > 0) return;
      e.preventDefault(); bar.focus({ preventScroll: true }); bar.classList.add("drag");
      MP.dragAt = fracAt(e.clientX); showAt(MP.dragAt);
      try { bar.setPointerCapture(e.pointerId); } catch { /* no capture: the drag still follows moves over the bar */ }
    });
    bar.addEventListener("pointermove", (e) => { if (bar.classList.contains("drag")) { MP.dragAt = fracAt(e.clientX); showAt(MP.dragAt); } });
    const end = (e) => {
      if (!bar.classList.contains("drag")) return;
      bar.classList.remove("drag");
      const f = MP.dragAt; MP.dragAt = null;
      const a = MP.audio;
      if (e.type === "pointerup" && f != null && a && Number.isFinite(a.duration)) a.currentTime = f * a.duration;
      paintPosition();
    };
    bar.addEventListener("pointerup", end);
    bar.addEventListener("pointercancel", end);
    bar.addEventListener("lostpointercapture", end);
    bar.addEventListener("keydown", (e) => {
      const a = MP.audio; if (!a) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); a.currentTime = Math.max(0, Math.min(a.duration || 0, a.currentTime + (e.key === "ArrowLeft" ? -5 : 5))); paintPosition(); }
      else if (e.key === " " || e.key === "Enter") { e.preventDefault(); playSong(it); }
    });
    const vol = h("input.mp-vol", { type: "range", min: "0", max: "1", step: "0.05", value: String(MP.audio ? MP.audio.volume : 0.7), "aria-label": "Volume" });
    vol.addEventListener("input", () => { if (MP.audio) MP.audio.volume = Number(vol.value); store.set("octive.previewVolume", vol.value); });
    const el = h("div.mp", { role: "region", "aria-label": "Song preview" },
      h("span.mp-eq", { "aria-hidden": "true" }, h("i"), h("i"), h("i"), h("i")),
      pic,
      h("div.mp-main", {},
        h("div.mp-top", {},
          h("div.mp-text", {}, h("a.mp-title", { href: open, text: it.title || "Song", title: it.title || "" }), h("small.mp-sub", { text: it.creator ? "by " + it.creator : "Workshop chart" })),
          toggle,
          h("button.mp-close", { type: "button", "aria-label": "Close the player", title: "Close", onclick: stopSong }, "✕")),
        h("div.mp-row", {}, bar, h("span.mp-time", { text: "0:00 / –:––" })),
        h("label.mp-volrow", {}, h("span", { text: "Volume" }), vol)));
    if (MP.el) MP.el.replaceWith(el); else document.body.append(el);
    MP.el = el;
    document.body.classList.add("mp-on");
  }

  // ---------------------------------------------------------------- 3.0: chart lists (kept in this browser, shared as one link)
  const LIST_KEY = "octive.chartList", LIST_MAX = 50;
  /** Your list: [{ id, t: title }] in the order you added them. */
  function chartList() {
    try { return (JSON.parse(store.get(LIST_KEY) || "[]") || []).filter((x) => x && /^[a-z0-9]{16,40}$/.test(x.id)); } catch { return []; }
  }
  function saveChartList(list) {
    store.set(LIST_KEY, list.length ? JSON.stringify(list.slice(0, LIST_MAX)) : null);
    paintListPill();
    // every + / ✓ and "My list" on the page repaints itself (each keeps its own painter)
    document.querySelectorAll(".wl-btn, .ws-mylist").forEach((el) => el._paint && el._paint());
  }
  const inChartList = (id) => chartList().some((x) => x.id === id);
  function toggleChartList(it) {
    const list = chartList(), i = list.findIndex((x) => x.id === it.id);
    if (i >= 0) list.splice(i, 1);
    else if (list.length >= LIST_MAX) { toast(`A list holds up to ${LIST_MAX} charts.`); return; }
    else list.push({ id: it.id, t: String(it.title || "").slice(0, 120) });
    saveChartList(list);
    toast(i >= 0 ? "Taken off your chart list" : "Added to your chart list");
  }
  const listLink = (ids) => SITE_URL + "workshop/?list=" + ids.join(",");
  /** The + / ✓ button on a Workshop card or item page. */
  function listBtn(it, big) {
    const b = h("button.wl-btn" + (big ? ".btn" : ""), { type: "button" });
    const paint = () => {
      const on = inChartList(it.id);
      b.classList.toggle("on", on);
      b.title = on ? "On your chart list: click to take it off" : "Add to your chart list (share the list as one link)";
      b.setAttribute("aria-pressed", String(on));
      b.replaceChildren(h("span.wl-ic", { text: on ? "✓" : "+" }), big ? (on ? "On your list" : "Add to list") : null);
    };
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); toggleChartList(it); });
    b._paint = paint;
    paint();
    return b;
  }
  /** The floating "Chart list · 3" on the Workshop's pages, and the drawer it opens. */
  function paintListPill() {
    const list = chartList();
    let pill = document.querySelector(".wl-pill");
    const want = document.body.dataset.page === "workshop" && list.length > 0;
    if (!want) { pill?.remove(); document.querySelector(".wl-drawer")?.remove(); return; }
    if (!pill) {
      pill = h("button.wl-pill", { type: "button", onclick: () => (document.querySelector(".wl-drawer") ? document.querySelector(".wl-drawer").remove() : openListDrawer()) });
      document.body.append(pill);
    }
    pill.replaceChildren(h("span.wl-note", { text: "♪" }), "Chart list", h("b", { text: String(list.length) }));
    const dr = document.querySelector(".wl-drawer");
    if (dr) openListDrawer(true);
  }
  function openListDrawer(repaint) {
    const list = chartList();
    let dr = document.querySelector(".wl-drawer");
    if (!dr) { dr = h("div.wl-drawer", { role: "dialog", "aria-label": "Your chart list" }); document.body.append(dr); }
    else if (!repaint) return;
    const copy = h("button.btn.small.primary", { type: "button" }, "Copy link");
    copy.addEventListener("click", async () => {
      const url = listLink(chartList().map((x) => x.id));
      try { await navigator.clipboard.writeText(url); copy.textContent = "Copied"; } catch { prompt("Copy this link:", url); }
      setTimeout(() => { copy.textContent = "Copy link"; }, 1600);
    });
    dr.replaceChildren(
      h("div.wl-head", {}, h("div", {}, h("b", { text: "Your chart list" }), h("small", { text: `${list.length} chart${list.length === 1 ? "" : "s"} · kept in this browser` })),
        h("button.wl-close", { type: "button", "aria-label": "Close", onclick: () => dr.remove() }, "✕")),
      h("ol.wl-items", {}, ...list.map((x, i) => h("li", {},
        h("span.wl-n", { text: String(i + 1) }), h("a", { href: "workshop/" + x.id, text: x.t || "Chart", title: x.t || "" }),
        h("button.wl-x", { type: "button", title: "Take it off", "aria-label": "Take it off", onclick: () => { saveChartList(chartList().filter((y) => y.id !== x.id)); } }, "✕")))),
      h("div.wl-acts", {}, copy, h("a.btn.small", { href: "workshop/?list=" + list.map((x) => x.id).join(","), onclick: () => dr.remove() }, "Open the list"),
        h("button.btn.small.ghost", { type: "button", onclick: () => { if (confirm("Empty your chart list?")) saveChartList([]); } }, "Empty it")));
  }
  /** workshop/?list=a,b,c: a list someone shared (or yours), with a download for each. */
  function chartListPage(ids) {
    ids = [...new Set(ids)].filter((x) => /^[a-z0-9]{16,40}$/.test(x)).slice(0, LIST_MAX);
    const mine = chartList().map((x) => x.id);
    const same = ids.length === mine.length && ids.every((x, i) => x === mine[i]);
    document.title = "Chart list · Workshop · OCTIVE";
    setCrumb("Chart list");
    const grid = h("div.wk-grid.wl-grid", {}, h("p.empty", { text: "Loading the charts…" }));
    const items = [];
    const copy = h("button.btn.primary", { type: "button" }, "Copy link");
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(listLink(ids)); copy.textContent = "Link copied"; } catch { prompt("Copy this link:", listLink(ids)); }
      setTimeout(() => { copy.textContent = "Copy link"; }, 1600);
    });
    const save = same ? null : h("button.btn", { type: "button", onclick: () => {
      const list = chartList();
      for (const it of items.filter(Boolean)) if (!list.some((x) => x.id === it.id)) list.push({ id: it.id, t: it.title });
      saveChartList(list); toast("Added to your chart list");
    } }, "Add them to my list");
    const all = h("button.btn", { type: "button", title: "Downloads every chart, one after another (your browser may ask to allow several downloads)", onclick: () => {
      items.filter(Boolean).forEach((it, i) => setTimeout(() => { const a = h("a", { href: `${worker}/api/download/${it.id}?redirect=1` }); document.body.append(a); a.click(); a.remove(); }, i * 900));
    } }, "Download all");
    app.replaceChildren(h("div.ws-page.wl-page", {},
      h("a.back", { href: "workshop" }, "← Workshop"),
      h("section.page-head", {}, h("p.eyebrow", { text: same ? "Your chart list" : "A shared chart list" }), h("h1", { text: `${ids.length} chart${ids.length === 1 ? "" : "s"}` }),
        h("p.sub", { text: same ? "The charts you added. Copy the link to share the whole list: it opens right here for anyone." : "Someone shared these Workshop charts with you. Download them, open them in OCTIVE, or add them to your own list." }),
        h("div.wl-page-acts", {}, copy, save, all)),
      grid));
    if (!ids.length) { grid.replaceChildren(h("p.empty", { text: "This list is empty." })); return; }
    let next = 0, done = 0;
    const slots = ids.map(() => wkGhosts(1)[0]);
    grid.replaceChildren(...slots);
    const pump = () => {
      if (next >= ids.length) return;
      const i = next++;
      cachedJson(`${worker}/api/items/${ids[i]}`, 600_000).then((d) => {
        const it = d && d.item;
        if (it) { items[i] = it; slots[i].replaceWith(wkCard(it)); } else slots[i].replaceWith(h("article.wk-card.wk-gone", {}, h("p", { text: "This chart isn't in the Workshop any more." })));
        if (++done === ids.length) { const keep = items.filter(Boolean); items.length = 0; items.push(...keep); }
        pump();
      });
    };
    for (let k = 0; k < 4; k++) pump();
  }

  /** After "Open in OCTIVE": if the game didn't take the link (not installed), say where to get it. */
  function openHint() {
    let left = false;
    const away = () => { left = true; };
    window.addEventListener("blur", away, { once: true });
    setTimeout(() => {
      window.removeEventListener("blur", away);
      if (left || document.hidden) return;
      const note = h("div.open-hint", {}, h("b", { text: "Didn't open?" }), " Open in OCTIVE needs OCTIVE 1.5 or newer installed on Windows or Android. ",
        h("a", { href: "downloads" }, "Download OCTIVE"), h("button.btn.ghost.small", { type: "button", onclick: () => note.remove() }, "OK"));
      document.querySelector(".open-hint")?.remove();
      document.body.append(note);
      setTimeout(() => note.remove(), 9000);
    }, 1800);
  }

  /** #/open/workshop/<id>: a web address for "Open in OCTIVE" (Discord only links to web pages). */
  function openPage() {
    const m = routeHash().match(/^#\/open\/workshop\/([a-z0-9]{16,40})/);
    document.title = "Open in OCTIVE";
    if (!m) { go("workshop"); return; }
    const link = `octive://workshop/${m[1]}`;
    app.replaceChildren(h("section.open-page", {},
      h("img", { src: "logo.svg", alt: "", width: 72, height: 72 }),
      h("h1", { text: "Opening OCTIVE…" }),
      h("p.sub", { text: "OCTIVE opens on the Workshop and gets this item for you." }),
      h("div.open-actions", {},
        h("a.btn.primary", { href: link, onclick: () => openHint() }, "Open in OCTIVE"),
        h("a.btn", { href: `${worker}/api/download/${m[1]}?redirect=1` }, "Download the file"),
        h("a.btn.ghost", { href: "downloads" }, "Get OCTIVE"))));
    setTimeout(() => { location.href = link; openHint(); }, 400);
  }

  // ---------------------------------------------------------------- 3.2: the Workshop, rebuilt (2026-11-27)
  // The user didn't like the song-select Workshop ("change the workshop, full change") and left the pick to me. Now: a
  // spotlight of the newest verified charts on top, the filters always open on the left (a panel on phones), and every
  // item as a wide card with its art behind it, its stars, a coloured dot per difficulty, its numbers and buttons.
  const WK_BANDS = [[0, 2.5], [2.5, 4], [4, 6], [6, 8], [8, 0]];
  const WK_SORTS = [["new", "Newest"], ["popular", "Most downloaded"], ["liked", "Most liked"], ["hardest", "Stars: highest"], ["easiest", "Stars: lowest"],
    ["pr", "Most PR"], ["title", "Title (A–Z)"], ["oldest", "Oldest"]];
  const wkWhen = (t) => (t ? ago(new Date(t).toISOString()) : "");
  /** Every difficulty of a Workshop item, easiest first: [{ name, stars, keys, song }]. */
  function wkDiffs(it) {
    return (it.songs || []).flatMap((sg) => (sg.charts || []).map((c) => ({ name: c.difficulty || "Chart", stars: Number(c.stars) || 0, keys: c.keys, song: sg.title || "" })))
      .sort((a, b) => a.stars - b.stars);
  }
  /** A dot per difficulty in its star colour (up to max, then +N). Pointing at them (or tapping them) lists every
   *  difficulty under the card, like osu!'s beatmap listing. */
  function wkDots(it, max = 12) {
    const d = wkDiffs(it);
    if (!d.length) return null;
    return h("button.wk-dots", { type: "button", "aria-expanded": "false", "aria-label": `${d.length} difficult${d.length === 1 ? "y" : "ies"}: show them` },
      ...d.slice(0, max).map((x) => h("i", { style: `--s:${starColor(x.stars)}` })),
      d.length > max ? h("small", { text: "+" + (d.length - max) }) : null);
  }
  /** The list that opens under a card: every difficulty, easiest first, with its stars, name and keys (and song, in a pack). */
  function wkDiffList(it) {
    // the song's title only helps when a pack's songs have different titles
    const d = wkDiffs(it), pack = new Set(d.map((x) => x.song)).size > 1;
    return h("div.wk-pop", { role: "list", "aria-label": "Difficulties" },
      ...d.map((x) => h("div.wk-pop-row", { role: "listitem" },
        h("span.wk-pop-star", { style: `--s:${starColor(x.stars)}`, text: "★ " + x.stars.toFixed(2) }),
        h("span.wk-pop-name", { text: x.name, title: x.name }),
        h("small", { text: [pack ? x.song : "", x.keys ? x.keys + "K" : ""].filter(Boolean).join(" · ") }))));
  }
  let wkOpenCell = null;
  /** What an item is in a few words: a chart's keys and its BPM and length (one song) or how many songs (a pack). */
  function wkFacts(it) {
    if (it.type !== "charts") return [WS_LABEL[it.type] || it.type];
    const songs = it.songs || [], out = [];
    if ((it.keys || []).length) out.push(it.keys.map((k) => k + "K").join(" "));
    if (songs.length > 1) out.push(`${songs.length} songs`);
    else if (songs[0]) {
      if (songs[0].bpm > 0) out.push(`${Math.round(songs[0].bpm)} BPM`);
      if (songs[0].durationUs > 0) out.push(mmss(songs[0].durationUs / 1e6));
    }
    return out;
  }
  /** A Workshop item as a wide card: its picture (▶ to listen, + for your list), its art faintly behind, its stars,
   *  title, maker, numbers and difficulties. The whole card opens its page. */
  function wkCard(it) {
    // one item on its own (a chart list) comes without its summary: work out its stars and keys from its difficulties
    if (it.type === "charts" && !(it.topStars > 0 && (it.keys || []).length)) {
      const d = wkDiffs(it);
      it = { ...it, topStars: it.topStars > 0 ? it.topStars : (d.length ? d[d.length - 1].stars : 0),
        keys: (it.keys || []).length ? it.keys : [...new Set(d.map((x) => x.keys).filter(Boolean))].sort((a, b) => a - b) };
    }
    const isChart = it.type === "charts";
    const top = Number(it.topStars) || 0;
    const href = "workshop/" + it.id;
    const pic = h("div.wk-pic" + (it.type === "skins" || it.type === "styles" ? ".contain" : ""));
    if (it.preview) pic.append(waitPic(pic, h("img", { src: it.preview, alt: "", loading: "lazy" })));
    else pic.append(h("span.wk-noart", { text: isChart ? "♪" : (WS_LABEL[it.type] || "?").charAt(0) }));
    if (isChart) pic.append(playBtn(it), listBtn(it));
    const facts = wkFacts(it);
    const when = wkWhen(it.at);
    const tint = isChart && top > 0 ? `--c:${starColor(top)}` : null;
    // (3.2) in the spotlight (bought in the game's points shop): gold, like in the game
    const lit = !!(it.spotlight && Date.parse(it.spotlight) > Date.now());
    const card = h("article.wk-card" + (isChart ? "" : ".wk-thing") + (lit ? ".wk-lit" : ""), { style: tint },
      it.preview ? h("img.wk-bg", { src: it.preview, alt: "", loading: "lazy", "aria-hidden": "true" }) : null,
      pic,
      h("div.wk-body", {},
        h("div.wk-top", {},
          lit ? h("span.wk-spotchip", { text: "★ Spotlight", title: "Its maker put it on top of the Workshop for a day" }) : null,
          isChart && top > 0 ? h("span.wk-star", { text: "★ " + top.toFixed(2), title: "Its hardest difficulty" }) : h("span.wk-kind", { text: WS_LABEL[it.type] || it.type }),
          it.verified && isChart ? h("span.wk-ver", { text: "Verified", title: "Verified by OCTIVE: global leaderboards and full PR" }) : null,
          it.customizable && !isChart ? h("span.wk-ver", { text: "Customizable", title: "Its maker allows changes" }) : null,
          it.builtin ? h("span.wk-own", { text: "OCTIVE", title: "One of OCTIVE's own" }) : null,
          h("span.wk-stats", {},
            h("span", { title: `${fmt0.format(it.likes || 0)} like${it.likes === 1 ? "" : "s"}` }, h("i", { text: "♥" }), fmt0.format(it.likes || 0)),
            h("span", { title: `${fmt0.format(it.downloads || 0)} download${it.downloads === 1 ? "" : "s"}` }, h("i", { text: "↓" }), fmt0.format(it.downloads || 0)))),
        h("h3.wk-title", {}, h("a", { href, text: it.title, title: it.title })),
        h("p.wk-by", {}, "by ", h("a", { href: profileHref(it.creatorId || ""), text: it.creator || "someone" }), facts.length ? h("span", { text: " · " + facts.join(" · ") }) : null),
        h("div.wk-foot", {},
          isChart ? wkDots(it) : h("span.wk-when", { text: when }),
          isChart && it.topPR > 0 ? h("b.wk-pr", { text: fmt0.format(Math.round(it.topPR)) + " PR",
            title: it.verified ? "The most PR its hardest difficulty gives" : "The most PR its hardest difficulty gives. Not verified yet, so a third of it counts toward totals and the global ranking." })
            : isChart ? h("span.wk-when", { text: when }) : null)));
    // (3.2) the card sits in a cell, so the list of difficulties can open under it, over the cards below
    const cell = h("div.wk-cell", { style: tint }, card);
    const dots = card.querySelector(".wk-dots");
    if (!dots) return cell;
    const pop = wkDiffList(it);
    cell.append(pop);
    const open = (on) => {
      if (on && wkOpenCell && wkOpenCell !== cell) wkOpenCell._open(false);
      cell.classList.toggle("pop", on);
      dots.setAttribute("aria-expanded", String(on));
      wkOpenCell = on ? cell : wkOpenCell === cell ? null : wkOpenCell;
    };
    cell._open = open;
    dots.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") open(true); });
    cell.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") open(false); });
    // a mouse already opened it by pointing; a tap or Enter opens and closes it
    dots.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); open(e.pointerType === "mouse" ? true : !cell.classList.contains("pop")); });
    cell.addEventListener("keydown", (e) => { if (e.key === "Escape" && cell.classList.contains("pop")) { open(false); dots.focus(); } });
    cell.addEventListener("focusout", (e) => { if (!cell.contains(e.relatedTarget)) open(false); });
    return cell;
  }
  /** Loading: grey cards in the shape of the real ones. */
  const wkGhosts = (n) => Array.from({ length: n }, () => h("div.wk-card.wk-ghost", { "aria-hidden": "true" }, h("div.wk-pic.pic-wait"), h("div.wk-body", {}, h("i"), h("i"), h("i"))));

  /** The Workshop's spotlight, one at a time, big (it moves on by itself until you pick one): first the uploads their makers
   *  put in the spotlight (bought in the game's points shop: on top of the Workshop for a day, gold), then the newest
   *  verified charts. */
  function wkSpotlight() {
    const box = h("section.wk-spot.wk-spot-wait", { "aria-label": "Spotlight" });
    // everything, newest first (the server puts uploads in the spotlight first)
    cachedJson(`${worker}/api/items?sort=new`, 120_000).then((d) => {
      const all = (d && d.items) || [];
      const lit = all.filter((x) => x.spotlight && Date.parse(x.spotlight) > Date.now()).slice(0, 10);
      const fresh = all.filter((x) => x.type === "charts" && x.verified && x.preview && !lit.includes(x));
      const picks = [...lit, ...fresh].slice(0, Math.max(6, lit.length));
      if (!box.isConnected) return;
      if (!picks.length) { box.remove(); return; }
      box.classList.remove("wk-spot-wait");
      let at = 0, timer = null, held = false;
      const bg = h("img.wk-spot-bg", { alt: "", "aria-hidden": "true" });
      const artImg = h("img", { alt: "" });
      const art = h("a.wk-spot-art", { "aria-label": "Open the chart" }, artImg);
      const play = h("span.wk-spot-play");
      const text = h("div.wk-spot-text");
      const pager = h("div.wk-spot-pager", { role: "group", "aria-label": "Spotlight charts" });
      const stop = () => { held = true; clearInterval(timer); };
      function show(i) {
        at = (i + picks.length) % picks.length;
        const it = picks[at], top = Number(it.topStars) || 0, diffs = wkDiffs(it), isLit = !!it.spotlight, isChart = it.type === "charts";
        box.style.setProperty("--c", isLit ? "#ffd23f" : top > 0 ? starColor(top) : "#ff4d9d");
        box.classList.toggle("lit", isLit);
        // (an upload without a picture can be in the spotlight too)
        for (const img of [bg, artImg]) { img.hidden = !it.preview; if (it.preview) img.src = it.preview; else img.removeAttribute("src"); }
        art.classList.toggle("noart", !it.preview);
        art.classList.toggle("contain", it.type === "skins" || it.type === "styles");
        art.href = "workshop/" + it.id;
        play.replaceChildren(playBtn(it, "big") || "");
        const left = isLit ? Math.max(0, Date.parse(it.spotlight) - Date.now()) : 0;
        text.replaceChildren(
          isLit ? h("p.wk-spot-tag.lit", {}, h("b", { text: "★ Spotlight" }), h("span", { text: `${left >= 3600e3 ? Math.floor(left / 3600e3) + "h" : Math.max(1, Math.ceil(left / 60e3)) + " min"} left in the spotlight` }))
            : h("p.wk-spot-tag", {}, h("b", { text: "New" }), h("span", { text: "Verified chart" })),
          h("h2.wk-spot-title", {}, h("a", { href: "workshop/" + it.id, text: it.title, title: it.title })),
          h("p.wk-spot-by", {}, "by ", h("a", { href: profileHref(it.creatorId || ""), text: it.creator || "someone" }),
            h("span", { text: " · " + [...wkFacts(it), isChart ? `${diffs.length} difficult${diffs.length === 1 ? "y" : "ies"}` : ""].filter(Boolean).join(" · ") })),
          diffs.length ? h("div.wk-spot-diffs", {}, ...diffs.slice(-6).map((x) => h("span", { style: `--s:${starColor(x.stars)}`, title: x.name, text: "★ " + x.stars.toFixed(2) })),
            diffs.length > 6 ? h("small", { text: `+${diffs.length - 6} more` }) : null) : null,
          h("div.wk-spot-acts", {},
            h("a.btn.primary", { href: `${worker}/api/download/${it.id}?redirect=1` }, "Download"),
            h("a.btn", { href: `octive://workshop/${it.id}`, title: "Opens OCTIVE (starting it if it's closed), goes to the Workshop and gets this", onclick: () => openHint() }, "Open in OCTIVE"),
            isChart ? listBtn(it, true) : null));
        [...pager.children].forEach((b, k) => { b.classList.toggle("on", k === at); b.setAttribute("aria-pressed", String(k === at)); });
        box.classList.remove("in"); void box.offsetWidth; box.classList.add("in");
      }
      picks.forEach((it, k) => pager.append(h("button", { type: "button", "aria-label": it.title, title: it.title, onclick: () => { stop(); show(k); } })));
      box.replaceChildren(bg,
        h("div.wk-spot-in", {}, text,
          h("div.wk-spot-side", {}, h("div.wk-spot-artwrap", {}, art, play),
            h("div.wk-spot-nav", {},
              h("button.wk-spot-arrow", { type: "button", "aria-label": "Previous chart", onclick: () => { stop(); show(at - 1); } }, "‹"),
              pager,
              h("button.wk-spot-arrow", { type: "button", "aria-label": "Next chart", onclick: () => { stop(); show(at + 1); } }, "›")))));
      show(0);
      timer = setInterval(() => {
        if (!box.isConnected) { clearInterval(timer); return; }
        if (!held && !document.hidden && !box.matches(":hover, :focus-within")) show(at + 1);
      }, 7000);
    });
    return box;
  }

  function workshopPage() {
    const one = (routeHash().match(/^#\/workshop\/([a-z0-9]{16,40})/) || [])[1];
    if (one) { workshopItemPage(one); paintListPill(); return; }
    const wq = new URLSearchParams((routeHash().split("?")[1] || ""));
    // (3.0) workshop/?list=a,b,c: a shared chart list
    if (wq.get("list") != null) { chartListPage(String(wq.get("list") || "").split(",").map((x) => x.trim()).filter(Boolean)); paintListPill(); return; }
    // (3.0) star range and tags from the address (a profile's "Charts for them" → More)
    if (wq.get("minStars") || wq.get("maxStars") || wq.get("tags")) {
      wsType = "charts"; wsF.minStars = wq.get("minStars") || ""; wsF.maxStars = wq.get("maxStars") || "";
      wsF.tags = new Set(String(wq.get("tags") || "").split(",").filter((t) => WS_TAGS.some(([id]) => id === t)));
    }
    // workshop?sort=liked (the home page's Most liked charts link), workshop?verified=1
    const wantSort = wq.get("sort");
    if (wantSort && WK_SORTS.some(([k]) => k === wantSort)) { wsSort = wantSort; wsType = "charts"; }
    const wantVer = wq.get("verified");
    if (wantVer === "1" || wantVer === "0") { wsVerified = wantVer; wsType = "charts"; }
    document.title = "Workshop · OCTIVE";

    // the head: what it is, and how much there is
    const stat = (label) => h("div.stat", {}, h("span.stat-label", { text: label }), h("span.stat-value", { text: "–" }));
    const stats = { charts: stat("Charts"), verified: stat("Verified"), other: stat("Skins and themes") };
    const head = h("section.hero.wk-hero", {},
      h("div", {}, h("p.eyebrow", { text: "Made by players" }), h("h1", { text: "Workshop" }),
        h("p.sub", { text: "Charts, skins, themes and styles players made. Listen first, then download them or open them straight in OCTIVE. Share yours from the game: Play → Workshop → Share." })),
      h("div.hero-side", {}, stats.charts, stats.verified, stats.other));

    // the bar: what to show, the search and the order
    const types = h("div.wk-types", { role: "tablist", "aria-label": "What to show" });
    const search = h("input.wk-q", { type: "search", placeholder: "Search charts, creators and players…", value: wsQuery, "aria-label": "Search the Workshop" });
    const sIc = h("span.wk-sic", { "aria-hidden": "true" });
    sIc.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/></svg>';
    const sort = h("select.wk-sort", { "aria-label": "Order" }, ...WK_SORTS.map(([v, t]) => h("option", { value: v, text: t })));
    sort.value = wsSort;
    const side = h("aside.wk-side", { "aria-label": "Filters" });
    const filterBtn = h("button.btn.small.wk-filter-btn", { type: "button", "aria-expanded": "false" }, "Filters");
    filterBtn.addEventListener("click", () => { const open = !side.classList.contains("open"); side.classList.toggle("open", open); filterBtn.setAttribute("aria-expanded", String(open)); });

    // the results: how many, Surprise me, your list, players the search found, the cards
    const status = h("p.wk-status", { text: "Loading…" });
    const grid = h("div.wk-grid", {}, ...wkGhosts(6));
    const people = h("div.ws-people", { hidden: true });
    function paintPeople() {
      const q = (wsQuery || "").toLowerCase();
      const found = q.length >= 2 && data ? data.players.filter((p) => (p.name || "").toLowerCase().includes(q)).slice(0, 8) : [];
      people.hidden = !found.length;
      people.replaceChildren(...(found.length ? [h("span.ws-people-cap", { text: `Players · ${found.length}` }), h("div.ws-people-row", {}, ...found.map(playerChip))] : []));
    }
    let shown = [];
    const surprise = h("button.btn.small.wk-surprise", { type: "button", title: "Open a random one of the items showing", onclick: () => {
      if (!shown.length) { toast("Nothing to pick from: change the filters."); return; }
      go("workshop/" + shown[Math.floor(Math.random() * shown.length)].id);
    } }, h("span.ws-dice", { text: "⚄" }), "Surprise me");
    const myList = h("button.btn.small.ws-mylist", { type: "button", onclick: () => openListDrawer() });
    const paintMyList = () => { const n = chartList().length; myList.replaceChildren(h("span.wl-note", { text: "♪" }), n ? `My list · ${n}` : "My list"); myList.disabled = !n; myList.title = n ? "Your chart list" : "Add charts with the + on their pictures"; };
    paintMyList();
    myList._paint = paintMyList;

    // the filters (the same as the game's Filters panel)
    let typed = null;
    const later = () => { clearTimeout(typed); typed = setTimeout(load, 350); };
    const clearAll = () => { wsVerified = ""; wsCustom = false; wsF.builtin = false; wsF.by = ""; wsF.charter = ""; wsF.keys.clear(); wsF.minStars = ""; wsF.maxStars = ""; wsF.tags.clear(); paintSide(); load(); };
    const clearBtn = h("button.wk-clear", { type: "button", onclick: clearAll });
    const paintCount = () => {
      const n = wsActive();
      filterBtn.textContent = n ? `Filters · ${n}` : "Filters";
      clearBtn.hidden = !n;
      clearBtn.textContent = `Clear ${n}`;
    };
    const chip = (text, on, click, title, style) => { const b = h("button.wk-chip" + (on ? ".on" : ""), { type: "button", title, style, "aria-pressed": String(!!on) }, text); b.addEventListener("click", click); return b; };
    const group = (title, ...kids) => h("section.wk-fgroup", {}, h("h3", { text: title }), ...kids);
    function paintSide() {
      const changed = () => { paintSide(); load(); };
      const groups = [];
      if (wsType === "charts") groups.push(group("Show", h("div.wk-seg", {},
        chip("All", !wsVerified, () => { wsVerified = ""; changed(); }),
        chip("Verified", wsVerified === "1", () => { wsVerified = "1"; changed(); }, "Checked by OCTIVE: global leaderboards and full PR"),
        chip("Not yet", wsVerified === "0", () => { wsVerified = "0"; changed(); }, "Not verified yet"))));
      const only = [chip("OCTIVE's own", wsF.builtin, () => { wsF.builtin = !wsF.builtin; changed(); }, "OCTIVE's official songs, skins and themes")];
      if (wsType === "skins" || wsType === "styles") only.push(chip("Customizable", wsCustom, () => { wsCustom = !wsCustom; changed(); }, "Only ones their makers allow you to change"));
      groups.push(group("Only", h("div.wk-chips", {}, ...only)));
      if (wsType === "charts") {
        groups.push(group("Keys", h("div.wk-chips.wk-keys", {}, ...[4, 5, 6, 7, 8, 9, 10].map((k) => chip(k + "K", wsF.keys.has(k), () => { wsF.keys.has(k) ? wsF.keys.delete(k) : wsF.keys.add(k); changed(); })))));
        const lo = Number(wsF.minStars) || 0, hi = Number(wsF.maxStars) || 0;
        const bands = WK_BANDS.map(([a, b]) => {
          const on = (a || b) && lo === a && hi === b;
          return chip(b ? `${a}–${b}` : `${a}+`, on, () => { if (on) { wsF.minStars = ""; wsF.maxStars = ""; } else { wsF.minStars = a ? String(a) : ""; wsF.maxStars = b ? String(b) : ""; } changed(); },
            b ? `Hardest difficulty from ★ ${a} to ★ ${b}` : `Hardest difficulty ★ ${a} or more`, `--s:${starColor(a + 0.01)}`);
        });
        const mn = h("input.wk-num", { type: "number", min: 0, max: 99, step: 0.1, placeholder: "from", value: wsF.minStars, "aria-label": "Stars from" });
        const mx = h("input.wk-num", { type: "number", min: 0, max: 99, step: 0.1, placeholder: "to", value: wsF.maxStars, "aria-label": "Stars up to" });
        mn.addEventListener("input", () => { wsF.minStars = mn.value; paintCount(); later(); });
        mx.addEventListener("input", () => { wsF.maxStars = mx.value; paintCount(); later(); });
        groups.push(group("Stars", h("div.wk-chips.wk-bands", {}, ...bands), h("div.wk-range", {}, h("span", { text: "★" }), mn, h("span", { text: "to" }), mx)));
        const all = side.dataset.tags === "all";
        const tags = WS_TAGS.filter(([id], i) => all || i < 10 || wsF.tags.has(id));
        groups.push(group("Tags", h("div.wk-chips", {},
          ...tags.map(([id, name]) => chip(name, wsF.tags.has(id), () => { wsF.tags.has(id) ? wsF.tags.delete(id) : wsF.tags.add(id); changed(); })),
          all ? null : h("button.wk-more", { type: "button", onclick: () => { side.dataset.tags = "all"; paintSide(); } }, `+ ${WS_TAGS.length - tags.length} more`))));
        const ch = h("input.wk-text", { type: "search", placeholder: "A charter's name", value: wsF.charter, "aria-label": "Charter" });
        ch.addEventListener("input", () => { wsF.charter = ch.value.trim(); paintCount(); later(); });
        groups.push(group("Charter", ch));
      }
      const by = h("input.wk-text", { type: "search", placeholder: "A player's name", value: wsF.by, "aria-label": "Uploaded by" });
      by.addEventListener("input", () => { wsF.by = by.value.trim(); paintCount(); later(); });
      groups.push(group("Uploaded by", by));
      side.replaceChildren(h("div.wk-side-head", {}, h("b", { text: "Filters" }), clearBtn), ...groups);
      paintCount();
    }

    let counts = {};
    const paintTypes = () => types.replaceChildren(...WS_TYPES.map(([id, name]) => {
      const b = h("button.wk-type" + (id === wsType ? ".on" : ""), { type: "button", role: "tab", "aria-selected": String(id === wsType) },
        h("span", { text: name }), counts[id] != null ? h("small", { text: fmt0.format(counts[id]) }) : null);
      b.addEventListener("click", () => { if (wsType === id) return; wsType = id; paintTypes(); paintSide(); load(); });
      return b;
    }));
    let gen = 0;
    function load() {
      const g = ++gen;
      status.textContent = "Loading…";
      grid.classList.add("wk-loading");
      paintPeople();
      fetch(`${worker}/api/items?${wsQueryString()}`, { cache: "no-cache" })
        .then((r) => r.ok ? r.json() : null).catch(() => null).then((d) => {
          if (g !== gen || !grid.isConnected) return;
          grid.classList.remove("wk-loading");
          if (!d) { status.textContent = "The Workshop can't be reached right now."; grid.replaceChildren(); shown = []; return; }
          counts = d.counts || {}; paintTypes();
          stats.charts.lastChild.textContent = fmt0.format(counts.charts || 0);
          if (Number.isFinite(d.verifiedCharts)) stats.verified.lastChild.textContent = fmt0.format(d.verifiedCharts);
          stats.other.lastChild.textContent = fmt0.format((counts.skins || 0) + (counts.themes || 0) + (counts.styles || 0));
          const what = (WS_TYPES.find((t) => t[0] === wsType) || [, "items"])[1].toLowerCase();
          const n = wsActive();
          const order = (WK_SORTS.find(([k]) => k === wsSort) || [, ""])[1];
          const one = (WS_LABEL[wsType] || "item").toLowerCase();
          status.replaceChildren(...(d.items.length
            ? [h("b", { text: `${fmt0.format(d.items.length)} ${d.items.length === 1 ? one : what}` }), h("span", { text: [order && " · " + order.toLowerCase(), n ? ` · ${n} filter${n === 1 ? "" : "s"} on` : "",
              d.pending ? ` · ${d.pending} older upload${d.pending === 1 ? " is" : "s are"} still being read for these filters` : ""].join("") })]
            : [h("span", { text: wsQuery ? `No ${what} match "${wsQuery}".` : n ? `No ${what} match these filters.` : `No ${what} shared yet.` })]));
          grid.replaceChildren(...(d.items.length ? d.items.map(wkCard)
            : [h("div.wk-empty", {}, h("b", { text: "Nothing here" }), h("p", { text: n ? "Try fewer filters." : wsQuery ? "Try other words, or a creator's name." : "Share yours from the game: Play → Workshop → Share." }),
              n ? h("button.btn.small", { type: "button", onclick: clearAll }, "Clear the filters") : null)]));
          shown = d.items;
        });
    }
    let t = null;
    search.addEventListener("input", () => { wsQuery = search.value.trim(); clearTimeout(t); t = setTimeout(load, 250); });
    sort.addEventListener("change", () => { wsSort = sort.value; load(); });

    app.replaceChildren(h("div.wk-page", {},
      head,
      wkSpotlight(),
      h("div.wk-bar", {}, types, h("label.wk-search", {}, sIc, search), sort, filterBtn),
      h("div.wk-main", {}, side,
        h("div.wk-results", {},
          h("div.wk-results-head", {}, status, h("div.wk-head-acts", {}, surprise, myList)),
          people, grid))));
    paintTypes();
    paintSide();
    load();
  }

  /** One Workshop item: a banner from its picture, its numbers and tags, then (songs) every difficulty, like an osu! beatmap page. */
  function workshopItemPage(id) {
    document.title = "Workshop · OCTIVE";
    const box = h("div.ws-item", {}, h("p.empty", { text: "Loading…" }));
    app.replaceChildren(h("div.ws-page", {}, h("a.back", { href: "workshop" }, "← Workshop"), box));
    fetch(`${worker}/api/items/${id}`, { cache: "no-cache" }).then((r) => r.ok ? r.json() : null).catch(() => null).then((d) => {
      if (!box.isConnected) return;
      const it = d && d.item;
      if (!it) { box.replaceChildren(h("p.empty", { text: "That item isn't in the Workshop any more." })); return; }
      document.title = `${it.title} · Workshop · OCTIVE`;
      const kb = it.size / 1048576;
      const songs = (it.meta && it.meta.songs) || it.songs || [];
      const charts = songs.flatMap((sg) => sg.charts || []);
      const top = charts.reduce((m, c) => Math.max(m, Number(c.stars) || 0), 0);
      const keys = [...new Set(charts.map((c) => c.keys).filter(Boolean))].sort((a, b) => a - b);
      const date = (t) => new Date(t).toLocaleDateString(undefined, { dateStyle: "medium" });
      const isSong = it.type === "charts";
      // (2.1.2) likes and reviews: the same data the game shows (/api/items/<id>/reviews, like, review, unreview)
      const social = { likes: it.likes || 0, liked: false, reviews: [], count: it.reviews || 0, mine: null, loaded: false };
      const likeChip = h("span.wsi-chip.likes", { title: "Likes" });
      const revChip = h("span.wsi-chip.revs", { title: "Reviews" });
      const likeBtn = h("button.btn.ws-like", { type: "button" });

      // the banner: the picture sharp on the left and blurred behind everything
      const pic = h("div.wsi-pic" + (it.type === "skins" || it.type === "styles" ? ".contain" : ""));
      if (it.preview) pic.append(waitPic(pic, h("img", { src: it.preview, alt: "" })));
      if (isSong) pic.append(playBtn(it, "big"));
      if (it.verified && isSong) pic.append(h("span.ws-verified", { text: "✓ VERIFIED", title: "Verified by OCTIVE: global leaderboards and full PR" }));
      if (isSong && top > 0) pic.append(h("span.ws-stars", { text: "★ " + top.toFixed(2), style: `background:${starColor(top)}` }));
      const chip = (text, title, cls, style) => h("span.wsi-chip" + (cls ? "." + cls : ""), { title, style }, text);
      const sg0 = songs[0] || {};
      const stats = h("div.wsi-stats", {},
        isSong && top > 0 ? chip("★ " + top.toFixed(2), "Its hardest difficulty", "star", `--c:${starColor(top)}`) : null,
        keys.length ? chip(keys.map((k) => k + "K").join(" · "), "Keys", "keys") : null,
        songs.length === 1 && sg0.bpm ? chip(`${Math.round(sg0.bpm * 10) / 10} BPM`, "Tempo", "bpm") : null,
        songs.length === 1 && sg0.durationUs ? chip(fmtLength(sg0.durationUs), "Length", "len") : null,
        songs.length > 1 ? chip(`${songs.length} songs`, "A pack", "len") : null,
        chip(`${fmt0.format(it.downloads || 0)} download${it.downloads === 1 ? "" : "s"}`, "Downloads", "dls"),
        likeChip, revChip,
        chip(`${kb.toFixed(kb < 1 ? 2 : 1)} MB`, "Size", "size"));
      const tagList = [...new Set([...(it.tags || []), ...charts.flatMap((c) => c.autoTags || [])])];
      const own = new Set(it.tags || []);
      const tags = tagList.length ? h("div.ws-tags.wsi-tags", {}, tagList.map((t) => h("span.ws-tag" + (own.has(t) ? "" : ".auto"), { text: wsTagName(t), title: own.has(t) ? "Tagged by the uploader" : "Auto-tag: worked out from the charts' notes" }))) : null;
      const hero = h("section.wsi-hero", { style: (it.preview ? `--pic:url("${it.preview}");` : "") + (isSong && top > 0 ? `--c:${starColor(top)}` : "") || null },
        pic,
        h("div.wsi-head", {},
          h("span.ws-kind", { text: WS_LABEL[it.type] || it.type }),
          h("h1", { text: it.title }),
          h("a.ws-by", { href: profileHref(it.creatorId || "") }, "by " + (it.creator || "someone")),
          stats, tags,
          h("div.wsi-actions", {},
            h("a.btn.primary", { href: `octive://workshop/${it.id}`, onclick: () => openHint() }, "Open in OCTIVE"),
            likeBtn,
            h("a.btn", { href: `${worker}/api/download/${it.id}?redirect=1` }, (it.fileNames || []).length > 1 ? "Download (first song)" : "Download"),
            it.discord ? h("a.btn.discord", { href: it.discord, target: "_blank", rel: "noopener" }, h("img", { src: "discord.png", alt: "" }), "On Discord") : null,
            listBtn(it, true))));

      // every difficulty: a coloured star tile, its name and charter, its numbers and a bar for how hard it is
      const diffs = h("section.panel.wsi-diffs", {}, h("h2", { text: charts.length ? `Difficulties · ${charts.length}` : "Difficulties" }),
        it.verified && isSong ? h("p.wsi-board-note", { text: "Verified: every difficulty has a global leaderboard. Click one to see it in the Leaderboard below." }) : null);
      const boardPicks = [];
      const hardest = charts.reduce((m, c) => (!m || (Number(c.stars) || 0) > (Number(m.stars) || 0)) ? c : m, null);
      for (const sg of songs) {
        diffs.append(h("div.wsi-song", {}, h("b", { text: `${sg.artist} - ${sg.title}` }),
          h("span", { text: [sg.bpm ? `${Math.round(sg.bpm * 10) / 10} BPM` : "", sg.durationUs ? fmtLength(sg.durationUs) : ""].filter(Boolean).join(" · ") })));
        for (const c of (sg.charts || []).slice().sort((a, b) => a.keys - b.keys || a.stars - b.stars)) {
          const st = Number(c.stars) || 0, col = starColor(st);
          const drow = h("div.wsi-diff", { style: `--c:${col}` },
            h("span.wsi-star", { text: "★ " + st.toFixed(2) }),
            h("div.wsi-diff-name", {}, h("b", { text: c.difficulty || "Chart" }), c.creator ? h("span", { text: "by " + c.creator }) : null),
            h("div.wsi-diff-facts", {},
              h("span", { text: `${c.keys}K` }),
              h("span", { text: `${fmt0.format(c.notes || 0)} notes` }),
              c.nps ? h("span", { text: `${c.nps} NPS`, title: "Notes per second" }) : null,
              c.od != null ? h("span", { text: `OD ${c.od}`, title: "Overall difficulty: how tight the timing is" }) : null),
            h("span.wsi-meter", { title: `${st.toFixed(2)} stars` }, h("span", { style: `width:${Math.min(100, st * 10)}%` })));
          diffs.append(drow);
          if (it.verified && isSong && (c.chartId || c.osuMd5)) boardPicks.push({ sg, c, row: drow });
        }
      }

      // the details on the side
      const row = (k, v) => v == null || v === "" ? null : h("div", {}, h("dt", { text: k }), h("dd", {}, v));
      const osuSet = songs.find((sg) => sg.osuSet > 0)?.osuSet;
      const status = !isSong ? null : it.verified ? h("span.wsi-ok", { text: "✓ Verified" }) : it.verifyRequested ? h("span.wsi-wait", { text: "Waiting for a check" }) : h("span", { text: "Not verified" });
      const info = h("aside.panel.wsi-info", {}, h("h2", { text: "Details" }),
        h("dl", {},
          row("Shared", date(it.at)),
          it.updated ? row("Updated", date(it.updated)) : null,
          row("Version", it.version ? "v" + it.version : null),
          row("Downloads", fmt0.format(it.downloads || 0)),
          row("Size", `${kb.toFixed(kb < 1 ? 2 : 1)} MB`),
          (it.fileNames || []).length > 1 ? row("Files", fmt0.format(it.fileNames.length)) : null,
          row("Status", status),
          osuSet ? row("osu!", h("a", { href: `https://osu.ppy.sh/beatmapsets/${osuSet}`, target: "_blank", rel: "noopener" }, "Beatmap page ↗")) : null,
          it.type === "skins" || it.type === "styles" ? row("Editing", it.customizable ? "Customizable in the skin maker" : "🔒 Only its maker") : null));

      const reviews = h("section.panel.wsi-reviews", {});
      box.replaceChildren(hero,
        h("div.wsi-grid", {},
          h("div.wsi-main", {}, it.description ? h("section.panel.wsi-about", {}, h("h2", { text: "About" }), h("p", { text: it.description })) : null, songs.length ? diffs : null,
            boardPicks.length ? wsBoardBox(boardPicks, hardest) : null, reviews),
          info));
      wsSocial(it, social, { likeBtn, likeChip, revChip, reviews, date });
    });
  }

  /** A short message at the bottom of the screen (review posted, something went wrong). */
  function toast(text) {
    document.querySelector(".site-toast")?.remove();
    const t = h("div.site-toast", { role: "status", text });
    document.body.append(t);
    setTimeout(() => t.classList.add("out"), 2600);
    setTimeout(() => t.remove(), 3100);
  }

  const HEART_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.7 4.5c2.1 0 3.6 1.1 4.3 2.4.7-1.3 2.2-2.4 4.3-2.4 3.7 0 5.8 3.9 4.3 7.3C19.5 16.4 12 21 12 21z"/></svg>';
  const signedInHere = () => !!(store.get("octive.token", true) || store.get("octive.session"));
  /** The signed-in player (loaded once), for "your review" and the moderator's remove button. */
  async function meNow() {
    if (me || !signedInHere()) return me;
    try { if (!store.get("octive.token", true)) await refreshSession(); me = await callApi("me", undefined, true); updateAccountNav(); } catch { /* signed out */ }
    return me;
  }
  /** Senterra, the official account and moderators may remove anyone's review (the server checks it too). */
  const canModerate = (m) => !!m && (m.playerId === ROLE_OWNER || m.playerId === OFFICIAL_ID || findPlayer(m.playerId)?.role === "MOD");

  /** An upload's Like button and Reviews panel, kept in step with the game's (same server data). */
  function wsSocial(it, s, ui) {
    const { likeBtn, likeChip, revChip, reviews, date } = ui;
    let shown = 5, busy = false;
    const paintCounts = () => {
      likeChip.textContent = `♥ ${fmt0.format(s.likes)} like${s.likes === 1 ? "" : "s"}`;
      revChip.textContent = `${fmt0.format(s.count)} review${s.count === 1 ? "" : "s"}`;
      likeBtn.innerHTML = HEART_SVG;
      likeBtn.append(` ${s.liked ? "Liked" : "Like"} · ${fmt0.format(s.likes)}`);
      likeBtn.classList.toggle("on", s.liked);
      likeBtn.title = !signedInHere() ? "Sign in to like it" : s.liked ? "You like this. Press again to take it back." : "Like it (the uploader is told once)";
    };
    likeBtn.addEventListener("click", async () => {
      if (!signedInHere()) { go("account"); return; }
      if (busy) return;
      busy = true;
      const was = { likes: s.likes, liked: s.liked };
      s.liked = !s.liked; s.likes = Math.max(0, s.likes + (s.liked ? 1 : -1)); paintCounts();   // answer at once, fix it after
      try { const r = await callApi(`/api/items/${it.id}/like`, { like: s.liked }, true); s.likes = r.likes ?? s.likes; s.liked = r.liked ?? s.liked; }
      catch (e) { Object.assign(s, was); toast(e.message); }
      busy = false; paintCounts();
    });
    const load = async () => {
      let r = null;
      try { r = await callApi(`/api/items/${it.id}/reviews`, undefined, signedInHere()); }
      catch { try { r = await callApi(`/api/items/${it.id}/reviews`); } catch { /* offline */ } }
      if (r) Object.assign(s, { likes: r.likes || 0, liked: !!r.liked, reviews: r.reviews || [], count: r.count || 0, mine: r.mine || null, loaded: true });
      await meNow();
      paintCounts(); paintReviews();
    };
    const stars = (n) => h("span.rv-stars", { title: `${n} star${n === 1 ? "" : "s"}` }, "★".repeat(n), h("i", { text: "★".repeat(5 - n) }));
    function form() {
      if (!signedInHere()) return h("p.rv-signin", {}, h("a", { href: "account" }, "Sign in"), " to like it and write a review.");
      let rating = s.mine?.rating || 0;
      const text = h("textarea.rv-text", { maxlength: 300, rows: 3, placeholder: s.mine ? "Change your review" : "A short review (up to 300 letters)" });
      text.value = s.mine?.text || "";
      const left = h("span.rv-left");
      const paintLeft = () => { left.textContent = `${text.value.length}/300`; };
      text.addEventListener("input", paintLeft); paintLeft();
      const pick = h("span.rv-pick", { title: "Stars (optional): press the same star again to clear them" });
      const paintPick = () => pick.replaceChildren(...[1, 2, 3, 4, 5].map((i) => h("button" + (i <= rating ? ".on" : ""), { type: "button", "aria-label": `${i} star${i === 1 ? "" : "s"}`, onclick: () => { rating = rating === i ? 0 : i; paintPick(); } }, "★")));
      paintPick();
      const msg = h("span.rv-msg");
      const post = h("button.btn.primary.small", { type: "button" }, s.mine ? "Update" : "Post");
      post.addEventListener("click", async () => {
        if (!text.value.trim()) { msg.textContent = "Write something first."; return; }
        post.disabled = true; msg.textContent = "";
        try {
          const body = { text: text.value };
          if (rating > 0) body.rating = rating;
          await callApi(`/api/items/${it.id}/review`, body, true);
          toast("Review posted.");
          await load();
        } catch (e) { msg.textContent = e.message; post.disabled = false; }
      });
      const del = s.mine ? h("button.btn.ghost.small", { type: "button" }, "Delete mine") : null;
      if (del) del.addEventListener("click", () => remove(s.mine.by, del));
      return h("div.rv-form", {}, text, h("div.rv-row", {}, pick, left, h("span.rv-grow"), msg, del, post));
    }
    async function remove(by, btn) {
      const own = me && by === me.playerId;
      if (!confirm(own ? "Delete your review?" : "Remove this review? (moderator)")) return;
      if (btn) btn.disabled = true;
      try { await callApi(`/api/items/${it.id}/unreview`, { by }, true); await load(); }
      catch (e) { toast(e.message); if (btn) btn.disabled = false; }
    }
    function card(r) {
      const own = me && r.by === me.playerId;
      const long = (r.text || "").length > 220;
      const body = h("p.rv-body" + (long ? ".clamp" : ""), { text: r.text || "" });
      const head = h("div.rv-head", {},
        h("a.rv-name", { href: profileHref(r.by || ""), text: r.name || "Player" }),
        r.rating ? stars(r.rating) : null,
        h("span.rv-when", { text: date(r.at) + (r.edited ? " · edited" : "") }),
        h("span.rv-grow"),
        own || canModerate(me) ? h("button.btn.ghost.small.rv-del", { type: "button", title: own ? "Delete your review" : "Remove this review (moderator)", onclick: (e) => remove(r.by, e.currentTarget) }, own ? "Delete" : "Remove") : null);
      const more = long ? h("button.rv-more", { type: "button", onclick: (e) => { body.classList.remove("clamp"); e.currentTarget.remove(); } }, "Read all") : null;
      return h("article.rv-card" + (own ? ".mine" : ""), {}, head, body, more);
    }
    function paintReviews() {
      const list = s.reviews.slice(0, shown);
      reviews.replaceChildren(
        h("h2", { text: s.count ? `Reviews · ${fmt0.format(s.count)}` : "Reviews" }),
        form(),
        !s.loaded ? h("p.empty", { text: "Loading reviews…" }) : !s.reviews.length ? h("p.empty", { text: "No reviews yet: be the first." }) : h("div.rv-list", {}, list.map(card)),
        s.reviews.length > shown ? h("button.btn.small.rv-show", { type: "button", onclick: () => { shown += 5; paintReviews(); } }, `Show more (${fmt0.format(s.reviews.length - shown)} left)`) : null);
    }
    paintCounts(); paintReviews(); load();
  }


  // ================================================================ 2.1.2 site additions
  /** A small picture for any player: their ranking picture when they're ranked, else their first letter. */
  function smallAvatar(id, name, avatarHash) {
    const box = h("span.avatar", {}, h("img", { alt: "", loading: "lazy", hidden: true }), h("span.initial", { text: (name || "?").charAt(0).toUpperCase() }), h("span.dot", { hidden: true }));
    const p = findPlayer(id);
    if (p) { setAvatar(box, p); return box; }
    box.querySelector(".dot").remove();
    box.style.setProperty("--av", avatarTint(id || name));
    // not in the loaded ranking (yet): their picture straight from the server, the first letter if there's none
    if (worker && id) {
      const img = box.querySelector("img"), initial = box.querySelector(".initial");
      waitForPicture(box, img, initial, `${worker}/avatar/${encodeURIComponent(id)}` + (avatarHash ? `?v=${encodeURIComponent(avatarHash)}` : ""));
      img.onerror = () => { box.classList.remove("av-wait"); img.remove(); initial.hidden = false; };
    }
    return box;
  }

  // ---------------------------------------------------------------- Workshop chart leaderboards (the game's global boards)
  const boardCache = new Map();
  function boardKeyOf(sg, c) {
    const set = Math.round(Number(sg.osuSet) || 0);
    return `${set > 0 ? "osu-" + set : sg.songId}/${set > 0 && c.osuMd5 ? c.osuMd5 : c.chartId}`;
  }
  /** The Leaderboard box: a button per difficulty on top, that difficulty's global board under it. Clicking a
   *  difficulty in the Difficulties box picks it here too (and scrolls down to it). The hardest one shows first. */
  function wsBoardBox(picks, hardest) {
    const content = h("div.wsi-board");
    const tabs = h("div.wb-tabs", { role: "tablist" });
    const multiKeys = new Set(picks.map((p) => p.c.keys)).size > 1;
    const multiSongs = new Set(picks.map((p) => p.sg)).size > 1;
    const box = h("section.panel.wsi-lb", {},
      h("div.wsi-lb-head", {}, h("h2", { text: "Leaderboard" }), h("span.wsi-lb-sub", { text: "Global scores, checked from each play's replay" })),
      tabs, content);
    const buttons = picks.map((p) => {
      const st = Number(p.c.stars) || 0;
      return h("button", { type: "button", role: "tab", style: `--c:${starColor(st)}`, onclick: () => select(p, false) },
        h("b", { text: "★ " + st.toFixed(2) }),
        h("span", { text: (multiSongs ? (p.sg.title || "") + " · " : "") + (p.c.difficulty || "Chart") + (multiKeys ? ` · ${p.c.keys}K` : "") }));
    });
    tabs.append(...buttons);
    function select(p, scroll) {
      buttons.forEach((b, i) => { const on = picks[i] === p; b.classList.toggle("on", on); b.setAttribute("aria-selected", String(on)); });
      picks.forEach((x) => x.row.classList.toggle("on-board", x === p));
      fillBoard(content, boardKeyOf(p.sg, p.c));
      if (scroll) box.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    for (const p of picks) {
      p.row.classList.add("has-board");
      p.row.title = "See its leaderboard";
      p.row.tabIndex = 0;
      p.row.addEventListener("click", () => select(p, true));
      p.row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(p, true); } });
    }
    select(picks.find((p) => p.c === hardest) || picks[picks.length - 1], false);
    return box;
  }
  async function fillBoard(panel, key) {
    panel.replaceChildren(h("p.empty", { text: "Loading the leaderboard…" }));
    let d = boardCache.get(key);
    if (!d) {
      d = await fetch(`${worker}/scores/${key}`, { cache: "no-cache" }).then((r) => r.ok ? r.json() : null).catch(() => null);
      if (d) boardCache.set(key, d);
    }
    const entries = (d && d.entries) || [];
    if (!entries.length) { panel.replaceChildren(h("p.empty", { text: "No scores yet: be the first to set one in the game." })); return; }
    let shown = 10;
    const paint = () => {
      const rows = entries.slice(0, shown).map((e) => h("a.wb-row", { href: profileHref(e.playerId), "data-place": e.rank },
        h("span.wb-rank", { text: "#" + e.rank }),
        smallAvatar(e.playerId, e.name, e.avatarHash),
        h("span.wb-name", {}, h("b", { text: e.name || "Player" }), e.mods ? h("span.wb-mods", { text: e.mods }) : null),
        h("span.wb-score", { text: fmt0.format(e.score || 0) }),
        h("span.wb-acc", { text: (Number(e.accuracy) || 0).toFixed(2) + "%" }),
        h("span.wb-combo" + (e.fullCombo ? ".fc" : ""), { text: e.fullCombo ? "FC" : (e.maxCombo ? fmt0.format(e.maxCombo) + "x" : "") }),
        h("span.wb-pr", { text: e.pp ? fmt0.format(Math.round(e.pp)) + " PR" : "" })));
      panel.replaceChildren(
        h("div.wb-head", {}, h("span", { text: "#" }), h("span"), h("span", { text: "Player" }), h("span", { text: "Score" }), h("span", { text: "Acc" }), h("span", { text: "Combo" }), h("span", { text: "PR" })),
        ...rows,
        entries.length > shown ? h("button.btn.small.wb-more", { type: "button", onclick: (ev) => { ev.stopPropagation(); shown = entries.length; paint(); } }, `Show all ${entries.length}`) : null);
    };
    paint();
  }

  // ---------------------------------------------------------------- Live on Twitch (home page strip)
  /** Everyone streaming right now, most viewers first (the developer, Senterra, always first while live). */
  const liveIds = () => Object.keys(LIVE_NOW || {}).sort((x, y) => (y === ROLE_OWNER) - (x === ROLE_OWNER) || (LIVE_NOW[y].viewers || 0) - (LIVE_NOW[x].viewers || 0));
  /** One stream: their picture with the play mark, name, viewers, how long, the title and Watch stream. */
  function liveCard(id) {
    const lv = LIVE_NOW[id] || {};
    const p = findPlayer(id);
    const name = (p && p.name) || lv.name || "Player";
    const av = smallAvatar(id, name);
    let dot = av.querySelector(".dot");
    if (!dot) { dot = h("span.dot"); av.append(dot); }
    dot.hidden = false; dot.classList.add("live"); dot.innerHTML = LIVE_SVG;
    const mins = lv.startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(lv.startedAt)) / 60000)) : null;
    const since = mins == null ? "" : mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`;
    return h("article.live-card", {},
      h("a.live-who", { href: profileHref(id) }, av, h("span", {}, h("b", { text: name }), h("small", { text: [`${fmt0.format(lv.viewers || 0)} watching`, since && `live for ${since}`].filter(Boolean).join(" · ") }))),
      h("p.live-title", { text: [lv.title, lv.game].filter(Boolean).join(" · ") || `twitch.tv/${lv.login}`, title: lv.title || "" }),
      h("a.btn.small.live-watch", { href: `https://www.twitch.tv/${lv.login}`, target: "_blank", rel: "noopener" }, "Watch stream ▶"));
  }
  /** The home page's strip (one row of streams, "Watch more →" when there are more than fit) and the #/live page. */
  function paintLiveStrip() {
    const ids = liveIds();
    const el = document.querySelector(".hm-live");
    if (el) {
      el.hidden = !ids.length;
      if (!ids.length) el.replaceChildren();
      else {
        const more = h("a.btn.small.live-more-btn", { href: "live", hidden: true }, "Watch more →");
        const row = h("div.live-row.one-row", {}, ...ids.map(liveCard));
        el.replaceChildren(h("div.section-head", {}, h("h2.section-title", {}, h("span.live-pulse"), `Live on Twitch now · ${ids.length}`), more), row);
        fitLiveRow();
      }
    }
    const page = document.querySelector(".live-page .live-row");
    if (page) {
      const head = document.querySelector(".live-page .live-count");
      if (head) head.textContent = ids.length ? `${ids.length} streaming now` : "Nobody is streaming right now";
      page.replaceChildren(...(ids.length ? ids.map(liveCard)
        : [h("p.empty", { text: "Nobody is live right now. Players who link Twitch in the game (Settings → Account → Twitch) show up here while they stream." })]));
    }
  }
  /** Only the first row shows on the home page: Watch more appears when some streams didn't fit. */
  function fitLiveRow() {
    const row = document.querySelector(".hm-live .live-row");
    const more = document.querySelector(".hm-live .live-more-btn");
    if (!row || !more) return;
    const cards = [...row.children];
    cards.forEach((c) => { c.hidden = false; });   // measure them all, then hide the ones past the first row
    const first = cards[0] ? cards[0].offsetTop : 0;
    const past = cards.filter((c) => c.offsetTop > first + 4);
    past.forEach((c) => { c.hidden = true; });
    const hidden = past.length;
    more.hidden = hidden === 0;
    more.textContent = hidden ? `Watch more (${hidden}) →` : "Watch more →";
  }
  let liveFitT = null;
  window.addEventListener("resize", () => { clearTimeout(liveFitT); liveFitT = setTimeout(fitLiveRow, 120); });
  /** #/live: every stream right now (refreshed every minute with the rest of the site). */
  function livePage() {
    document.title = "Live now · OCTIVE";
    app.replaceChildren(h("div.live-page", {},
      h("a.back", { href: "./" }, "← Home"),
      h("section.page-head", {}, h("h1", {}, h("span.live-pulse"), " Live on Twitch"),
        h("p.sub", { text: "OCTIVE players streaming right now, most viewers first. Link your own Twitch in the game (Settings → Account → Twitch) to show up here while you're live." }),
        h("div.ph-chips", {}, h("span.ph-chip.live-count", { text: "…" }))),
      h("div.live-row")));
    paintLiveStrip();
  }

  // ---------------------------------------------------------------- daily charts
  const TIER_COLOR = { easy: "#4ad391", normal: "#4fd6e8", hard: "#f2c14e", extreme: "#ff5c8a" };
  let dailyCache = null, dailyAt = 0;
  async function loadDaily() {
    if (dailyCache && Date.now() - dailyAt < 60_000) return dailyCache;
    const d = await fetch(`${worker}/play/daily`, { cache: "no-cache" }).then((r) => r.ok ? r.json() : null).catch(() => null);
    if (d) { dailyCache = d; dailyAt = Date.now(); }
    return d;
  }
  function untilText(iso) {
    const ms = Math.max(0, Date.parse(iso) - Date.now());
    const hh = Math.floor(ms / 3_600_000), mm = Math.floor(ms / 60_000) % 60, ss = Math.floor(ms / 1000) % 60;
    return `${hh}h ${String(mm).padStart(2, "0")}m ${String(ss).padStart(2, "0")}s`;
  }
  /** The home page's row: today's four charts, small. */
  function loadDailyRow(box) {
    loadDaily().then((d) => {
      if (!box.isConnected) return;
      const tiers = (d && d.tiers) || [];
      if (!tiers.length) { box.hidden = true; return; }
      box.querySelector(".hm-daily-row").replaceChildren(...tiers.map((t) => {
        const col = TIER_COLOR[t.tier] || "#b69bff";
        const best = (t.top || [])[0];
        return h("a.hd-card", { href: "daily", style: `--c:${col}` },
          h("span.hd-pic", {}, t.preview ? h("img", { src: t.preview, alt: "", loading: "lazy", onerror: (e) => e.currentTarget.remove() }) : null, h("span.hd-tier", { text: t.name })),
          h("span.hd-body", {},
            h("b", { text: t.title, title: t.title }),
            h("small", { text: `${t.difficulty} · ★ ${(t.stars || 0).toFixed(2)}` }),
            h("small.hd-best", { text: best ? `Best: ${best.name} · ${best.acc.toFixed(2)}%` : "Nobody yet: be first" })));
      }));
    });
  }
  /** #/daily: today's charts, the scoring and every tier's board.
   *  (3.2) Redone: a countdown to the next charts (with how far the day has gone), the rules in three lines, and each tier
   *  as a wide card: its chart's picture (▶ to listen), the tier and what it multiplies by, the chart, and the day's best. */
  const TIER_MULT = { easy: "×½", normal: "×1", hard: "×2", extreme: "×3" };
  function dailyPage() {
    document.title = "Daily charts · OCTIVE";
    const clock = h("b.dp-clock", { text: "--:--:--" });
    const dayFill = h("i");
    const dateEl = h("small.dp-date");
    const tiersBox = h("div.dp-tiers", {}, ...Array.from({ length: 4 }, () => h("div.dp-tcard.dp-ghost", { "aria-hidden": "true" }, h("div.dp-tart.pic-wait"), h("div.dp-tinfo", {}, h("i"), h("i"), h("i")))));
    const rule = (b, t) => h("li", {}, h("b", { text: b }), h("span", { text: t }));
    app.replaceChildren(h("div.daily-page.dp-page", {},
      h("section.hero.dp-hero", {},
        h("div", {}, h("p.eyebrow", { text: "Every day" }), h("h1", { text: "Daily charts" }),
          h("p.sub", { text: "Four charts for everyone, new every day at midnight UTC. Play them in the game: Play → Daily & Shop." })),
        h("div.dp-timer", { role: "timer", "aria-label": "Time until the next charts" },
          h("small", { text: "New charts in" }), clock, h("span.dp-daybar", { title: "How much of today has gone" }, dayFill), dateEl)),
      h("ul.dp-rules", {},
        rule("One try", "at each chart, once a day"),
        rule("No mods", "every chart as it is"),
        rule("Accuracy is points", "rounded down, times the tier: ×½ ×1 ×2 ×3")),
      tiersBox));
    loadDaily().then((d) => {
      if (!tiersBox.isConnected) return;
      if (!d || !(d.tiers || []).length) { tiersBox.replaceChildren(h("p.empty", { text: "Today's charts can't be loaded right now." })); return; }
      const next = Date.parse(d.nextAt);
      if (d.date) dateEl.textContent = new Date(d.date + "T12:00:00Z").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
      const tick = () => {
        if (!clock.isConnected) { clearInterval(iv); return; }
        const left = Math.max(0, next - Date.now());
        const hh = Math.floor(left / 3_600_000), mm = Math.floor(left / 60_000) % 60, ss = Math.floor(left / 1000) % 60;
        clock.textContent = [hh, mm, ss].map((n) => String(n).padStart(2, "0")).join(":");
        dayFill.style.width = `${Math.min(100, Math.max(0, (1 - left / 86_400_000) * 100)).toFixed(2)}%`;
      };
      const iv = setInterval(tick, 1000); tick();
      tiersBox.replaceChildren(...d.tiers.map((t) => {
        const col = TIER_COLOR[t.tier] || "#b69bff";
        const top = t.top || [];
        const board = h("ol.dp-top");
        let shown = 5;
        const paintBoard = () => board.replaceChildren(
          ...(top.length ? top.slice(0, shown).map((sc, i) => h("li", {}, h("a.dp-row", { href: profileHref(sc.id), "data-place": i + 1 },
              h("span.dp-rank", { text: String(i + 1) }), smallAvatar(sc.id, sc.name), h("b.dp-who", { text: sc.name || "Player" }),
              h("span.dp-acc", { text: (Number(sc.acc) || 0).toFixed(2) + "%" }), h("span.dp-pts", { text: fmt0.format(sc.points || 0) }))))
            : [h("li.dp-none", {}, h("b", { text: "Nobody yet" }), h("span", { text: "Be the first to set a score today." }))]),
          top.length > shown ? h("li.dp-more", {}, h("button.btn.small.ghost", { type: "button", onclick: () => { shown = top.length; paintBoard(); } }, `Show all ${fmt0.format(top.length)}`)) : null);
        paintBoard();
        const art = h("div.dp-tart");
        if (t.preview) art.append(waitPic(art, h("img", { src: t.preview, alt: "", loading: "lazy", onerror: (e) => e.currentTarget.remove() })));
        else art.append(h("span.dp-noart", { text: "♪" }));
        if (t.itemId) art.append(playBtn({ id: t.itemId, title: t.title, creator: t.artist, preview: t.preview, type: "charts" }, "big"));
        return h("article.dp-tcard", { style: `--c:${col}` },
          art,
          h("div.dp-tinfo", {},
            h("div.dp-ttop", {}, h("span.dp-tname", { text: t.name }), h("span.dp-mult", { text: TIER_MULT[t.tier] || "", title: "Your accuracy is multiplied by this" }),
              h("span.dp-tmax", { text: `up to ${fmt0.format(t.maxPoints || 0)} pts` })),
            h("h2.dp-ttitle", { text: t.title || "Chart", title: t.title || "" }),
            h("p.dp-tartist", { text: [t.artist, t.creator ? "charted by " + t.creator : ""].filter(Boolean).join(" · ") }),
            h("div.dp-facts", {},
              h("span.dp-star", { text: "★ " + (t.stars || 0).toFixed(2), style: `--s:${starColor(t.stars || 0)}` }),
              t.difficulty ? h("span", { text: t.difficulty }) : null, h("span", { text: `${t.keys || 4}K` }),
              t.notes ? h("span", { text: `${fmt0.format(t.notes)} notes` }) : null,
              t.durationUs ? h("span", { text: fmtLength(t.durationUs) }) : null),
            h("div.dp-actions", {},
              t.itemId ? h("a.btn.small.primary", { href: `octive://workshop/${t.itemId}`, onclick: () => openHint() }, "Open in OCTIVE") : null,
              t.itemId ? h("a.btn.small", { href: "workshop/" + t.itemId }, "View chart") : null)),
          h("div.dp-tboard", {},
            h("div.dp-tboard-head", {}, h("b", { text: "Today's best" }), h("small", { text: `${fmt0.format(t.players || 0)} played` })),
            board));
      }));
    });
  }

  // ---------------------------------------------------------------- profile progress: rank / PR / accuracy and skills
  /** The profile's graph with tabs: global rank, PR and accuracy, day by day. */
  function progressGraphs(days) {
    const host = h("div.pf-graphs");
    const tabs = h("div.pf-gtabs");
    const metrics = [["Rank", 3], ["PR", 1], ["Accuracy", 2]];
    let cur = 3;
    const paint = () => {
      tabs.replaceChildren(...metrics.map(([label, k]) => h("button" + (k === cur ? ".on" : ""), { type: "button", onclick: () => { cur = k; paint(); } }, label)));
      host.replaceChildren(tabs, metricGraph(days, cur));
    };
    paint();
    return host;
  }
  function metricGraph(days, k) {
    const NS = "http://www.w3.org/2000/svg", W = 600, H = 80, pad = 6;
    const vals = days.map((d) => Number(d[k]) || 0);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const up = k !== 3; // rank: smaller is better, drawn higher
    const y = (v) => hi === lo ? H / 2 : up ? H - pad - (v - lo) / (hi - lo) * (H - pad * 2) : pad + (v - lo) / (hi - lo) * (H - pad * 2);
    const x = (i) => i / (days.length - 1) * W;
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("preserveAspectRatio", "none"); svg.setAttribute("aria-hidden", "true");
    const defs = document.createElementNS(NS, "defs");
    defs.innerHTML = `<linearGradient id="pf-rank-line" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${W}" y2="0"><stop offset="0" stop-color="#a764ff"/><stop offset=".5" stop-color="#ff4d9d"/><stop offset="1" stop-color="#ffd23f"/></linearGradient>`
      + '<linearGradient id="pf-rank-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff4d9d" stop-opacity=".3"/><stop offset="1" stop-color="#ff4d9d" stop-opacity="0"/></linearGradient>';
    const pts = days.map((d, i) => `${x(i).toFixed(1)},${y(vals[i]).toFixed(1)}`).join(" ");
    const area = document.createElementNS(NS, "polygon"); area.setAttribute("points", `0,${H} ${pts} ${W},${H}`);
    const line = document.createElementNS(NS, "polyline"); line.setAttribute("points", pts); line.setAttribute("vector-effect", "non-scaling-stroke");
    svg.append(defs, area, line);
    const dot = h("span.pf-dot", { hidden: true }), tip = h("span.pf-tip", { hidden: true });
    const what = k === 3 ? "Global rank" : k === 1 ? "PR" : "Accuracy";
    const box = h("div.pf-chart", { title: `${what}, day by day` }, svg, dot, tip);
    const dayText = (s) => new Date(s + "T12:00:00Z").toLocaleDateString(undefined, { day: "numeric", month: "short" });
    const valText = (d) => k === 3 ? `#${fmt0.format(d[3])}` : k === 1 ? `${fmt0.format(d[1])} PR` : `${(Number(d[2]) || 0).toFixed(2)}%`;
    box.addEventListener("pointermove", (e) => {
      const r = box.getBoundingClientRect();
      const i = Math.max(0, Math.min(days.length - 1, Math.round((e.clientX - r.left) / r.width * (days.length - 1))));
      const d = days[i], px = x(i) / W * r.width, py = y(vals[i]) / H * r.height;
      dot.hidden = tip.hidden = false;
      dot.style.left = px + "px"; dot.style.top = py + "px";
      tip.textContent = `${valText(d)} · ${dayText(d[0])}`;
      tip.style.left = Math.max(0, Math.min(r.width - tip.offsetWidth, px - tip.offsetWidth / 2)) + "px";
    });
    box.addEventListener("pointerleave", () => { dot.hidden = tip.hidden = true; });
    return box;
  }
  /** The skill radar (the game's): a level for each kind of pattern, from the verified charts they played. */
  function skillsSection(sk) {
    const axes = sk.axes || [];
    const NS = "http://www.w3.org/2000/svg", S = 260, C = S / 2, R = 92;
    const levels = axes.map((a) => Number(a.level) || 0);
    // (2.1.4) the same scale as the game's radar (ProgressView.SkillRadar): 0 in the middle, the best skill + 0.4 (rounded up
    // to a whole star) at the edge, rings at whole stars (every second one past 6)
    const max = Math.max(2, Math.ceil(Math.max(0, ...levels) + 0.4));
    const frac = (v) => Math.max(0, Math.min(1, v / max));
    const ang = (i) => -Math.PI / 2 + i * 2 * Math.PI / axes.length;
    const pt = (i, r) => [C + Math.cos(ang(i)) * r, C + Math.sin(ang(i)) * r];
    const poly = (r) => axes.map((_, i) => pt(i, r).map((v) => v.toFixed(1)).join(",")).join(" ");
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `-62 -14 ${S + 124} ${S + 34}`); svg.setAttribute("class", "sk-radar"); svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Skills: " + axes.map((a) => `${a.name} ${(+a.level).toFixed(1)}`).join(", "));
    let inner = "";
    const step = max > 6 ? 2 : 1;
    for (let st = step; st <= max; st += step) inner += `<polygon class="sk-ring${st === max ? " edge" : ""}" points="${poly(R * st / max)}"/>`;
    axes.forEach((_, i) => { const [x2, y2] = pt(i, R); inner += `<line class="sk-spoke" x1="${C}" y1="${C}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`; });
    if (levels.some((v) => v > 0)) {
      inner += `<polygon class="sk-shape" points="${axes.map((a, i) => pt(i, R * frac(levels[i])).map((v) => v.toFixed(1)).join(",")).join(" ")}"/>`;
      axes.forEach((_, i) => { if (levels[i] > 0) { const [x, y] = pt(i, R * frac(levels[i])); inner += `<circle class="sk-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5"/>`; } });
    }
    axes.forEach((a, i) => {
      const [lx, ly] = pt(i, R + 22);
      const anchor = Math.abs(lx - C) < 8 ? "middle" : lx < C ? "end" : "start";
      const y0 = ly + (ly < C - R * 0.5 ? -6 : ly > C + R * 0.5 ? 6 : -2);
      inner += `<text class="sk-label" x="${lx.toFixed(1)}" y="${y0.toFixed(1)}" text-anchor="${anchor}">${String(a.name).replace(/[<&]/g, "")}`
        + `<tspan class="sk-val" x="${lx.toFixed(1)}" dy="14">★${levels[i].toFixed(1)}</tspan></text>`;
    });
    svg.innerHTML = inner;
    const list = h("ul.sk-list", {}, ...axes.slice().sort((a, b) => b.level - a.level).map((a) => h("li", {},
      h("span", { text: a.name }), h("span.sk-bar", {}, h("i", { style: `width:${frac(Number(a.level) || 0) * 100}%` })), h("b", { text: (Number(a.level) || 0).toFixed(1) }),
      h("small", { text: `${fmt0.format(a.plays || 0)} play${a.plays === 1 ? "" : "s"}` }))));
    // the strongest and the weakest, in words (as the game says it)
    const known = axes.filter((a) => (Number(a.level) || 0) > 0).sort((a, b) => b.level - a.level);
    const best = known.length ? known[0].name : null, weak = known.length > 1 ? known[known.length - 1].name : null;
    return h("section.pf-skills", {},
      h("h2", { text: "Skills" }),
      h("p.sk-sub", {}, h("b.sk-overall", { text: `★${(Number(sk.overall) || 0).toFixed(1)}` }), " overall level"),
      h("div.sk-grid", {}, svg, list),
      best ? h("p.sk-words", { text: `Best at ${best}` + (weak && weak !== best ? ` · could work on ${weak}` : "") + ` · from ${fmt0.format(sk.plays || 0)} verified plays` }) : null);
  }

  // ---------------------------------------------------------------- Workshop search: players too
  function playerChip(p) {
    const a = h("a.ws-person", { href: profileHref(p.id) },
      smallAvatar(p.id, p.name),
      h("span", {}, h("b", { text: p.name || "Player" }), h("small", { text: `#${fmt0.format(p.rank || 0)} · ${fmt0.format(Math.round(p.pp || 0))} PR` })));
    return a;
  }

  const fmtLength = (us) => { const s = Math.round(us / 1e6); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  const starColor = (st) => st >= 8 ? "#ff5c8a" : st >= 6 ? "#b69bff" : st >= 4 ? "#f2c14e" : st >= 2.5 ? "#4ad391" : "#4fd6e8";

  // ---------------------------------------------------------------- downloads

  function download() {
    const card = (cls, os, iconSvg, title, desc, ...rest) => h("article.dl." + cls, {},
      h("div.dl-head", {}, h("span.dl-icon", {}, iconSvg), h("div", {}, h("span.dl-os", { text: os }), h("h3", { text: title }))),
      h("p.dl-desc", { text: desc }), ...rest);
    const svg = (paths) => { const s = document.createElement("span"); s.innerHTML = `<svg viewBox="0 0 24 24">${paths}</svg>`; return s.firstChild; };
    // (2.2.1) the installer or OCTIVE from the Microsoft Store (no Windows warning, and the Store keeps it updated):
    // two matching buttons side by side, one under the other on narrow screens
    const btnIcon = (paths) => {
      const s = svg(paths);
      for (const [k, v] of Object.entries({ width: 18, height: 18, fill: "none", stroke: "currentColor", "stroke-width": 2.2, "stroke-linejoin": "round", "stroke-linecap": "round" })) s.setAttribute(k, v);
      return s;
    };
    const winBtn = h("a.btn.primary.wide", { href: worker + "/releases/OCTIVE-Installer.exe", style: "flex:1 1 190px" },
      btnIcon('<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>'), "Download installer");
    const storeBtn = h("a.btn.primary.wide", { href: "https://apps.microsoft.com/detail/9NWSQ5L9XWB7", target: "_blank", rel: "noopener", style: "flex:1 1 190px" },
      btnIcon('<path d="M4.5 8h15l-1.3 12.5H5.8z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>'), "Microsoft Store");
    const winBtns = h("div.dl-btns", { style: "display:flex;gap:10px;flex-wrap:wrap" }, winBtn, storeBtn);
    const apkBtn = h("a.btn.primary.wide", { href: "#" }, "Download the APK");
    const winSize = h("span.dl-size"), apkSize = h("span.dl-size");
    const win = card("win" + (!isAndroid ? ".suggested" : ""), "Windows", svg('<path d="M3 5.5l7.5-1v7H3zM11.5 4.4L21 3v8.5h-9.5zM3 12.5h7.5v7L3 18.5zM11.5 12.5H21V21l-9.5-1.4z"/>'),
      "Windows 10 and 11", "The installer downloads the newest version, puts OCTIVE in your Start menu and starts it. The game updates itself after that.",
      winBtns, h("div.dl-foot", {}, winSize),
      h("p.dl-note", { text: "Windows may say it protected your PC, because the installer is new. Click More info, then Run anyway. The Microsoft Store version doesn't show this, and the Store keeps it updated." }));
    const android = card("android" + (isAndroid ? ".suggested" : ""), "Android", svg('<path d="M7 9h10v8a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1z"/><path d="M7 8a5 5 0 0 1 10 0z"/><path d="M9 18v3M15 18v3M4.5 10v5M19.5 10v5M8.5 4L7 2M15.5 4L17 2"/>'),
      "Phones and tablets", "Android 8 or newer (64-bit). Open the APK after it downloads; you may need to allow your browser to install apps.",
      apkBtn, h("div.dl-foot", {}, apkSize));
    const linux = card("linux.soon", "Linux", svg('<path d="M12 3c-2 0-3 1.8-3 4 0 1.4.3 2.3-.6 3.6C7.2 12.3 6 14 6 16c0 1 .3 1.7.8 2.2M12 3c2 0 3 1.8 3 4 0 1.4-.3 2.3.6 3.6C16.8 12.3 18 14 18 16c0 1-.3 1.7-.8 2.2"/><path d="M5 19c1.5-.5 2.5-1 3.5 0s2.5 1.5 3.5 1.5 2.5-.5 3.5-1.5 2-.5 3.5 0"/>'),
      "Coming soon", "A Linux version is planned. Until then, the Windows version may run through Proton or Wine.",
      h("span.btn.wide.disabled", { "aria-disabled": "true" }, "Coming soon"));
    const web = h("article.dl.web", {},
      h("div.dl-head", {}, h("span.dl-icon", {}, svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/>')),
        h("div", {}, h("span.dl-os", { text: "Browser" }), h("h3", { text: "Play right now" }))),
      h("p.dl-desc", { text: "No download: play in Chrome, Edge or Firefox. Import .oct or osu! (.osz / .osu) beatmaps; they stay saved in your browser. Same account, scores and friends as the apps." }),
      h("a.btn.primary.wide", { href: "play/" }, "▶ Play in browser"),
      h("p.dl-note", { text: "Timing is tighter in the Windows and Android apps. Controllers work too." }));
    const mac = card("mac.unsupported", "macOS", svg('<path d="M16 3c-1 .2-2.2 1-2.6 2.2-.3.8-.2 1.6-.2 1.6s1.2.1 2.1-.9c.8-.9.9-2.1.7-2.9z"/><path d="M12.5 7.5c-1 0-2-.6-3-.6C7.4 6.9 5 8.6 5 12.3 5 16 7.4 21 9.3 21c1 0 1.6-.6 2.9-.6 1.3 0 1.7.6 2.9.6 1.4 0 2.8-2.4 3.4-4-2-.9-2.6-3.6-.9-5.2.4-.4.9-.7 1.3-.9-.9-1.3-2.2-2-3.5-2-1.2 0-2 .6-2.9.6z"/>'),
      "Not supported", "OCTIVE doesn't run on Macs, and there are no plans for a macOS version right now.",
      h("span.btn.wide.disabled", { "aria-disabled": "true" }, "Not available"));
    const notes = h("section.release-notes", { hidden: true });
    const testerBox = h("section.tester-dl", { hidden: true });
    const verChip = h("span.ph-chip.ver", { text: "Latest version" });
    loadRelease().then((m) => { if (m && m.version) verChip.textContent = "v" + m.version; });
    // (3.0) the one for your device first and big, then the rest
    const first = isAndroid ? android : win, second = isAndroid ? win : android;
    first.classList.add("featured");
    const page = h("div.download-page", {},
      h("section.page-head", {}, h("p.eyebrow", { text: "Free on every device" }), h("h1", { text: "Download OCTIVE" }), h("p.sub", { text: "Free on Windows and Android, or play in your browser. Your account, scores and friends work on all of them." }),
        h("div.ph-chips", {}, h("span.ph-chip.free", { text: "Free" }), verChip, h("span.ph-chip", { text: "Windows · Android · Browser" }))),
      testerBox,
      h("div.dl-grid", {}, first, web, second, linux, mac),
      notes);
    app.replaceChildren(page);
    // testers (signed in here): the newest test build; the server only answers testers
    (async () => {
      if (!worker || !(store.get("octive.token", true) || store.get("octive.session"))) return;
      let t = null;
      try {
        if (!store.get("octive.token", true)) await refreshSession();
        t = (await callApi("/releases/test-links", undefined, true)).test;
      } catch { return; }
      if (!t || !page.isConnected) return;
      const label = `${t.version}-test${t.test}`;
      const onTest = store.get("octive.webChannel") === "test";
      const play = h("button.btn", { type: "button", onclick: () => { store.set("octive.webChannel", onTest ? "release" : "test"); location.href = "play/"; } },
        onTest ? "▶ Play the latest release in the browser" : "▶ Play the test build in the browser");
      testerBox.replaceChildren(
        h("div.tester-head", {}, h("span.badge.tester-tag", { text: "TESTER" }), h("h2", { text: `Test build ${label}` })),
        h("p.panel-sub", { text: "Only testers see this. It's a test build, not a full release: it may have bugs. It installs over your current OCTIVE (songs, scores and settings are kept); after that the game offers newer test builds itself, and the Swap button in the main menu goes back to the latest release. When the full release comes out, test builds update to it." }),
        t.notes ? h("p.tester-notes", { text: t.notes }) : null,
        h("div.tester-btns", {},
          t.windows ? h("a.btn.primary", { href: t.windows.url }, `Windows · ${mb(t.windows.size)}`) : null,
          t.android ? h("a.btn.primary", { href: t.android.url }, `Android APK · ${mb(t.android.size)}`) : null,
          t.web ? play : null),
        h("p.dl-note", { text: "Windows: unzip it anywhere and open OCTIVE.exe; it installs itself over your current version. Android: open the APK. Links work for 2 hours; reload this page for new ones." }));
      testerBox.hidden = false;
    })();
    document.title = "Download · OCTIVE";
    loadRelease().then((m) => {
      if (!m || !page.isConnected) return;
      if (m.windows) {
        winSize.textContent = `Version ${m.version} · ${mb(m.windows.size)} download`;
      }
      if (m.android) { apkBtn.href = worker + "/releases/" + m.android.file; apkSize.textContent = `Version ${m.version} · ${mb(m.android.size)}`; }
      if (m.notes) {
        notes.replaceChildren(h("h2", { text: `What's new in ${m.version}` }), h("p", { text: m.notes }),
          h("span.dl-size", { text: "Released " + new Date(m.published).toLocaleDateString(undefined, { dateStyle: "long" }) }));
        notes.hidden = false;
      }
    });
  }

  // ---------------------------------------------------------------- account (sign in on the site)

  const store = {
    get(k, session) { try { return (session ? sessionStorage : localStorage).getItem(k); } catch { return null; } },
    set(k, v, session) { try { const s = session ? sessionStorage : localStorage; v == null ? s.removeItem(k) : s.setItem(k, v); } catch { /* private mode */ } },
  };
  let me = null;

  async function callApi(path, body, auth) {
    const go = async () => {
      const headers = { "Content-Type": "application/json" };
      const token = store.get("octive.token", true);
      if (auth && token) headers.Authorization = "Bearer " + token;
      const res = await fetch(worker + (path.startsWith("/") ? path : "/account/" + path), { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
      let out = {};
      try { out = await res.json(); } catch { /* empty */ }
      return { res, out };
    };
    let { res, out } = await go();
    if (auth && res.status === 401 && await refreshSession()) ({ res, out } = await go());
    if (!res.ok) { const e = new Error(out.error || "Something went wrong (" + res.status + ")."); e.status = res.status; throw e; }
    return out;
  }

  async function refreshSession() {
    const s = store.get("octive.session");
    if (!s) return false;
    try {
      const res = await fetch(worker + "/account/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionToken: s }) });
      if (!res.ok) { if (res.status === 401) store.set("octive.session", null); return false; }
      const t = await res.json();
      store.set("octive.token", t.token, true);
      if (t.sessionToken) store.set("octive.session", t.sessionToken);
      return true;
    } catch { return false; }
  }

  function signOut() {
    store.set("octive.token", null, true); store.set("octive.session", null); me = null;
    updateAccountNav(); go("account");
  }

  function updateAccountNav() {
    // signed in: your name and picture open your public profile; the gear opens your account settings
    const a = document.querySelector('[data-nav="account"]');
    if (a) {
      const name = a.querySelector(".side-name"), av = a.querySelector(".side-av");
      if (name) name.replaceChildren(me ? me.name : "Sign in", me ? checkEl({ id: me.playerId, check: me.check }) : null);
      else a.textContent = me ? me.name : "Sign in";
      a.setAttribute("href", me && me.hasCard && !me.banned ? profileHref(me.playerId) : "account");
      a.dataset.nav = me && me.hasCard && !me.banned ? "me" : "account";
      a.title = me ? "Your public profile" : "Sign in";
      if (av) {
        const img = av.querySelector("img");
        if (me && me.avatarHash) {
          const src = `${worker}/avatar/${encodeURIComponent(me.playerId)}?v=${encodeURIComponent(me.avatarHash)}`;
          if (img) img.src = src; else av.replaceChildren(h("img", { src, alt: "" }));
        } else if (img) av.replaceChildren(...new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>', "image/svg+xml").childNodes);
      }
    }
    // (3.0) the same in the top bar
    const top = document.querySelector(".top-me");
    if (top) {
      const signedIn = !!me;
      top.href = me && me.hasCard && !me.banned ? profileHref(me.playerId) : "account";
      top.title = signedIn ? "Your profile" : "Sign in";
      top.querySelector(".top-me-name")?.replaceChildren(signedIn ? me.name : "Sign in");
      const tav = top.querySelector(".top-av");
      if (tav) {
        if (me && me.avatarHash) tav.replaceChildren(h("img", { src: `${worker}/avatar/${encodeURIComponent(me.playerId)}?v=${encodeURIComponent(me.avatarHash)}`, alt: "" }));
        else if (tav.querySelector("img")) tav.replaceChildren(...new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>', "image/svg+xml").childNodes);
      }
    }
    const gear = document.querySelector(".nav-settings");
    if (gear) gear.hidden = !me;
    const m = document.querySelector('[data-nav="messages"]');
    if (m) {
      m.hidden = !me;
      const label = m.querySelector(".nav-msg-label");
      if (label) { m.querySelector(".nav-count")?.remove(); if (me && dmUnread > 0) m.append(h("span.nav-count", { text: String(dmUnread) })); }
      else { m.textContent = "Messages"; if (me && dmUnread > 0) m.append(h("span.nav-count", { text: String(dmUnread) })); }
    }
  }

  const field = (label, input, hint) => h("label.field", {}, h("span.field-label", { text: label }), input, hint ? h("span.field-hint", { text: hint }) : null);
  const msg = () => h("p.form-msg", { role: "status" });
  function setMsg(el, text, ok) { el.textContent = text || ""; el.classList.toggle("ok", !!ok); }
  async function busy(btn, fn) {
    if (btn.disabled) return;
    btn.disabled = true; const label = btn.textContent; btn.textContent = "Working…";
    try { await fn(); } finally { btn.disabled = false; btn.textContent = label; }
  }

  async function account() {
    if (!worker) { app.replaceChildren(h("p.empty", { text: "Accounts aren't available on this copy of the site." })); return; }
    document.title = "Account · OCTIVE";
    if (!me && (store.get("octive.token", true) || store.get("octive.session"))) {
      app.replaceChildren(h("p.empty", { text: "Loading your account…" }));
      try {
        if (!store.get("octive.token", true)) await refreshSession();
        me = await callApi("me", undefined, true);
      } catch (e) { if (e.status === 401) { store.set("octive.token", null, true); store.set("octive.session", null); } }
      updateAccountNav();
      if (!routeHash().startsWith("#/account")) return;
    }
    if (!me) return signInPage();
    profilePage();
  }

  function signInPage() {
    const user = h("input", { type: "text", autocomplete: "username", maxlength: 20, required: true, spellcheck: "false" });
    const pass = h("input", { type: "password", autocomplete: "current-password", maxlength: 30, required: true });
    const out = msg();
    const btn = h("button.btn.primary.wide", { type: "submit" }, "Sign in");
    const form = h("form.auth-card", {
      onsubmit: (e) => {
        e.preventDefault();
        busy(btn, async () => {
          setMsg(out, "");
          try {
            const r = await callApi("sign-in", { username: user.value.trim(), password: pass.value });
            store.set("octive.token", r.token, true);
            if (r.sessionToken) store.set("octive.session", r.sessionToken);
            me = r.me; updateAccountNav(); profilePage();
          } catch (err) { setMsg(out, err.message); pass.select(); }
        });
      },
    },
      emblemSvg(64),
      h("h1", { text: "Sign in" }),
      h("p.sub", { text: "Use the same username and password as in the game." }),
      field("Username", user), field("Password", pass),
      out, btn,
      h("div.auth-links", {}, h("a", { href: "reset" }, "Forgot your password?"), h("span", { text: "No account? Make one in the game: Profile → Sign up." })));
    app.replaceChildren(h("div.auth-wrap", {}, form));
    setTimeout(() => user.focus(), 30);
  }

  function section(title, sub, ...kids) {
    return h("section.panel", {}, h("h2", { text: title }), sub ? h("p.panel-sub", { text: sub }) : null, ...kids);
  }

  let accountTab = "supporter";
  function accountHead() {
    const p = { id: me.playerId, name: me.name, badges: me.badges, role: me.badges[0] || null,
      avatar: me.avatarHash ? `${worker}/avatar/${encodeURIComponent(me.playerId)}?v=${encodeURIComponent(me.avatarHash)}` : null,
      supporter: me.supporter && me.supporter.active ? { ...me.supporter, ...(me.looks || {}) } : null };
    const c = me.card || {};
    const status = [me.username ? "@" + me.username : null, c.version ? "last played on v" + c.version : null].filter(Boolean).join(" · ");
    const head = h("article.card.me-card", {},
      h("div.card-avatar", {}, h("img", { alt: "", hidden: true }), h("span.initial")),
      h("div.card-body", {},
        h("div.card-name-row", {}, h("h1.card-name", { text: me.name }), h("span.badge", { hidden: true })),
        status ? h("div.card-status", { text: status }) : null,
        me.hasCard ? h("dl.card-stats", {},
          h("div", {}, h("dt", { text: "Performance" }), h("dd", { text: fmt0.format(c.pp) + " PR" })),
          h("div", {}, h("dt", { text: "Accuracy" }), h("dd", { text: fmt2.format(c.accuracy) + "%" })),
          h("div", {}, h("dt", { text: "Level" }), h("dd", { text: "Lv" + c.level })),
          h("div", {}, h("dt", { text: "Plays" }), h("dd", { text: fmt0.format(c.playCount) }))) : h("p.panel-sub", { text: "Play a chart in the game while signed in and your stats show up here." })),
      h("div.me-actions", {},
        me.hasCard && !me.banned ? h("a.btn", { href: profileHref(me.playerId) }, "Public profile") : null,
        h("button.btn.ghost", { type: "button", onclick: signOut }, "Sign out")));
    setAvatar(head.querySelector(".card-avatar"), p);
    setRole(head, head.querySelector(".badge"), p);
    decorateCard(head, p);
    return head;
  }

  function profilePage() {
    const head = accountHead();
    // one section at a time, picked from the side (a row of tabs on phones)
    const editable = me.hasCard && !me.banned;
    const tabs = [
      editable && ["supporter", "♥ Supporter", supporterPanel],
      editable && ["profile", "Profile", () => h("div", {}, h("div.split", {}, picturePanel(), bioPanel()), me.creator ? socialsPanel() : null)],
      ["preferences", "Preferences", preferencesPanel],
      ["security", "Email & password", () => h("div.split", {}, emailPanel(), passwordPanel())],
    ].filter(Boolean);
    const wanted = hashQuery().get("tab");
    if (wanted && tabs.some((t) => t[0] === wanted)) accountTab = wanted;
    if (accountTab === "discord" || accountTab === "socials") accountTab = accountTab === "discord" ? "preferences" : "profile";
    if (!tabs.some((t) => t[0] === accountTab)) accountTab = tabs[0][0];
    const nav = h("nav.acc-nav", { "aria-label": "Account sections" });
    const body = h("div.acc-body");
    const show = () => {
      nav.replaceChildren(...tabs.map(([id, label]) => h("button.acc-tab" + (id === accountTab ? ".on" : ""), { type: "button", onclick: () => { accountTab = id; show(); } }, label)));
      const t = tabs.find((x) => x[0] === accountTab);
      body.replaceChildren(t[2]());
    };
    show();
    const notices = [];
    if (me.banned) notices.push(h("div.notice", { text: "This account is banned, so it can't be changed or appear in the ranking." }));
    if (!me.hasCard) notices.push(h("div.notice", { text: "Your profile appears online after your first play in the game while signed in. Until then it can't be edited here." }));
    if (me.gifts && me.gifts.length) notices.push(h("button.gift-banner", { type: "button", onclick: () => giftPopup() }, `♥ You have ${me.gifts.length === 1 ? "a supporter gift" : me.gifts.length + " supporter gifts"} to claim`));
    app.replaceChildren(head, ...notices, h("div.acc-layout", {}, nav, body));
    document.title = `${me.name} · OCTIVE`;
    setTimeout(giftPopup, 400);
  }

  async function saveProfile(body, out, okText) {
    try {
      me = await callApi("profile", body, true);
      setMsg(out, okText + " The game picks it up next time it starts.", true);
      if (data) load();
      return true;
    } catch (e) { setMsg(out, e.message); return false; }
  }

  /**
   * A cropping window for a picture before it's saved: drag it to move it, zoom with the slider, the mouse wheel or two
   * fingers. The frame has the shape it's saved in (with a circle guide for profile pictures, which show round). Gives the
   * part of the picture to keep ({ sx, sy, sw, sh } in its pixels), or null when cancelled.
   */
  function cropPicture(bmp, { title, aspect, round }) {
    return new Promise((resolve) => {
      const W = bmp.width, H = bmp.height;
      const VW = Math.max(200, Math.round(Math.min(520, window.innerWidth - 72, (window.innerHeight - 280) * aspect)));
      const VH = Math.round(VW / aspect);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cv = h("canvas.crop-canvas", { width: VW * dpr, height: VH * dpr, "aria-label": "Drag to move the picture" });
      cv.style.width = VW + "px"; cv.style.height = VH + "px";
      if (round) cv.classList.add("round");
      const ctx = cv.getContext("2d");
      const minS = Math.max(VW / W, VH / H), maxS = minS * 8;
      let s = minS, cx = W / 2, cy = H / 2;
      const clamp = () => {
        s = Math.min(maxS, Math.max(minS, s));
        const hw = VW / 2 / s, hh = VH / 2 / s;
        cx = Math.min(W - hw, Math.max(hw, cx)); cy = Math.min(H - hh, Math.max(hh, cy));
      };
      const zoom = h("input.crop-zoom", { type: "range", min: 0, max: 1000, value: 0, "aria-label": "Zoom" });
      const toSlider = () => { zoom.value = String(Math.round(Math.log(s / minS) / Math.log(maxS / minS) * 1000)); };
      const draw = () => {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, VW, VH);
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bmp, VW / 2 - cx * s, VH / 2 - cy * s, W * s, H * s);
        if (round) {
          // outside the circle: darkened (that part shows in square places only)
          ctx.fillStyle = "#04050a99";
          ctx.beginPath(); ctx.rect(0, 0, VW, VH); ctx.arc(VW / 2, VH / 2, Math.min(VW, VH) / 2, 0, Math.PI * 2, true); ctx.fill();
          ctx.strokeStyle = "#ffffffaa"; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(VW / 2, VH / 2, Math.min(VW, VH) / 2 - 1, 0, Math.PI * 2); ctx.stroke();
        }
      };
      // zooming keeps the point under the pointer (or the middle) where it is
      const zoomTo = (ns, px = VW / 2, py = VH / 2) => {
        const ix = cx + (px - VW / 2) / s, iy = cy + (py - VH / 2) / s;
        s = Math.min(maxS, Math.max(minS, ns));
        cx = ix - (px - VW / 2) / s; cy = iy - (py - VH / 2) / s;
        clamp(); toSlider(); draw();
      };
      zoom.addEventListener("input", () => zoomTo(minS * Math.pow(maxS / minS, Number(zoom.value) / 1000)));
      cv.addEventListener("wheel", (e) => {
        e.preventDefault();
        const r = cv.getBoundingClientRect();
        zoomTo(s * Math.pow(1.0015, -e.deltaY), e.clientX - r.left, e.clientY - r.top);
      }, { passive: false });
      // drag with a mouse or a finger; two fingers pinch
      const pts = new Map();
      let pinch = 0;
      cv.addEventListener("pointerdown", (e) => { cv.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); cv.classList.add("dragging"); });
      cv.addEventListener("pointermove", (e) => {
        const p = pts.get(e.pointerId); if (!p) return;
        if (pts.size >= 2) {
          p.x = e.clientX; p.y = e.clientY;
          const [a, b] = [...pts.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          const r = cv.getBoundingClientRect();
          if (pinch > 0) zoomTo(s * d / pinch, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
          pinch = d;
          return;
        }
        cx -= (e.clientX - p.x) / s; cy -= (e.clientY - p.y) / s;
        p.x = e.clientX; p.y = e.clientY;
        clamp(); draw();
      });
      const up = (e) => { pts.delete(e.pointerId); pinch = 0; if (!pts.size) cv.classList.remove("dragging"); };
      cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
      const finish = (keep) => {
        layer.remove(); document.removeEventListener("keydown", onKey);
        resolve(keep ? { sx: cx - VW / 2 / s, sy: cy - VH / 2 / s, sw: VW / s, sh: VH / s } : null);
      };
      const onKey = (e) => { if (e.key === "Escape") finish(false); else if (e.key === "Enter") finish(true); };
      const ok = h("button.btn.primary", { type: "button", onclick: () => finish(true) }, "Use it");
      const cancel = h("button.btn.ghost", { type: "button", onclick: () => finish(false) }, "Cancel");
      const reset = h("button.btn.ghost", { type: "button", onclick: () => { s = minS; cx = W / 2; cy = H / 2; toSlider(); draw(); } }, "Reset");
      const box = h("div.crop-modal", { role: "dialog", "aria-modal": "true", "aria-label": title },
        h("h2", { text: title }),
        h("p.panel-sub", { text: "Drag the picture to move it, and zoom with the slider or the mouse wheel (or two fingers)." }),
        h("div.crop-frame", {}, cv),
        h("div.crop-zoom-row", {}, h("span.field-label", { text: "Zoom" }), zoom),
        h("div.crop-actions", {}, reset, h("span.crop-gap"), cancel, ok));
      const layer = h("div.modal-layer", { onclick: (e) => { if (e.target === layer) finish(false); } }, box);
      document.body.append(layer);
      document.addEventListener("keydown", onKey);
      draw();
      setTimeout(() => ok.focus(), 30);
    });
  }

  // (2.2.2) choosing a new picture or banner, from the Account page or the pencils on your own profile
  /** A file from the system's picker (null when it's closed without one). */
  function pickFile(accept) {
    return new Promise((resolve) => {
      const input = h("input", { type: "file", accept, hidden: true });
      const done = (f) => { input.remove(); resolve(f); };
      input.addEventListener("change", () => done((input.files && input.files[0]) || null));
      input.addEventListener("cancel", () => done(null));
      document.body.append(input);
      input.click();
    });
  }
  const runBusy = (btn, fn) => (btn ? busy(btn, fn) : fn());
  /** A new profile picture: picked, cropped round, saved. Its JPEG (base64), or null. */
  async function newPicture(out, btn) {
    const file = await pickFile("image/png,image/jpeg,image/webp,image/gif");
    if (!file) return null;
    if (file.size > 15 * 1048576) { setMsg(out, "That picture is too big (15 MB at most)."); return null; }
    let bmp;
    try { bmp = await createImageBitmap(file); } catch { setMsg(out, "That picture couldn't be read."); return null; }
    const crop = await cropPicture(bmp, { title: "Crop your picture", aspect: 1, round: true });
    if (!crop) return null;
    let saved = null;
    await runBusy(btn, async () => {
      try {
        const square = (size, q) => {
          const cv = document.createElement("canvas"); cv.width = cv.height = size;
          const c2 = cv.getContext("2d"); c2.imageSmoothingQuality = "high";
          c2.drawImage(bmp, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, size, size);
          return cv.toDataURL("image/jpeg", q).split(",")[1];
        };
        const full = square(256, 0.9), small = square(128, 0.85);
        if (await saveProfile({ avatar: full, avatarSmall: small }, out, "Picture saved.")) saved = full;
      } catch { setMsg(out, "That picture couldn't be read."); }
    });
    return saved;
  }
  /** A new supporter banner: picked, cropped 3:1, saved. Its JPEG (base64), or null. */
  async function newBanner(out, btn) {
    const file = await pickFile("image/png,image/jpeg,image/webp");
    if (!file) return null;
    let bmp;
    try { bmp = await createImageBitmap(file); } catch { setMsg(out, "That picture couldn't be read."); return null; }
    const crop = await cropPicture(bmp, { title: "Crop your banner", aspect: 3, round: false });
    if (!crop) return null;
    let saved = null;
    await runBusy(btn, async () => {
      try {
        const W = 1200, H = 400, cv = document.createElement("canvas"); cv.width = W; cv.height = H;
        const c2 = cv.getContext("2d"); c2.imageSmoothingQuality = "high";
        c2.drawImage(bmp, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, W, H);
        const b64 = cv.toDataURL("image/jpeg", 0.85).split(",")[1];
        if (await saveLooks({ banner: b64 }, out, "Banner saved.")) saved = b64;
      } catch { setMsg(out, "That picture couldn't be read."); }
    });
    return saved;
  }

  function picturePanel() {
    const out = msg();
    const preview = h("div.pic-preview", {}, h("img", { alt: "", hidden: true }), h("span.initial", { text: me.name.charAt(0).toUpperCase() }));
    if (me.avatarHash) { const img = preview.querySelector("img"); img.src = `${worker}/avatar/${encodeURIComponent(me.playerId)}?v=${encodeURIComponent(me.avatarHash)}`; img.hidden = false; preview.querySelector(".initial").hidden = true; }
    const btn = h("button.btn", { type: "button", disabled: me.avatarLocked }, "Choose a picture…");
    btn.addEventListener("click", async () => {
      const full = await newPicture(out, btn);
      if (!full) return;
      const img = preview.querySelector("img"); img.src = "data:image/jpeg;base64," + full; img.hidden = false; preview.querySelector(".initial").hidden = true;
      const big = document.querySelector(".me-card .card-avatar img"); if (big) { big.src = img.src; big.hidden = false; big.nextElementSibling.hidden = true; }
    });
    return section("Picture", me.avatarLocked ? "A developer set your picture, so it can't be changed." : "Choose a picture, then move and zoom it to pick what shows.",
      h("div.pic-row", {}, preview, btn), out);
  }

  function bioPanel() {
    const ta = h("textarea", { rows: 6, maxlength: 400, spellcheck: "true" });
    ta.value = me.bio || "";
    const count = h("span.field-hint");
    const prev = h("p.bio-text.bio-preview");
    const upd = () => { count.textContent = `${ta.value.length}/400 · ${ta.value.split("\n").length}/8 lines`; renderBio(prev, ta.value || "Your bio preview shows here."); };
    ta.addEventListener("input", upd); upd();
    const out = msg();
    const btn = h("button.btn.primary", { type: "button", onclick: () => busy(btn, () => saveProfile({ bio: ta.value }, out, "Bio saved.")) }, "Save bio");
    return section("Bio", "Formatting codes work like in the game: #c red, #a green, #b aqua, #e yellow, #l bold, #o italic, #g rainbow, #r reset, #RRGGBB any colour.",
      ta, count, h("div.bio-preview-box", {}, h("span.field-label", { text: "Preview" }), prev), h("div.panel-actions", {}, btn), out);
  }

  function socialsPanel() {
    const inputs = {};
    const hints = { youtube: "@handle or channel link", tiktok: "@username", x: "@username", instagram: "username", bluesky: "name.bsky.social", discord: "invite link (https://discord.gg/…)", website: "https://…" };
    const rows = SOCIALS.filter(([id]) => id !== "discord" || me.playerId === ROLE_OWNER).map(([id, name]) => {
      const i = h("input", { type: "text", maxlength: 200, placeholder: hints[id], spellcheck: "false" });
      i.value = (me.socials && me.socials[id]) || "";
      inputs[id] = i;
      return field(name, i);
    });
    const out = msg();
    const btn = h("button.btn.primary", { type: "button", onclick: () => {
      const socials = {};
      for (const [id, , format] of SOCIALS) {
        const v = inputs[id].value.trim();
        if (!v) continue;
        if (!socialUrl(format, v)) return setMsg(out, `Check your ${id} link: a handle like @name, or a full https:// link.`);
        socials[id] = v;
      }
      busy(btn, () => saveProfile({ socials }, out, "Socials saved."));
    } }, "Save socials");
    const panel = section("Socials", "Content creators: players see these on your profile, in the game and here. Leave a box empty to hide it.",
      h("div.social-form", {}, rows), h("div.panel-actions", {}, btn), out);
    panel.classList.add("creator-panel");
    return panel;
  }

  function discordPanel() {
    const out = msg();
    const box = h("div");
    const render = () => {
      box.textContent = "";
      if (me.discord) {
        const un = h("button.btn.ghost", { type: "button", onclick: () => busy(un, async () => {
          try { me = await callApi("discord/unlink", {}, true); setMsg(out, "Discord unlinked.", true); render(); } catch (e) { setMsg(out, e.message); }
        }) }, "Unlink");
        box.append(h("div.email-row", {}, h("img.dc-logo", { src: "discord.png", alt: "" }), h("b", { text: me.discord.name || "Linked" }), h("span.field-hint", { text: "Discord linked" }), un));
        // the Discord options (the same as in the game's Settings → Profile → Discord)
        const opts = h("div.dc-opts", {}, h("p.field-hint", { text: "Loading your Discord options…" }));
        box.append(opts);
        callApi("discord/status", {}, true).then((st) => {
          const p = st.prefs || {};
          const opt = (key, title, hint) => {
            const cb = h("input", { type: "checkbox" }); cb.checked = !!p[key];
            cb.addEventListener("change", async () => {
              cb.disabled = true;
              try { const r = await callApi("discord/prefs", { [key]: cb.checked }, true); setMsg(out, r.note || "Saved.", true); }
              catch (e) { cb.checked = !cb.checked; setMsg(out, e.message); }
              cb.disabled = false;
            });
            return h("label.dc-opt", {}, cb, h("span", {}, h("b", { text: title }), h("span.field-hint", { text: hint })));
          };
          opts.replaceChildren(
            opt("show", "Show my Discord on my profile", "Players see your Discord name on your OCTIVE profile and can copy it to add you."),
            opt("dmAlerts", "Message me on Discord", "The OCTIVE bot DMs you when a friend sends you a message (at most once per friend every 10 minutes)."),
            opt("streak", "Streak reminders", "The OCTIVE bot DMs you a few hours before your daily streak would end (once a day, only if you haven't played)."),
            opt("updates", "Ping me for updates", "Gives you the @Octive Updates role in the OCTIVE Discord, pinged when a new version is out."));
        }).catch((e) => opts.replaceChildren(h("p.field-hint", { text: "Couldn't load your Discord options: " + e.message })));
        return;
      }
      const codeBox = h("div.link-code", { hidden: true });
      const get = h("button.btn.primary", { type: "button", onclick: () => busy(get, async () => {
        try {
          const r = await callApi("discord/code", {}, true);
          codeBox.replaceChildren(
            h("span.field-label", { text: "In Discord, type" }),
            h("code.link-cmd", { text: `/link code:${r.code}` }),
            h("span.field-hint", { text: "The code works for 10 minutes. Then refresh this page." }));
          codeBox.hidden = false;
          try { await navigator.clipboard.writeText(`/link code:${r.code}`); setMsg(out, "Copied the command. Paste it in any channel with the OCTIVE app.", true); } catch { /* no clipboard */ }
        } catch (e) { setMsg(out, e.message); }
      }) }, "Link Discord");
      box.append(h("div.panel-actions", { style: "justify-content:flex-start" }, get), codeBox);
    };
    render();
    const perks = h("ul.dc-perks", {}, [
      "Your Discord on your OCTIVE profile, so friends can add you in one click",
      "Your Workshop uploads credit your Discord account in the server",
      "A DM from the OCTIVE bot when a friend messages you",
      "Pings for new OCTIVE updates (the @Octive Updates role)",
      "/profile, /compare and /achievements in Discord show your stats",
      "Boost the server: you're a supporter while you boost (with the role)",
      "The \"Connected\" achievement in the game",
    ].map((t) => h("li", { text: t })));
    return section("Discord", "Link your Discord: you get a code here, then use /link in the OCTIVE Discord.", me.discord ? null : h("div.dc-why", {}, h("div.dc-why-head", {}, h("img.dc-logo", { src: "discord.png", alt: "" }), h("b", { text: "What you get when you link" })), perks), box, out);
  }

  /** (2.1.1) Twitch: linked by signing in with Twitch (not typed), so the channel on a profile is really theirs. */
  function twitchPanel() {
    const out = msg();
    const box = h("div", {}, h("p.field-hint", { text: "Checking your Twitch link…" }));
    // back from Twitch's sign-in
    const q = new URLSearchParams(location.search);
    if (q.get("twitch") === "linked") {
      setMsg(out, "Twitch linked! Your channel shows on your profile now.", true);
      history.replaceState(null, "", location.pathname + location.hash);
    }
    const render = (st) => {
      box.textContent = "";
      if (!st.linked) {
        const link = h("button.btn.primary.tw-link", { type: "button", onclick: () => busy(link, async () => {
          try { const r = await callApi("twitch/start", { from: "site" }, true); location.href = r.url; }
          catch (e) { setMsg(out, e.message); }
        }) }, "Link Twitch");
        if (st.ready === false) { link.disabled = true; setMsg(out, "Twitch linking isn't set up on the server yet."); }
        box.append(h("div.panel-actions", { style: "justify-content:flex-start" }, link));
        return;
      }
      const un = h("button.btn.ghost", { type: "button", onclick: () => {
        if (!confirm("Unlink Twitch? Your channel won't show on your profile any more.")) return;
        busy(un, async () => { try { await callApi("twitch/unlink", {}, true); setMsg(out, "Twitch unlinked.", true); load(); } catch (e) { setMsg(out, e.message); } });
      } }, "Unlink");
      box.append(h("div.email-row.tw-row", {},
        h("span.tw-logo", { text: "twitch" }),
        h("a", { href: `https://www.twitch.tv/${encodeURIComponent(st.linked.login)}`, target: "_blank", rel: "noopener", text: `twitch.tv/${st.linked.login}` }),
        h("span.field-hint", { text: "Linked with Twitch" }), un));
      const cb = h("input", { type: "checkbox" }); cb.checked = st.show !== false;
      cb.addEventListener("change", async () => {
        cb.disabled = true;
        try { await callApi("twitch/prefs", { show: cb.checked }, true); setMsg(out, cb.checked ? "Your Twitch shows on your profile." : "Your Twitch is hidden from your profile.", true); }
        catch (e) { cb.checked = !cb.checked; setMsg(out, e.message); }
        cb.disabled = false;
      });
      box.append(h("div.dc-opts", {}, h("label.dc-opt", {}, cb, h("span", {}, h("b", { text: "Show my Twitch on my profile" }),
        h("span.field-hint", { text: "Players see your channel on your profile, in the game and here. While you're live, your profile shows it with a Watch stream button." })))));
    };
    const load = () => callApi("twitch/status", {}, true).then(render).catch((e) => { box.replaceChildren(h("p.field-hint", { text: "Couldn't check your Twitch link: " + e.message })); });
    load();
    return section("Twitch", "Link your Twitch channel by signing in with Twitch: it shows on your profile with a check mark, and players see when you're live.", box, out);
  }

  /** Preferences: connections (Discord, Twitch) and shortcuts; the game's own options are in its Settings → Profile. */
  function preferencesPanel() {
    const conn = discordPanel();
    const boost = h("p.field-hint", { text: "Boosting the OCTIVE Discord server with your Discord linked makes you a supporter for as long as the boost lasts (any paid supporter time is paused meanwhile and continues after)." });
    conn.append(boost);
    const tw = twitchPanel();
    const more = section("Messages and friends", "Read and send messages to your friends, see who follows you, and manage who you follow.",
      h("div.panel-actions", { style: "justify-content:flex-start;gap:10px;flex-wrap:wrap" },
        h("a.btn.primary", { href: "messages" }, "Open messages"),
        h("a.btn", { href: profileHref(me.playerId) }, "My public profile")));
    const game = section("In the game", "Discord status, appearing offline, who can watch you play and notifications are set in OCTIVE: Settings → Profile.");
    return h("div", {}, conn, tw, more, game);
  }

  function emailPanel() {
    const out = msg();
    const box = h("div");
    const render = () => {
      box.textContent = "";
      if (me.email && me.emailVerified) {
        const rm = h("button.btn.ghost", { type: "button", onclick: () => {
          if (!confirm("Remove this email? You won't be able to reset your password until you link one again.")) return;
          busy(rm, async () => { try { me = await callApi("email/remove", {}, true); setMsg(out, "Email removed.", true); render(); } catch (e) { setMsg(out, e.message); } });
        } }, "Remove");
        box.append(h("div.email-row", {}, h("span.email-ok", { text: "✓" }), h("b", { text: me.email }), h("span.field-hint", { text: "confirmed" }), rm));
      }
      const email = h("input", { type: "email", autocomplete: "email", maxlength: 254, placeholder: "you@example.com" });
      const send = h("button.btn" + (me.email ? "" : ".primary"), { type: "button", onclick: () => busy(send, async () => {
        try {
          const r = await callApi("email", { email: email.value.trim() }, true);
          me.pendingEmail = r.pendingEmail; setMsg(out, `We sent a 6-digit code to ${r.pendingEmail}. It works for 15 minutes.`, true); render();
        } catch (e) { setMsg(out, e.message); }
      }) }, me.email ? "Change email" : "Send code");
      box.append(h("div.inline-form", {}, field(me.email ? "New email" : "Email address", email), send));
      if (me.pendingEmail) {
        const code = h("input", { type: "text", inputmode: "numeric", autocomplete: "one-time-code", maxlength: 6, placeholder: "123456" });
        const verify = h("button.btn.primary", { type: "button", onclick: () => busy(verify, async () => {
          try { me = await callApi("email/verify", { code: code.value.trim() }, true); setMsg(out, "Email confirmed. You can now reset your password with it.", true); render(); }
          catch (e) { setMsg(out, e.message); }
        }) }, "Confirm");
        box.append(h("div.inline-form", {}, field(`Code sent to ${me.pendingEmail}`, code), verify));
        setTimeout(() => code.focus(), 30);
      }
    };
    render();
    return section("Email", "Link an email so you can reset your password if you forget it. It's private: only used for codes.", box, out);
  }

  function passwordPanel() {
    const cur = h("input", { type: "password", autocomplete: "current-password", maxlength: 30 });
    const next = h("input", { type: "password", autocomplete: "new-password", maxlength: 30 });
    const again = h("input", { type: "password", autocomplete: "new-password", maxlength: 30 });
    const out = msg();
    const btn = h("button.btn.primary", { type: "button", onclick: () => {
      if (next.value !== again.value) return setMsg(out, "The new passwords don't match.");
      busy(btn, async () => {
        try {
          await callApi("password", { password: cur.value, newPassword: next.value }, true);
          cur.value = next.value = again.value = "";
          setMsg(out, "Password changed. Sign in with it in the game next time.", true);
        } catch (e) { setMsg(out, e.message); }
      });
    } }, "Change password");
    return section("Password", "8–30 characters with an upper case letter, a lower case letter, a number and a symbol.",
      h("div.pw-grid", {}, field("Current password", cur), field("New password", next), field("New password again", again)),
      h("div.panel-actions", {}, btn), out);
  }

  // ---------------------------------------------------------------- forgot password

  function resetPage() {
    document.title = "Reset password · OCTIVE";
    // a reset link from Senterra or Octive: just the new password
    const link = ((routeHash().split("?")[1] || "").match(/(?:^|&)link=([a-f0-9]{40})/) || [])[1];
    if (link) {
      const out = msg();
      const pass = h("input", { type: "password", autocomplete: "new-password", maxlength: 30 });
      const again = h("input", { type: "password", autocomplete: "new-password", maxlength: 30 });
      const go = h("button.btn.primary.wide", { type: "button", onclick: () => {
        if (pass.value !== again.value) return setMsg(out, "The passwords don't match.");
        busy(go, async () => {
          try { const r = await callApi("reset/link", { token: link, newPassword: pass.value }); setMsg(out, r.message, true); setTimeout(() => { go("account"); }, 2200); }
          catch (e) { setMsg(out, e.message); }
        });
      } }, "Set new password");
      app.replaceChildren(h("div.auth-card", {}, emblemSvg(64), h("h1", { text: "Choose a new password" }),
        h("p.sub", { text: "This link was made for your account by OCTIVE. It works once." }),
        field("New password", pass, "8–30 characters with upper and lower case, a number and a symbol."), field("New password again", again), go, out));
      return;
    }
    const user = h("input", { type: "text", autocomplete: "username", maxlength: 20, spellcheck: "false" });
    const out = msg();
    const send = h("button.btn.primary.wide", { type: "submit" }, "Email me a code");
    // a linked Discord: the code can come from the OCTIVE bot in Discord DMs
    const viaDiscord = h("button.btn.wide", { type: "button", hidden: true }, "Send the code to my Discord DMs");
    viaDiscord.addEventListener("click", () => busy(viaDiscord, async () => {
      try { const r = await callApi("reset/start", { username: user.value.trim(), via: "discord" }); setMsg(out, r.message, true); step2.hidden = false; setTimeout(() => code.focus(), 30); }
      catch (err) { setMsg(out, err.message); }
    }));
    let optT = null;
    user.addEventListener("input", () => {
      clearTimeout(optT);
      optT = setTimeout(async () => {
        try { const o = await callApi("reset/options", { username: user.value.trim() }); viaDiscord.hidden = !o.discord; } catch { viaDiscord.hidden = true; }
      }, 400);
    });
    const step2 = h("div", { hidden: true });
    const code = h("input", { type: "text", inputmode: "numeric", autocomplete: "one-time-code", maxlength: 6, placeholder: "123456" });
    const pass = h("input", { type: "password", autocomplete: "new-password", maxlength: 30 });
    const again = h("input", { type: "password", autocomplete: "new-password", maxlength: 30 });
    const finish = h("button.btn.primary.wide", { type: "button", onclick: () => {
      if (pass.value !== again.value) return setMsg(out, "The passwords don't match.");
      busy(finish, async () => {
        try {
          const r = await callApi("reset/finish", { username: user.value.trim(), code: code.value.trim(), newPassword: pass.value });
          setMsg(out, r.message, true); step2.hidden = true;
          setTimeout(() => { go("account"); }, 2200);
        } catch (e) { setMsg(out, e.message); }
      });
    } }, "Set new password");
    step2.append(field("Code (from the email or Discord)", code), field("New password", pass, "8–30 characters with upper and lower case, a number and a symbol."), field("New password again", again), finish);
    const form = h("form.auth-card", {
      onsubmit: (e) => {
        e.preventDefault();
        busy(send, async () => {
          try { const r = await callApi("reset/start", { username: user.value.trim() }); setMsg(out, r.message, true); step2.hidden = false; setTimeout(() => code.focus(), 30); }
          catch (err) { setMsg(out, err.message); }
        });
      },
    },
      emblemSvg(64),
      h("h1", { text: "Reset your password" }),
      h("p.sub", { text: "We email a code to the address linked to your account. No email linked? Sign in and add one in Account first." }),
      field("Username", user), send, viaDiscord, step2, out,
      h("div.auth-links", {}, h("a", { href: "account" }, "← Back to sign in")));
    app.replaceChildren(h("div.auth-wrap", {}, form));
    setTimeout(() => user.focus(), 30);
  }

  // ---------------------------------------------------------------- supporter (Stripe), looks, following, status

  const STATUS_TEXT = { desktop: "Online Desktop", mobile: "Online Mobile", web: "Online Website", site: "Viewing Website" };
  /** "Online Desktop", "Viewing Website", "Last online 3 hours ago"… */
  function statusText(p) {
    if (isOfficial(p)) return officialText();
    if (p.online) {
      // test builds report "desktop-dev" etc.: "Online Desktop - Playing DEV Build"
      const dev = /-dev$/.test(p.status || "");
      const base = STATUS_TEXT[(p.status || "").replace(/-dev$/, "")] || "Online";
      return dev ? base + " - Playing DEV Build" : base;
    }
    return p.lastSeen ? "Last online " + ago(p.lastSeen) : "Offline";
  }

  const MONTHLY = 250;
  /** Same as the server: longer blocks cost less, never more than 50% off. */
  const discountFor = (m) => Math.min(0.5, m >= 36 ? 0.5 : m >= 24 ? 0.4 : m >= 12 ? 0.3 : m >= 6 ? 0.2 : m >= 3 ? 0.1 : 0);
  const MAX_MONTHS = 120;
  const priceFor = (m) => Math.round(MONTHLY * m * (1 - discountFor(m)));
  const usd = (cents) => "$" + (cents / 100).toFixed(2);
  const MILESTONE_ART = [[36, "3y", "36 months"], [12, "1y", "12 months"], [6, "6m", "6 months"], [3, "3m", "3 months"], [1, "1m", "1 month"], [0, "new", "New supporter"]];
  const milestoneArt = (months) => (MILESTONE_ART.find(([m]) => months >= m) || MILESTONE_ART[MILESTONE_ART.length - 1]);
  // gifter badges: months of supporter bought for other players
  const GIFTER_ART = [[36, "star", "Star Gifter", "36+"], [24, "platinum", "Platinum Gifter", "24–35"], [12, "gold", "Gold Gifter", "12–23"], [6, "silver", "Silver Gifter", "6–11"], [3, "bronze", "Bronze Gifter", "3–5"], [1, "starter", "Gift Starter", "1–2"]];
  const gifterArt = (months) => GIFTER_ART.find(([m]) => months >= m) || null;
  const giftedOf = (p) => (p && (p.gifted || (p.supporter && p.supporter.gifted))) || 0;
  const supporterNoOf = (p) => { const n = p && (p.supporterNo != null ? p.supporterNo : p.supporter && p.supporter.number); return n == null ? null : n; };
  const supporterNoText = (n) => "Supporter #" + String(n).padStart(4, "0");

  function gifterPill(p) {
    const g = giftedOf(p), art = gifterArt(g);
    if (!art) return null;
    return h("span.sup-pill.small.gifter", { title: `${art[2]} · ${monthsGiftedText(g)} gifted to other players` }, h("img", { src: `badges/gifter-${art[1]}.png`, alt: art[2] }));
  }
  const monthsGiftedText = (m) => `${fmt0.format(m)} month${m === 1 ? "" : "s"}`;
  const EFFECT_NAMES = { none: "None", sparkles: "Sparkles", snow: "Snow", hearts: "Hearts", embers: "Embers", stars: "Stars", aurora: "Aurora", rain: "Rain" };
  const monthsText = (days) => { const m = Math.floor((days || 0) / 30.4375); return m >= 12 ? `${Math.floor(m / 12)} year${m >= 24 ? "s" : ""}${m % 12 ? ` ${m % 12} month${m % 12 === 1 ? "" : "s"}` : ""}` : m >= 1 ? `${m} month${m === 1 ? "" : "s"}` : `${Math.max(0, Math.floor(days || 0))} day${Math.floor(days) === 1 ? "" : "s"}`; };
  const isSupporter = (p) => !!(p && p.supporter && p.supporter.active);
  /** (2.1.4) Supported before but not now: they keep the badge they earned (not the perks). */
  const wasSupporter = (p) => !!(p && p.supporter && !p.supporter.active && (p.supporter.days || 0) > 0);

  function hashQuery() {
    const r = routeHash(), i = r.indexOf("?");
    return new URLSearchParams(i >= 0 ? r.slice(i + 1) : "");
  }

  /** A supporter's name in their colours (bio codes), or plain. */
  function nameInto(el, p) {
    const style = p.supporter && p.supporter.active && p.supporter.nameStyle;
    if (style) renderBio(el, style); else el.textContent = p.name || "Player";
    el.querySelector(".check")?.remove();
    const c = checkEl(p); if (c) el.append(c);
    // their country (2.0): the server works it out from their connection
    el.querySelector(".flag")?.remove();
    const f = flagEl(p.country); if (f) el.prepend(f);
  }

  /** A country's flag (emoji from its 2-letter code), with its name on hover. */
  function flagEl(code) {
    if (!/^[A-Z]{2}$/.test(code || "")) return null;
    const emoji = String.fromCodePoint(...[...code].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
    let title = code;
    try { title = new Intl.DisplayNames(["en"], { type: "region" }).of(code) || code; } catch { /* the code */ }
    return h("span.flag", { text: emoji, title, "aria-label": title });
  }

  /** The animated GIF picture of a supporter, else their normal picture. */
  function avatarUrl(p) {
    if (worker && isSupporter(p) && p.supporter.gif) return `${worker}/looks/gif/${encodeURIComponent(p.id)}?v=${encodeURIComponent(p.supporter.gif)}`;
    return p.avatar || null;
  }

  function supporterPill(p, small) {
    const s = p.supporter, former = !s.active;
    const [, key] = milestoneArt(s.months || 0);
    return h("span.sup-pill" + (small ? ".small" : "") + (former ? ".former" : ""),
      { title: s.lifetime ? "Lifetime OCTIVE supporter" : former ? `Former OCTIVE supporter · ${monthsText(s.days)} in total` : `OCTIVE supporter · ${monthsText(s.days)} in total` },
      h("img", { src: `badges/supporter-${key}.png`, alt: "" }), small ? null : h("span", { text: former ? "Former supporter" : "Supporter" }));
  }

  /** Profile effects drawn on a canvas over the card (same set as the game). */
  function effectLayer(kind) {
    const cv = h("canvas.fx-layer", { "aria-hidden": "true" });
    if (!kind || kind === "none") return cv;
    const ctx = cv.getContext("2d");
    const parts = [];
    const rnd = (a, b) => a + Math.random() * (b - a);
    const spawn = (w, hh, initial) => {
      const p = { x: rnd(0, w), y: initial ? rnd(0, hh) : (kind === "embers" ? hh + 8 : -8), r: rnd(1.2, 3.2), v: rnd(10, 30), t: rnd(0, 6.28), life: rnd(2, 6) };
      if (kind === "rain") { p.v = rnd(180, 260); p.r = rnd(8, 16); }
      if (kind === "sparkles" || kind === "stars") { p.y = rnd(0, hh); p.v = 0; }
      return p;
    };
    let last = performance.now();
    const step = (now) => {
      if (!cv.isConnected) { if (performance.now() - last > 5000) return; }
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const w = cv.clientWidth, hh = cv.clientHeight;
      if (cv.width !== w || cv.height !== hh) { cv.width = w; cv.height = hh; }
      ctx.clearRect(0, 0, w, hh);
      const want = kind === "aurora" ? 0 : kind === "rain" ? 70 : 40;
      while (parts.length < want) parts.push(spawn(w, hh, true));
      if (kind === "aurora") {
        const t = now / 1000;
        for (let i = 0; i < 3; i++) {
          const g = ctx.createLinearGradient(0, 0, w, 0);
          const hue = (t * 12 + i * 70) % 360;
          g.addColorStop(0, `hsla(${hue},90%,65%,0)`); g.addColorStop(0.5, `hsla(${hue},90%,65%,0.16)`); g.addColorStop(1, `hsla(${(hue + 60) % 360},90%,65%,0)`);
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.moveTo(0, hh * 0.2);
          for (let x = 0; x <= w; x += 20) ctx.lineTo(x, hh * (0.25 + 0.12 * i) + Math.sin(x / 90 + t * (0.6 + i * 0.2)) * 22);
          ctx.lineTo(w, 0); ctx.lineTo(0, 0); ctx.fill();
        }
      }
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]; p.t += dt;
        if (kind === "snow") { p.y += p.v * dt; p.x += Math.sin(p.t) * 10 * dt; ctx.fillStyle = "rgba(255,255,255,.75)"; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill(); }
        else if (kind === "rain") { p.y += p.v * dt; ctx.strokeStyle = "rgba(140,190,255,.45)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - 2, p.y + p.r); ctx.stroke(); }
        else if (kind === "embers") { p.y -= p.v * dt; p.x += Math.sin(p.t * 2) * 8 * dt; ctx.fillStyle = `rgba(255,${140 + (p.r * 20 | 0)},60,${0.8 - (p.t / p.life) * 0.6})`; ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 0.8, 0, 7); ctx.fill(); }
        else if (kind === "hearts") { p.y += p.v * dt * 0.8; p.x += Math.sin(p.t) * 6 * dt; ctx.fillStyle = "rgba(255,110,170,.7)"; ctx.font = `${8 + p.r * 4}px sans-serif`; ctx.fillText("♥", p.x, p.y); }
        else { // sparkles, stars: twinkle in place
          const a = Math.max(0, Math.sin((p.t / p.life) * Math.PI));
          ctx.fillStyle = kind === "stars" ? `rgba(255,236,170,${a})` : `rgba(255,255,255,${a})`;
          const s = p.r * (kind === "stars" ? 1.6 : 1.2);
          ctx.beginPath(); ctx.moveTo(p.x, p.y - s * 2); ctx.lineTo(p.x + s * 0.5, p.y); ctx.lineTo(p.x, p.y + s * 2); ctx.lineTo(p.x - s * 0.5, p.y); ctx.fill();
          ctx.beginPath(); ctx.moveTo(p.x - s * 2, p.y); ctx.lineTo(p.x, p.y + s * 0.5); ctx.lineTo(p.x + s * 2, p.y); ctx.lineTo(p.x, p.y - s * 0.5); ctx.fill();
        }
        if (p.y > hh + 20 || p.y < -20 || p.t > p.life && (kind === "sparkles" || kind === "stars" || kind === "embers")) parts[i] = spawn(w, hh, kind === "sparkles" || kind === "stars");
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    return cv;
  }

  /** Supporter decoration on a profile card: banner, effect, pill, coloured name. */
  function decorateCard(card, p) {
    const gp = gifterPill(p), row0 = card.querySelector(".card-name-row");
    if (!isSupporter(p)) {
      // a former supporter keeps the badge they earned
      if (row0 && wasSupporter(p)) row0.append(supporterPill(p));
      if (gp && row0) row0.append(gp);
      return;
    }
    const s = p.supporter;
    card.classList.add("supporter");
    if (s.banner && worker) {
      card.style.setProperty("--banner", `url("${worker}/looks/banner/${encodeURIComponent(p.id)}?v=${encodeURIComponent(s.banner)}")`);
      card.classList.add("has-banner");
    }
    if (s.effect && s.effect !== "none") card.prepend(effectLayer(s.effect));
    const nameEl = card.querySelector(".card-name");
    if (nameEl) nameInto(nameEl, p);
    const row = card.querySelector(".card-name-row");
    if (row) { row.append(supporterPill(p)); if (gp) row.append(gp); }
  }

  /** Lifetime supporter statistics and the anniversary badges earned. */
  function supporterSection(p) {
    const s = p.supporter, gifted = giftedOf(p), no = supporterNoOf(p);
    const isSup = s && (s.active || s.days > 0);
    if (!isSup && !gifted && no == null) return null;
    const earned = isSup ? MILESTONE_ART.slice().reverse().filter(([m]) => (s.months || 0) >= m) : [];
    const gifts = GIFTER_ART.slice().reverse().filter(([m]) => gifted >= m);
    const title = !isSup ? "OCTIVE gifter" : s.lifetime ? "Lifetime supporter" : s.booster ? "OCTIVE supporter · Server Booster" : s.active ? "OCTIVE supporter" : "Former supporter";
    return h("section.sup-section", {},
      h("div.sup-title", {}, h("h2", { text: title }), no != null ? h("span.sup-no", { title: "Every supporter's number, in the order they first supported OCTIVE", text: supporterNoText(no) }) : null),
      isSup ? null : h("div.tiles", {},
        h("div.tile", {}, h("span", { text: "Months gifted to others" }), h("b", { text: monthsGiftedText(gifted) }))),
      !isSup ? null : h("div.tiles", {},
        h("div.tile", {}, h("span", { text: "Supported for" }), h("b", { text: monthsText(s.days) })),
        h("div.tile", {}, h("span", { text: "Since" }), h("b", { text: s.since ? new Date(s.since).toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "—" })),
        s.lifetime ? h("div.tile", {}, h("span", { text: "Until" }), h("b", { text: "Forever" }))
          : s.booster ? h("div.tile", {}, h("span", { text: "Until" }), h("b", { text: "Server Booster" }))
          : s.active && s.until ? h("div.tile", {}, h("span", { text: "Until" }), h("b", { text: new Date(s.until).toLocaleDateString(undefined, { dateStyle: "medium" }) })) : null,
        h("div.tile", {}, h("span", { text: "Months bought" }), h("b", { text: fmt0.format(s.totalMonthsBought || 0) })),
        s.monthsReceived ? h("div.tile", {}, h("span", { text: "Months gifted to them" }), h("b", { text: monthsGiftedText(s.monthsReceived) })) : null,
        h("div.tile", {}, h("span", { text: "Months gifted to others" }), h("b", { text: monthsGiftedText(gifted) }))),
      // (2.1.4) supporter badges and gifter badges on lines of their own
      earned.length ? h("div.sup-earned-row", {}, h("span.sup-earned-head", { text: "Supporter badges" }),
        h("div.sup-earned", {}, earned.map(([, key, label]) => h("figure", {}, h("img", { src: `badges/supporter-${key}.png`, alt: "" }), h("figcaption", { text: label }))))) : null,
      gifts.length ? h("div.sup-earned-row", {}, h("span.sup-earned-head", { text: "Gifter badges" }),
        h("div.sup-earned", {}, gifts.map(([, key, label]) => h("figure", { title: `${monthsGiftedText(gifted)} gifted to other players` }, h("img", { src: `badges/gifter-${key}.png`, alt: "" }), h("figcaption", { text: label }))))) : null);
  }

  /** Names of people opened from a profile's Message button (not friends, so not in the inbox yet). */
  const dmNames = {};

  /** Followers / following, a Follow button and Gift supporter. */
  // (2.1.1) the purple play mark of a player streaming on Twitch (their status dot turns into it)
  const LIVE_SVG = '<svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="50" fill="#6a3399"/><circle cx="50" cy="50" r="39" fill="none" stroke="#fff" stroke-width="7"/><path d="M40 30 L70 50 L40 70 Z" fill="#fff"/></svg>';

  /** A player streaming on Twitch right now: the play mark on their picture and a "live" box under their name. */
  function markLive(card, avatar, tw) {
    if (!tw || !tw.live || !card.isConnected) return;
    const dot = avatar.querySelector(".dot");
    if (dot) { dot.hidden = false; dot.classList.add("live"); dot.innerHTML = LIVE_SVG; dot.title = "Live on Twitch"; dot.dataset.profileLive = "1"; }
    const url = `https://www.twitch.tv/${tw.login}`;
    const mins = tw.live.startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(tw.live.startedAt)) / 60000)) : null;
    const since = mins == null ? "" : mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`;
    const box = h("a.pf-live", { href: url, target: "_blank", rel: "noopener", title: "Watch on Twitch" },
      (() => { const m = h("span.pf-live-mark"); m.innerHTML = LIVE_SVG; return m; })(),
      h("div.pf-live-text", {},
        h("b", { text: "LIVE on Twitch" }),
        h("span", { text: [tw.live.title, tw.live.game].filter(Boolean).join(" · ") || `twitch.tv/${tw.login}` }),
        h("small", { text: [`${fmt0.format(tw.live.viewers || 0)} watching`, since && `live for ${since}`].filter(Boolean).join(" · ") })),
      h("span.pf-live-watch", { text: "Watch stream ▶" }));
    card.querySelector(".pf-liveslot")?.append(box); // the head's top right
  }

  // (2.1.1) profile links as small chips: the platform's logo and its name (the link is on hover and click)
  const SOCIAL_ICONS = { twitch: "icons/twitch.png", youtube: "icons/youtube.png", tiktok: "icons/tiktok.png", x: "icons/x.png",
    instagram: "icons/instagram.svg", bluesky: "icons/bluesky.svg", website: "icons/website.png", discord: "discord.png" };
  function socialChip(id, name, url, title) {
    return h(`a.fc-social.fc-${id}`, { href: url, target: "_blank", rel: "noopener noreferrer", title: title || url },
      h("img", { src: SOCIAL_ICONS[id], alt: "" }), h("b", { text: name }));
  }
  /** A content creator's links (YouTube, TikTok…), as chips. The Discord server link is the official server's only. */
  function creatorChips(p) {
    if (!(p.badges || []).includes("CREATOR") || !p.socials) return [];
    const out = [];
    for (const [id, name, format] of SOCIALS) {
      if (id === "discord" && p.id !== ROLE_OWNER) continue;
      const url = socialUrl(format, p.socials[id]);
      if (url) out.push(socialChip(id, id === "discord" ? "Discord server" : name, url));
    }
    return out;
  }

  function socialRow(p, onSocial, discordSlot) {
    const followers = h("b", { text: "…" }), following = h("b", { text: "…" });
    const followBtn = h("button.btn", { type: "button", hidden: true });
    const out = h("span.social-msg");
    const isOwner = p.id === ROLE_OWNER;
    let youFollow = false;
    const paint = () => {
      followBtn.hidden = !!(me && me.playerId === p.id);
      followBtn.textContent = isOwner || youFollow ? "Following" : "Follow";
      followBtn.classList.toggle("primary", !(isOwner || youFollow));
      followBtn.disabled = isOwner;
      followBtn.title = isOwner ? "Every player follows the OCTIVE developer" : !me ? "Sign in to follow players" : youFollow ? "Click to unfollow" : "";
    };
    followBtn.addEventListener("click", async () => {
      if (!me) { go("account"); return; }
      const want = !youFollow;
      followBtn.disabled = true;
      try {
        const r = await callApi("/follow", { playerId: p.id, follow: want }, true);
        youFollow = want; followers.textContent = fmtCount(r.followers);
      } catch (e) { out.textContent = e.message; }
      followBtn.disabled = false; paint();
    });
    // the official account messages anyone, and anyone can message it (no friendship needed)
    const msgBtn = h("a.btn.msg", { href: "messages/" + encodeURIComponent(p.id), hidden: true, title: "Send a message" }, "✉ Message");
    msgBtn.hidden = !(me && me.playerId !== p.id && (me.playerId === OFFICIAL_ID || p.id === OFFICIAL_ID));
    msgBtn.addEventListener("click", (e) => { if (!me) { e.preventDefault(); go("account"); } else dmNames[p.id] = p.name; });
    const gift = h("a.btn.gift", { href: "supporter?gift=" + encodeURIComponent(p.id), hidden: !!(me && me.playerId === p.id) || !!(p.supporter && p.supporter.lifetime) }, "♥ Gift supporter");
    const friends = h("b", { text: "…" });
    let row;
    // their links: the creator's socials now, their Discord and Twitch once the profile loads
    const links = h("div.fc-links", {}, creatorChips(p));
    const open = (k) => row.dispatchEvent(new CustomEvent("open-list", { detail: k }));
    const icon = (paths) => { const s = document.createElement("span"); s.className = "fc-icon"; s.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`; return s; };
    const tile = (k, count, label, title, paths) => h("button.follow-count", { type: "button", onclick: () => open(k), title },
      icon(paths), h("span.fc-text", {}, count, h("small", { text: label })));
    row = h("div.social-row", {},
      h("div.fc-tiles", {},
        tile("followers", followers, "Followers", "See who follows " + (p.name || "them"), '<path d="M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1"/><circle cx="9" cy="8" r="3.5"/><path d="M22 19v-1a4 4 0 0 0-3-3.9M16 4.2a3.5 3.5 0 0 1 0 6.6"/>'),
        tile("following", following, "Following", "See who " + (p.name || "they") + " follows", '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>'),
        tile("friends", friends, "Friends", "See " + (p.name || "their") + "'s friends", '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-3.3 3.6-6 8-6s8 2.7 8 6"/>')),
      h("div.fc-actions", {}, out, msgBtn, followBtn, gift),
      links);
    paint();
    (async () => {
      try {
        const token = store.get("octive.token", true);
        const res = await fetch(`${worker}/social/${encodeURIComponent(p.id)}`, { headers: token ? { Authorization: "Bearer " + token } : {} });
        const s = await res.json();
        followers.textContent = fmtCount(s.followers || 0);
        following.textContent = fmtCount((s.following || []).length);
        friends.textContent = s.friends != null ? fmtCount(s.friends) : "—";
        youFollow = isOwner || s.youFollow === true;
        paint();
        if (onSocial) { try { onSocial(s); } catch { /* the rest still shows */ } }
        // their Discord, when they chose to show it (Settings → Profile → Discord in the game)
        if (s.discord || s.discordUser) {
          // shows their Discord name; copies the username (what you type to add them)
          const user = s.discordUser || s.discord;
          const shown = s.discordUser && s.discord && s.discord.toLowerCase() !== s.discordUser.toLowerCase() ? `${s.discord} · @${s.discordUser}` : (s.discord || s.discordUser);
          const chip = h("button.fc-discord", { type: "button", title: "Click to copy their Discord username" }, h("img.dc-logo", { src: "discord.png", alt: "Discord" }), h("b", { text: shown }), h("span.dc-copy", { text: "Copy" }));
          chip.addEventListener("click", async () => {
            try { await navigator.clipboard.writeText(user); chip.querySelector(".dc-copy").textContent = "Copied!"; }
            catch { chip.querySelector(".dc-copy").textContent = user; }
            setTimeout(() => { chip.querySelector(".dc-copy").textContent = "Copy"; }, 1800);
          });
          if (discordSlot) discordSlot.append(chip); else links.prepend(chip); // the profile head's bottom right
        }
        // (2.1.1) their Twitch channel, linked by signing in with Twitch (so it's really theirs)
        if (s.twitch && /^[a-z0-9_]{1,25}$/.test(s.twitch.login || "")) {
          links.prepend(socialChip("twitch", "Twitch", `https://www.twitch.tv/${s.twitch.login}`, `twitch.tv/${s.twitch.login} · linked with Twitch`));
        }
      } catch { followers.textContent = "—"; following.textContent = "—"; }
    })();
    return row;
  }
  const ROLE_OWNER = "PlwcYVKV9y7NBFWfUaC263XpCFbE";

  /** Followers, following or friends of a player; on your own profile you can unfollow and unfriend here. */
  function peopleList(p, kind) {
    const box = h("div.people", {}, h("p.empty", { text: "Loading…" }));
    (async () => {
      let r;
      try { r = await callApi(`/social/${encodeURIComponent(p.id)}/${kind}`, undefined, !!(store.get("octive.token", true) || store.get("octive.session"))); }
      catch (e) { box.replaceChildren(h("p.empty", { text: e.message })); return; }
      const list = r.players || [];
      const empty = { followers: "No followers yet.", following: "Not following anyone yet.", friends: "No friends to show. Friends show here once their game has been opened with version 1.4." }[kind];
      if (!list.length) { box.replaceChildren(h("p.empty", { text: empty })); return; }
      const mine = !!r.mine;
      box.replaceChildren(h("p.people-count", { text: `${fmt0.format(list.length)} ${kind === "followers" ? (list.length === 1 ? "follower" : "followers") : kind === "friends" ? (list.length === 1 ? "friend" : "friends") : "followed"}` }),
        ...list.map((x) => {
          const actions = h("span.people-actions");
          const row = h("div.person", {},
            h("a.person-main", { href: profileHref(x.id) },
              dmAvatar(x.id, x.name, "person-av"),
              h("span.person-text", {}, h("span.person-name", { text: x.name || "Player" }),
                h("span.person-sub", { text: [x.rank ? "#" + fmt0.format(x.rank) : null, x.pp ? fmt0.format(x.pp) + " PR" : null, x.level ? "Lv" + x.level : null].filter(Boolean).join(" · ") || "not ranked yet" })),
              x.online ? h("span.person-on", { title: "Online" }) : null),
            actions);
          if (mine && kind === "following" && x.id !== ROLE_OWNER)
            actions.append(h("button.btn", { type: "button", onclick: async (e) => {
              e.target.disabled = true;
              try { await callApi("/follow", { playerId: x.id, follow: false }, true); row.remove(); } catch (err) { e.target.disabled = false; alert(err.message); }
            } }, "Unfollow"));
          if (mine && kind === "friends") {
            actions.append(h("a.btn", { href: "messages/" + encodeURIComponent(x.id) }, "Message"));
            // the official OCTIVE account is everyone's friend: it can't be removed
            if (x.id !== OFFICIAL_ID) actions.append(h("button.btn", { type: "button", onclick: async (e) => {
              if (!confirm(`Remove ${x.name || "this player"} from your friends? Your game removes the friendship the next time it's open.`)) return;
              e.target.disabled = true;
              try { await callApi("/dm/unfriend", { playerId: x.id }, true); row.remove(); } catch (err) { e.target.disabled = false; alert(err.message); }
            } }, "Unfriend"));
          }
          return row;
        }));
    })();
    return box;
  }

  // ---------------------------------------------------------------- #/supporter

  function supporterPage() {
    document.title = "Supporter · OCTIVE";
    const q = hashQuery();
    let months = 3;
    let giftTo = q.get("gift") || null;
    const thanks = q.get("thanks") === "1";

    const perks = [
      ["3× daily points", "Every daily chart pays three times the points: up to 150 on Easy, 300 on Normal, 600 on Hard and 900 on Extreme. (The day's scoreboard still shows everyone's normal points.)"],
      ["10% off in the points shop", "Every title, frame, icon, colour and extra costs 10% less, gifts for friends included."],
      ["Supporter badge", "A supporter badge on your profile and next to your name on leaderboards, with anniversary art as your support adds up."],
      ["Account banner", "A banner picture across the top of your profile, in the game and on the website."],
      ["Coloured name", "Colour and style your name with the same codes as bios: rainbow, bold, any colour."],
      ["Profile effects", "Sparkles, snow, hearts, embers, stars, aurora or rain over your profile card."],
      ["Animated picture", "A GIF profile picture (up to 8 MB) that's animated everywhere it shows."],
      ["Name changes any time", "No waiting between name changes."],
      ["More Workshop uploads", "Share 10 songs, packs, skins, themes or styles to the Workshop a day (3 without supporter)."],
      ["Leaderboard border", "A pink supporter border on your leaderboard rows."],
      ["Lifetime statistics", "Your total time supporting shows on your profile and never resets, even with gaps."],
    ];

    const total = h("b.price-total"), each = h("span.price-each"), save = h("span.price-save");
    const slider = h("input.months-slider", { type: "range", min: 1, max: 36, step: 1, value: months, "aria-label": "Months" });
    const monthsLabel = h("b.months-label");
    // any number of months: type it (up to 10 years)
    const custom = h("input.months-custom", { type: "number", min: 1, max: MAX_MONTHS, step: 1, value: months, inputmode: "numeric", "aria-label": "Custom number of months", title: `Any number of months, 1 to ${MAX_MONTHS}` });
    const setMonths = (m, from) => {
      months = Math.max(1, Math.min(MAX_MONTHS, Math.round(Number(m) || 1)));
      if (from !== "slider") slider.value = Math.min(36, months);
      if (from !== "custom") custom.value = months;
      upd();
    };
    // (3.2) the usual lengths as tiles: how many months, what a month costs, and the discount
    const quick = h("div.su-tiles", {}, [1, 3, 6, 12, 24, 36].map((m) => {
      const pct = Math.round(discountFor(m) * 100);
      return h("button.su-tile" + (m === 36 ? ".best" : ""), { type: "button", "data-m": m, onclick: () => setMonths(m), "aria-label": `${m} month${m === 1 ? "" : "s"}` },
        pct ? h("span.su-off", { text: `−${pct}%` }) : null,
        h("b", { text: String(m) }), h("small", { text: m === 1 ? "month" : "months" }),
        h("span.su-per", { text: `${usd(priceFor(m) / m)} a month` }),
        m === 36 ? h("span.su-best", { text: "Best value" }) : null);
    }));
    const upd = () => {
      monthsLabel.textContent = months === 1 ? "1 month" : `${months} months`;
      const cents = priceFor(months), pct = Math.round(discountFor(months) * 100);
      total.textContent = usd(cents);
      each.textContent = `${usd(cents / months)} a month`;
      save.textContent = pct ? `${pct}% off${pct >= 50 ? " (the most)" : ""} · you save ${usd(MONTHLY * months - cents)}` : "No discount below 3 months";
      save.classList.toggle("on", pct > 0);
      for (const b of quick.children) b.classList.toggle("on", Number(b.dataset.m) === months);
    };
    slider.addEventListener("input", () => setMonths(slider.value, "slider"));
    custom.addEventListener("input", () => { if (custom.value !== "") setMonths(custom.value, "custom"); });
    custom.addEventListener("change", () => setMonths(custom.value, null));

    // who it's for: me, or a gift to another player
    const forMe = h("button.seg", { type: "button" }, "For me");
    const forGift = h("button.seg", { type: "button" }, "♥ As a gift");
    const giftBox = h("div.gift-box", { hidden: true });
    const giftSearch = h("input", { type: "search", placeholder: "Search players by name…", spellcheck: "false" });
    const giftList = h("div.gift-list");
    const giftChosen = h("div.gift-chosen");
    giftBox.append(giftChosen, giftSearch, giftList);
    const playerById = (id) => data && data.players.find((x) => x.id === id);
    const paintGift = () => {
      forMe.classList.toggle("on", giftTo === null); forGift.classList.toggle("on", giftTo !== null);
      giftBox.hidden = giftTo === null;
      giftChosen.textContent = "";
      if (giftTo) {
        const p = playerById(giftTo);
        giftChosen.append(h("span", { text: "Gift for " }), h("b", { text: p ? p.name : "this player" }),
          h("button.link", { type: "button", onclick: () => { giftTo = ""; paintGift(); giftSearch.focus(); } }, "change"));
      } else if (giftTo === "") giftChosen.append(h("span", { text: "Who should get it?" }));
      giftSearch.hidden = !!giftTo; giftList.hidden = !!giftTo;
      freeBtn.hidden = !(me && me.playerId === ROLE_OWNER && giftTo);
      paintBuy();
    };
    // (2.1.4) a lifetime supporter only gifts: months for themselves would do nothing
    const lifeNote = h("p.life-note", { hidden: true }, "You're a lifetime supporter, so you don't need months. You can still gift supporter to other players: choose ", h("b", { text: "♥ As a gift" }), ".");
    function paintBuy() {
      const life = !!(me && me.supporter && me.supporter.lifetime) && giftTo === null;
      buy.disabled = life;
      buy.textContent = life ? "You're a lifetime supporter" : "Continue to payment";
      lifeNote.hidden = !life;
    }
    const searchGift = () => {
      giftList.textContent = "";
      const term = giftSearch.value.trim().toLowerCase();
      if (!term || !data) return;
      for (const p of data.players.filter((x) => (x.name || "").toLowerCase().includes(term) && (!me || x.id !== me.playerId) && !(x.supporter && x.supporter.lifetime)) /* (2.2.1) months do nothing for lifetime supporters */.slice(0, 8))
        giftList.append(h("button.gift-pick", { type: "button", onclick: () => { giftTo = p.id; paintGift(); } }, h("span", { text: p.name }), h("span.dim", { text: "#" + fmt0.format(p.rank) })));
      if (/^[A-Za-z0-9_-]{20,64}$/.test(giftSearch.value.trim()))
        giftList.append(h("button.gift-pick", { type: "button", onclick: () => { giftTo = giftSearch.value.trim(); paintGift(); } }, h("span", { text: "Use this player ID" }), h("span.dim", { text: giftSearch.value.trim().slice(0, 10) + "…" })));
      if (!giftList.children.length) giftList.append(h("p.panel-sub", { text: "Nobody by that name in the ranking. You can also gift from a player's profile in the game, or paste their player ID." }));
    };
    giftSearch.addEventListener("input", searchGift);
    forMe.addEventListener("click", () => { giftTo = null; paintGift(); });
    forGift.addEventListener("click", () => { if (giftTo === null) giftTo = ""; paintGift(); setTimeout(() => giftSearch.focus(), 20); });

    const out = msg();
    const buy = h("button.btn.primary.wide.buy", { type: "button" }, "Continue to payment");
    buy.addEventListener("click", () => busy(buy, async () => {
      setMsg(out, "");
      if (!me) { setMsg(out, "Sign in first (same account as the game)."); return; }
      if (giftTo === "") { setMsg(out, "Choose who gets the gift."); return; }
      try {
        const r = await callApi("/support/checkout", { months, giftTo: giftTo || undefined }, true);
        location.href = r.url;
      } catch (e) { setMsg(out, e.message); }
    }));
    // (2.1.4) lifetime supporter: $35 once, for your own account
    const lifeOut = msg();
    const lifeBuy = h("button.btn.primary.life-buy", { type: "button" }, "Get lifetime · $35");
    lifeBuy.addEventListener("click", () => busy(lifeBuy, async () => {
      setMsg(lifeOut, "");
      if (!me) { setMsg(lifeOut, "Sign in first (same account as the game)."); return; }
      try {
        const r = await callApi("/support/checkout", { lifetime: true }, true);
        location.href = r.url;
      } catch (e) { setMsg(lifeOut, e.message); }
    }));
    const lifetimePanel = h("section.su-life", { id: "su-life" },
      h("div.su-life-top", {}, h("img.su-life-badge", { src: "badges/supporter-3y.png", alt: "" }),
        h("div", {}, h("span.su-life-tag", { text: "Lifetime" }), h("h2", { text: "Supporter forever" }))),
      h("div.su-life-price", {}, h("b.life-price", { text: "$35" }), h("span.life-once", { text: "one time" })),
      h("ul.su-life-list", {}, ...["Every perk, for good: it never runs out", "The price of 14 months at $2.50", "Your time as a supporter keeps growing every day", "For your own account"].map((t) => h("li", { text: t }))),
      lifeBuy, lifeOut);
    const signHint = h("p.panel-sub.center");
    // the developer can gift supporter time for free
    const freeBtn = h("button.btn.wide.free-gift", { type: "button", hidden: true }, "♥ Gift for free (developer)");
    freeBtn.addEventListener("click", () => busy(freeBtn, async () => {
      setMsg(out, "");
      try {
        const r = await callApi("/support/grant", { playerId: giftTo, months }, true);
        setMsg(out, `Sent ${months === 1 ? "1 month" : months + " months"} of supporter to ${r.name || "the player"} for free. They'll get a pop-up to claim it on their profile.`, true);
      } catch (e) { setMsg(out, e.message); }
    }));

    const status = h("div.sup-status");
    // (3.2) the page, redone: a hero with a look at a supporter's profile, the plans (months or lifetime), the perks as
    // cards with icons, the badges as two tracks, and the supporters
    const pvName = h("b.su-pv-name.rainbow-text", { text: "Your name" });
    const art = (m) => `badges/supporter-${milestoneArt(m)[1]}.png`;
    const preview = h("div.su-preview", { "aria-hidden": "true" },
      h("img.su-float.f1", { src: art(36), alt: "" }), h("img.su-float.f2", { src: art(12), alt: "" }), h("img.su-float.f3", { src: art(3), alt: "" }),
      h("div.su-pv-card", {},
        h("div.su-pv-banner", {}, ...Array.from({ length: 14 }, (_, i) => h("i", { style: `--x:${(i * 37) % 100}%;--y:${(i * 53) % 100}%;--d:${(i % 5) * 0.6}s` }))),
        h("div.su-pv-body", {},
          h("span.su-pv-av", {}, h("img", { src: "logo.svg", alt: "" })),
          h("div.su-pv-who", {}, pvName, h("span.sup-pill", {}, h("img", { src: art(12), alt: "" }), h("span", { text: "Supporter" })))),
        h("div.su-pv-perks", {}, ...["3× daily points", "Coloured name", "Banner", "Profile effects"].map((t) => h("span", { text: t })))));
    const plans = h("section.su-plans", { id: "su-plans" },
      h("div.su-buy", {},
        h("div.su-buy-head", {}, h("h2", { text: "Choose your time" }), h("div.seg-row", {}, forMe, forGift)),
        h("p.panel-sub", { text: "$2.50 a month. The longer the block, the less each month costs, down to half price at 36 months. One payment, nothing renews." }),
        giftBox,
        quick,
        h("div.su-custom", {}, h("span", { text: "Or any number of months" }), slider, h("label.months-custom-wrap", {}, custom)),
        h("div.su-total", {}, h("div.su-total-main", {}, h("small", {}, monthsLabel), total, h("div.su-total-sub", {}, each, save)), buy),
        lifeNote, freeBtn, out, signHint,
        h("p.fine", { text: "Payments are handled by Stripe; OCTIVE never sees your card. Time adds onto any time you already have. See the Terms for refunds." })),
      lifetimePanel);
    const PERK_ICONS = [
      '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M8 3v4M16 3v4M3.5 10h17"/><path d="m12 12.4.9 1.8 2 .3-1.45 1.4.35 2-1.8-.95-1.8.95.35-2-1.45-1.4 2-.3z"/>',
      '<path d="M3 12V4h8l9.3 9.3a1.5 1.5 0 0 1 0 2.1l-5.9 5.9a1.5 1.5 0 0 1-2.1 0z"/><circle cx="7.5" cy="8.5" r="1.5"/>',
      '<path d="M8.5 3h7L20 7.5v7L15.5 19h-7L4 14.5v-7z"/><path d="m12 7.6 1.2 2.4 2.6.4-1.9 1.8.5 2.6-2.4-1.3-2.4 1.3.5-2.6-1.9-1.8 2.6-.4z"/>',
      '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.6"/><path d="m21 16-5-5-8 8"/>',
      '<path d="M4 19 9 5h2l5 14M6.2 14h7.6"/><path d="M19 9s2 2.3 2 3.6a2 2 0 0 1-4 0C17 11.3 19 9 19 9z"/>',
      '<path d="M12 4c.6 3.6 1.9 5 5.5 5.5C13.9 10 12.6 11.4 12 15c-.6-3.6-1.9-5-5.5-5.5C10.1 9 11.4 7.6 12 4z"/><path d="M18.5 14c.3 1.7.9 2.3 2.5 2.5-1.6.3-2.2.9-2.5 2.5-.3-1.6-.9-2.2-2.5-2.5 1.6-.2 2.2-.8 2.5-2.5z"/>',
      '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 9 5 3-5 3z"/>',
      '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"/><path d="m14.5 7.5 3 3"/>',
      '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
      '<rect x="3" y="4" width="18" height="5" rx="1.5"/><rect x="3" y="11" width="18" height="4" rx="1.2"/><rect x="3" y="17" width="18" height="3" rx="1"/>',
      '<path d="M3 20h18"/><path d="M6 16v-4M11 16V8M16 16v-6M20 16V5"/>',
    ];
    const PERK_COLS = ["#ff4d9d", "#ff9a3d", "#ffd23f", "#3ee089", "#36d6ff", "#5b7cff", "#a764ff"];
    const perkGrid = h("section.su-perks", {},
      h("div.section-head", {}, h("h2.section-title", { text: "What you get" })),
      h("div.su-perk-grid", {}, perks.map(([t, d], i) => {
        const ic = h("span.su-perk-ic");
        ic.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${PERK_ICONS[i] || PERK_ICONS[2]}</svg>`;
        return h("div.su-perk", { style: `--c:${PERK_COLS[i % PERK_COLS.length]}` }, ic, h("b", { text: t }), h("p", { text: d }));
      })));
    const track = (title, sub, items) => h("section.su-badges", {},
      h("div.section-head", {}, h("h2.section-title", { text: title })), h("p.panel-sub", { text: sub }),
      h("ol.su-track", {}, ...items.map(([img, label, note]) => h("li", {}, h("img", { src: img, alt: "" }), h("b", { text: label }), note ? h("small", { text: note }) : null))));
    const wallN = h("span.su-wall-n");
    const page = h("div.supporter-page.su-page", {},
      thanks ? h("div.thanks", {}, h("b", { text: "Thank you! ♥" }), h("span", { text: " Your support is being added now and shows in the game within a few minutes. Gifts wait for the player to claim them on their profile." })) : null,
      h("section.su-hero", {},
        h("div.su-hero-text", {},
          h("p.eyebrow", { text: "Support OCTIVE" }),
          h("h1", { text: "Become a supporter" }),
          h("p.sub", { text: "OCTIVE is free and made by one developer. Supporting keeps the servers running and gets you a few nice extras." }),
          status,
          h("div.su-hero-acts", {},
            h("button.btn.primary.big", { type: "button", onclick: () => plans.scrollIntoView({ behavior: "smooth", block: "start" }) }, "♥ Choose your time"),
            h("button.btn.big", { type: "button", onclick: () => lifetimePanel.scrollIntoView({ behavior: "smooth", block: "center" }) }, "Lifetime · $35")),
          h("ul.su-facts", {}, h("li", { text: `From ${usd(priceFor(36) / 36)} a month` }), h("li", { text: "Nothing renews" }), h("li", { text: "Paid safely with Stripe" }))),
        preview),
      plans,
      perkGrid,
      h("div.su-badge-row", {},
        track("Anniversary badges", "Earned from your total time as a supporter. Gaps never reset it.",
          MILESTONE_ART.slice().reverse().map(([, key, label]) => [`badges/supporter-${key}.png`, label])),
        track("Gifter badges", "Earned by gifting supporter to other players: every month you gift counts.",
          GIFTER_ART.slice().reverse().map(([, key, label, range]) => [`badges/gifter-${key}.png`, label, `${range} months`]))),
      h("section.panel.wall.su-wall", {}, h("div.su-wall-head", {}, h("h2", { text: "Thank you, supporters" }), wallN),
        h("p.panel-sub", { text: "Everyone who buys supporter gets a Supporter number (#0001, #0002…) in the order they first supported OCTIVE." }),
        h("div.wall-list", {}, h("p.panel-sub", { text: "Loading…" }))));
    app.replaceChildren(page);
    upd(); paintGift();

    const paintMe = () => {
      pvName.textContent = me ? me.name : "Your name";
      signHint.textContent = me ? `Signed in as ${me.name}.` : "";
      if (!me) signHint.append(h("a", { href: "account" }, "Sign in"), " with your game account to buy.");
      status.textContent = "";
      const s = me && me.supporter;
      // already lifetime: nothing to buy here
      const life = !!(s && s.lifetime);
      lifeBuy.hidden = life;
      lifetimePanel.classList.toggle("owned", life);
      lifetimePanel.querySelector(".life-once").textContent = life ? "You're a lifetime supporter ♥" : "one time";
      paintBuy();
      if (s && (s.active || s.days > 0))
        status.append(h("span.sup-pill", {}, h("img", { src: `badges/supporter-${milestoneArt(s.months || 0)[1]}.png`, alt: "" }), h("span", { text: s.lifetime ? "Lifetime supporter" : s.booster ? "Supporter · Server Booster" : s.active ? `Supporter until ${new Date(s.until).toLocaleDateString(undefined, { dateStyle: "medium" })}` : "Former supporter" })),
          h("span.dim", { text: ` · ${monthsText(s.days)} in total` }));
    };
    paintMe();
    if (!me && (store.get("octive.token", true) || store.get("octive.session")))
      (async () => { try { if (!store.get("octive.token", true)) await refreshSession(); me = await callApi("me", undefined, true); updateAccountNav(); if (page.isConnected) { paintMe(); paintGift(); } } catch { /* signed out */ } })();
    if (thanks && me) setTimeout(async () => { try { me = await callApi("me", undefined, true); if (page.isConnected) paintMe(); } catch { /* later */ } }, 4000);

    // the supporter wall
    (async () => {
      const wall = page.querySelector(".wall-list");
      try {
        const r = await (await fetch(worker + "/support/all")).json();
        if (!data) await load();
        if (page.isConnected) paintGift();
        const list = Object.entries(r.supporters || {}).filter(([, s]) => s.active).sort((a, b) => (b[1].days || 0) - (a[1].days || 0));
        wall.textContent = "";
        for (const [id, s] of list) {
          const p = (data && data.players.find((x) => x.id === id)) || { id, name: "Supporter" };
          const a = h("a.wall-item", { href: profileHref(id) }, h("img", { src: `badges/supporter-${milestoneArt(s.months || 0)[1]}.png`, alt: "" }), h("span.wall-name"));
          nameInto(a.querySelector(".wall-name"), { ...p, supporter: s });
          wall.append(a);
        }
        if (!list.length) wall.append(h("p.panel-sub", { text: "Be the first." }));
        else wallN.textContent = `${fmt0.format(list.length)} supporting now`;
      } catch { wall.textContent = "The list couldn't be loaded."; }
    })();
  }

  // ---------------------------------------------------------------- account: supporter panel and looks editor

  function supporterPanel() {
    const s = me.supporter || {};
    if (!s.active) {
      return section("Supporter", s.days > 0 ? `You supported OCTIVE for ${monthsText(s.days)}. Thank you! Your badges stay; support again to get the perks back.` : "3× daily points, 10% off in the points shop, a coloured name, banner, profile effects, animated picture, a profile link of your own and more.",
        me.link ? h("p.field-hint", { text: `Your profile link stays yours: ${SITE_URL}u/${me.link}` }) : null,
        h("div.panel-actions", {}, h("a.btn.primary", { href: "supporter" }, "Become a supporter")));
    }
    const looks = me.looks || {};
    const out = msg();
    // coloured name
    const nameInput = h("input", { type: "text", maxlength: 200, spellcheck: "false", placeholder: `e.g. #g${me.name}` });
    nameInput.value = looks.nameStyle || "";
    const namePrev = h("span.name-preview");
    const updName = () => { if (nameInput.value) renderBio(namePrev, nameInput.value); else namePrev.textContent = me.name; };
    nameInput.addEventListener("input", updName); updName();
    const saveName = h("button.btn", { type: "button", onclick: () => busy(saveName, () => saveLooks({ nameStyle: nameInput.value }, out, "Name colours saved.")) }, "Save name");
    // effect
    const effSel = h("select", {}, Object.entries(EFFECT_NAMES).map(([k, v]) => h("option", { value: k, text: v })));
    effSel.value = looks.effect || "none";
    const effPrev = h("div.effect-preview", {}, effectLayer(effSel.value), h("span", { text: "Preview" }));
    effSel.addEventListener("change", () => { effPrev.firstChild.replaceWith(effectLayer(effSel.value)); busy(saveName, () => saveLooks({ effect: effSel.value }, out, "Effect saved.")); });
    // banner
    const bannerPrev = h("div.banner-preview");
    if (looks.banner) bannerPrev.style.backgroundImage = `url("${worker}/looks/banner/${encodeURIComponent(me.playerId)}?v=${looks.banner}")`;
    const bannerBtn = h("button.btn", { type: "button" }, "Choose banner…");
    bannerBtn.addEventListener("click", async () => { const b64 = await newBanner(out, bannerBtn); if (b64) bannerPrev.style.backgroundImage = `url("data:image/jpeg;base64,${b64}")`; });
    const bannerDel = h("button.btn.ghost", { type: "button", onclick: () => busy(bannerDel, async () => { if (await saveLooks({ banner: "" }, out, "Banner removed.")) bannerPrev.style.backgroundImage = ""; }) }, "Remove");
    // (2.2.2) their own profile link: /u/<link> on the website, and a link that shows their card where it's shared
    const linkIn = h("input", { type: "text", maxlength: 20, spellcheck: "false", autocomplete: "off", placeholder: me.name.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 20) || "YourName" });
    linkIn.value = me.link || "";
    const linkShow = h("p.field-hint");
    const paintLink = () => { linkShow.textContent = me.link ? `${SITE_URL}u/${me.link}` : "No link of your own yet: your profile's address has your player id."; };
    paintLink();
    const linkSave = h("button.btn", { type: "button", onclick: () => busy(linkSave, async () => {
      try { const r = await callApi("/support/link", { link: linkIn.value.trim() }, true); me.link = r.link; linkIn.value = r.link || ""; paintLink(); setMsg(out, r.link ? "Profile link saved." : "Profile link removed.", true); }
      catch (e) { setMsg(out, e.message); }
    }) }, "Save link");
    // GIF picture
    const gifIn = h("input", { type: "file", accept: "image/gif", hidden: true });
    const gifPrev = h("div.pic-preview", {}, h("img", { alt: "", hidden: !looks.gif, src: looks.gif ? `${worker}/looks/gif/${encodeURIComponent(me.playerId)}?v=${looks.gif}` : undefined }));
    const gifBtn = h("button.btn", { type: "button", onclick: () => gifIn.click() }, "Choose GIF…");
    const gifDel = h("button.btn.ghost", { type: "button", onclick: () => busy(gifDel, async () => { if (await saveLooks({ gif: "" }, out, "Animated picture removed.")) gifPrev.querySelector("img").hidden = true; }) }, "Remove");
    gifIn.addEventListener("change", async () => {
      const file = gifIn.files && gifIn.files[0]; gifIn.value = "";
      if (!file) return;
      if (file.size > 8 * 1048576) return setMsg(out, `That GIF is ${(file.size / 1048576).toFixed(1)} MB; 8 MB at most.`);
      await busy(gifBtn, async () => {
        setMsg(out, "Uploading…", true);
        // the raw file (not base64 JSON), with the sign-in refreshed once if it ran out
        const send = () => fetch(worker + "/support/gif", { method: "POST", headers: { "Content-Type": "image/gif", Authorization: "Bearer " + (store.get("octive.token", true) || "") }, body: file });
        try {
          let res = await send();
          if (res.status === 401 && await refreshSession()) res = await send();
          const r = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(r.error || "Upload failed (" + res.status + ").");
          me.looks = r.looks;
          setMsg(out, "Animated picture saved. It shows in the game within a few minutes.", true);
          const img = gifPrev.querySelector("img"); img.src = URL.createObjectURL(file); img.hidden = false;
          refreshHead();
        } catch (e) { setMsg(out, e.message); }
      });
    });
    return section(s.lifetime ? "Supporter · lifetime" : s.booster ? "Supporter · Server Booster" : "Supporter",
      s.lifetime ? `Thank you! You've supported OCTIVE for ${monthsText(s.days)}.`
        : s.booster ? `Thank you for boosting the OCTIVE Discord! You're a supporter while the boost lasts.${s.until ? ` Your paid supporter time is paused meanwhile and continues afterwards (until ${new Date(s.until).toLocaleDateString(undefined, { dateStyle: "long" })}).` : ""}`
        : `Thank you! Supporter until ${new Date(s.until).toLocaleDateString(undefined, { dateStyle: "long" })} · ${monthsText(s.days)} in total.`,
      h("div.sup-edit", {},
        h("div.sup-col", {},
          field("Coloured name", nameInput, "Codes, then the letters of your name: #g rainbow, #c red, #l bold, #RRGGBB (like #ffb3baS#ffdfbae…). Capitals are matched to your name when you save."),
          h("div.name-row", {}, h("div.name-preview-box", {}, namePrev), saveName),
          field("Profile effect", effSel), effPrev),
        h("div.sup-col", {},
          h("span.field-label", { text: "Banner" }), bannerPrev, h("div.panel-actions.left", {}, bannerBtn, looks.banner ? bannerDel : null),
          field("Profile link (yours to keep, even after your supporter time)", h("div.link-row", {}, h("span.link-pre", { text: "/u/" }), linkIn, linkSave), "3 to 20 letters, numbers, - and _. Nothing offensive, and not another player's name."), linkShow,
          h("span.field-label", { text: "Animated picture (GIF, up to 8 MB)" }), h("div.pic-row", {}, gifPrev, gifBtn, looks.gif ? gifDel : null, gifIn))),
      out,
      h("div.panel-actions", {}, h("a.btn", { href: "supporter" }, "Add more time")));
  }

  /** Redraws the Account page's header card with the latest looks. */
  function refreshHead() {
    const old = document.querySelector(".me-card");
    if (old && me) old.replaceWith(accountHead());
  }

  async function saveLooks(body, out, okText) {
    try {
      const r = await callApi("/support/looks", body, true);
      me.looks = r.looks;
      // the server matches the name's capitals: show what was saved
      if (body.nameStyle !== undefined && r.looks && typeof r.looks.nameStyle === "string") {
        const box = document.querySelector(".name-preview-box");
        const input = box && box.closest(".sup-col") ? box.closest(".sup-col").querySelector("input[type=text]") : null;
        if (input && input.value !== r.looks.nameStyle) { input.value = r.looks.nameStyle; input.dispatchEvent(new Event("input")); }
      }
      setMsg(out, okText + " It shows in the game within a few minutes.", true);
      refreshHead();
      return true;
    } catch (e) { setMsg(out, e.message); return false; }
  }

  // "Viewing Website": while the site is open and signed in
  function pingSeen() {
    if (!worker || document.hidden || !(store.get("octive.token", true) || store.get("octive.session"))) return;
    callApi("seen", {}, true).catch(() => {});
  }

  // ---------------------------------------------------------------- achievements (public, from the player's card)
  let achDefs = null;
  const loadAchDefs = () => achDefs ??= fetch("data/achievements.json?v=2.2.2-1").then((r) => r.json()).catch(() => []);
  const ACH_COLOURS = { Milestones: "#8b7bff", Skill: "#4fd6e8", Supporter: "#ff6fae", "OCTIVE Remixes": "#f2c14e", Community: "#5865f2", Ranked: "#ff9f43" };
  const ACH_ICONS = { Milestones: "★", Skill: "✔", Supporter: "♥", "OCTIVE Remixes": "♪", Community: "☺", Ranked: "♛" };

  function achievementsSection(p) {
    const box = h("section.ach-section", {}, h("p.panel-sub", { text: "Loading achievements…" }));
    loadAchDefs().then((defs) => {
      const got = p.achievements || {};
      const hasData = Object.keys(got).length > 0;
      const count = defs.filter((d) => got[d.id]).length;
      let tab = "All", all = false;
      const groups = ["All", ...new Set(defs.map((d) => d.group))];
      const grid = h("div.ach-grid");
      const tabs = h("div.ach-tabs");
      const more = h("button.btn.ghost.ach-more", { type: "button", onclick: () => { all = true; paint(); } });
      const paint = () => {
        tabs.replaceChildren(...groups.map((g) => {
          const list = g === "All" ? defs : defs.filter((d) => d.group === g);
          const n = list.filter((d) => got[d.id]).length;
          const b = h("button.ach-tab" + (g === tab ? ".on" : ""), { type: "button", style: g === tab ? `--c:${ACH_COLOURS[g] || "#f2c14e"}` : "", onclick: () => { tab = g; all = false; paint(); } },
            h("span", { text: (ACH_ICONS[g] ? ACH_ICONS[g] + " " : "") + g }), h("b", { text: `${n}/${list.length}` }));
          return b;
        }));
        const list = (tab === "All" ? defs : defs.filter((d) => d.group === tab)).slice()
          .sort((a, b) => (got[b.id] ? 1 : 0) - (got[a.id] ? 1 : 0) || (got[b.id] || "").localeCompare(got[a.id] || ""));
        const shown = all ? list : list.slice(0, 12);
        more.hidden = all || list.length <= 12;
        more.textContent = `Show all ${list.length}`;
        grid.replaceChildren(...shown.map((d) => {
          const when = got[d.id];
          const hide = !when && d.secret;
          return h("div.ach-card" + (when ? ".got" : ""), { style: `--c:${ACH_COLOURS[d.group] || "#f2c14e"}`, title: hide ? "Secret achievement" : d.desc },
            h("span.ach-icon", { text: when ? (ACH_ICONS[d.group] || "★") : "🔒" }),
            h("div.ach-text", {},
              h("b", { text: hide ? "Secret achievement" : d.title }),
              h("span", { text: hide ? "Keep playing to find out." : d.desc }),
              when ? h("span.ach-date", { text: "Unlocked " + new Date(when).toLocaleDateString(undefined, { dateStyle: "medium" }) }) : null));
        }));
      };
      box.replaceChildren(
        h("div.ach-head", {},
          h("h2", { text: "Achievements" }),
          h("span.ach-count", { text: `${count} / ${defs.length}` }),
          h("div.bar.ach-bar", {}, h("div.fill", { style: `width:${defs.length ? Math.round(count / defs.length * 100) : 0}%` }))),
        hasData ? null : h("p.panel-sub", { text: "Achievements show here once this player plays on version 1.3.2 or newer." }),
        tabs, grid, more);
      paint();
    });
    return box;
  }

  // ---------------------------------------------------------------- gifts wait to be claimed (pop-up on your own profile)
  let giftPopupOpen = false;
  function giftPopup() {
    if (giftPopupOpen || !me || !(me.gifts && me.gifts.length)) return;
    const own = page() === "account" || profileKey() === me.playerId || (!!me.link && String(profileKey() || "").toLowerCase() === me.link.toLowerCase());
    if (!own) return;
    giftPopupOpen = true;
    const gifts = me.gifts;
    const total = gifts.reduce((n, g) => n + g.months, 0);
    const out = msg();
    const close = () => { giftPopupOpen = false; layer.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    const claim = h("button.btn.primary.wide.buy", { type: "button" }, gifts.length === 1 ? "Claim gift" : `Claim all ${gifts.length} gifts`);
    const later = h("button.btn.ghost.wide", { type: "button", onclick: close }, "Later");
    const art = h("img.gift-art", { src: `badges/supporter-${milestoneArt(Math.floor(((me.supporter && me.supporter.days) || 0) / 30.4375) + total)[1]}.png`, alt: "" });
    const box = h("div.gift-modal", { role: "dialog", "aria-modal": "true", "aria-label": "Supporter gift" },
      effectLayer("sparkles"),
      art,
      h("h2", { text: gifts.length === 1 ? "You got a gift!" : `You got ${gifts.length} gifts!` }),
      h("ul.gift-items", {}, gifts.map((g) => h("li", {},
        h("b", { text: g.fromName || "Someone" }),
        h("span", { text: ` gifted you ${g.months === 1 ? "1 month" : g.months + " months"} of OCTIVE supporter` }),
        g.at ? h("span.dim", { text: " · " + new Date(g.at).toLocaleDateString(undefined, { dateStyle: "medium" }) }) : null))),
      h("p.panel-sub", { text: `Claiming adds ${total === 1 ? "1 month" : total + " months"} to your supporter time, starting now.` }),
      out, claim, later);
    claim.addEventListener("click", () => busy(claim, async () => {
      setMsg(out, "");
      try {
        const r = await callApi("/support/claim", {}, true);
        me.gifts = r.gifts || [];
        me.supporter = r.status;
        box.querySelector("h2").textContent = "Claimed! ♥";
        box.querySelector(".gift-items").replaceWith(h("p", { text: `You're a supporter until ${new Date(r.status.until).toLocaleDateString(undefined, { dateStyle: "long" })}. Set up your coloured name, banner and effect on the Account page.` }));
        claim.remove();
        later.textContent = "Close";
        later.onclick = () => { close(); route(); };
        if (data) load();
      } catch (e) { setMsg(out, e.message); }
    }));
    const layer = h("div.modal-layer", { onclick: (e) => { if (e.target === layer) close(); } }, box);
    document.body.append(layer);
    document.addEventListener("keydown", onKey);
    setTimeout(() => claim.focus(), 30);
  }

  // ---------------------------------------------------------------- #/help: common questions
  const HELP = [
    ["Getting started", [
      ["How do I get OCTIVE?", "Download it from the Download page: Windows (the installer or the Microsoft Store), Android (APK) or play in your browser. It's free."],
      ["Do I need an account?", "No, you can play offline. An account puts your scores on the global ranking, keeps them in sync between devices, and lets you add friends and play multiplayer. Make one in the game: Profile → Sign up."],
      ["Can I play my osu!mania maps?", "Yes. On Windows, Song Select → the folder button imports your whole osu! Songs folder, or import single .osz / .osu files. osu!standard, taiko and catch maps can be converted to 4K too (Settings → osu! songs)."],
      ["The notes feel early or late", "Use Settings → Calibration: tap along to the clicks and apply the suggested audio offset. The visual offset moves only what you see."],
    ]],
    ["Scoring, PR and mods", [
      ["What are OCTIVE's timing windows (ms)?", "Every chart uses the same hit windows: how far off you can be, early or late, for each judgement (Marvelous ±30 ms, Perfect ±55, Great ±85, Good ±120, Bad ±150). A note you haven't hit 150 ms after it is a Miss, and a press more than 150 ms early is a ghost tap. Long note releases get 1.5× the windows. The osu! Timing mod uses osu!mania's OD windows instead.", () => timingWindows()],
      ["What is PR?", "PR is your performance rating (it used to be called PP). It works like osu!'s performance points."],
      ["How is PR worked out?", "Like osu!mania: each chart has a star rating, and a play's PR grows with the stars and needs high accuracy (osu!mania accuracy: Marvelous 320, Perfect 300, Great 200, Good 100, Bad 50). Your total adds up the best play on every chart, each at its full PR, so every chart you play well counts."],
      ["Why did my PR change?", "Version 1.3.3 reworked PR: vibro and spam charts are rated more fairly and accuracy counts more. Your past plays were recalculated the first time you opened the new version."],
      ["What do mods do?", "Pick them in Song Select (Mods, or F1). Easy widens the timing windows (PP ×0.5), Hard Rock tightens them (PP ×1.1), Hidden and Fade In hide the notes in different ways (PP ×1.06), Half Time and Double Time change the song speed (the stars are worked out at that speed), and Mirror flips the chart."],
      ["Can I change the speed without changing the pitch?", "Yes. In Song Select → Mods, turn off Pitch shift under the song speed: the song then keeps its own pitch at any speed (it takes a moment to prepare when the play starts). On, faster songs sound higher, like osu!'s Nightcore. The chart editor has the same switch next to its speed menu."],
      ["Which charts give PR?", "Every chart you finish, built-in or imported. OCTIVE Official charts also have an online leaderboard per chart."],
    ]],
    ["Multiplayer and friends", [
      ["How do I play with friends?", "Play → Multiplayer. The host makes a room and shares its code (or uses Invite friends); others join with the code or from Public rooms. Everyone needs the chart: built-in songs always work, imported songs must be the same file."],
      ["My friend didn't get my invite", "They need to be on your friends list and online. Invites show as a notification with a Join button and in their Friends panel (F8)."],
      ["What Discord commands are there?", "In the OCTIVE Discord: /profile shows a player's stats (yours, if linked), /leaderboard the ranking, /online who's playing, /download the game, /link connects your OCTIVE account (get the code on the website: Account → Preferences → Link Discord), /unlink disconnects it, and /update re-checks your supporter status and server boost right away and gives or removes the OCTIVE Supporter role."],
      ["How do I get the OCTIVE Supporter role in Discord?", "Link your Discord (Account → Preferences → Link Discord, then /link in Discord). Supporters get the role automatically within a few hours, or straight away with /update. Boosting the OCTIVE Discord server also makes you a supporter while the boost lasts; any paid supporter time is paused meanwhile and continues afterwards."],
      ["Can I message friends who are offline?", "Yes. Messages are saved to your account, so friends get them the next time they open OCTIVE. You can also read and send messages on this website: sign in and open Messages. Only friends can message each other."],
      ["How do I play with just one friend?", "Open Friends (F8), click your friend and choose Play together. OCTIVE makes a private room for the two of you and sends them the invite."],
      ["Can people watch me play?", "Friends can watch your plays live if you allow it in Settings → Profile & data."],
    ]],
    ["Workshop", [
      ["What is the Workshop?", "A place to share and get charts, note skins, menu themes and whole styles made by players. Open it in the game (Play → Workshop) or on this website (Workshop in the menu). Everything shared is also posted in the OCTIVE Discord (#octive-charts, #octive-skins, #octive-themes and #octive-styles)."],
      ["How do I share something?", "Sign in, then in the game: Play → Workshop → Share, and pick a chart from your list, or use Share to the Workshop in Settings → Style for your skin, theme or whole style. Add a title and a description; a preview picture is made for you."],
      ["Can I try a skin before getting it?", "Yes. Click a skin, theme or style in the Workshop to preview it: skins play live with the song that's on, themes show the menus, and styles have pages for each part. Previews are only kept until you close OCTIVE."],
      ["How do I remove my upload?", "The bin button on your own card in the Workshop removes it from the Workshop and deletes its post in the OCTIVE Discord. Moderators can remove uploads that break the rules."],
      ["What does Open in OCTIVE do?", "On a Workshop item on this website (or in its Discord post), Open in OCTIVE starts OCTIVE (or switches to it if it's already open), opens the Workshop and downloads that item for you. It works with OCTIVE 1.5 or newer on Windows and Android."],
      ["Can I update something I shared?", "Yes. The edit button on your own card in the Workshop changes its title or description, or uploads a new version. The post in the OCTIVE Discord is updated in place, and everyone who gets it afterwards gets the new version."],
      ["How big can a file be?", "Up to 150 MB (a pack of songs: 150 MB in all)."],
    ]],
    ["Discord", [
      ["How do I link my Discord?", "Account → Preferences on this website (or Settings → Profile → Discord in the game): you get a code, then type /link with it in the OCTIVE Discord."],
      ["What does linking give me?", "Your Discord on your OCTIVE profile (if you switch it on) so people can copy your username and add you, credit on your Workshop uploads, a DM from the OCTIVE bot when a friend messages you, pings for new updates, /profile, /compare and /achievements in Discord, the supporter role while you boost the server, and the Connected achievement."],
      ["How do I share a score?", "Finish a song while signed in, then press Share score on the results screen. A picture of your results, with your name and picture big at the top, is posted in #octive-scores in the OCTIVE Discord."],
      ["What does copying a Discord name copy?", "Clicking someone's Discord on their profile copies their Discord username (the one you type to add them), not their display name."],
      ["Is the global chat the same as Discord?", "Yes: the Chat tab in Friends (F8) is linked with #octive-chat in the OCTIVE Discord. Messages from the game show in Discord, and the other way round."],
    ]],
    ["Profiles and checks", [
      ["What do the check marks mean?", "A blue check means a known person whose account is really theirs. The navy and gold check is for official OCTIVE accounts. Only the OCTIVE developer gives them out."],
      ["What is the OCTIVE account?", "The official OCTIVE account. It isn't on the ranking, it can message any player (and you can answer it) and it's always level 1000."],
      ["I switched accounts and my picture or bio looked wrong", "Fixed in 1.5: each account on a computer keeps its own picture, bio, links, friends and followers. Signing in to another account loads that account's own."],
    ]],
    ["Style: skins, themes and HUD", [
      ["Where are skins and themes?", "Settings → Style has everything about how OCTIVE looks: your whole style, the HUD layout, note skins (with the skin maker) and menu themes."],
      ["What is a style?", "One .octstyle file with your note skin, menu theme, HUD layout and mouse cursor, like an osu! skin. Send it to a friend or share it to the Workshop, and they look exactly like you."],
      ["Can I use osu! skins?", "Yes. Import an .osk in Settings → Style → Import. They're converted as well as possible; some unusual skins may not look quite right."],
    ]],
    ["Accounts and scores", [
      ["I signed in to another account and my scores were gone", "Scores on a computer belong to one account. When someone else signs in, your scores are put aside and come back when you sign in again. Plays made while signed out are only added to an account if you say yes when it asks."],
      ["I forgot my password", "Use Forgot password on the Account page. It needs an email linked to your account (link one on the Account page while signed in)."],
      ["Can I change my name?", "Yes, once a week in the game (Profile → Name). Supporters can change it any time."],
      ["Where are my account settings on the website?", "In the menu on the left: your name and picture open your public profile, and the gear button next to it opens your account settings (picture, bio, email, password, Discord and preferences)."],
    ]],
    ["Supporter and payments", [
      ["What does supporting give?", "A supporter badge with anniversary art, a profile banner, coloured names, profile effects, an animated GIF picture, free name changes and a pink border on leaderboards. It's cosmetic only and never affects scores."],
      ["How do gifts work?", "Choose As a gift on the Supporter page and pick a player. They get a pop-up on their own profile on this website to claim it, and their time starts when they claim it."],
      ["Does it renew automatically?", "No. Each purchase is a one-time payment through Stripe; nothing is charged again."],
    ]],
    ["Problems", [
      ["An osu! song won't play", "Some osu! maps have audio that's really an MP4 file with an .mp3 name. OCTIVE 1.4 plays these on Windows. If a song still fails, re-import it or report it in the Discord."],
      ["osu! maps scroll strangely", "Turn off osu! scroll speed changes in Settings → Gameplay for a constant speed, like osu!'s constant speed option."],
      ["Where are my files?", "Settings → Profile & data shows the data folder (songs, replays, skins and settings) with an Open folder button."],
      ["Something else?", "Ask in the OCTIVE Discord server or open an issue at github.com/SenterraSlays/octive/issues."],
    ]],
  ];

  /** (2.2.2) The Help page's timing table: OCTIVE's hit windows (Engine/Judgement/Judge.cs), releases, mods, osu! Timing. */
  function timingWindows() {
    const rows = [[30, 45], [55, 82.5], [85, 127.5], [120, 180], [150, 225]];
    const ms = (v) => "±" + (Number.isInteger(v) ? v : v.toFixed(1)) + " ms";
    const table = h("table.timing-table", {},
      h("thead", {}, h("tr", {}, h("th", { text: "Judgement" }), h("th", { text: "Hit" }), h("th", { text: "Long note release" }))),
      h("tbody", {}, ...rows.map(([hit, rel], i) => {
        const [name, col] = JUDGEMENTS[i];
        return h("tr", {}, h("td", {}, h("span.timing-name", { text: name, style: `--j:${col}` })), h("td", { text: ms(hit) }), h("td", { text: ms(rel) }));
      }), h("tr.timing-miss", {}, h("td", {}, h("span.timing-name", { text: "Miss", style: `--j:${JUDGEMENTS[5][1]}` })), h("td", { text: "over 150 ms late" }), h("td", { text: "over 225 ms late" }))));
    const od = (v) => [16, 64 - 3 * v, 97 - 3 * v, 127 - 3 * v, 151 - 3 * v, 188 - 3 * v].join(" / ");
    return h("div.timing-help", {}, table,
      h("ul.timing-notes", {},
        h("li", { text: "Too early: a press more than 150 ms before a note is a ghost tap and does nothing." }),
        h("li", { text: "Mods: Easy makes every window 1.4× wider, Hard Rock 1.4× tighter." }),
        h("li", { text: `osu! Timing (OT) uses osu!mania's windows from the chart's OD: MAX ±16 ms, 300 ±(64 − 3·OD), 200 ±(97 − 3·OD), 100 ±(127 − 3·OD), 50 ±(151 − 3·OD), and a miss at 188 − 3·OD. At OD 8 that's ${od(8)} ms.` }),
        h("li", { text: "Chart makers can widen or tighten single notes (0.25× to 4×) with a note's window scale." })));
  }

  function helpPage() {
    document.title = "Help · OCTIVE";
    const q = h("input.help-search", { type: "search", placeholder: "Search the questions…", "aria-label": "Search help" });
    const list = h("div.help-list");
    const paint = () => {
      const term = q.value.trim().toLowerCase();
      list.replaceChildren(...HELP.map(([group, items]) => {
        const shown = items.filter(([a, b]) => !term || (a + " " + b).toLowerCase().includes(term));
        if (!shown.length) return null;
        return h("section.help-group", {}, h("h2", { text: group }),
          ...shown.map(([a, b, more]) => h("details.help-item", term ? { open: true } : {}, h("summary", { text: a }), h("p", { text: b }), more ? more() : null)));
      }).filter(Boolean));
      if (!list.children.length) list.append(h("p.empty", { text: "No questions match. Try other words, or ask in the Discord." }));
    };
    q.addEventListener("input", paint);
    // (3.0) help?q=… (from the quick search) opens with that question found
    q.value = hashQuery().get("q") || "";
    paint();
    app.replaceChildren(h("div.help-page", {},
      h("section.page-head", {}, h("p.eyebrow", { text: "Questions and answers" }), h("h1", { text: "Help" }), h("p.sub", { text: "Common questions about OCTIVE. Can't find yours? Press Ctrl K to search everything, or ask in the Discord." })),
      q, list));
  }


  // ---------------------------------------------------------------- #/updates: every release and its announcement
  // releases/history.json is written by the release tool (full releases only, never test builds).

  /** A bit of Markdown (the Discord announcement) as page elements: headings, bullets, bold, code, links. */
  function markdown(text) {
    const inline = (s) => {
      const out = [];
      const re = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|https?:\/\/[^\s)<>]+)/g;
      let last = 0, m;
      while ((m = re.exec(s))) {
        if (m.index > last) out.push(s.slice(last, m.index));
        const t = m[0];
        if (t.startsWith("**") || t.startsWith("__")) out.push(h("strong", { text: t.slice(2, -2) }));
        else if (t.startsWith("`")) out.push(h("code", { text: t.slice(1, -1) }));
        else out.push(h("a", { href: t, target: "_blank", rel: "noopener", text: t.replace(/^https?:\/\//, "") }));
        last = m.index + t.length;
      }
      if (last < s.length) out.push(s.slice(last));
      return out;
    };
    const root = h("div.md");
    let list = null;
    for (const raw of String(text || "").split("\n")) {
      const line = raw.trimEnd();
      const bullet = line.match(/^\s*(?:[•\-*]|\d+\.)\s+(.*)$/);
      if (bullet) { if (!list) { list = h("ul"); root.append(list); } list.append(h("li", {}, inline(bullet[1]))); continue; }
      list = null;
      if (!line.trim()) continue;
      const hd = line.match(/^(#{1,3})\s+(.*)$/);
      if (hd) root.append(h(hd[1].length === 1 ? "h3" : "h4", {}, inline(hd[2])));
      else root.append(h("p", {}, inline(line)));
    }
    return root;
  }

  function updatesPage() {
    document.title = "Updates · OCTIVE";
    const list = h("div.updates-list", {}, h("p.empty", { text: "Loading the update history…" }));
    const chips = h("div.ph-chips");
    app.replaceChildren(h("div.updates-page", {},
      h("section.page-head", {}, h("h1", { text: "Update history" }), h("p.sub", { text: "Every OCTIVE release, newest first. The game updates itself when a new one comes out." }), chips),
      list));
    fetch(worker + "/releases/history.json", { cache: "no-cache" }).then((r) => r.ok ? r.json() : []).catch(() => []).then((hist) => {
      hist = (Array.isArray(hist) ? hist : []).filter((x) => x && x.version && !/test/i.test(x.version));
      if (!hist.length) { list.replaceChildren(h("p.empty", { text: "The update history couldn't be loaded right now." })); return; }
      chips.replaceChildren(h("span.ph-chip.ver", { text: "Latest: v" + hist[0].version }), h("span.ph-chip", { text: `${hist.length} release${hist.length === 1 ? "" : "s"}` }));
      list.replaceChildren(...hist.map((x, i) => {
        const when = x.published ? new Date(x.published) : null;
        const date = when && !isNaN(when) ? when.toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" }) : "";
        const body = x.announcement ? markdown(x.announcement) : h("div.md", {}, h("p", { text: x.notes || "" }));
        const card = h("article.update" + (i === 0 ? ".latest" : ""), { id: "v" + x.version },
          h("header.update-head", {},
            h("div", {}, h("h2", {}, "OCTIVE ", h("span.update-ver", { text: x.version })), date ? h("time", { datetime: x.published, text: date }) : null),
            i === 0 ? h("span.update-pill", { text: "Latest" }) : null),
          body);
        // long announcements fold until opened
        if ((x.announcement || "").length > 1400) {
          card.classList.add("folded");
          const more = h("button.btn.update-more", { type: "button", text: "Show everything" });
          more.addEventListener("click", () => { const f = card.classList.toggle("folded"); more.textContent = f ? "Show everything" : "Show less"; });
          card.append(more);
        }
        return card;
      }));
      const anchor = routeHash().split("?")[0].match(/^#\/updates\/(.+)$/);
      if (anchor) document.getElementById("v" + anchor[1])?.scrollIntoView({ behavior: "smooth" });
    });
  }

  // ---------------------------------------------------------------- messages (the same ones as in the game)
  // #/messages lists conversations and friends; #/messages/<playerId> opens one. Messages live on the
  // Worker (/dm/*), so they reach friends who are offline and match the game on every device.

  let dmUnread = 0, dmTimer = null;

  async function refreshDmBadge() {
    if (!worker || !me) return;
    try { const box = await callApi("/dm/inbox", undefined, true); dmUnread = box.unread || 0; } catch { /* keep */ }
    updateAccountNav();
  }

  const dmAvatar = (id, name, cls = "dm-av") => {
    const el = h("span." + cls, { text: (name || "?").slice(0, 1).toUpperCase(), style: `--av:${avatarTint(id)}` });
    const img = h("img", { src: `${worker}/avatar/${encodeURIComponent(id)}`, alt: "", loading: "lazy" });
    img.addEventListener("load", () => { el.textContent = ""; el.append(img); });
    return el;
  };

  function dmWhen(ms) {
    const d = new Date(ms), now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    if (now - d < 6 * 86_400_000) return d.toLocaleDateString(undefined, { weekday: "short" });
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  async function messagesPage() {
    document.title = "Messages · OCTIVE";
    clearInterval(dmTimer); dmTimer = null;
    if (!worker) { app.replaceChildren(h("p.empty", { text: "Messages aren't available on this copy of the site." })); return; }
    if (!me && (store.get("octive.token", true) || store.get("octive.session"))) {
      app.replaceChildren(h("p.empty", { text: "Loading your messages…" }));
      try { if (!store.get("octive.token", true)) await refreshSession(); me = await callApi("me", undefined, true); updateAccountNav(); } catch { /* signed out */ }
      if (page() !== "messages") return;
    }
    if (!me) {
      const ic = h("span.dm-signin-ic", { "aria-hidden": "true" });
      ic.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4h0A2.5 2.5 0 0 1 4 13.5z"/><path d="M8.5 8.5h7M8.5 11.5h4.5"/></svg>';
      app.replaceChildren(h("section.dm-signin", {}, ic,
        h("h1", { text: "Messages" }),
        h("p.sub", { text: "Sign in with your OCTIVE account to read and send messages to your friends. They get them in the game too, even when they're offline." }),
        h("a.btn.primary.big", { href: "account" }, "Sign in")));
      return;
    }
    const openId = (routeHash().match(/^#\/messages\/([A-Za-z0-9_-]{8,64})/) || [])[1] || null;
    const list = h("div.dm-list");
    const pane = h("section.dm-pane");
    const unreadChip = h("span.dm-unread-chip", { hidden: true });
    const root = h("div.dm-page" + (openId ? ".dm-open" : ""), {}, h("aside.dm-side", {}, h("div.dm-side-head", {}, h("h1", { text: "Messages" }), unreadChip), list), pane);
    app.replaceChildren(root);
    let box = null, thread = [], since = 0, paintHead = () => {};

    const nameOf = (id) => (box?.threads || []).find((t) => t.with === id)?.name || (box?.friends || []).find((f) => f.id === id)?.name || dmNames[id] || findPlayer(id)?.name || (id === OFFICIAL_ID ? "Octive" : "Player");

    function paintList() {
      const seen = new Set();
      const rows = [];
      for (const t of box?.threads || []) {
        seen.add(t.with);
        rows.push(h("a.dm-row" + (t.with === openId ? ".active" : "") + (t.unread ? ".unread" : "") + (findPlayer(t.with)?.online ? ".online" : ""), { href: "messages/" + encodeURIComponent(t.with) },
          dmAvatar(t.with, t.name),
          h("span.dm-row-main", {}, h("span.dm-row-name", { text: t.name || "Player" }), h("span.dm-row-last", { text: (t.fromMe ? "You: " : "") + (t.preview || "") })),
          h("span.dm-row-side", {}, h("span.dm-when", { text: t.last ? dmWhen(t.last) : "" }), t.unread ? h("span.dm-count", { text: String(t.unread) }) : null)));
      }
      const others = (box?.friends || []).filter((f) => !seen.has(f.id)).sort((a, b) => a.name.localeCompare(b.name));
      if (others.length) {
        rows.push(h("p.dm-cap", { text: "Friends" }));
        for (const f of others)
          rows.push(h("a.dm-row" + (f.id === openId ? ".active" : "") + (findPlayer(f.id)?.online ? ".online" : ""), { href: "messages/" + encodeURIComponent(f.id) },
            dmAvatar(f.id, f.name), h("span.dm-row-main", {}, h("span.dm-row-name", { text: f.name || "Player" }), h("span.dm-row-last", { text: "Start a conversation" }))));
      }
      if (!rows.length)
        rows.push(h("p.dm-none", { text: box && !box.synced
          ? "Open OCTIVE and sign in once: the game shares your friend list with the website so you can message them here."
          : "No friends yet. Add friends in the game (Friends, F8), then message them here." }));
      list.replaceChildren(...rows);
      const n = box?.unread || 0;
      unreadChip.hidden = !n;
      unreadChip.textContent = `${n} unread`;
    }

    const feed = h("div.dm-feed");
    const input = h("textarea.dm-input", { rows: 1, maxlength: 500, placeholder: "Write a message…", "aria-label": "Message" });
    const sendBtn = h("button.dm-sendbtn", { type: "submit", "aria-label": "Send", title: "Send (Enter)" });
    sendBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12 20 4l-4 16-4.5-6.5z"/><path d="M20 4 11.5 13.5"/></svg>';
    const note = h("p.form-msg", { role: "status" });

    function paintThread() {
      const kids = [];
      let day = "", prev = null;
      for (const m of thread) {
        const d = new Date(m.at).toDateString();
        if (d !== day) { day = d; prev = null; kids.push(h("p.dm-day", {}, h("span", { text: d === new Date().toDateString() ? "Today" : new Date(m.at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) }))); }
        const mine = m.from === me.playerId;
        const first = !prev || prev.from !== m.from || m.at - prev.at > 5 * 60e3;
        kids.push(h("div.dm-msg" + (mine ? ".mine" : "") + (first ? ".first" : "") + (m.pending ? ".pending" : "") + (m.failed ? ".failed" : ""), {},
          !mine && first ? dmAvatar(m.from, nameOf(m.from), "dm-msg-av") : null,
          h("div.dm-bubble", {},
            h("p", { text: m.text }),
            h("span.dm-time", { text: m.failed ? "Not sent: " + m.failed : m.pending ? "Sending…" : new Date(m.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) }))));
        prev = m;
      }
      if (!kids.length) kids.push(h("p.dm-none", { text: `Say hi to ${nameOf(openId)}! They'll see it in the game, even if they're offline right now.` }));
      const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
      feed.replaceChildren(...kids);
      if (atBottom || !feed.dataset.ready) { feed.scrollTop = feed.scrollHeight; feed.dataset.ready = "1"; }
    }

    async function loadThread() {
      if (!openId) return;
      try {
        const r = await callApi(`/dm/thread/${encodeURIComponent(openId)}?since=${since}`, undefined, true);
        const fresh = (r.msgs || []).filter((m) => !thread.some((x) => x.id === m.id && !x.pending));
        for (const m of fresh) { thread = thread.filter((x) => x.id !== m.id); thread.push(m); since = Math.max(since, m.at); }
        thread.sort((a, b) => a.at - b.at);
        if (fresh.length) paintThread();
      } catch (e) { setMsg(note, e.message); }
    }

    async function loadInbox() {
      try { box = await callApi("/dm/inbox", undefined, true); } catch (e) { list.replaceChildren(h("p.dm-none", { text: e.message })); return; }
      dmUnread = box.unread || 0;
      updateAccountNav();
      const t = openId && (box.threads || []).find((x) => x.with === openId);
      if (t && t.unread) { callApi("/dm/read", { with: openId }, true).then(refreshDmBadge).catch(() => {}); t.unread = 0; }
      paintList();
    }

    async function send() {
      const text = input.value.trim();
      if (!text || !openId) return;
      const id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/-/g, "").slice(0, 32);
      const draft = { id, from: me.playerId, text, at: Date.now(), pending: true };
      thread.push(draft); input.value = ""; input.style.height = ""; paintThread();
      try {
        const r = await callApi("/dm/send", { to: openId, id, text, name: me.name }, true);
        Object.assign(draft, r.msg, { pending: false });
        since = Math.max(since, draft.at);
        loadInbox();
      } catch (e) { draft.pending = false; draft.failed = e.message; }
      paintThread();
    }

    if (openId) {
      input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
      input.addEventListener("input", () => { input.style.height = ""; input.style.height = Math.min(input.scrollHeight, 160) + "px"; });
      const headAv = h("span.dm-head-av"), headName = h("a.dm-head-name", { href: profileHref(openId) }), headSub = h("small.dm-head-sub");
      paintHead = () => {
        headAv.replaceChildren(dmAvatar(openId, nameOf(openId)));
        headName.textContent = nameOf(openId);
        const p = findPlayer(openId);
        headSub.textContent = p ? (p.online ? "● " : "") + statusText(p) : "";
        headSub.classList.toggle("on", !!(p && p.online));
      };
      paintHead();
      const head = h("div.dm-head", {},
        h("a.dm-back", { href: "messages", "aria-label": "All messages" }, "←"),
        headAv, h("div.dm-head-text", {}, headName, headSub),
        h("a.btn.small.dm-head-prof", { href: profileHref(openId) }, "Profile"));
      pane.replaceChildren(head, feed,
        h("form.dm-send", { onsubmit: (e) => { e.preventDefault(); send(); } }, input, sendBtn), note);
    } else {
      const ic = h("span.dm-empty-ic", { "aria-hidden": "true" });
      ic.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4h0A2.5 2.5 0 0 1 4 13.5z"/><path d="M8.5 8.5h7M8.5 11.5h4.5"/></svg>';
      pane.replaceChildren(h("div.dm-empty", {}, ic, h("b", { text: "Your messages" }),
        h("p", { text: "Pick a conversation or a friend. Messages reach them in the game too, even when they're offline." })));
    }

    await loadInbox();
    if (openId) {
      paintHead();
      await loadThread();
      paintThread();
      input.focus();
    }
    dmTimer = setInterval(() => {
      if (page() !== "messages") { clearInterval(dmTimer); dmTimer = null; return; }
      if (document.hidden) return;
      loadInbox(); loadThread();
    }, 8000);
  }

  // ---------------------------------------------------------------- #/crews and #/crew/<id>: the crew board and a crew's page (2.0.2)
  const crewCol = (c) => (/^#[0-9A-Fa-f]{6}$/.test(String(c || "")) ? c : "#3FD8FF");
  function crewTag(c, big) {
    const col = crewCol(c.color);
    return h("span.crew-tag" + (big ? ".big" : ""), { text: c.tag || "?", style: `color:${col};background:${col}22;border-color:${col}99` });
  }
  function crewsPage() {
    const one = (routeHash().match(/^#\/crew\/([a-z0-9]{10,24})/) || [])[1];
    if (one) return crewPage(one);
    document.title = "Crews · OCTIVE";
    const podium = h("div.t3-wrap");
    const list = h("div.crew-list", {}, h("p.empty", { text: "Loading the crew board…" }));
    app.replaceChildren(h("section.cw-board", {},
      h("section.page-head", {}, h("p.eyebrow", { text: "Teams" }), h("h1", { text: "Crews" }),
        h("p.sub", { text: "Crews are teams of up to 12 players. A crew's score is its five best members' PR added up. Make or join one in the game: Profile → Crew." })),
      podium, list));
    fetch(`${worker}/play/crews`, { cache: "no-cache" }).then((r) => r.ok ? r.json() : null).catch(() => null).then((d) => {
      if (!list.isConnected) return;
      const crews = (d && d.crews) || [];
      if (!crews.length) { list.replaceChildren(h("p.empty", { text: "No crews yet." })); return; }
      const best = Math.max(1, ...crews.map((c) => c.score || 0));
      const members = (c) => `${c.members} member${c.members === 1 ? "" : "s"}`;
      // (3.2) the top three on cards, in their crew's colour
      const t3 = topThree(crews.slice(0, 3).map((c) => ({ place: c.rank, href: "crew/" + encodeURIComponent(c.id), color: crewCol(c.color),
        art: h("span.t3-crew", {}, crewTag(c, true)), name: h("span", { text: c.name }), sub: members(c),
        value: fmt0.format(Math.round(c.score || 0)) + " PR", stats: [["Members", `${fmt0.format(c.members || 0)} / 12`]] })));
      podium.replaceChildren(...(t3 ? [t3] : []));
      // everyone else, with a bar for their score next to the best crew's
      list.replaceChildren(...crews.slice(3).map((c) => h("a.crew-row", { href: "crew/" + encodeURIComponent(c.id), style: `--crew:${crewCol(c.color)}` },
        h("span.crew-rank", { text: "#" + c.rank }),
        crewTag(c),
        h("span.crew-name", { text: c.name }),
        h("span.crew-members", { text: members(c) }),
        h("span.cw-bar", {}, h("span", { style: `width:${Math.max(2, Math.round((c.score || 0) / best * 100))}%` })),
        h("b.crew-score", { text: fmt0.format(Math.round(c.score || 0)) + " PR" }))));
    });
  }
  function crewPage(id) {
    document.title = "Crew · OCTIVE";
    const box = h("div", {}, h("p.empty", { text: "Loading the crew…" }));
    app.replaceChildren(h("div.crew-page", {}, h("a.back", { href: "crews" }, "← Crew board"), box));
    fetch(`${worker}/play/crews/of?id=${encodeURIComponent(id)}`, { cache: "no-cache" }).then((r) => r.ok ? r.json() : null).catch(() => null).then((d) => {
      if (!box.isConnected) return;
      const c = d && d.crew;
      if (!c) { box.replaceChildren(h("p.empty", { text: "That crew isn't around any more." })); return; }
      document.title = `${c.name} · Crews · OCTIVE`;
      const col = crewCol(c.color);
      const date = (t) => t ? new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
      const stat = (label, value) => h("div.crew-stat", {}, h("span.field-label", { text: label }), h("b", { text: value }));
      const wars = c.wars || {};
      const all = (c.members || []).slice().sort((a, b) => (b.pp || 0) - (a.pp || 0));
      const hero = h("section.crew-hero.cw-hero", { style: `--crew:${col}` },
        h("div.crew-top", {}, crewTag(c, true),
          h("div.crew-titles", {}, h("h1", { text: c.name }), c.desc ? h("p.crew-desc", { text: c.desc }) : null,
            c.created ? h("p.cw-since", { text: "A crew since " + date(c.created) }) : null)),
        h("div.crew-stats", {},
          stat("Crew rank", c.rank > 0 ? "#" + fmt0.format(c.rank) : "–"),
          stat("Score", fmt0.format(Math.round(c.score || 0)) + " PR"),
          stat("Members", `${all.length} / ${c.max || 12}`),
          stat("Crew wars won", fmt0.format(wars.wins || 0)),
          stat("War podiums", fmt0.format(wars.podiums || 0))),
        h("p.panel-sub", { text: "Score: the five best members' PR added up." }));
      // the members, best first: the five who count get a ★, and a bar for their PR next to the best member's
      const best = Math.max(1, ...all.map((m) => m.pp || 0));
      const members = all.map((m, i) => {
        // the same picture as on the ranking (and an online dot), or their first letter
        const av = h("span.avatar.crew-av", {}, h("img", { alt: "", loading: "lazy", hidden: true }), h("span.initial", { text: (m.name || "?").charAt(0).toUpperCase() }), h("span.dot", { hidden: true }));
        const rp = findPlayer(m.id);
        if (rp) setAvatar(av, rp);
        return h("a.crew-member", { href: profileHref(m.id), style: `--crew:${col}` },
          h("span.cw-pos", { text: String(i + 1) }),
          av,
          h("span.cw-who", {}, h("span.crew-name", { text: m.name || "Player" }), m.joined ? h("span.cw-joined", { text: "joined " + date(m.joined) }) : null),
          m.role === "owner" ? h("span.crew-owner", { text: "OWNER", style: `color:${col};background:${col}22` }) : null,
          i < 5 ? h("span.cw-star", { text: "★", title: "One of the five who count for the crew's score" }) : h("span.cw-star.off"),
          h("span.cw-bar", {}, h("span", { style: `width:${Math.max(2, Math.round((m.pp || 0) / best * 100))}%` })),
          h("b.crew-score", { text: fmt0.format(Math.round(m.pp || 0)) + " PR" }));
      });
      box.replaceChildren(hero,
        h("div.section-head.crew-sub", {}, h("h2.section-title", { text: `Members · ${all.length} / ${c.max || 12}` }), h("span.cw-note", { text: "★ counts for the crew's score" })),
        h("div.crew-list", {}, members));
    });
  }

  // (2.2.2) profiles have addresses without a #: senterraslays.github.io/octive/u/<player id or link>. GitHub Pages serves
  // u/<key>.html (written by the Worker, with the player's card for link previews) or, for anyone else, 404.html (this
  // same site); the page is picked from the path. Old #/u/ links are moved to the new address.
  function profileKey() {
    if (!location.pathname.startsWith(BASE_PATH)) return null;
    const m = location.pathname.slice(BASE_PATH.length).match(/^u\/([^/]+?)(?:\.html)?\/?$/);
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  }
  function tidyAddress() {
    const hash = location.hash;
    if (hash.startsWith("#/")) {
      // an old #/ link: its page at its own address (a query before the #, like ?twitch=linked#/account, comes along)
      let rest = routePath(hash);
      if (!rest.includes("?") && location.search) rest += location.search;
      history.replaceState(history.state, "", BASE_PATH + rest);
    } else if (/^(index|404)(\.html)?$/.test(location.pathname.slice(BASE_PATH.length))) history.replaceState(history.state, "", BASE_PATH + location.search);
  }

  function page() {
    if (profileKey()) return "player";
    const m = routeHash().match(/^#\/([a-z]+)/);
    return m ? m[1] : "home";
  }

  // (3.0) the page's name beside OCTIVE in the top bar
  const PAGE_NAMES = { rankings: "Rankings", countries: "Countries", ranked: "Ranked", crews: "Crews", workshop: "Workshop", daily: "Daily charts",
    download: "Download", tools: "Rhythm tools", updates: "Updates", supporter: "Supporter", help: "Help", live: "Live on Twitch", messages: "Messages",
    account: "Account", reset: "Password reset", open: "Workshop", compare: "Compare players", player: "Player" };
  function setCrumb(text) {
    const c = document.getElementById("crumb");
    if (c) c.replaceChildren(...(text ? [h("i"), h("b", { text })] : []));
  }

  function route(fromHashChange) {
    if (!app) return;
    tidyAddress();
    const pg = page();
    const mine = pg === "player" && me && (profileKey() === me.playerId || (!!me.link && String(profileKey()).toLowerCase() === me.link.toLowerCase()));
    const navKey = pg === "player" ? (mine ? "me" : "rankings") : pg === "account" ? "settings" : pg === "crew" ? "crews" : pg;
    for (const a of document.querySelectorAll("[data-nav]")) a.classList.toggle("active", a.dataset.nav === navKey || (navKey === "settings" && a.dataset.nav === "account"));
    // (3.0) every page has its own colour (the background's glow, titles, tabs…)
    const q = hashQuery();
    const pageKey = pg === "player" ? (q.get("vs") ? "compare" : "player") : pg === "rankings" && q.get("view") === "countries" ? "countries" : pg === "crew" ? "crews" : pg;
    // leaving the tools: a test that's still going stops (its clicks and timers)
    if (pageKey !== "tools" && toolKeys) { toolKeys.stop?.(); toolKeys = null; }
    document.body.dataset.page = pageKey;
    setCrumb(pageKey === "home" ? "" : PAGE_NAMES[pageKey] || "");
    if ((pg === "rankings" || pg === "player" || pg === "ranked") && !data) { app.replaceChildren(h("p.empty", { text: "Loading the ranking…" })); return; }
    if (pg === "player") player(profileKey());
    else if (pg === "rankings") rankings();
    else if (pg === "ranked") rankedPage();
    else if (pg === "download") download();
    else if (pg === "account") account();
    else if (pg === "reset") resetPage();
    else if (pg === "supporter") supporterPage();
    else if (pg === "help") helpPage();
    else if (pg === "updates") updatesPage();
    else if (pg === "workshop") workshopPage();
    else if (pg === "daily") dailyPage();
    else if (pg === "live") livePage();
    else if (pg === "messages") messagesPage();
    else if (pg === "open") openPage();
    else if (pg === "crews" || pg === "crew") crewsPage();
    else if (pg === "tools") toolsPage();
    else home();
    paintListPill();
    if (fromHashChange) window.scrollTo(0, 0);
  }

  window.addEventListener("hashchange", () => { route(true); closeSide(); });
  // (2.2.2) moving between the site's pages without loading the site again (links to its own files, like about.html
  // or play/, load as usual)
  const SITE_ROUTES = new Set(["", "u", "rankings", "ranked", "crews", "crew", "workshop", "daily", "downloads", "updates", "supporter", "help", "account", "reset", "messages", "live", "open", "tools"]);
  window.addEventListener("popstate", () => route(true));
  document.addEventListener("click", (e) => {
    // a link to a spot on this page (#app, the skip link): go there, don't load another page
    const jump = e.target.closest && e.target.closest('a[href^="#"]:not([href^="#/"])');
    if (jump && e.button === 0) {
      const id = jump.getAttribute("href").slice(1), to = (id && document.getElementById(id)) || document.querySelector("main");
      if (to) { e.preventDefault(); to.setAttribute("tabindex", "-1"); to.focus({ preventScroll: true }); to.scrollIntoView({ block: "start" }); }
      return;
    }
    if (!app || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // (pages of their own load the site as usual)
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
    const u = new URL(a.href, document.baseURI);
    if (u.origin !== location.origin || !u.pathname.startsWith(BASE_PATH)) return;
    const rest = u.pathname.slice(BASE_PATH.length);
    let to;
    if (u.hash.startsWith("#/")) to = BASE_PATH + routePath(u.hash);
    else if (SITE_ROUTES.has(rest.split("/")[0]) && !/\.[a-z0-9]+$/i.test(rest)) to = u.pathname + u.search;
    else return;
    e.preventDefault();
    if (to === location.pathname + location.search) history.replaceState(history.state, "", to); else history.pushState(null, "", to);
    route(true);
    closeSide();
  });

  // ---------------------------------------------------------------- 3.0: the menu, a sidebar that slides in
  // Pointing at the window's left edge opens it and moving away closes it again; the menu button (or the M key) opens
  // it until you click elsewhere. Pinned, it stays open beside the page (wide screens only). On phones it's a drawer.
  const side = document.querySelector(".side");
  const menuBtn = document.querySelector(".menu-btn");
  const pinBtn = document.querySelector(".side-pin");
  const hoverable = matchMedia("(hover: hover) and (pointer: fine)");
  const wideEnough = matchMedia("(min-width: 1180px)");
  let sideBy = null, sideShut = null;
  function openSide(by) {
    clearTimeout(sideShut);
    if (!side || document.body.classList.contains("side-pinned")) return;
    sideBy = by;
    document.body.classList.add("side-open");
    menuBtn?.setAttribute("aria-expanded", "true");
  }
  function closeSide() {
    clearTimeout(sideShut);
    sideBy = null;
    document.body.classList.remove("side-open", "menu-open");
    menuBtn?.setAttribute("aria-expanded", "false");
  }
  const toggleSide = (by) => (document.body.classList.contains("side-open") ? closeSide() : openSide(by));
  function applyPin(on) {
    const pinned = !!on && wideEnough.matches;
    document.body.classList.toggle("side-pinned", pinned);
    pinBtn?.setAttribute("aria-pressed", String(!!on));
    if (pinBtn) pinBtn.title = on ? "Let the menu hide again" : "Keep the menu open";
    if (pinned) closeSide();
  }
  if (side) {
    applyPin(store.get("octive.sidePinned") === "1");
    wideEnough.addEventListener?.("change", () => applyPin(store.get("octive.sidePinned") === "1"));
    pinBtn?.addEventListener("click", () => {
      const on = store.get("octive.sidePinned") !== "1";
      store.set("octive.sidePinned", on ? "1" : null);
      applyPin(on);
      if (!on) openSide("click");
    });
    document.querySelector(".side-edge")?.addEventListener("pointerenter", () => { if (hoverable.matches) openSide("hover"); });
    side.addEventListener("pointerenter", () => clearTimeout(sideShut));
    side.addEventListener("pointerleave", (e) => { if (sideBy === "hover" && e.pointerType === "mouse") sideShut = setTimeout(closeSide, 280); });
    side.addEventListener("focusout", (e) => { if (sideBy && sideBy !== "hover" && e.relatedTarget && !side.contains(e.relatedTarget) && !e.relatedTarget.closest(".menu-btn")) closeSide(); });
    menuBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSide("click");
      // from the keyboard: straight to the first link
      if (e.detail === 0 && document.body.classList.contains("side-open")) setTimeout(() => side.querySelector(".side-nav a:not([hidden])")?.focus(), 60);
    });
    document.querySelector(".side-scrim")?.addEventListener("click", closeSide);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && document.body.classList.contains("side-open")) { closeSide(); menuBtn?.focus(); } });
  }
  document.querySelector(".qs-btn")?.addEventListener("click", () => openSearch());
  // the menu's live line: players online now and the latest version
  function paintSideStatus() {
    const on = document.getElementById("side-online");
    if (on && data) on.textContent = fmt0.format(data.players.filter((p) => p.online).length);
  }
  loadRelease().then((m) => { const v = document.getElementById("side-ver"); if (v && m && m.version) v.textContent = "v" + m.version; });
  // stay signed in: show the name in the menu
  if (worker && (store.get("octive.token", true) || store.get("octive.session")) && page() !== "account")
    callApi("me", undefined, true).then((m) => { me = m; updateAccountNav(); giftPopup(); refreshDmBadge(); }).catch(() => {});
  // unread messages in the menu
  setInterval(() => { if (me && !document.hidden && page() !== "messages") refreshDmBadge(); }, 90_000);
  // "Viewing Website" for others while signed in here
  setTimeout(pingSeen, 3000);
  setInterval(pingSeen, 120_000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pingSeen(); });
  // keep online status fresh while the page is open
  setInterval(() => {
    const q = document.querySelector("[data-search]"), typing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (!document.hidden && !(q && q.value) && !typing && !qsLayer && !hashQuery().has("vs") && window.scrollY < 200 && ["home", "rankings", "player", "ranked"].includes(page())) load();
  }, 90_000);
  // ---------------------------------------------------------------- 3.0: rhythm tools (key test, tapping test, offset finder)
  // Everything runs in the page; nothing is sent anywhere. While a tool is open it listens to the keyboard, so the site's
  // own shortcuts (G…, M, the arrow-key secret) stay quiet on this page.
  const TOOL_TABS = [["keys", "Key test"], ["tap", "Tapping test"], ["offset", "Offset finder"]];
  let toolKeys = null; // the open tool's key handlers: { down(e), up(e), blur() }
  const toolTyping = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || "");
  document.addEventListener("keydown", (e) => {
    if (!toolKeys || document.body.dataset.page !== "tools" || e.ctrlKey || e.metaKey || e.altKey || toolTyping(e)) return;
    // Enter and Space on a link or a button do what they normally do (follow it, press it)
    if ((e.key === "Enter" || e.key === " ") && e.target && e.target.closest && e.target.closest("a[href], button, select, [role=button], .side, .qs-layer, .modal-layer") && !e.target.closest(".of-pad, .tp-pad")) return;
    toolKeys.down(e);
  });
  document.addEventListener("keyup", (e) => { if (toolKeys && document.body.dataset.page === "tools") toolKeys.up?.(e); });
  window.addEventListener("blur", () => toolKeys?.blur?.());
  const KEY_NAMES = { Space: "Space", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Minus: "-", Equal: "=",
    Backquote: "`", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", ShiftLeft: "L Shift", ShiftRight: "R Shift", CapsLock: "Caps", Tab: "Tab", Enter: "Enter", Backspace: "Back" };
  const keyName = (code) => KEY_NAMES[code] || String(code || "").replace(/^Key|^Digit|^Numpad/, "");

  function toolsPage() {
    document.title = "Rhythm tools · OCTIVE";
    const want = hashQuery().get("t");
    const t = TOOL_TABS.some(([k]) => k === want) ? want : "keys";
    const body = h("div.tl-body.tl-live");
    toolKeys?.stop?.();
    toolKeys = null;
    app.replaceChildren(h("div.tools-page", {},
      h("section.page-head", {}, h("p.eyebrow", { text: "For your setup" }), h("h1", { text: "Rhythm tools" }),
        h("p.sub", { text: "Check that your keyboard can hold every key at once, see how fast and steady you tap, and find your audio offset. It all runs in this page: nothing is sent anywhere." })),
      h("nav.tl-tabs.rk-tabs", { "aria-label": "Tools" }, ...TOOL_TABS.map(([k, label]) => h("a.ws-tab" + (k === t ? ".on" : ""), { href: "tools?t=" + k }, label))),
      body));
    if (t === "keys") keyTest(body); else if (t === "tap") tapTest(body); else offsetTest(body);
  }

  // ---- the key test: hold your keys down together; every lane that lights up is a key your keyboard registered
  const KEY_LAYOUTS = { "4K": ["KeyD", "KeyF", "KeyJ", "KeyK"], "5K": ["KeyD", "KeyF", "Space", "KeyJ", "KeyK"], "6K": ["KeyS", "KeyD", "KeyF", "KeyJ", "KeyK", "KeyL"],
    "7K": ["KeyS", "KeyD", "KeyF", "Space", "KeyJ", "KeyK", "KeyL"], "10K": ["KeyA", "KeyS", "KeyD", "KeyF", "KeyV", "KeyN", "KeyJ", "KeyK", "KeyL", "Semicolon"] };
  const LANE_COLS = ["#ff4d9d", "#36d6ff", "#ffd23f", "#a764ff", "#3ee089", "#ff9a3d", "#5b7cff", "#2fe0c0", "#ff5a6e", "#b9a6ff"];
  function keyTest(body) {
    let mine = null;
    try { mine = JSON.parse(store.get("octive.toolKeys") || "null"); } catch { /* none */ }
    let pick = store.get("octive.toolLayout") || "4K";
    let codes = pick === "mine" && Array.isArray(mine) && mine.length ? mine : KEY_LAYOUTS[pick] || KEY_LAYOUTS["4K"];
    if (pick === "mine" && codes === KEY_LAYOUTS["4K"]) pick = "4K";
    let held = new Set(), most = 0, counts = {}, setting = null;
    const field = h("div.kt-field");
    const nowEl = h("b", { text: "0" }), mostEl = h("b", { text: "0" }), msgEl = h("p.kt-msg");
    const chips = h("div.kt-layouts");
    const lanes = new Map();
    function build() {
      held = new Set(); most = 0; counts = {};
      lanes.clear();
      field.style.setProperty("--n", codes.length);
      field.replaceChildren(...codes.map((code, i) => {
        const lane = h("div.kt-lane", { style: `--c:${LANE_COLS[i % LANE_COLS.length]}` }, h("span.kt-beam"), h("span.kt-cap", { text: keyName(code) }), h("small.kt-count", { text: "0" }));
        lanes.set(code, lane);
        return lane;
      }));
      chips.replaceChildren(h("span.kt-cap-label", { text: "Layout" }),
        ...Object.keys(KEY_LAYOUTS).map((k) => h("button.chip" + (pick === k ? ".on" : ""), { type: "button", onclick: () => { pick = k; codes = KEY_LAYOUTS[k]; store.set("octive.toolLayout", k); build(); } }, k)),
        Array.isArray(mine) && mine.length ? h("button.chip" + (pick === "mine" ? ".on" : ""), { type: "button", onclick: () => { pick = "mine"; codes = mine; store.set("octive.toolLayout", "mine"); build(); } }, `My keys (${mine.length}K)`) : null,
        h("button.chip.kt-set", { type: "button", onclick: startSetting }, "Set my keys…"));
      paint();
    }
    function paint() {
      nowEl.textContent = String(held.size);
      mostEl.textContent = `${most} / ${codes.length}`;
      if (setting) { msgEl.className = "kt-msg setting"; msgEl.textContent = setting.length ? `Keys so far: ${setting.map(keyName).join(" ")} · press Enter when you're done (Esc to stop)` : "Press your keys from left to right, then Enter."; return; }
      const all = most >= codes.length;
      msgEl.className = "kt-msg" + (all ? " ok" : "");
      msgEl.textContent = all ? `All ${codes.length} keys register together: no ghosting on this layout.`
        : most > 1 ? `The most keys held together so far: ${most}. Hold all ${codes.length} down at once: if a lane stays dark, your keyboard can't register that combination (ghosting).`
          : matchMedia("(pointer: coarse)").matches && !matchMedia("(pointer: fine)").matches ? "This test needs a keyboard: open this page on a computer, or connect a keyboard."
          : `Hold all ${codes.length} keys down at once. Every lane that lights up is a key your keyboard registered.`;
    }
    function startSetting() { setting = []; field.classList.add("setting"); paint(); }
    function burst(lane) {
      const n = h("i.kt-note");
      lane.append(n);
      setTimeout(() => n.remove(), 600);
    }
    toolKeys = {
      down(e) {
        if (setting) {
          e.preventDefault();
          if (e.code === "Escape") { setting = null; field.classList.remove("setting"); paint(); return; }
          if (e.code === "Enter") {
            if (setting.length) { mine = setting.slice(0, 10); store.set("octive.toolKeys", JSON.stringify(mine)); store.set("octive.toolLayout", "mine"); pick = "mine"; codes = mine; }
            setting = null; field.classList.remove("setting"); build(); return;
          }
          if (!e.repeat && !setting.includes(e.code) && setting.length < 10) setting.push(e.code);
          paint(); return;
        }
        const lane = lanes.get(e.code);
        if (!lane) return;
        e.preventDefault();
        if (e.repeat) return;
        held.add(e.code);
        counts[e.code] = (counts[e.code] || 0) + 1;
        lane.classList.add("on");
        lane.querySelector(".kt-count").textContent = String(counts[e.code]);
        burst(lane);
        most = Math.max(most, held.size);
        paint();
      },
      up(e) { const lane = lanes.get(e.code); if (!lane) return; held.delete(e.code); lane.classList.remove("on"); paint(); },
      blur() { held.clear(); lanes.forEach((l) => l.classList.remove("on")); paint(); },
    };
    body.replaceChildren(h("section.tl-card.feature-card", {},
      h("div.tl-top", {}, h("div", {}, h("h2", { text: "Key test" }), h("p.tl-sub", { text: "Some keyboards can't register certain keys held together (ghosting), which drops notes in chords and jumps. Hold your keys down and see." })),
        h("div.tl-nums", {}, h("div.num-tile", { style: "--s:var(--cyan)" }, h("small", { text: "Held now" }), nowEl), h("div.num-tile", { style: "--s:var(--green)" }, h("small", { text: "Most at once" }), mostEl))),
      chips, field, msgEl,
      h("button.btn.small.ghost.kt-reset", { type: "button", onclick: build }, "Start over")));
    build();
  }

  // ---- the tapping test: tap two keys as fast and as evenly as you can
  const TAP_KEYS = [["Z X", ["KeyZ", "KeyX"]], ["D F", ["KeyD", "KeyF"]], ["J K", ["KeyJ", "KeyK"]], ["Any key", null]];
  const TAP_MODES = [["10 s", { secs: 10 }], ["20 s", { secs: 20 }], ["30 s", { secs: 30 }], ["100 taps", { taps: 100 }]];
  function tapTest(body) {
    let keySet = Number(store.get("octive.tapKeys") || 0) || 0, mode = Number(store.get("octive.tapMode") || 0) || 0;
    let taps = [], raf = 0, done = false;
    const bpmEl = h("b", { text: "0" }), urEl = h("b", { text: "–" }), tapsEl = h("b", { text: "0" }), timeEl = h("b", { text: "–" });
    const graph = h("div.tp-graph"), result = h("div.tp-result", { hidden: true });
    const opts = h("div.tp-opts");
    const pad = h("div.tp-pad", {}, h("span.tp-pad-big", { text: "Tap to start" }), h("small"));
    const stats = () => {
      const iv = [];
      for (let i = 1; i < taps.length; i++) iv.push(taps[i] - taps[i - 1]);
      if (!iv.length) return { bpm: 0, ur: 0, iv };
      const mean = iv.reduce((a, b) => a + b, 0) / iv.length;
      const sd = Math.sqrt(iv.reduce((a, b) => a + (b - mean) * (b - mean), 0) / iv.length);
      return { bpm: 15000 / mean, ur: sd * 10, iv };
    };
    function paintOpts() {
      opts.replaceChildren(h("span.kt-cap-label", { text: "Keys" }), ...TAP_KEYS.map(([label], i) => h("button.chip" + (i === keySet ? ".on" : ""), { type: "button", onclick: () => { keySet = i; store.set("octive.tapKeys", String(i)); reset(); } }, label)),
        h("span.kt-cap-label", { text: "Length" }), ...TAP_MODES.map(([label], i) => h("button.chip" + (i === mode ? ".on" : ""), { type: "button", onclick: () => { mode = i; store.set("octive.tapMode", String(i)); reset(); } }, label)));
    }
    function paintGraph() {
      const { iv } = stats();
      if (iv.length < 3) { graph.replaceChildren(); return; }
      const pts = iv.map((_, i) => { const w = iv.slice(Math.max(0, i - 3), i + 1); return 15000 / (w.reduce((a, b) => a + b, 0) / w.length); });
      const lo = Math.min(...pts) * 0.96, hi = Math.max(...pts) * 1.04, W = 600, H = 120;
      const poly = pts.map((v, i) => `${(i / (pts.length - 1) * W).toFixed(1)},${(H - (v - lo) / Math.max(1, hi - lo) * H).toFixed(1)}`).join(" ");
      graph.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${poly}" vector-effect="non-scaling-stroke"/></svg>`;
    }
    function tick() {
      const m = TAP_MODES[mode][1];
      const el = taps.length ? (performance.now() - taps[0]) / 1000 : 0;
      timeEl.textContent = m.secs ? Math.max(0, m.secs - el).toFixed(1) + " s" : `${taps.length} / ${m.taps}`;
      if (m.secs && el >= m.secs) { finish(); return; }
      raf = requestAnimationFrame(tick);
    }
    function paintNums() {
      const s = stats();
      bpmEl.textContent = s.bpm ? fmt0.format(s.bpm) : "0";
      urEl.textContent = s.iv.length >= 2 ? s.ur.toFixed(1) : "–";
      tapsEl.textContent = String(taps.length);
    }
    function finish() {
      cancelAnimationFrame(raf); done = true;
      body.querySelector(".tl-card")?.classList.remove("running");
      const s = stats();
      const m = TAP_MODES[mode][1];
      const text = `OCTIVE tapping test: ${fmt0.format(s.bpm)} BPM (1/4 notes), ${s.ur.toFixed(1)} UR, ${taps.length} taps in ${m.secs ? m.secs + " s" : (((taps[taps.length - 1] - taps[0]) / 1000).toFixed(1) + " s")}`;
      const copy = h("button.btn.small", { type: "button" }, "Copy result");
      copy.addEventListener("click", async () => { try { await navigator.clipboard.writeText(text); copy.textContent = "Copied"; } catch { prompt("Copy:", text); } });
      result.replaceChildren(h("p", {}, h("b", { text: `${fmt0.format(s.bpm)} BPM` }), ` with an unstable rate of ${s.ur.toFixed(1)}. `,
        s.ur < 80 ? "Very steady." : s.ur < 140 ? "Nice and even." : "Try fewer, more even taps: a lower UR counts more than speed."), h("div.tp-acts", {}, copy, h("button.btn.small.primary", { type: "button", onclick: reset }, "Again")));
      result.hidden = false;
      pad.querySelector(".tp-pad-big").textContent = "Done";
      pad.querySelector("small").textContent = "Press Again (or Enter) to go again";
    }
    function reset() {
      cancelAnimationFrame(raf); taps = []; done = false;
      result.hidden = true; graph.replaceChildren();
      body.querySelector(".tl-card")?.classList.remove("running");
      paintOpts(); paintNums();
      timeEl.textContent = TAP_MODES[mode][1].secs ? TAP_MODES[mode][1].secs + " s" : `0 / ${TAP_MODES[mode][1].taps}`;
      pad.querySelector(".tp-pad-big").textContent = "Tap to start";
      pad.querySelector("small").textContent = TAP_KEYS[keySet][1] ? `Tap ${TAP_KEYS[keySet][0].replace(" ", " and ")} one after the other` : "Tap any keys one after the other";
    }
    toolKeys = {
      down(e) {
        if (done) { if (e.code === "Enter") { e.preventDefault(); reset(); } return; }
        const ok = TAP_KEYS[keySet][1] ? TAP_KEYS[keySet][1].includes(e.code) : !/^(Shift|Control|Alt|Meta|Tab|Escape|Enter|F\d+)/.test(e.code);
        if (!ok) return;
        e.preventDefault();
        if (e.repeat) return;
        hit();
      },
      blur() { /* keep going: the clock decides */ },
      stop() { cancelAnimationFrame(raf); },
    };
    // a tap on the pad counts too (phones and tablets have no keys)
    pad.addEventListener("pointerdown", (e) => { e.preventDefault(); if (!done) hit(); });
    function hit() {
        const now = performance.now();
        if (!taps.length) { body.querySelector(".tl-card")?.classList.add("running"); raf = requestAnimationFrame(tick); }
        taps.push(now);
        pad.classList.remove("hit"); void pad.offsetWidth; pad.classList.add("hit");
        pad.querySelector(".tp-pad-big").textContent = String(taps.length);
        paintNums(); paintGraph();
        const m = TAP_MODES[mode][1];
        if (m.taps && taps.length >= m.taps) finish();
    }
    body.replaceChildren(h("section.tl-card.feature-card", {},
      h("div.tl-top", {}, h("div", {}, h("h2", { text: "Tapping test" }), h("p.tl-sub", { text: "Alternate two keys as fast and as evenly as you can. BPM counts each tap as a 1/4 note; the unstable rate (UR, lower is better) is how even your taps are." })),
        h("div.tl-nums", {},
          h("div.num-tile", { style: "--s:var(--pink)" }, h("small", { text: "BPM" }), bpmEl),
          h("div.num-tile", { style: "--s:var(--cyan)" }, h("small", { text: "UR" }), urEl),
          h("div.num-tile", { style: "--s:var(--green)" }, h("small", { text: "Taps" }), tapsEl),
          h("div.num-tile", { style: "--s:var(--orange)" }, h("small", { text: "Time" }), timeEl))),
      opts, pad, graph, result));
    reset();
  }

  // ---- the offset finder: OCTIVE's own hit sound on the beat; tap along and see how early or late you are
  let offCtx = null;
  /** OCTIVE's default sounds, made the same way as the game's SfxBank (hit: an 808-style click with a little noise). */
  function octSound(ctx, kind) {
    const rate = ctx.sampleRate, secs = kind === "tick" ? 0.05 : 0.09, n = Math.floor(secs * rate);
    const buf = ctx.createBuffer(1, n, rate), d = buf.getChannelData(0);
    const click808 = (t, f0, f1) => { const f = f1 + (f0 - f1) * Math.exp(-t * 60); return Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 45); };
    for (let i = 0; i < n; i++) {
      const t = i / rate, fade = Math.min(1, i / 48);
      const v = kind === "tick" ? Math.sin(2 * Math.PI * 2400 * t) * Math.exp(-t * 100) * 0.6
        : click808(t, 2600, 900) * 0.55 + (Math.random() * 2 - 1) * Math.exp(-t / 0.012) * 0.35;
      d[i] = Math.max(-1, Math.min(1, v * fade));
    }
    return buf;
  }
  function offsetTest(body) {
    const BPM = 110, BEAT = 60 / BPM, COUNT_IN = 4, BEATS = 20;
    let run = null;
    const meanEl = h("b", { text: "–" }), spreadEl = h("b", { text: "–" }), beatEl = h("b", { text: "–" });
    const line = h("div.of-line", {}, h("span.of-mid"), h("span.of-early", { text: "early" }), h("span.of-late", { text: "late" }));
    const dots = h("div.of-beats");
    const result = h("div.tp-result", { hidden: true });
    const startBtn = h("button.btn.primary.big", { type: "button" }, "▶ Start");
    const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
    function paint() {
      if (!run) return;
      const errs = run.errs;
      meanEl.textContent = errs.length ? `${median(errs) > 0 ? "+" : ""}${Math.round(median(errs))} ms` : "–";
      const m = errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : 0;
      spreadEl.textContent = errs.length > 1 ? `±${Math.round(Math.sqrt(errs.reduce((a, b) => a + (b - m) * (b - m), 0) / errs.length))} ms` : "–";
    }
    function stop(finished) {
      if (!run) return;
      clearInterval(run.timer);
      for (const s of run.sources) { try { s.stop(); } catch { /* done */ } }
      const errs = run.errs;
      body.querySelector(".tl-card")?.classList.remove("running");
      startBtn.textContent = "▶ Start again";
      if (finished && errs.length >= 6) {
        const med = Math.round(median(errs));
        const late = med > 0;
        result.replaceChildren(
          h("p", {}, "You tap ", h("b", { text: `${Math.abs(med)} ms ${late ? "late" : "early"}` }), ` on average (the middle of ${errs.length} taps). `),
          h("p", {}, Math.abs(med) <= 5 ? "That's right on the beat: you don't need an offset." : ["In OCTIVE, set the audio offset to ", h("b", { text: `${late ? "+" : "−"}${Math.abs(med)} ms` }),
            " (Settings → Calibration), or turn on Adjust offset automatically (Settings → Audio) and the game keeps tuning it after each song."]),
          h("p.of-note", { text: "Measured with this browser's sound. Wireless headphones add their own delay, and the game's audio can differ a little, so treat it as a starting point." }));
        result.hidden = false;
      } else if (finished) {
        result.replaceChildren(h("p", { text: "Not enough taps landed near the beat to tell. Tap along with every click after the four count-in ticks, then try again." }));
        result.hidden = false;
      }
      run = null;
    }
    function start() {
      if (run) { stop(false); return; }
      offCtx = offCtx || new (window.AudioContext || window.webkitAudioContext)();
      const ctx = offCtx;
      ctx.resume();
      const hit = octSound(ctx, "hit"), tick = octSound(ctx, "tick");
      const lat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
      const t0 = ctx.currentTime + 0.6;
      const sources = [];
      const beats = [];
      for (let i = 0; i < COUNT_IN + BEATS; i++) {
        const src = ctx.createBufferSource(), g = ctx.createGain();
        src.buffer = i < COUNT_IN ? tick : hit;
        g.gain.value = i < COUNT_IN ? 0.55 : 0.9;
        src.connect(g).connect(ctx.destination);
        src.start(t0 + i * BEAT);
        sources.push(src);
        if (i >= COUNT_IN) beats.push(t0 + i * BEAT + lat);
      }
      result.hidden = true;
      line.querySelectorAll(".of-dot").forEach((d) => d.remove());
      dots.replaceChildren(...Array.from({ length: COUNT_IN + BEATS }, (_, i) => h("i" + (i < COUNT_IN ? ".in" : ""))));
      run = { ctx, t0, lat, beats, errs: [], sources, timer: 0 };
      body.querySelector(".tl-card")?.classList.add("running");
      startBtn.textContent = "■ Stop";
      run.timer = setInterval(() => {
        if (!run) return;
        const k = Math.floor((ctx.currentTime - lat - t0) / BEAT);
        [...dots.children].forEach((d, i) => d.classList.toggle("past", i <= k));
        beatEl.textContent = k < 0 ? "–" : k < COUNT_IN ? `Count-in ${k + 1}` : `${Math.min(BEATS, k - COUNT_IN + 1)} / ${BEATS}`;
        if (ctx.currentTime > t0 + (COUNT_IN + BEATS) * BEAT + lat + 0.4) stop(true);
      }, 40);
      paint();
    }
    function tap() {
      if (!run) return;
      const now = run.ctx.currentTime;
      if (now < run.beats[0] - BEAT / 2) return; // still counting in
      let best = null;
      for (const b of run.beats) if (best === null || Math.abs(now - b) < Math.abs(now - best)) best = b;
      const err = (now - best) * 1000;
      if (Math.abs(err) > 220) return; // not near a beat
      run.errs.push(err);
      const d = h("span.of-dot" + (err > 0 ? ".late" : ""), { style: `left:${50 + Math.max(-1, Math.min(1, err / 150)) * 50}%` });
      line.append(d);
      paint();
    }
    startBtn.addEventListener("click", start);
    const padEl = h("button.of-pad", { type: "button", onpointerdown: (e) => { e.preventDefault(); tap(); } }, h("span", { text: "Tap here, or any key" }));
    toolKeys = {
      down(e) {
        if (/^(Shift|Control|Alt|Meta|Tab|Escape|F\d+)/.test(e.code)) { if (e.code === "Escape") stop(false); return; }
        if (e.code === "Enter" && !run) { e.preventDefault(); start(); return; }
        e.preventDefault();
        if (!e.repeat) tap();
      },
      blur() { /* keep listening */ },
      stop() { stop(false); },
    };
    body.replaceChildren(h("section.tl-card.feature-card", {},
      h("div.tl-top", {}, h("div", {}, h("h2", { text: "Offset finder" }), h("p.tl-sub", { text: `OCTIVE's own hit sound plays ${BEATS} times at ${BPM} BPM after four count-in ticks. Tap along to the clicks (any key, or the pad) and see whether you hit early or late.` })),
        h("div.tl-nums", {},
          h("div.num-tile", { style: "--s:var(--pink)" }, h("small", { text: "You're off by" }), meanEl),
          h("div.num-tile", { style: "--s:var(--cyan)" }, h("small", { text: "Spread" }), spreadEl),
          h("div.num-tile", { style: "--s:var(--green)" }, h("small", { text: "Beat" }), beatEl))),
      h("div.of-row", {}, startBtn, padEl), dots, line, result));
  }


  // ---------------------------------------------------------------- 3.0: quick search (Ctrl+K) and keyboard shortcuts
  // One box for everything: players (from the ranking), Workshop charts (asked from the server as you type), the site's
  // pages, Help's answers, and "name vs name" to compare two players.
  const QS_PAGES = [
    ["Home", "./", "The front page"], ["Rankings", "rankings", "Every player by total PR"], ["Countries", "rankings?view=countries", "Countries ranked by their players' PR"],
    ["Ranked", "ranked", "The 1v1 ladders"], ["Crews", "crews", "Teams of up to 12 players"], ["Workshop", "workshop", "Charts, skins, themes and styles"],
    ["Daily charts", "daily", "Today's charts and scores"], ["Download", "downloads", "Windows, Android or the browser"], ["Play in browser", "play/", "No download needed"],
    ["Rhythm tools", "tools", "Key test, tapping test and offset finder"], ["Key test", "tools?t=keys", "See which keys still register when held together"],
    ["Tapping test", "tools?t=tap", "Your tapping speed (BPM) and unstable rate"], ["Offset finder", "tools?t=offset", "Tap along to the clicks to find your audio offset"],
    ["Updates", "updates", "Every release and its patch notes"], ["Supporter", "supporter", "Support OCTIVE and get a few extras"], ["Help", "help", "Common questions"],
    ["Live on Twitch", "live", "Players streaming right now"], ["Messages", "messages", "Your conversations"], ["Account settings", "account", "Sign in, your profile and preferences"],
    ["About OCTIVE", "about.html", "What OCTIVE is"], ["osu!mania maps in OCTIVE", "osu-mania.html", "Bring your maps"], ["FNF charts", "fnf.html", "Friday Night Funkin' songs and modcharts"],
    ["Privacy", "privacy.html", "What's collected and why"], ["Terms", "terms.html", "The rules"],
  ];
  const QS_ICON = {
    page: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>', chart: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 0 1 4.9.7c0 1.7-2.4 2.1-2.4 3.8M12 17h.01"/>', vs: '<path d="M4 6l6 12M10 6L4 18"/><path d="M20 7.5c-.8-1-2-1.5-3.2-1.5-1.6 0-2.8.9-2.8 2.2 0 3 6 1.8 6 5.3 0 1.4-1.3 2.5-3.1 2.5-1.3 0-2.6-.6-3.4-1.6"/>',
  };
  const qsIcon = (k) => { const s = h("span.qs-ic"); s.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${QS_ICON[k]}</svg>`; return s; };
  let qsLayer = null, qsWsCache = new Map();
  /** The best player for a name typed in the search ("sent" finds Senterra). */
  function findByName(q) {
    q = String(q || "").trim().toLowerCase();
    if (!q || !data) return [];
    const ps = data.official ? [...data.players, data.official] : data.players;
    return ps.filter((p) => (p.name || "").toLowerCase().includes(q))
      .sort((a, b) => ((b.name || "").toLowerCase().startsWith(q) - (a.name || "").toLowerCase().startsWith(q)) || ((a.rank || 1e9) - (b.rank || 1e9)));
  }
  function closeSearch() { qsLayer?.remove(); qsLayer = null; document.documentElement.classList.remove("qs-on"); }
  function openSearch(start) {
    if (qsLayer) { qsLayer.querySelector("input").focus(); return; }
    if (!data) load();
    const input = h("input.qs-input", { type: "search", placeholder: "Search players, charts, pages and help…", autocomplete: "off", spellcheck: "false", "aria-label": "Search OCTIVE" });
    const results = h("div.qs-results", { role: "listbox" });
    const box = h("div.qs-box", { role: "dialog", "aria-modal": "true", "aria-label": "Search OCTIVE" },
      h("div.qs-field", {}, (() => { const s = h("span.qs-glass"); s.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>'; return s; })(),
        input, h("button.qs-esc", { type: "button", onclick: closeSearch, "aria-label": "Close" }, h("kbd", { text: "Esc" }))),
      results,
      h("div.qs-foot", {},
        h("span", {}, h("kbd", { text: "↑" }), h("kbd", { text: "↓" }), " move"),
        h("span", {}, h("kbd", { text: "Enter" }), " open"),
        h("span.qs-tip", {}, "Type ", h("b", { text: "name vs name" }), " to compare two players"),
        h("button.qs-keys", { type: "button", onclick: () => { closeSearch(); shortcutsSheet(); } }, h("kbd", { text: "?" }), " shortcuts")));
    qsLayer = h("div.qs-layer", { onmousedown: (e) => { if (e.target === qsLayer) closeSearch(); } }, box);
    document.body.append(qsLayer);
    document.documentElement.classList.add("qs-on");
    let items = [], at = 0, gen = 0;
    const mark = () => items.forEach((el, i) => { el.classList.toggle("on", i === at); el.setAttribute("aria-selected", String(i === at)); if (i === at) el.scrollIntoView({ block: "nearest" }); });
    const item = (href, icon, title, sub, kind) => {
      const a = h("a.qs-item", { href, role: "option", onclick: () => closeSearch() }, icon, h("span.qs-text", {}, h("b", {}, title), sub ? h("small", { text: sub }) : null), kind ? h("span.qs-kind", { text: kind }) : null);
      a.addEventListener("pointermove", () => { const i = items.indexOf(a); if (i >= 0 && i !== at) { at = i; mark(); } });
      return a;
    };
    const group = (name, els) => (els.length ? [h("div.qs-group", { text: name }), ...els] : []);
    function paint(wsItems, wsBusy) {
      const q = input.value.trim(), ql = q.toLowerCase();
      const out = [];
      // name vs name
      const vs = q.match(/^(.+?)\s+(?:vs\.?|versus|v)\s+(.+)$/i);
      if (vs) {
        const a = findByName(vs[1])[0], b = findByName(vs[2]).find((x) => !a || x.id !== a.id);
        if (a && b) out.push(...group("Compare", [item(profileHref(a.id) + "?vs=" + encodeURIComponent(b.id), qsIcon("vs"), `${a.name} vs ${b.name}`, "Stats, graphs, skills and the charts they've both played", "Compare")]));
      }
      const players = q ? findByName(vs ? vs[1] : q).slice(0, 6) : (data ? data.players.filter((p) => p.online).slice(0, 4) : []);
      out.push(...group(q ? "Players" : "Online now", players.map((p) => item(profileHref(p.id), smallAvatar(p.id, p.name),
        p.name || "Player", isOfficial(p) ? "Official OCTIVE account" : [`#${fmt0.format(p.rank)}`, `${fmt0.format(p.pp || 0)} PR`, p.country ? regionName(p.country) : ""].filter(Boolean).join(" · "), "Player"))));
      if (q && !vs) {
        const ws = (wsItems || []).slice(0, 6).map((x) => {
          const pic = h("span.qs-pic");
          if (x.preview) pic.append(waitPic(pic, h("img", { src: x.preview, alt: "", loading: "lazy" })));
          return item("workshop/" + x.id, pic, x.title, [x.creator ? "by " + x.creator : "", x.topStars > 0 ? "★ " + x.topStars.toFixed(2) : "", x.verified ? "verified" : ""].filter(Boolean).join(" · "), "Chart");
        });
        if (wsBusy && !ws.length) out.push(h("div.qs-group", { text: "Charts" }), h("p.qs-busy", { text: "Searching the Workshop…" }));
        else out.push(...group("Charts", ws));
      }
      const pages = q ? QS_PAGES.filter(([n, , d]) => (n + " " + d).toLowerCase().includes(ql)).slice(0, 5) : QS_PAGES.filter(([, href]) => ["rankings", "workshop", "downloads", "daily", "tools", "rankings?view=countries"].includes(href));
      out.push(...group(q ? "Pages" : "Jump to", pages.map(([n, href, d]) => item(href, qsIcon("page"), n, d, "Page"))));
      if (q.length >= 3) {
        const help = HELP.flatMap(([g, list]) => list.map(([qq, a]) => [g, qq, a])).filter(([, qq, a]) => (qq + " " + a).toLowerCase().includes(ql)).slice(0, 4);
        out.push(...group("Help", help.map(([g, qq, a]) => item("help?q=" + encodeURIComponent(qq), qsIcon("help"), qq, a.length > 90 ? a.slice(0, 88) + "…" : a, g))));
      }
      if (!out.length) out.push(h("p.qs-none", { text: q ? `Nothing found for "${q}".` : "Start typing…" }));
      results.replaceChildren(...out);
      items = [...results.querySelectorAll(".qs-item")];
      at = Math.min(at, Math.max(0, items.length - 1));
      mark();
    }
    let wsT = null;
    function update() {
      const q = input.value.trim();
      at = 0;
      const key = q.toLowerCase();
      clearTimeout(wsT);
      const g = ++gen; // an answer for an older query is dropped
      if (!q || /\s(?:vs\.?|versus|v)\s/i.test(q)) { paint([], false); return; }
      if (qsWsCache.has(key)) { paint(qsWsCache.get(key), false); return; }
      paint([], true);
      wsT = setTimeout(() => {
        fetch(`${worker}/api/items?type=charts&sort=popular&q=${encodeURIComponent(q)}`, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((d) => {
          const list = (d && d.items) || [];
          qsWsCache.set(key, list);
          if (g === gen && qsLayer) paint(list, false);
        });
      }, 220);
    }
    input.addEventListener("input", update);
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); at = Math.min(items.length - 1, at + 1); mark(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); at = Math.max(0, at - 1); mark(); }
      else if (e.key === "Enter") { e.preventDefault(); items[at]?.click(); }
      else if (e.key === "Escape") { e.preventDefault(); closeSearch(); }
    });
    if (start) input.value = start;
    update();
    setTimeout(() => input.focus(), 0);
    // the players arrive with the ranking: paint again once it's here
    if (!data) { const wait = setInterval(() => { if (!qsLayer) { clearInterval(wait); return; } if (data) { clearInterval(wait); update(); } }, 250); }
  }
  /** "?" : every keyboard shortcut. */
  const GO_KEYS = { h: ["./", "Home"], r: ["rankings", "Rankings"], n: ["rankings?view=countries", "Countries"], k: ["ranked", "Ranked"], c: ["crews", "Crews"],
    w: ["workshop", "Workshop"], d: ["daily", "Daily charts"], l: ["downloads", "Download"], t: ["tools", "Rhythm tools"], u: ["updates", "Updates"],
    s: ["supporter", "Supporter"], q: ["help", "Help"], p: ["me", "Your profile"], m: ["messages", "Messages"] };
  function goKey(to) {
    if (to === "me") to = me && me.playerId && me.hasCard && !me.banned ? profileHref(me.playerId) : "account";
    if (!app || /\.html$|^play\//.test(to)) { location.href = BASE_PATH + routePath(to === "./" ? "" : to); return; }
    go(to === "./" ? "" : to);
  }
  function shortcutsSheet() {
    if (document.querySelector(".keys-layer")) return;
    const row = (keys, what) => h("div.keys-row", {}, h("span.keys-k", {}, ...keys.map((k) => h("kbd", { text: k }))), h("span", { text: what }));
    const layer = h("div.modal-layer.keys-layer", { onmousedown: (e) => { if (e.target === layer) layer.remove(); } },
      h("div.keys-modal", { role: "dialog", "aria-label": "Keyboard shortcuts" },
        h("div.keys-head", {}, h("h2", { text: "Keyboard shortcuts" }), h("button.btn.small.ghost", { type: "button", onclick: () => layer.remove() }, "Close")),
        h("div.keys-cols", {},
          h("div", {}, h("h3", { text: "Anywhere" }), row(["Ctrl", "K"], "Search"), row(["/"], "Search"), row(["M"], "Open or close the menu"), row(["?"], "This list"), row(["Esc"], "Close")),
          h("div", {}, h("h3", { text: "Go to: press G, then" }), ...Object.entries(GO_KEYS).map(([k, [, n]]) => row([k.toUpperCase()], n))))));
    document.body.append(layer);
    const off = (e) => { if (e.key === "Escape") { layer.remove(); document.removeEventListener("keydown", off); } };
    document.addEventListener("keydown", off);
  }
  let gAt = 0;
  document.addEventListener("keydown", (e) => {
    const t = e.target, typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") { e.preventDefault(); qsLayer ? closeSearch() : openSearch(); return; }
    if (typing || e.repeat || e.ctrlKey || e.metaKey || e.altKey || qsLayer || document.querySelector(".modal-layer")) return;
    if (document.body.dataset.page === "tools" && document.querySelector(".tl-live")) return; // a test is listening to the keys
    if (e.key === "/") { e.preventDefault(); openSearch(); return; }
    if (e.key === "?") { e.preventDefault(); shortcutsSheet(); return; }
    const k = e.key.toLowerCase();
    if (gAt && Date.now() - gAt < 1200) { gAt = 0; if (GO_KEYS[k]) { e.preventDefault(); goKey(GO_KEYS[k][0]); } return; }
    if (k === "g") { gAt = Date.now(); return; }
    if (k === "m" && side) toggleSide("click");
  });

  // ---------------------------------------------------------------- a secret: ↑ ↑ ↓ ↓ ← → ← → on the arrow keys
  // A wrong key starts it over straight away (the keys you just pressed still count if they begin the code again).
  const SECRET = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight"];
  let secretKeys = [];
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return; // typing, not playing
    if (document.body.dataset.page === "tools") return; // the key and tapping tests use the arrow keys too
    secretKeys.push(e.key);
    let k = Math.min(secretKeys.length, SECRET.length);
    while (k > 0 && !SECRET.slice(0, k).every((s, i) => s === secretKeys[secretKeys.length - k + i])) k--;
    secretKeys = secretKeys.slice(secretKeys.length - k);
    if (k === SECRET.length) { secretKeys = []; location.href = "https://www.youtube.com/watch?v=QDia3e12czc"; }
  });
  // ---------------------------------------------------------------- start
  if (app) route();
  else {
    // a page of its own (about.html, privacy.html…): the menu and search work, the page itself is already there
    document.body.dataset.page ||= "about";
    document.querySelectorAll(`.side-nav [data-nav="${document.body.dataset.page}"]`).forEach((a) => a.classList.add("active"));
  }
  load();
})();
