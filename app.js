// OCTIVE rankings site: reads data/leaderboard.json (written by scripts/update.mjs) and renders the
// global ranking (#/) and player cards (#/u/<playerId>). No build step, no dependencies.
(() => {
  "use strict";

  /** Special accounts by Unity player ID (same list as the game's PlayerRoles). */
  const ROLES = {
    "PlwcYVKV9y7NBFWfUaC263XpCFbE": { badge: "DEV", title: "OCTIVE developer" }, // Senterra
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

  // the game's level curve: level n needs 400 000 × (n − 1)² experience
  const xpFor = (lv) => 400000 * (lv - 1) * (lv - 1);

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
  }

  function setRole(root, badgeEl, p) {
    const role = ROLES[p.id];
    if (!role) return null;
    root.classList.add("dev");
    badgeEl.textContent = role.badge;
    badgeEl.hidden = false;
    return role;
  }

  function rankings() {
    const view = clone("tpl-rankings");
    const rows = view.querySelector("[data-rows]");
    const search = view.querySelector("[data-search]");
    view.querySelector("[data-count]").textContent = fmt0.format(data.players.length);
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
    view.querySelector(".c-pp").textContent = fmt0.format(p.pp || 0) + "pp";
    view.querySelector(".c-acc").textContent = fmt2.format(p.accuracy || 0) + "%";
    view.querySelector(".c-rank").textContent = "#" + fmt0.format(p.rank);
    const lv = p.level || 1;
    view.querySelector(".c-lvl").textContent = "Lv" + lv;
    view.querySelector(".fill").style.width = Math.round(Math.max(0, Math.min(1, p.levelProgress || 0)) * 100) + "%";
    const toNext = Math.round((xpFor(lv + 1) - xpFor(lv)) * (1 - (p.levelProgress || 0)));
    view.querySelector(".c-next").textContent = `${fmt0.format(toNext)} xp to Lv${lv + 1}`;
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
})();
