// OCTIVE website: home (#/), global ranking (#/rankings), player profiles (#/u/<playerId>), downloads
// (#/download), sign-in and profile editing (#/account) and password resets (#/reset). Reads the ranking
// and releases from the Worker. No build step, no dependencies.
(() => {
  "use strict";

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
    if (p.avatar) {
      img.src = p.avatar.includes("?") || !p.avatarHash ? p.avatar : p.avatar + "?v=" + encodeURIComponent(p.avatarHash);
      img.hidden = false; initial.hidden = true;
      img.onerror = () => { img.hidden = true; initial.hidden = false; };
    }
    const dot = box.querySelector(".dot");
    if (dot) {
      dot.hidden = false;
      dot.classList.toggle("on", !!p.online);
      dot.title = p.online ? "Online now" : p.lastSeen ? "Last online " + ago(p.lastSeen) : "Offline";
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
      if (/^[0-9a-fA-F]{6}$/.test(src.slice(i + 1, i + 7)) && !isHex(src[i + 7] || "")) { flush(); cur = { ...cur, colour: src.slice(i + 1, i + 7), rainbow: false }; i += 6; continue; }
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
      const list = q ? data.players.filter((p) => (p.name || "").toLowerCase().includes(q)) : data.players;
      empty.hidden = list.length > 0;
      if (!list.length && q) empty.textContent = `Nobody called "${filter.trim()}" is ranked.`;
      for (const p of list) {
        const r = clone("tpl-row").firstElementChild;
        r.href = "#/u/" + encodeURIComponent(p.id);
        r.dataset.place = String(p.rank);
        r.querySelector(".rank").textContent = "#" + fmt0.format(p.rank);
        r.querySelector(".name").textContent = p.name || "Player";
        setAvatar(r.querySelector(".avatar"), p);
        setRole(r, r.querySelector(".badge"), p);
        r.querySelector(".acc").textContent = fmt2.format(p.accuracy || 0) + "%";
        r.querySelector(".lvl").textContent = "Lv" + (p.level || 1);
        r.querySelector(".plays").textContent = fmt0.format(p.playCount || 0);
        r.querySelector(".pp").textContent = fmt0.format(p.pp || 0) + "pp";
        rows.appendChild(r);
      }
    }
    search.addEventListener("input", () => render(search.value));
    render("");
    app.replaceChildren(view);
    document.title = "OCTIVE Rankings";
  }

  function player(id) {
    const p = data.players.find((x) => x.id === id);
    if (!p) {
      app.innerHTML = '<a class="back" href="#/rankings">← All players</a><p class="empty">That player isn\'t in the ranking (yet).</p>';
      return;
    }
    const view = clone("tpl-player");
    const card = view.querySelector(".card");
    view.querySelector(".card-name").textContent = p.name || "Player";
    view.querySelector(".card-rank").textContent = "#" + fmt0.format(p.rank);
    setAvatar(view.querySelector(".card-avatar"), p);
    const role = setRole(card, view.querySelector(".badge"), p);
    if (role) { const t = view.querySelector(".card-title"); t.textContent = role.title; t.hidden = false; }
    const status = view.querySelector(".card-status");
    status.textContent = p.online ? "● Online now" : p.lastSeen ? "Last online " + ago(p.lastSeen) : "Offline";
    status.classList.toggle("on", !!p.online);
    const set = (sel, v) => { view.querySelector(sel).textContent = v; };
    set(".c-pp", fmt0.format(p.pp || 0) + "pp");
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
    if (p.devFriend && !ROLES[p.id]) view.querySelector(".devfriend").hidden = false;
    if (p.bio && p.bio.trim()) {
      view.querySelector(".bio").hidden = false;
      renderBio(view.querySelector(".bio-text"), p.bio);
    }
    if ((p.badges || []).includes("CREATOR") && p.socials) {
      const box = view.querySelector(".social-links");
      if (box && renderSocials(box, p.socials) > 0) view.querySelector(".socials").hidden = false;
    }
    app.replaceChildren(view);
    document.title = `${p.name} · OCTIVE Rankings`;
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
    ["pp", "Global ranking", "Every chart has a star rating. Your best plays earn performance points, levels and a place on the ranking."],
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

  function home() {
    const players = data ? data.players : [];
    const version = h("div.home-meta");
    const hero = h("section.home-hero",
      {},
      h("div.home-copy", {},
        h("span.eyebrow", { text: "Free rhythm game · Windows and Android" }),
        h("h1", {}, "Hit every note.", h("br"), h("span.grad", { text: "Climb the ranking." })),
        h("p.lead", { text: "OCTIVE is a vertical scrolling rhythm game for 1 to 20 keys. Bring your osu!mania library, play with friends online and earn performance points on a global ranking." }),
        h("div.cta", {},
          h("a.btn.primary", { href: "#/download" }, "Download free"),
          h("a.btn", { href: "#/rankings" }, "See the rankings")),
        version),
      h("div.home-art", {}, playfield(), emblemSvg()));
    const stat = (label, value, cls) => h("div.hstat", {}, h("b" + (cls ? "." + cls : ""), { text: value }), h("span", { text: label }));
    const top = players[0];
    const stats = h("section.home-stats", {},
      stat("Ranked players", data ? fmt0.format(players.length) : "…"),
      stat("Online now", data ? fmt0.format(players.filter((p) => p.online).length) : "…", "online-count"),
      stat("Top performance", top ? fmt0.format(top.pp) + "pp" : "—"),
      stat("Latest version", "…"));
    const features = h("section.features", {},
      h("h2.section-title", { text: "Everything a rhythm game player wants" }),
      h("div.feature-grid", {}, FEATURES.map(([id, title, text]) => h("article.feature", {}, icon(id), h("h3", { text: title }), h("p", { text })))));
    const podium = h("section.home-top", {},
      h("div.section-head", {}, h("h2.section-title", { text: "Top players" }), h("a.more", { href: "#/rankings" }, "Full ranking →")),
      h("div.podium", {}, players.slice(0, 3).map((p) => {
        const a = h("a.pod", { href: "#/u/" + encodeURIComponent(p.id), "data-place": p.rank },
          h("span.pod-rank", { text: "#" + p.rank }),
          h("span.avatar", {}, h("img", { alt: "", loading: "lazy", hidden: true }), h("span.initial"), h("span.dot", { hidden: true })),
          h("span.pod-name", {}, h("span.name", { text: p.name || "Player" }), h("span.badge", { hidden: true })),
          h("span.pod-pp", { text: fmt0.format(p.pp || 0) + "pp" }),
          h("span.pod-sub", { text: `${fmt2.format(p.accuracy || 0)}% · Lv${p.level || 1}` }));
        setAvatar(a.querySelector(".avatar"), p);
        setRole(a, a.querySelector(".badge"), p);
        return a;
      }), !players.length ? h("p.empty", { text: data ? "No ranked players yet. Be the first!" : "Loading the ranking…" }) : null));
    const end = h("section.home-end", {},
      emblemSvg(84),
      h("div", {}, h("h2", { text: "Ready to play?" }), h("p", { text: "OCTIVE is free. The installer always gets you the newest version, and the game updates itself." })),
      h("a.btn.primary", { href: "#/download" }, "Download OCTIVE"));
    app.replaceChildren(hero, stats, features, podium, end);
    document.title = "OCTIVE · Free vertical scrolling rhythm game";
    loadRelease().then((m) => {
      if (!m || !hero.isConnected) return;
      stats.lastChild.querySelector("b").textContent = "v" + m.version;
      version.textContent = `Version ${m.version} · ${new Date(m.published).toLocaleDateString(undefined, { dateStyle: "medium" })}`;
    });
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
    const mac = card("mac.unsupported", "macOS", svg('<path d="M16 3c-1 .2-2.2 1-2.6 2.2-.3.8-.2 1.6-.2 1.6s1.2.1 2.1-.9c.8-.9.9-2.1.7-2.9z"/><path d="M12.5 7.5c-1 0-2-.6-3-.6C7.4 6.9 5 8.6 5 12.3 5 16 7.4 21 9.3 21c1 0 1.6-.6 2.9-.6 1.3 0 1.7.6 2.9.6 1.4 0 2.8-2.4 3.4-4-2-.9-2.6-3.6-.9-5.2.4-.4.9-.7 1.3-.9-.9-1.3-2.2-2-3.5-2-1.2 0-2 .6-2.9.6z"/>'),
      "Not supported", "OCTIVE doesn't run on Macs, and there are no plans for a macOS version right now.",
      h("span.btn.wide.disabled", { "aria-disabled": "true" }, "Not available"));
    const notes = h("section.release-notes", { hidden: true });
    const page = h("div.download-page", {},
      h("section.page-head", {}, h("h1", { text: "Download OCTIVE" }), h("p.sub", { text: "Free on Windows and Android. Your account, scores and friends work on both." })),
      h("div.dl-grid", {}, win, android, linux, mac),
      notes);
    app.replaceChildren(page);
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
      const res = await fetch(worker + "/account/" + path, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
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
    const a = document.querySelector('[data-nav="account"]');
    if (a) a.textContent = me ? me.name : "Sign in";
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

  function profilePage() {
    const p = { id: me.playerId, name: me.name, badges: me.badges, role: me.badges[0] || null,
      avatar: me.avatarHash ? `${worker}/avatar/${encodeURIComponent(me.playerId)}?v=${encodeURIComponent(me.avatarHash)}` : null };
    const c = me.card || {};
    const head = h("article.card.me-card", {},
      h("div.card-avatar", {}, h("img", { alt: "", hidden: true }), h("span.initial")),
      h("div.card-body", {},
        h("div.card-name-row", {}, h("h1.card-name", { text: me.name }), h("span.badge", { hidden: true })),
        h("div.card-status", { text: `@${me.username}` + (c.version ? ` · last played on v${c.version}` : "") }),
        me.hasCard ? h("dl.card-stats", {},
          h("div", {}, h("dt", { text: "Performance" }), h("dd", { text: fmt0.format(c.pp) + "pp" })),
          h("div", {}, h("dt", { text: "Accuracy" }), h("dd", { text: fmt2.format(c.accuracy) + "%" })),
          h("div", {}, h("dt", { text: "Level" }), h("dd", { text: "Lv" + c.level })),
          h("div", {}, h("dt", { text: "Plays" }), h("dd", { text: fmt0.format(c.playCount) }))) : h("p.panel-sub", { text: "Play a chart in the game while signed in and your stats show up here." }),
        h("div.me-actions", {},
          me.hasCard && !me.banned ? h("a.btn", { href: "#/u/" + encodeURIComponent(me.playerId) }, "View public profile") : null,
          h("button.btn.ghost", { type: "button", onclick: signOut }, "Sign out"))));
    setAvatar(head.querySelector(".card-avatar"), p);
    setRole(head, head.querySelector(".badge"), p);
    const panels = [];
    if (me.banned) panels.push(h("div.notice", { text: "This account is banned, so it can't be changed or appear in the ranking." }));
    if (!me.hasCard) panels.push(h("div.notice", { text: "Your profile appears online after your first play in the game while signed in. Until then it can't be edited here." }));
    if (me.hasCard && !me.banned) panels.push(picturePanel(), bioPanel());
    if (me.hasCard && !me.banned && me.creator) panels.push(socialsPanel());
    panels.push(emailPanel(), passwordPanel());
    app.replaceChildren(head, h("div.panels", {}, panels));
    document.title = `${me.name} · OCTIVE`;
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

  function page() {
    const hash = location.hash || "#/";
    if (/^#\/u\//.test(hash)) return "player";
    const m = hash.match(/^#\/([a-z]+)/);
    return m ? m[1] : "home";
  }

  function route(fromHashChange) {
    const pg = page();
    for (const a of document.querySelectorAll("[data-nav]")) a.classList.toggle("active", a.dataset.nav === (pg === "player" ? "rankings" : pg));
    if ((pg === "rankings" || pg === "player") && !data) { app.replaceChildren(h("p.empty", { text: "Loading the ranking…" })); return; }
    if (pg === "player") player(decodeURIComponent(location.hash.slice(4)));
    else if (pg === "rankings") rankings();
    else if (pg === "download") download();
    else if (pg === "account") account();
    else if (pg === "reset") resetPage();
    else home();
    if (fromHashChange) window.scrollTo(0, 0);
  }

  window.addEventListener("hashchange", () => route(true));
  route();
  load();
  // stay signed in: show the name in the menu
  if (worker && (store.get("octive.token", true) || store.get("octive.session")) && page() !== "account")
    callApi("me", undefined, true).then((m) => { me = m; updateAccountNav(); }).catch(() => {});
  // keep online status fresh while the page is open
  setInterval(() => { const q = document.querySelector("[data-search]"); if (!document.hidden && !(q && q.value) && window.scrollY < 200 && ["home", "rankings", "player"].includes(page())) load(); }, 90_000);
})();
