// OCTIVE website: home (#/), global ranking (#/rankings), player profiles (#/u/<playerId>), downloads
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
  const fmt2 = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let data = null;

  // the game's level curve: level 1 → 2 takes 10,000 xp, every level after takes 7% more
  const xpFor = (lv) => lv <= 1 ? 0 : Math.round(100000 * (Math.pow(1.07, lv - 1) - 1) / 0.07);

  const worker = WORKER_URL.replace(/\/+$/, "");


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
    for (const p of data.players)
      if (worker && p.avatarHash) p.avatar = `${worker}/avatar/${encodeURIComponent(p.id)}?v=${encodeURIComponent(p.avatarHash)}`;
    if (data.updated) {
      const when = new Date(data.updated);
      document.getElementById("updated").textContent = "Updated " + when.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    }
    if (["home", "rankings", "player"].includes(page())) route();
  }

  function clone(id) { return document.getElementById(id).content.cloneNode(true); }

  function setAvatar(box, p) {
    const img = box.querySelector("img"), initial = box.querySelector(".initial");
    initial.textContent = (p.name || "?").charAt(0).toUpperCase();
    const gif = isSupporter(p) && p.supporter.gif ? avatarUrl(p) : null;
    if (gif || p.avatar) {
      img.src = gif || (p.avatar.includes("?") || !p.avatarHash ? p.avatar : p.avatar + "?v=" + encodeURIComponent(p.avatarHash));
      img.hidden = false; initial.hidden = true;
      img.onerror = () => { img.hidden = true; initial.hidden = false; };
    }
    const dot = box.querySelector(".dot");
    if (dot) {
      dot.hidden = false;
      dot.classList.toggle("on", !!p.online);
      dot.title = statusText(p);
      dot.classList.toggle("site", !!p.online && p.status === "site");
    }
  }

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
    ["youtube", "YouTube", "https://www.youtube.com/@{0}"], ["twitch", "Twitch", "https://www.twitch.tv/{0}"],
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

  function rankings() {
    const view = clone("tpl-rankings");
    const rows = view.querySelector("[data-rows]");
    const search = view.querySelector("[data-search]");
    view.querySelector("[data-count]").textContent = fmt0.format(data.players.length);
    view.querySelector("[data-online]").textContent = fmt0.format(data.players.filter((p) => p.online).length);
    const notice = view.querySelector("[data-sample]");
    if (data.error) {
      notice.textContent = data.players.length
        ? "The ranking couldn't be refreshed just now; showing the last known one."
        : "The ranking couldn't be loaded right now: " + data.error;
      notice.hidden = false;
    } else notice.hidden = !data.sample;
    const empty = view.querySelector("[data-empty]");

    function render(filter) {
      rows.textContent = "";
      const q = (filter || "").trim().toLowerCase();
      const list = q ? data.players.filter((p) => (p.name || "").toLowerCase().includes(q)) : data.players.slice();
      if (q && data.official && ("octive".includes(q) || (data.official.name || "").toLowerCase().includes(q))) list.unshift(data.official);
      empty.hidden = list.length > 0;
      if (!list.length && q) empty.textContent = `Nobody called "${filter.trim()}" is ranked.`;
      for (const p of list) {
        const r = clone("tpl-row").firstElementChild;
        r.href = "#/u/" + encodeURIComponent(p.id);
        r.dataset.place = String(p.rank);
        r.querySelector(".rank").textContent = isOfficial(p) ? INF : "#" + fmt0.format(p.rank);
        nameInto(r.querySelector(".name"), p);
        setAvatar(r.querySelector(".avatar"), p);
        setRole(r, r.querySelector(".badge"), p);
        if (isSupporter(p)) { r.classList.add("supporter"); const pill = supporterPill(p); pill.classList.add("rank"); r.querySelector(".player").append(pill); }
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
    document.title = "OCTIVE Rankings";
  }

  function player(id) {
    const p = findPlayer(id);
    if (!p) {
      app.innerHTML = '<a class="back" href="#/rankings">← All players</a><p class="empty">That player isn\'t in the ranking (yet).</p>';
      setTimeout(giftPopup, 400);
      return;
    }
    const view = clone("tpl-player");
    const card = view.querySelector(".card");
    nameInto(view.querySelector(".card-name"), p);
    view.querySelector(".card-rank").textContent = isOfficial(p) ? INF : "#" + fmt0.format(p.rank);
    setAvatar(view.querySelector(".card-avatar"), p);
    const role = setRole(card, view.querySelector(".badge"), p);
    if (role) { const t = view.querySelector(".card-title"); t.textContent = role.title; t.hidden = false; }
    const status = view.querySelector(".card-status");
    status.textContent = p.online ? "● " + statusText(p) : statusText(p);
    status.classList.toggle("on", !!p.online);
    if (isOfficial(p)) {
      // its status line keeps changing while the page is open
      const tick = setInterval(() => { if (!status.isConnected) { clearInterval(tick); return; } status.textContent = "● " + statusText(p); }, 1000);
    }
    decorateCard(card, p);
    card.after(socialRow(p));
    // what they shared to the Workshop
    const uploads = h("section.ws-profile", { hidden: true }, h("div.section-head", {}, h("h2.section-title", { text: "Workshop uploads" }), h("a.more", { href: "#/workshop" }, "Workshop →")), h("div.ws-grid"));
    card.parentNode.appendChild(uploads);
    fetch(`${worker}/api/items?creator=${encodeURIComponent(p.id)}`, { cache: "no-cache" }).then((r) => r.ok ? r.json() : null).catch(() => null).then((d) => {
      const items = (d && d.items) || [];
      if (!items.length || !uploads.isConnected) return;
      uploads.querySelector(".section-title").textContent = `Workshop uploads · ${items.length}`;
      uploads.querySelector(".ws-grid").replaceChildren(...items.map(workshopCard));
      uploads.hidden = false;
    });
    const set = (sel, v) => { view.querySelector(sel).textContent = v; };
    set(".c-pp", fmt0.format(p.pp || 0) + " PR");
    set(".c-acc", fmt2.format(p.accuracy || 0) + "%");
    set(".c-rank", "#" + fmt0.format(p.rank));
    const lv = p.level || 1;
    set(".c-lvl", "Lv" + lv);
    set(".s-level", "Lv" + lv);
    set(".s-score", fmt0.format(p.totalScore || 0));
    set(".s-plays", fmt0.format(p.playCount || 0));
    set(".s-fc", fmt0.format(p.fullCombos || 0));
    set(".s-rank", "#" + fmt0.format(p.rank));
    set(".s-combo", p.maxCombo ? fmt0.format(p.maxCombo) + "x" : "—");
    set(".s-time", p.playTimeMs ? playTime(p.playTimeMs) : "—");
    set(".s-xp", fmt0.format(p.xp || 0));
    view.querySelector(".fill").style.width = Math.round(Math.max(0, Math.min(1, p.levelProgress || 0)) * 100) + "%";
    const toNext = Math.round((xpFor(lv + 1) - xpFor(lv)) * (1 - (p.levelProgress || 0)));
    set(".c-next", `${fmt0.format(toNext)} xp to Lv${lv + 1}`);
    if (isOfficial(p)) {
      // the official account: every number is infinite, and it never misses
      set(".c-pp", INF + " PR"); set(".c-acc", "100.00%"); set(".c-rank", INF);
      set(".c-lvl", "Lv1000"); set(".s-level", "Lv1000"); set(".c-next", "Max level");
      for (const sel of [".s-score", ".s-plays", ".s-fc", ".s-rank", ".s-time", ".s-xp"]) set(sel, INF);
      set(".s-combo", INF + "x");
      view.querySelector(".fill").style.width = "100%";
    }
    if (p.devFriend && !ROLES[p.id]) view.querySelector(".devfriend").hidden = false;
    if (p.bio && p.bio.trim()) {
      view.querySelector(".bio").hidden = false;
      renderBio(view.querySelector(".bio-text"), p.bio);
    }
    const sup = supporterSection(p);
    if (sup) view.querySelector(".tiles").after(sup);
    view.querySelector(".tiles").parentNode.append(achievementsSection(p));
    if ((p.badges || []).includes("CREATOR") && p.socials) {
      const box = view.querySelector(".social-links");
      if (box && renderSocials(box, p.socials) > 0) view.querySelector(".socials").hidden = false;
    }
    // everything under the card goes into tabs: the overview, and who they follow / are followed by / are friends with
    const overview = h("div.prof-overview");
    for (const el of [...view.children]) if (!el.matches(".back, .card, .social-row")) overview.append(el);
    const pane = h("div.prof-pane");
    const tabBtns = {};
    const tabs = h("nav.prof-tabs", {}, ...[["overview", "Overview"], ["followers", "Followers"], ["following", "Following"], ["friends", "Friends"]].map(([k, label]) =>
      (tabBtns[k] = h("button.prof-tab", { type: "button", onclick: () => openTab(k) }, label))));
    function openTab(k) {
      for (const [key, b] of Object.entries(tabBtns)) b.classList.toggle("active", key === k);
      if (k === "overview") { pane.replaceChildren(overview); return; }
      pane.replaceChildren(peopleList(p, k));
    }
    view.append(tabs, pane);
    openTab("overview");
    view.querySelector(".social-row")?.addEventListener("open-list", (e) => { openTab(e.detail); tabs.scrollIntoView({ behavior: "smooth", block: "start" }); });
    app.replaceChildren(view);
    document.title = `${p.name} · OCTIVE Rankings`;
    setTimeout(giftPopup, 400);
    window.scrollTo(0, 0);
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

  /** A little playfield with notes falling into the receptors (pure CSS animation). */
  function playfield() {
    const lanes = h("div.pf-lanes");
    // a fixed, musical-looking pattern: [lane, beat]
    const pattern = [[0, 0], [1, 1], [2, 2], [3, 3], [1, 4], [2, 4.5], [0, 5], [3, 5.5], [1, 6], [2, 6], [0, 7], [3, 7.5]];
    for (let lane = 0; lane < 4; lane++) {
      const col = h("div.pf-lane" + (lane === 1 || lane === 2 ? ".inner" : ""));
      for (const [l, beat] of pattern) if (l === lane) {
        const n = h("span.pf-note");
        n.style.animationDelay = (beat * 0.375) + "s";
        col.appendChild(n);
      }
      col.appendChild(h("span.pf-receptor"));
      lanes.appendChild(col);
    }
    return h("div.playfield", { "aria-hidden": "true" }, lanes, h("div.pf-judge", { text: "PERFECT" }), h("div.pf-combo", { text: "128" }));
  }

  const FEATURES = [
    ["osu", "Your osu! library", "Point OCTIVE at your osu! folder and play every mania map (and convert the rest). Collections come along too."],
    ["pp", "Global ranking", "Every chart has a star rating. Your best plays earn performance rating (PR), levels and a place on the ranking."],
    ["mp", "Multiplayer", "Make a room, share the code and play the same chart together, or watch a friend play live."],
    ["practice", "Practice mode", "Loop the hard part, slow it down to 0.5x and work up to full speed."],
    ["editor", "Chart editor", "Make your own charts with a waveform, scrub bar, test play and up to 20 keys."],
    ["skins", "Skins and themes", "Arrows, bars, circles, osu! skin import, and menu themes to make it yours."],
    ["replay", "Replays", "Every play is saved. Rewatch it, seek through it and slow it down to see what went wrong."],
    ["mobile", "Play anywhere", "Windows and Android, with touch controls you can set up the way you like."],
  ];
  const ICONS = {
    osu: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>',
    pp: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    mp: '<circle cx="8" cy="9" r="3"/><circle cx="17" cy="9" r="3"/><path d="M2 20c0-3 3-5 6-5s6 2 6 5M13 15c1-.6 2.5-1 4-1 3 0 5 2 5 5"/>',
    practice: '<path d="M4 12a8 8 0 1 0 3-6.3"/><path d="M4 4v5h5"/><path d="M12 8v4l3 2"/>',
    editor: '<path d="M4 20h4L20 8l-4-4L4 16z"/><path d="M14 6l4 4"/>',
    skins: '<path d="M12 3a9 9 0 1 0 0 18c1.5 0 2-1 2-2 0-1.5-1-2 0-3s3 0 5-1 2-4 2-4c0-4.5-4-8-9-8z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="11" cy="7" r="1.2"/><circle cx="16" cy="8.5" r="1.2"/>',
    replay: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9l5 3-5 3z"/>',
    mobile: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
  };
  const icon = (id) => { const s = document.createElement("span"); s.className = "f-icon"; s.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[id] || ""}</svg>`; return s; };

  // ---------------------------------------------------------------- the front page's live playfield
  // A real chart from a song that comes with OCTIVE (data/demo.json, made from the game's own files), played by
  // autoplay on a canvas: notes, long notes, receptor flashes, judgements, combo and score. Sound is optional.
  let demoData = null;
  function livePlayfield() {
    const wrap = h("div.live-pf");
    const cv = h("canvas", { "aria-hidden": "true" });
    const tag = h("div.live-tag", {}, h("span.live-dot"), h("span", { text: "Live autoplay" }));
    const song = h("div.live-song", {}, h("b", { text: "Loading…" }), h("span"));
    const sound = h("button.live-sound", { type: "button", title: "Play with sound", "aria-label": "Play with sound" }, "🔈 Sound");
    wrap.append(cv, tag, song, sound);
    const ctx = cv.getContext("2d");
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let audio = null, t0 = performance.now(), lastT = -1, hit = 0, combo = 0, judgeAt = -1e9, judgeText = "", flash = [0, 0, 0, 0], bursts = [], visible = true;
    const COL = [["#ffb3cb", "#ff5c8a"], ["#a6f5ff", "#3fd8e6"], ["#a6f5ff", "#3fd8e6"], ["#ffb3cb", "#ff5c8a"]];
    const io2 = "IntersectionObserver" in window ? new IntersectionObserver((e) => { visible = e[0].isIntersecting; }) : null;
    if (io2) io2.observe(wrap);

    function size() {
      const r = wrap.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(200, Math.round(r.width)), hh = Math.max(260, Math.round(r.height));
      if (cv.width !== w * dpr || cv.height !== hh * dpr) { cv.width = w * dpr; cv.height = hh * dpr; cv.style.width = w + "px"; cv.style.height = hh + "px"; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
      return [w, hh];
    }
    const rr = (x, y, w, h2, r) => { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h2, r) : ctx.rect(x, y, w, h2); };

    function frame() {
      if (!wrap.isConnected) { if (audio) audio.pause(); io2 && io2.disconnect(); return; }
      requestAnimationFrame(frame);
      if (!demoData || (!visible && !audio)) return;
      const d = demoData, [W, H] = size();
      let t = audio && !audio.paused ? audio.currentTime * 1000 : (performance.now() - t0) % d.durationMs;
      if (reduce && !audio) t = 9000;
      if (t < lastT) { hit = 0; combo = 0; bursts = []; }
      // autoplay hits every note when it reaches the line
      while (hit < d.notes.length && d.notes[hit][0] <= t) {
        const n = d.notes[hit++];
        combo++; flash[n[1]] = 1; judgeAt = t; judgeText = hit % 23 === 0 ? "PERFECT" : "MARVELOUS";
        bursts.push({ lane: n[1], at: t });
      }
      lastT = t;
      const pad = 16, laneW = (W - pad * 2) / d.keys, hitY = H - 70, speed = 0.62; // px per ms
      ctx.clearRect(0, 0, W, H);
      // lanes
      for (let l = 0; l < d.keys; l++) {
        const x = pad + l * laneW;
        ctx.fillStyle = l % 2 ? "rgba(255,255,255,0.035)" : "rgba(255,255,255,0.02)";
        ctx.fillRect(x + 2, 0, laneW - 4, H);
        if (flash[l] > 0) {
          const g = ctx.createLinearGradient(0, hitY, 0, hitY - 160);
          g.addColorStop(0, `rgba(255,255,255,${0.16 * flash[l]})`); g.addColorStop(1, "rgba(255,255,255,0)");
          ctx.fillStyle = g; ctx.fillRect(x + 2, hitY - 160, laneW - 4, 160);
        }
      }
      // long note bodies, then the notes
      const noteH = 16;
      for (let i = hit - 40 < 0 ? 0 : hit - 40; i < d.notes.length; i++) {
        const [nt, lane, end] = d.notes[i];
        const y = hitY - (nt - t) * speed;
        if (y < -40 && !end) break;
        if (y < -40 && end && hitY - (end - t) * speed > H) break;
        const x = pad + lane * laneW + 5, w = laneW - 10;
        const [c1, c2] = COL[lane % 4];
        if (end) {
          if (t > end) continue;
          const yHead = Math.min(y, hitY), yTail = hitY - (end - t) * speed;
          if (yTail < yHead) {
            ctx.fillStyle = t >= nt ? c2 + "aa" : c2 + "66";
            rr(x + w * 0.18, yTail, w * 0.64, yHead - yTail, 6); ctx.fill();
          }
          if (t >= nt) { flash[lane] = Math.max(flash[lane], 0.6); continue; } // held: the head sits in the receptor
        } else if (nt < t) continue;
        if (y > H + 20) continue;
        const g = ctx.createLinearGradient(0, y - noteH / 2, 0, y + noteH / 2);
        g.addColorStop(0, c1); g.addColorStop(1, c2);
        ctx.fillStyle = g; ctx.shadowColor = c2; ctx.shadowBlur = 12;
        rr(x, y - noteH / 2, w, noteH, 7); ctx.fill();
        ctx.shadowBlur = 0;
      }
      // receptors and hit bursts
      for (let l = 0; l < d.keys; l++) {
        const x = pad + l * laneW + 5, w = laneW - 10;
        ctx.strokeStyle = `rgba(255,255,255,${0.35 + 0.5 * flash[l]})`; ctx.lineWidth = 2;
        rr(x, hitY - noteH / 2 - 2, w, noteH + 4, 8); ctx.stroke();
        flash[l] = Math.max(0, flash[l] - 0.08);
      }
      bursts = bursts.filter((b) => t - b.at < 260);
      for (const b of bursts) {
        const k = (t - b.at) / 260, cx = pad + b.lane * laneW + laneW / 2;
        ctx.strokeStyle = `rgba(255,255,255,${0.8 * (1 - k)})`; ctx.lineWidth = 3 * (1 - k) + 1;
        ctx.beginPath(); ctx.ellipse(cx, hitY, laneW * (0.35 + 0.5 * k), 12 + 22 * k, 0, 0, Math.PI * 2); ctx.stroke();
      }
      // HUD: combo, judgement, score
      ctx.textAlign = "center";
      if (combo >= 3) {
        ctx.fillStyle = "rgba(255,255,255,0.92)"; ctx.font = "800 40px Inter, system-ui, sans-serif";
        ctx.fillText(String(combo), W / 2, H * 0.36);
        ctx.fillStyle = "rgba(255,255,255,0.45)"; ctx.font = "700 10px Inter, system-ui, sans-serif"; ctx.fillText("COMBO", W / 2, H * 0.36 + 16);
      }
      const ja = t - judgeAt;
      if (ja < 700) {
        const pop = 1 + 0.18 * Math.max(0, 1 - ja / 80), alpha = ja < 450 ? 1 : 1 - (ja - 450) / 250;
        ctx.save(); ctx.translate(W / 2, H * 0.52); ctx.scale(pop, pop);
        ctx.font = "800 17px Inter, system-ui, sans-serif"; ctx.fillStyle = judgeText === "PERFECT" ? `rgba(255,216,102,${alpha})` : `rgba(165,240,255,${alpha})`;
        ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 14; ctx.fillText(judgeText, 0, 0); ctx.restore();
      }
      ctx.textAlign = "right"; ctx.fillStyle = "rgba(255,255,255,0.85)"; ctx.font = "800 15px Inter, system-ui, sans-serif";
      ctx.fillText(String(Math.round(1e6 * hit / d.notes.length)).padStart(7, "0"), W - 12, 24);
      ctx.fillStyle = "rgba(255,255,255,0.5)"; ctx.font = "700 11px Inter, system-ui, sans-serif"; ctx.fillText("100.00%", W - 12, 40);
      // progress
      ctx.fillStyle = "rgba(139,123,255,0.8)"; ctx.fillRect(0, 0, W * (t / d.durationMs), 3);
    }

    const go = (d) => {
      demoData = d;
      song.firstChild.textContent = `${d.artist} - ${d.title}`;
      song.lastChild.textContent = `${d.difficulty} · ${d.keys}K · ★${Number(d.rating).toFixed(2)}`;
      requestAnimationFrame(frame);
    };
    if (demoData) go(demoData);
    else fetch("data/demo.json?v=1.5.0", { cache: "force-cache" }).then((r) => r.ok ? r.json() : null).then((d) => { if (d) go(d); else song.firstChild.textContent = ""; }).catch(() => { song.firstChild.textContent = ""; });
    sound.addEventListener("click", () => {
      if (!audio) {
        audio = new Audio("data/demo.mp3"); audio.loop = true; audio.volume = 0.6;
        // start where the picture is, so the sound and the notes line up
        audio.currentTime = ((performance.now() - t0) % (demoData ? demoData.durationMs : 32000)) / 1000;
        audio.play().catch(() => {});
        sound.textContent = "🔊 Mute"; sound.title = "Mute";
      } else if (audio.paused) { audio.play().catch(() => {}); sound.textContent = "🔊 Mute"; }
      else { audio.pause(); t0 = performance.now() - audio.currentTime * 1000; sound.textContent = "🔈 Sound"; }
    });
    return wrap;
  }

  function home() {
    const players = data ? data.players : [];
    const online = players.filter((p) => p.online).length;
    const top = players[0];
    const verPill = h("span.h2-pill", {}, h("span.h2-dot"), "Free · Windows, Android and your browser");
    const hero = h("section.h2-hero", {},
      h("div.h2-glow"),
      h("div.h2-copy", {},
        verPill,
        h("h1", {}, "The rhythm game", h("br"), h("span.grad", { text: "you make your own." })),
        h("p.lead", { text: "OCTIVE is a vertical scrolling rhythm game for 1 to 20 keys. Play your osu!mania library, chart your own songs, share skins and charts in the Workshop, and climb a global ranking with friends." }),
        h("div.cta", {},
          h("a.btn.primary.big", { href: "#/download" }, "Download free"),
          h("a.btn.big", { href: "play/" }, "▶ Play in browser"))),
      h("div.h2-art", {}, h("div.h2-frame", {}, livePlayfield()), emblemSvg(64)));
    const live = (label, value, cls) => h("div.h2-live" + (cls ? "." + cls : ""), {}, h("b", { text: value }), h("span", { text: label }));
    const vEl = live("Latest version", "…");
    const strip = h("section.h2-strip", {},
      live("Online now", data ? fmt0.format(online) : "…", "on"),
      live("Ranked players", data ? fmt0.format(players.length) : "…"),
      live("Top performance", top ? fmt0.format(top.pp) + " PR" : "—"),
      vEl);

    // what's new: the latest release and its notes
    const news = h("article.h2-card.h2-news", {}, h("p.empty", { text: "Loading the latest update…" }));
    // fresh from the Workshop
    const shelf = h("div.h2-shelf", {}, h("p.empty", { text: "Loading the Workshop…" }));
    const row2 = h("section.h2-row", {},
      h("div.h2-col", {}, h("div.section-head", {}, h("h2.section-title", { text: "What's new" }), h("a.more", { href: "#/updates" }, "All updates →")), news),
      h("div.h2-col.wide", {}, h("div.section-head", {}, h("h2.section-title", { text: "Fresh in the Workshop" }), h("a.more", { href: "#/workshop" }, "Browse →")), shelf));

    const features = h("section.h2-features", {},
      h("h2.section-title", { text: "Everything you need to play, make and share" }),
      h("div.h2-bento", {}, FEATURES.map(([id, title, text], i) => h("article.h2-feature" + (i < 2 ? ".big" : ""), {}, icon(id), h("h3", { text: title }), h("p", { text })))));

    const podium = h("section.home-top", {},
      h("div.section-head", {}, h("h2.section-title", { text: "Top players" }), h("a.more", { href: "#/rankings" }, "Full ranking →")),
      h("div.podium", {}, players.slice(0, 3).map((p) => {
        const a = h("a.pod", { href: "#/u/" + encodeURIComponent(p.id), "data-place": p.rank },
          h("span.pod-rank", { text: "#" + p.rank }),
          h("span.avatar", {}, h("img", { alt: "", loading: "lazy", hidden: true }), h("span.initial"), h("span.dot", { hidden: true })),
          h("span.pod-name", {}, h("span.name", { text: p.name || "Player" }), h("span.badge", { hidden: true })),
          h("span.pod-pp", { text: fmt0.format(p.pp || 0) + " PR" }),
          h("span.pod-sub", { text: `${fmt2.format(p.accuracy || 0)}% · Lv${p.level || 1}` }));
        setAvatar(a.querySelector(".avatar"), p);
        setRole(a, a.querySelector(".badge"), p);
        return a;
      }), !players.length ? h("p.empty", { text: data ? "No ranked players yet. Be the first!" : "Loading the ranking…" }) : null));
    const end = h("section.h2-end", {},
      emblemSvg(72),
      h("div", {}, h("h2", { text: "Ready to play?" }), h("p", { text: "It's free. The installer always gets the newest version, and the game updates itself." })),
      h("div.cta", {}, h("a.btn.primary.big", { href: "#/download" }, "Download OCTIVE")));
    app.replaceChildren(hero, strip, row2, features, podium, end);
    document.title = "OCTIVE · The rhythm game you make your own";

    loadRelease().then((m) => {
      if (!m || !hero.isConnected) return;
      vEl.querySelector("b").textContent = "v" + m.version;
      verPill.lastChild.textContent = `Free · v${m.version} · Windows, Android and your browser`;
    });
    fetch(worker + "/releases/history.json", { cache: "no-cache" }).then((r) => r.ok ? r.json() : []).catch(() => []).then((hist) => {
      if (!news.isConnected) return;
      const x = (Array.isArray(hist) ? hist : []).find((y) => y && y.version && !/test/i.test(y.version));
      if (!x) { news.replaceChildren(h("p.empty", { text: "No updates yet." })); return; }
      const when = x.published ? new Date(x.published).toLocaleDateString(undefined, { dateStyle: "long" }) : "";
      const body = x.announcement ? markdown(x.announcement) : h("div.md", {}, h("p", { text: x.notes || "" }));
      news.replaceChildren(h("header.h2-news-head", {}, h("b", { text: "OCTIVE " + x.version }), h("span", { text: when })), body, h("a.btn.small", { href: "#/updates/" + x.version }, "Read it all"));
    });
    fetch(worker + "/api/items?sort=new", { cache: "no-cache" }).then((r) => r.ok ? r.json() : null).catch(() => null).then((d) => {
      if (!shelf.isConnected) return;
      const items = (d && d.items) || [];
      if (!items.length) { shelf.replaceChildren(h("p.empty", { text: "Nothing shared yet. Share yours from the game: Play → Workshop." })); return; }
      shelf.replaceChildren(...items.slice(0, 6).map(workshopCard));
    });
  }

  // ---------------------------------------------------------------- #/workshop: charts, skins, themes and styles players shared
  const WS_TYPES = [["charts", "Charts"], ["skins", "Skins"], ["themes", "Themes"], ["styles", "Styles"]];
  const WS_LABEL = { charts: "Chart", skins: "Skin", themes: "Theme", styles: "Style" };
  let wsType = "charts", wsSort = "new", wsQuery = "";

  function workshopCard(it) {
    const pic = h("div.ws-pic" + (it.type === "skins" || it.type === "styles" ? ".contain" : ""));
    if (it.preview) { const img = h("img", { src: it.preview, alt: "", loading: "lazy" }); img.onerror = () => img.remove(); pic.append(img); }
    else pic.append(h("span.ws-type", { text: WS_LABEL[it.type] || "" }));
    const kb = it.size / 1048576;
    return h("article.ws-card", {},
      pic,
      h("div.ws-body", {},
        h("span.ws-kind", { text: WS_LABEL[it.type] || it.type }),
        h("h3", { text: it.title, title: it.title }),
        h("a.ws-by", { href: "#/u/" + encodeURIComponent(it.creatorId || "") }, "by " + (it.creator || "someone")),
        h("p.ws-desc", { text: it.description || "", title: it.description || undefined }),
        h("span.ws-meta", { text: `${kb.toFixed(kb < 1 ? 2 : 1)} MB · ${fmt0.format(it.downloads || 0)} download${it.downloads === 1 ? "" : "s"} · ${new Date(it.at).toLocaleDateString(undefined, { dateStyle: "medium" })}` }),
        h("div.ws-actions", {},
          h("a.btn.primary.small", { href: `${worker}/api/download/${it.id}?redirect=1` }, "Download"),
          h("a.btn.small.ws-open", { href: `octive://workshop/${it.id}`, title: "Opens OCTIVE (starting it if it's closed), goes to the Workshop and gets this", onclick: () => openHint() }, "Open in OCTIVE"))));
  }

  /** After "Open in OCTIVE": if the game didn't take the link (not installed), say where to get it. */
  function openHint() {
    let left = false;
    const away = () => { left = true; };
    window.addEventListener("blur", away, { once: true });
    setTimeout(() => {
      window.removeEventListener("blur", away);
      if (left || document.hidden) return;
      const note = h("div.open-hint", {}, h("b", { text: "Didn't open?" }), " Open in OCTIVE needs OCTIVE for Windows installed (version 1.5 or newer). ",
        h("a", { href: "#/download" }, "Download OCTIVE"), h("button.btn.ghost.small", { type: "button", onclick: () => note.remove() }, "OK"));
      document.querySelector(".open-hint")?.remove();
      document.body.append(note);
      setTimeout(() => note.remove(), 9000);
    }, 1800);
  }

  /** #/open/workshop/<id>: a web address for "Open in OCTIVE" (Discord only links to web pages). */
  function openPage() {
    const m = (location.hash || "").match(/^#\/open\/workshop\/([a-z0-9]{16,40})/);
    document.title = "Open in OCTIVE";
    if (!m) { location.hash = "#/workshop"; return; }
    const link = `octive://workshop/${m[1]}`;
    app.replaceChildren(h("section.open-page", {},
      h("img", { src: "logo.svg", alt: "", width: 72, height: 72 }),
      h("h1", { text: "Opening OCTIVE…" }),
      h("p.sub", { text: "OCTIVE opens on the Workshop and gets this item for you." }),
      h("div.open-actions", {},
        h("a.btn.primary", { href: link, onclick: () => openHint() }, "Open in OCTIVE"),
        h("a.btn", { href: `${worker}/api/download/${m[1]}?redirect=1` }, "Download the file"),
        h("a.btn.ghost", { href: "#/download" }, "Get OCTIVE"))));
    setTimeout(() => { location.href = link; openHint(); }, 400);
  }

  function workshopPage() {
    document.title = "Workshop · OCTIVE";
    const tabs = h("div.ws-tabs");
    const grid = h("div.ws-grid", {}, h("p.empty", { text: "Loading…" }));
    const status = h("p.ws-status");
    const search = h("input.help-search.ws-search", { type: "search", placeholder: "Search titles and creators…", value: wsQuery });
    const sort = h("select.ws-sort", {}, h("option", { value: "new", text: "Newest" }), h("option", { value: "popular", text: "Most downloaded" }));
    sort.value = wsSort;
    let counts = {};
    const paintTabs = () => tabs.replaceChildren(...WS_TYPES.map(([id, name]) => {
      const b = h("button.ws-tab" + (id === wsType ? ".on" : ""), { type: "button" }, name, counts[id] ? h("span.ws-count", { text: String(counts[id]) }) : null);
      b.addEventListener("click", () => { wsType = id; paintTabs(); load(); });
      return b;
    }));
    let gen = 0;
    const load = () => {
      const g = ++gen;
      status.textContent = "Loading…";
      fetch(`${worker}/api/items?type=${wsType}&sort=${wsSort}${wsQuery ? "&q=" + encodeURIComponent(wsQuery) : ""}`, { cache: "no-cache" })
        .then((r) => r.ok ? r.json() : null).catch(() => null).then((d) => {
          if (g !== gen || !grid.isConnected) return;
          if (!d) { status.textContent = "The Workshop can't be reached right now."; grid.replaceChildren(); return; }
          counts = d.counts || {}; paintTabs();
          const what = (WS_TYPES.find((t) => t[0] === wsType) || [, "items"])[1].toLowerCase();
          status.textContent = d.items.length ? `${d.items.length} ${what}` : (wsQuery ? `No ${what} match "${wsQuery}".` : `No ${what} shared yet.`);
          grid.replaceChildren(...d.items.map(workshopCard));
        });
    };
    let t = null;
    search.addEventListener("input", () => { wsQuery = search.value.trim(); clearTimeout(t); t = setTimeout(load, 250); });
    sort.addEventListener("change", () => { wsSort = sort.value; load(); });
    app.replaceChildren(h("div.ws-page", {},
      h("section.page-head", {}, h("h1", { text: "Workshop" }),
        h("p.sub", { text: "Charts, skins, themes and styles made by players. Download them here and open them with OCTIVE, or get them in the game (Play → Workshop). To share yours, use Share in the game: it's posted in the OCTIVE Discord too." })),
      h("div.ws-bar", {}, tabs, h("div.ws-tools", {}, search, sort)),
      status, grid));
    paintTabs();
    load();
  }

  // ---------------------------------------------------------------- downloads

  function download() {
    const card = (cls, os, iconSvg, title, desc, ...rest) => h("article.dl." + cls, {},
      h("div.dl-head", {}, h("span.dl-icon", {}, iconSvg), h("div", {}, h("span.dl-os", { text: os }), h("h3", { text: title }))),
      h("p.dl-desc", { text: desc }), ...rest);
    const svg = (paths) => { const s = document.createElement("span"); s.innerHTML = `<svg viewBox="0 0 24 24">${paths}</svg>`; return s.firstChild; };
    const winBtn = h("a.btn.primary.wide", { href: worker + "/releases/OCTIVE-Installer.exe" }, "Download the installer");
    const apkBtn = h("a.btn.primary.wide", { href: "#" }, "Download the APK");
    const winSize = h("span.dl-size"), apkSize = h("span.dl-size");
    const win = card("win" + (!isAndroid ? ".suggested" : ""), "Windows", svg('<path d="M3 5.5l7.5-1v7H3zM11.5 4.4L21 3v8.5h-9.5zM3 12.5h7.5v7L3 18.5zM11.5 12.5H21V21l-9.5-1.4z"/>'),
      "Windows 10 and 11", "The installer downloads the newest version, puts OCTIVE in your Start menu and starts it. The game updates itself after that.",
      winBtn, h("div.dl-foot", {}, winSize),
      h("p.dl-note", { text: "Windows may say it protected your PC, because the installer is new. Click More info, then Run anyway." }));
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
    const page = h("div.download-page", {},
      h("section.page-head", {}, h("h1", { text: "Download OCTIVE" }), h("p.sub", { text: "Free on Windows and Android. Your account, scores and friends work on both." })),
      testerBox,
      h("div.dl-grid", {}, win, android, web, linux, mac),
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
    updateAccountNav(); location.hash = "#/account"; account();
  }

  function updateAccountNav() {
    // signed in: your name and picture open your public profile; the gear opens your account settings
    const a = document.querySelector('[data-nav="account"]');
    if (a) {
      const name = a.querySelector(".side-name"), av = a.querySelector(".side-av");
      if (name) name.replaceChildren(me ? me.name : "Sign in", me ? checkEl({ id: me.playerId, check: me.check }) : null);
      else a.textContent = me ? me.name : "Sign in";
      a.setAttribute("href", me && me.hasCard && !me.banned ? "#/u/" + encodeURIComponent(me.playerId) : "#/account");
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
      if (!location.hash.startsWith("#/account")) return;
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
      h("div.auth-links", {}, h("a", { href: "#/reset" }, "Forgot your password?"), h("span", { text: "No account? Make one in the game: Profile → Sign up." })));
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
        me.hasCard && !me.banned ? h("a.btn", { href: "#/u/" + encodeURIComponent(me.playerId) }, "Public profile") : null,
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

  function picturePanel() {
    const out = msg();
    const input = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", hidden: true });
    const preview = h("div.pic-preview", {}, h("img", { alt: "", hidden: true }), h("span.initial", { text: me.name.charAt(0).toUpperCase() }));
    if (me.avatarHash) { const img = preview.querySelector("img"); img.src = `${worker}/avatar/${encodeURIComponent(me.playerId)}?v=${encodeURIComponent(me.avatarHash)}`; img.hidden = false; preview.querySelector(".initial").hidden = true; }
    const btn = h("button.btn", { type: "button", onclick: () => input.click(), disabled: me.avatarLocked }, "Choose a picture…");
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      input.value = "";
      if (!file) return;
      if (file.size > 15 * 1048576) return setMsg(out, "That picture is too big (15 MB at most).");
      await busy(btn, async () => {
        try {
          const bmp = await createImageBitmap(file);
          const square = (size, q) => {
            const cv = document.createElement("canvas"); cv.width = cv.height = size;
            const s = Math.min(bmp.width, bmp.height);
            cv.getContext("2d").drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, size, size);
            return cv.toDataURL("image/jpeg", q).split(",")[1];
          };
          const full = square(256, 0.9), small = square(128, 0.85);
          if (await saveProfile({ avatar: full, avatarSmall: small }, out, "Picture saved.")) {
            const img = preview.querySelector("img"); img.src = "data:image/jpeg;base64," + full; img.hidden = false; preview.querySelector(".initial").hidden = true;
            const big = document.querySelector(".me-card .card-avatar img"); if (big) { big.src = img.src; big.hidden = false; big.nextElementSibling.hidden = true; }
          }
        } catch (e) { setMsg(out, "That picture couldn't be read."); }
      });
    });
    return section("Picture", me.avatarLocked ? "A developer set your picture, so it can't be changed." : "A square works best; other shapes are cropped to the middle.",
      h("div.pic-row", {}, preview, btn, input), out);
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
    const hints = { youtube: "@handle or channel link", twitch: "username", tiktok: "@username", x: "@username", instagram: "username", bluesky: "name.bsky.social", discord: "invite link (https://discord.gg/…)", website: "https://…" };
    const rows = SOCIALS.map(([id, name]) => {
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

  /** Preferences: connections (Discord) and shortcuts; the game's own options are in its Settings → Profile. */
  function preferencesPanel() {
    const conn = discordPanel();
    const boost = h("p.field-hint", { text: "Boosting the OCTIVE Discord server with your Discord linked makes you a supporter for as long as the boost lasts (any paid supporter time is paused meanwhile and continues after)." });
    conn.append(boost);
    const more = section("Messages and friends", "Read and send messages to your friends, see who follows you, and manage who you follow.",
      h("div.panel-actions", { style: "justify-content:flex-start;gap:10px;flex-wrap:wrap" },
        h("a.btn.primary", { href: "#/messages" }, "Open messages"),
        h("a.btn", { href: "#/u/" + encodeURIComponent(me.playerId) }, "My public profile")));
    const game = section("In the game", "Discord status, appearing offline, who can watch you play and notifications are set in OCTIVE: Settings → Profile.");
    return h("div", {}, conn, more, game);
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
    const user = h("input", { type: "text", autocomplete: "username", maxlength: 20, spellcheck: "false" });
    const out = msg();
    const send = h("button.btn.primary.wide", { type: "submit" }, "Email me a code");
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
          setTimeout(() => { location.hash = "#/account"; }, 2200);
        } catch (e) { setMsg(out, e.message); }
      });
    } }, "Set new password");
    step2.append(field("Code from the email", code), field("New password", pass, "8–30 characters with upper and lower case, a number and a symbol."), field("New password again", again), finish);
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
      field("Username", user), send, step2, out,
      h("div.auth-links", {}, h("a", { href: "#/account" }, "← Back to sign in")));
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

  function hashQuery() {
    const i = location.hash.indexOf("?");
    return new URLSearchParams(i >= 0 ? location.hash.slice(i + 1) : "");
  }

  /** A supporter's name in their colours (bio codes), or plain. */
  function nameInto(el, p) {
    const style = p.supporter && p.supporter.active && p.supporter.nameStyle;
    if (style) renderBio(el, style); else el.textContent = p.name || "Player";
    el.querySelector(".check")?.remove();
    const c = checkEl(p); if (c) el.append(c);
  }

  /** The animated GIF picture of a supporter, else their normal picture. */
  function avatarUrl(p) {
    if (worker && isSupporter(p) && p.supporter.gif) return `${worker}/looks/gif/${encodeURIComponent(p.id)}?v=${encodeURIComponent(p.supporter.gif)}`;
    return p.avatar || null;
  }

  function supporterPill(p, small) {
    const s = p.supporter;
    const [, key] = milestoneArt(s.months || 0);
    return h("span.sup-pill" + (small ? ".small" : ""), { title: s.lifetime ? "Lifetime OCTIVE supporter" : `OCTIVE supporter · ${monthsText(s.days)} in total` },
      h("img", { src: `badges/supporter-${key}.png`, alt: "" }), small ? null : h("span", { text: "Supporter" }));
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
    if (!isSupporter(p)) { if (gp && row0) row0.append(gp); return; }
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
      h("div.sup-earned", {},
        earned.map(([, key, label]) => h("figure", {}, h("img", { src: `badges/supporter-${key}.png`, alt: "" }), h("figcaption", { text: label }))),
        gifts.map(([, key, label]) => h("figure", { title: `${monthsGiftedText(gifted)} gifted to other players` }, h("img", { src: `badges/gifter-${key}.png`, alt: "" }), h("figcaption", { text: label })))));
  }

  /** Followers / following, a Follow button and Gift supporter. */
  function socialRow(p) {
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
      if (!me) { location.hash = "#/account"; return; }
      const want = !youFollow;
      followBtn.disabled = true;
      try {
        const r = await callApi("/follow", { playerId: p.id, follow: want }, true);
        youFollow = want; followers.textContent = fmt0.format(r.followers);
      } catch (e) { out.textContent = e.message; }
      followBtn.disabled = false; paint();
    });
    const gift = h("a.btn.gift", { href: "#/supporter?gift=" + encodeURIComponent(p.id), hidden: !!(me && me.playerId === p.id) || !!(p.supporter && p.supporter.lifetime) }, "♥ Gift supporter");
    const friends = h("b", { text: "…" });
    let row;
    const open = (k) => row.dispatchEvent(new CustomEvent("open-list", { detail: k }));
    const icon = (paths) => { const s = document.createElement("span"); s.className = "fc-icon"; s.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`; return s; };
    const tile = (k, count, label, title, paths) => h("button.follow-count", { type: "button", onclick: () => open(k), title },
      icon(paths), h("span.fc-text", {}, count, h("small", { text: label })));
    row = h("div.social-row", {},
      h("div.fc-tiles", {},
        tile("followers", followers, "Followers", "See who follows " + (p.name || "them"), '<path d="M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1"/><circle cx="9" cy="8" r="3.5"/><path d="M22 19v-1a4 4 0 0 0-3-3.9M16 4.2a3.5 3.5 0 0 1 0 6.6"/>'),
        tile("following", following, "Following", "See who " + (p.name || "they") + " follows", '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>'),
        tile("friends", friends, "Friends", "See " + (p.name || "their") + "'s friends", '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-3.3 3.6-6 8-6s8 2.7 8 6"/>')),
      h("div.fc-actions", {}, out, followBtn, gift));
    paint();
    (async () => {
      try {
        const token = store.get("octive.token", true);
        const res = await fetch(`${worker}/social/${encodeURIComponent(p.id)}`, { headers: token ? { Authorization: "Bearer " + token } : {} });
        const s = await res.json();
        followers.textContent = fmt0.format(s.followers || 0);
        following.textContent = fmt0.format((s.following || []).length);
        friends.textContent = s.friends != null ? fmt0.format(s.friends) : "—";
        youFollow = isOwner || s.youFollow === true;
        paint();
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
          row.append(chip);
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
            h("a.person-main", { href: "#/u/" + encodeURIComponent(x.id) },
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
            actions.append(h("a.btn", { href: "#/messages/" + encodeURIComponent(x.id) }, "Message"));
            actions.append(h("button.btn", { type: "button", onclick: async (e) => {
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
      ["Supporter badge", "A supporter badge on your profile and next to your name on leaderboards, with anniversary art as your support adds up."],
      ["Account banner", "A banner picture across the top of your profile, in the game and on the website."],
      ["Coloured name", "Colour and style your name with the same codes as bios: rainbow, bold, any colour."],
      ["Profile effects", "Sparkles, snow, hearts, embers, stars, aurora or rain over your profile card."],
      ["Animated picture", "A GIF profile picture (up to 8 MB) that's animated everywhere it shows."],
      ["Name changes any time", "No waiting between name changes."],
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
    const quick = h("div.quick-months", {}, [1, 3, 6, 12, 24, 36].map((m) => h("button.chip", { type: "button", "data-m": m, onclick: () => setMonths(m) }, m === 1 ? "1 month" : m === 36 ? "36 months · 50% off" : `${m} months`)));
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
    const giftSearch = h("input", { type: "search", placeholder: "Search ranked players by name…", spellcheck: "false" });
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
    };
    const searchGift = () => {
      giftList.textContent = "";
      const term = giftSearch.value.trim().toLowerCase();
      if (!term || !data) return;
      for (const p of data.players.filter((x) => (x.name || "").toLowerCase().includes(term) && (!me || x.id !== me.playerId)).slice(0, 8))
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
    const page = h("div.supporter-page", {},
      thanks ? h("div.thanks", {}, h("b", { text: "Thank you! ♥" }), h("span", { text: " Your support is being added now and shows in the game within a few minutes. Gifts wait for the player to claim them on their profile." })) : null,
      h("section.sup-hero", {},
        h("img.sup-hero-badge", { src: "badges/supporter-1y.png", alt: "" }),
        h("div", {}, h("h1", { text: "Support OCTIVE" }),
          h("p.sub", { text: "OCTIVE is free and made by one developer. Supporting keeps the servers running and gets you a few nice extras." }),
          status)),
      h("div.sup-grid", {},
        h("section.panel.buy-panel", {},
          h("h2", { text: "Choose your time" }),
          h("p.panel-sub", { text: "$2.50 a month, any number of months (type your own). Longer blocks cost less: 3+ months 10% off, 6+ 20%, 12+ 30%, 24+ 40%, and 36+ 50% (the most). One-time payment, nothing renews." }),
          h("div.seg-row", {}, forMe, forGift), giftBox,
          h("div.months-row", {}, monthsLabel, slider, h("label.months-custom-wrap", {}, h("span", { text: "Custom" }), custom)), quick,
          h("div.price-box", {}, total, h("div", {}, each, save)),
          buy, freeBtn, out, signHint,
          h("p.fine", { text: "Payments are handled by Stripe; OCTIVE never sees your card. Time adds onto any time you already have. See the Terms for refunds." })),
        h("section.panel.perk-panel", {},
          h("h2", { text: "What you get" }),
          h("ul.perks", {}, perks.map(([t, d]) => h("li", {}, h("b", { text: t }), h("span", { text: d })))))),
      h("section.panel.milestones", {},
        h("h2", { text: "Anniversary badges" }),
        h("p.panel-sub", { text: "Earned from your total time as a supporter. Gaps never reset it." }),
        h("div.sup-earned.big", {}, MILESTONE_ART.slice().reverse().map(([, key, label]) => h("figure", {}, h("img", { src: `badges/supporter-${key}.png`, alt: "" }), h("figcaption", { text: label }))))),
      h("section.panel.milestones", {},
        h("h2", { text: "Gifter badges" }),
        h("p.panel-sub", { text: "Earned by gifting supporter to other players: every month you gift counts. Everyone who buys supporter also gets a Supporter number (#0001, #0002…) in the order they first supported OCTIVE." }),
        h("div.sup-earned.big", {}, GIFTER_ART.slice().reverse().map(([, key, label, range]) => h("figure", {}, h("img", { src: `badges/gifter-${key}.png`, alt: "" }), h("figcaption", { text: `${label} · ${range} months` }))))),
      h("section.panel.wall", {}, h("h2", { text: "Supporters" }), h("div.wall-list", {}, h("p.panel-sub", { text: "Loading…" }))));
    app.replaceChildren(page);
    upd(); paintGift();

    const paintMe = () => {
      signHint.textContent = me ? `Signed in as ${me.name}.` : "";
      if (!me) signHint.append(h("a", { href: "#/account" }, "Sign in"), " with your game account to buy.");
      status.textContent = "";
      const s = me && me.supporter;
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
          const a = h("a.wall-item", { href: "#/u/" + encodeURIComponent(id) }, h("img", { src: `badges/supporter-${milestoneArt(s.months || 0)[1]}.png`, alt: "" }), h("span.wall-name"));
          nameInto(a.querySelector(".wall-name"), { ...p, supporter: s });
          wall.append(a);
        }
        if (!list.length) wall.append(h("p.panel-sub", { text: "Be the first." }));
      } catch { wall.textContent = "The list couldn't be loaded."; }
    })();
  }

  // ---------------------------------------------------------------- account: supporter panel and looks editor

  function supporterPanel() {
    const s = me.supporter || {};
    if (!s.active) {
      return section("Supporter", s.days > 0 ? `You supported OCTIVE for ${monthsText(s.days)}. Thank you! Your badges stay; support again to get the perks back.` : "Coloured name, banner, profile effects, animated picture and more.",
        h("div.panel-actions", {}, h("a.btn.primary", { href: "#/supporter" }, "Become a supporter")));
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
    const bannerIn = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", hidden: true });
    const bannerPrev = h("div.banner-preview");
    if (looks.banner) bannerPrev.style.backgroundImage = `url("${worker}/looks/banner/${encodeURIComponent(me.playerId)}?v=${looks.banner}")`;
    const bannerBtn = h("button.btn", { type: "button", onclick: () => bannerIn.click() }, "Choose banner…");
    const bannerDel = h("button.btn.ghost", { type: "button", onclick: () => busy(bannerDel, async () => { if (await saveLooks({ banner: "" }, out, "Banner removed.")) bannerPrev.style.backgroundImage = ""; }) }, "Remove");
    bannerIn.addEventListener("change", async () => {
      const file = bannerIn.files && bannerIn.files[0]; bannerIn.value = "";
      if (!file) return;
      await busy(bannerBtn, async () => {
        try {
          const bmp = await createImageBitmap(file);
          const W = 1200, H = 400, cv = document.createElement("canvas"); cv.width = W; cv.height = H;
          const scale = Math.max(W / bmp.width, H / bmp.height), sw = W / scale, sh = H / scale;
          cv.getContext("2d").drawImage(bmp, (bmp.width - sw) / 2, (bmp.height - sh) / 2, sw, sh, 0, 0, W, H);
          const b64 = cv.toDataURL("image/jpeg", 0.85).split(",")[1];
          if (await saveLooks({ banner: b64 }, out, "Banner saved.")) bannerPrev.style.backgroundImage = `url("data:image/jpeg;base64,${b64}")`;
        } catch { setMsg(out, "That picture couldn't be read."); }
      });
    });
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
          h("span.field-label", { text: "Banner" }), bannerPrev, h("div.panel-actions.left", {}, bannerBtn, looks.banner ? bannerDel : null, bannerIn),
          h("span.field-label", { text: "Animated picture (GIF, up to 8 MB)" }), h("div.pic-row", {}, gifPrev, gifBtn, looks.gif ? gifDel : null, gifIn))),
      out,
      h("div.panel-actions", {}, h("a.btn", { href: "#/supporter" }, "Add more time")));
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
  const loadAchDefs = () => achDefs ??= fetch("data/achievements.json?v=1.5.0-1").then((r) => r.json()).catch(() => []);
  const ACH_COLOURS = { Milestones: "#8b7bff", Skill: "#4fd6e8", Supporter: "#ff6fae", "OCTIVE Remixes": "#f2c14e", Community: "#5865f2" };
  const ACH_ICONS = { Milestones: "★", Skill: "✔", Supporter: "♥", "OCTIVE Remixes": "♪", Community: "☺" };

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
    const own = page() === "account" || location.hash === "#/u/" + encodeURIComponent(me.playerId) || location.hash === "#/u/" + me.playerId;
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
      ["How do I get OCTIVE?", "Download it from the Download page: Windows (installer), Android (APK) or play in your browser. It's free."],
      ["Do I need an account?", "No, you can play offline. An account puts your scores on the global ranking, keeps them in sync between devices, and lets you add friends and play multiplayer. Make one in the game: Profile → Sign up."],
      ["Can I play my osu!mania maps?", "Yes. On Windows, Song Select → the folder button imports your whole osu! Songs folder, or import single .osz / .osu files. osu!standard, taiko and catch maps can be converted to 4K too (Settings → osu! songs)."],
      ["The notes feel early or late", "Use Settings → Calibration: tap along to the clicks and apply the suggested audio offset. The visual offset moves only what you see."],
    ]],
    ["Scoring, PR and mods", [
      ["What is PR?", "PR is your performance rating (it used to be called PP). It works like osu!'s performance points."],
      ["How is PR worked out?", "Like osu!mania: each chart has a star rating, and a play's PR grows with the stars and needs high accuracy (osu!mania accuracy: Marvelous 320, Perfect 300, Great 200, Good 100, Bad 50). Your total is your best plays, each worth 95% of the one before, plus a small bonus for the number of charts played."],
      ["Why did my PR change?", "Version 1.3.3 reworked PR: vibro and spam charts are rated more fairly and accuracy counts more. Your past plays were recalculated the first time you opened the new version."],
      ["What do mods do?", "Pick them in Song Select (Mods, or F1). Easy widens the timing windows (PP ×0.5), Hard Rock tightens them (PP ×1.1), Hidden and Fade In hide the notes in different ways (PP ×1.06), Half Time and Double Time change the song speed (the stars are worked out at that speed), and Mirror flips the chart."],
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
      ["How big can a file be?", "As big as the OCTIVE Discord allows right now (it depends on the server's boost level; usually 50 MB)."],
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
          ...shown.map(([a, b]) => h("details.help-item", term ? { open: true } : {}, h("summary", { text: a }), h("p", { text: b }))));
      }).filter(Boolean));
      if (!list.children.length) list.append(h("p.empty", { text: "No questions match. Try other words, or ask in the Discord." }));
    };
    q.addEventListener("input", paint);
    paint();
    app.replaceChildren(h("div.help-page", {},
      h("section.page-head", {}, h("h1", { text: "Help" }), h("p.sub", { text: "Common questions about OCTIVE." })),
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
    app.replaceChildren(h("div.updates-page", {},
      h("section.page-head", {}, h("h1", { text: "Update history" }), h("p.sub", { text: "Every OCTIVE release, newest first. The game updates itself when a new one comes out." })),
      list));
    fetch(worker + "/releases/history.json", { cache: "no-cache" }).then((r) => r.ok ? r.json() : []).catch(() => []).then((hist) => {
      hist = (Array.isArray(hist) ? hist : []).filter((x) => x && x.version && !/test/i.test(x.version));
      if (!hist.length) { list.replaceChildren(h("p.empty", { text: "The update history couldn't be loaded right now." })); return; }
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
      const anchor = location.hash.match(/^#\/updates\/(.+)$/);
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
    const el = h("span." + cls, { text: (name || "?").slice(0, 1).toUpperCase() });
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
      app.replaceChildren(h("div.dm-signin", {},
        h("h1", { text: "Messages" }),
        h("p.sub", { text: "Sign in with your OCTIVE account to read and send messages to your friends." }),
        h("a.btn.primary", { href: "#/account" }, "Sign in")));
      return;
    }
    const openId = (location.hash.match(/^#\/messages\/([A-Za-z0-9_-]{8,64})/) || [])[1] || null;
    const list = h("div.dm-list");
    const pane = h("section.dm-pane");
    const root = h("div.dm-page" + (openId ? ".dm-open" : ""), {}, h("aside.dm-side", {}, h("h1", { text: "Messages" }), list), pane);
    app.replaceChildren(root);
    let box = null, thread = [], since = 0;

    const nameOf = (id) => (box?.threads || []).find((t) => t.with === id)?.name || (box?.friends || []).find((f) => f.id === id)?.name || "Player";

    function paintList() {
      const seen = new Set();
      const rows = [];
      for (const t of box?.threads || []) {
        seen.add(t.with);
        rows.push(h("a.dm-row" + (t.with === openId ? ".active" : "") + (t.unread ? ".unread" : ""), { href: "#/messages/" + encodeURIComponent(t.with) },
          dmAvatar(t.with, t.name),
          h("span.dm-row-main", {}, h("span.dm-row-name", { text: t.name || "Player" }), h("span.dm-row-last", { text: (t.fromMe ? "You: " : "") + (t.preview || "") })),
          h("span.dm-row-side", {}, h("span.dm-when", { text: t.last ? dmWhen(t.last) : "" }), t.unread ? h("span.dm-count", { text: String(t.unread) }) : null)));
      }
      const others = (box?.friends || []).filter((f) => !seen.has(f.id)).sort((a, b) => a.name.localeCompare(b.name));
      if (others.length) {
        rows.push(h("p.dm-cap", { text: "Friends" }));
        for (const f of others)
          rows.push(h("a.dm-row" + (f.id === openId ? ".active" : ""), { href: "#/messages/" + encodeURIComponent(f.id) },
            dmAvatar(f.id, f.name), h("span.dm-row-main", {}, h("span.dm-row-name", { text: f.name || "Player" }), h("span.dm-row-last", { text: "Start a conversation" }))));
      }
      if (!rows.length)
        rows.push(h("p.dm-none", { text: box && !box.synced
          ? "Open OCTIVE and sign in once: the game shares your friend list with the website so you can message them here."
          : "No friends yet. Add friends in the game (Friends, F8), then message them here." }));
      list.replaceChildren(...rows);
    }

    const feed = h("div.dm-feed");
    const input = h("textarea.dm-input", { rows: 1, maxlength: 500, placeholder: "Write a message…", "aria-label": "Message" });
    const sendBtn = h("button.btn.primary", { type: "submit" }, "Send");
    const note = h("p.form-msg", { role: "status" });

    function paintThread() {
      const kids = [];
      let day = "";
      for (const m of thread) {
        const d = new Date(m.at).toDateString();
        if (d !== day) { day = d; kids.push(h("p.dm-day", { text: d === new Date().toDateString() ? "Today" : new Date(m.at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) })); }
        const mine = m.from === me.playerId;
        kids.push(h("div.dm-msg" + (mine ? ".mine" : "") + (m.pending ? ".pending" : "") + (m.failed ? ".failed" : ""), {},
          h("p", { text: m.text }),
          h("span.dm-time", { text: m.failed ? "Not sent: " + m.failed : m.pending ? "Sending…" : new Date(m.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) })));
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
      const head = h("div.dm-head", {},
        h("a.dm-back", { href: "#/messages", "aria-label": "All messages" }, "←"),
        dmAvatar(openId, nameOf(openId)),
        h("a.dm-head-name", { href: "#/u/" + encodeURIComponent(openId) }, nameOf(openId)));
      pane.replaceChildren(head, feed,
        h("form.dm-send", { onsubmit: (e) => { e.preventDefault(); send(); } }, input, sendBtn), note);
    } else pane.replaceChildren(h("div.dm-empty", {}, h("p", { text: "Pick a conversation or a friend." })));

    await loadInbox();
    if (openId) {
      const nm = pane.querySelector(".dm-head-name"); if (nm) nm.textContent = nameOf(openId);
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

  function page() {
    const hash = location.hash || "#/";
    if (/^#\/u\//.test(hash)) return "player";
    const m = hash.match(/^#\/([a-z]+)/);
    return m ? m[1] : "home";
  }

  function route(fromHashChange) {
    const pg = page();
    const mine = pg === "player" && me && decodeURIComponent(location.hash.slice(4)) === me.playerId;
    const navKey = pg === "player" ? (mine ? "me" : "rankings") : pg === "account" ? "settings" : pg;
    for (const a of document.querySelectorAll("[data-nav]")) a.classList.toggle("active", a.dataset.nav === navKey || (navKey === "settings" && a.dataset.nav === "account"));
    if ((pg === "rankings" || pg === "player") && !data) { app.replaceChildren(h("p.empty", { text: "Loading the ranking…" })); return; }
    if (pg === "player") player(decodeURIComponent(location.hash.slice(4)));
    else if (pg === "rankings") rankings();
    else if (pg === "download") download();
    else if (pg === "account") account();
    else if (pg === "reset") resetPage();
    else if (pg === "supporter") supporterPage();
    else if (pg === "help") helpPage();
    else if (pg === "updates") updatesPage();
    else if (pg === "workshop") workshopPage();
    else if (pg === "messages") messagesPage();
    else if (pg === "open") openPage();
    else home();
    if (fromHashChange) window.scrollTo(0, 0);
  }

  window.addEventListener("hashchange", () => { route(true); document.body.classList.remove("menu-open"); document.querySelector(".nav-more")?.classList.remove("open"); });
  // the More menu opens on click too (touch screens), and closes when you click elsewhere
  const more = document.querySelector(".nav-more");
  if (more) {
    more.querySelector(".nav-more-btn").addEventListener("click", (e) => { e.stopPropagation(); more.classList.toggle("open"); });
    document.addEventListener("click", (e) => { if (!more.contains(e.target)) more.classList.remove("open"); });
  }
  // phones: the sidebar slides in from the menu button; a tap outside closes it
  const menuBtn = document.querySelector(".menu-btn");
  if (menuBtn) menuBtn.addEventListener("click", () => document.body.classList.toggle("menu-open"));
  document.querySelector(".side-scrim")?.addEventListener("click", () => document.body.classList.remove("menu-open"));
  route();
  load();
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
  setInterval(() => { const q = document.querySelector("[data-search]"); if (!document.hidden && !(q && q.value) && window.scrollY < 200 && ["home", "rankings", "player"].includes(page())) load(); }, 90_000);
})();
