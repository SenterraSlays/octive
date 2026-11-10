// OCTIVE rankings site: reads the ranking from the Worker (or data/leaderboard.json) and renders the
// global ranking (#/) and player profiles (#/u/<playerId>). No build step, no dependencies.
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
  };
  /**
   * The rankings Worker (Cloudflare) address, e.g. "https://octive-rankings.yourname.workers.dev".
   * Empty: the site reads data/leaderboard.json instead.
   */
  const WORKER_URL = "https://octive-rankings-api.lunalazum18.workers.dev/";
  /** Optional: a link to where people can download the game (itch.io, GitHub Releases). */
  const DOWNLOAD_URL = "";

  const app = document.getElementById("app");
  const fmt0 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const fmt2 = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let data = null;

  // the game's level curve: level 1 → 2 takes 10,000 xp, every level after takes 7% more
  const xpFor = (lv) => lv <= 1 ? 0 : Math.round(10000 * (Math.pow(1.07, lv - 1) - 1) / 0.07);

  if (DOWNLOAD_URL) { const d = document.getElementById("download-link"); d.href = DOWNLOAD_URL; d.hidden = false; }

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
    route();
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
    return role;
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
    src = (src || "").replace(/\r/g, "").slice(0, 400).split("\n").slice(0, 8).join("\n");
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
      app.innerHTML = '<a class="back" href="#/">← All players</a><p class="empty">That player isn\'t in the ranking (yet).</p>';
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
    app.replaceChildren(view);
    document.title = `${p.name} · OCTIVE Rankings`;
    window.scrollTo(0, 0);
  }

  function route() {
    if (!data) return;
    const m = location.hash.match(/^#\/u\/(.+)$/);
    document.querySelector('[data-nav="rankings"]').classList.toggle("active", !m);
    if (m) player(decodeURIComponent(m[1])); else rankings();
  }

  window.addEventListener("hashchange", route);
  load();
  // keep online status fresh while the page is open
  setInterval(() => { const q = document.querySelector("[data-search]"); if (!document.hidden && !(q && q.value) && window.scrollY < 200) load(); }, 90_000);
})();
