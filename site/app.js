/* סורק מחירים — לוגיקת הממשק.
 * הנתונים נבנים ע"י scripts/fetch_prices.py לתיקייה data/:
 *   stores.json        [{id, chain, chainName, name, sub, address, city, n}]
 *   cats.json          [[שם קטגוריה, מספר קובץ קטלוג], ...]
 *   catalog/bN.json    {ברקוד: [שם, יצרן, כמות, יחידה(g/ml/u/m), אינדקס קטגוריה, שקיל]}
 *   store/<id>.json    {c: [ברקודים], p: [מחירים], k: [אינדקס קטגוריה]}
 */
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const DATA = "data/";
  const LS_STORE = "shivuk.store";

  const state = {
    stores: [], cats: [], meta: null,
    chain: "all", store: null, storeData: null, storeIndex: null,
    buckets: new Map(), current: null, sort: "unit", scanner: null,
  };

  const getJSON = async (path) => {
    const r = await fetch(DATA + path, { cache: "no-cache" });
    if (!r.ok) throw new Error(path + " " + r.status);
    return r.json();
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (n) => "₪" + n.toFixed(2);
  const setStatus = (msg, err = false) => { const el = $("#status"); el.textContent = msg || ""; el.classList.toggle("err", !!err); };
  const storage = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  /* ---------- יחידות ---------- */
  function unitInfo(p, price = p.price) {
    // מחזיר {per, label} — מחיר להשוואה וטקסט תצוגה
    const { qty, unit, weighted } = p;
    if (!qty || !unit) return null;
    if (unit === "g") return { per: (price / qty) * 100, label: "ל-100 גרם", size: weighted ? "לק״ג" : fmtSize(qty, "g") };
    if (unit === "ml") return { per: (price / qty) * 100, label: "ל-100 מ״ל", size: fmtSize(qty, "ml") };
    if (unit === "u") return { per: price / qty, label: "ליחידה", size: qty > 1 ? `${trim(qty)} יח׳` : "יחידה" };
    if (unit === "m") return { per: price / qty, label: "למטר", size: `${trim(qty)} מטר` };
    return null;
  }
  const trim = (n) => (Math.round(n * 100) / 100).toString();
  function fmtSize(q, u) {
    if (u === "g") return q >= 1000 ? `${trim(q / 1000)} ק״ג` : `${trim(q)} גרם`;
    if (u === "ml") return q >= 1000 ? `${trim(q / 1000)} ליטר` : `${trim(q)} מ״ל`;
    return "";
  }
  const catLabel = (k) => (k.startsWith("~") ? "מוצרי " + k.slice(1) : k);

  /* ---------- טעינה ---------- */
  async function init() {
    try {
      const [stores, cats] = await Promise.all([getJSON("stores.json"), getJSON("cats.json")]);
      state.stores = stores; state.cats = cats;
    } catch (e) {
      $("#storeList").innerHTML = `<li class="empty">עדיין אין נתונים. הנתונים נבנים אוטומטית ע״י GitHub Actions — נסו שוב בעוד כמה דקות.</li>`;
      return;
    }
    getJSON("meta.json").then((m) => {
      state.meta = m;
      const d = new Date(m.updated);
      $("#metaInfo").textContent = `${m.stores} סניפים · ${m.products.toLocaleString("he-IL")} מוצרים · עודכן ${d.toLocaleDateString("he-IL")} ${d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}`;
    }).catch(() => {});

    renderChains();
    renderStores();
    const saved = storage.get(LS_STORE);
    const s = saved && state.stores.find((x) => x.id === saved);
    if (s) selectStore(s);
  }

  /* ---------- בחירת סניף ---------- */
  function renderChains() {
    const chains = [...new Map(state.stores.map((s) => [s.chain, s.chainName])).entries()];
    const html = [`<button class="chip on" data-chain="all">כל הרשתות</button>`]
      .concat(chains.map(([k, n]) => `<button class="chip" data-chain="${esc(k)}">${esc(n)}</button>`));
    $("#chainChips").innerHTML = html.join("");
    $("#chainChips").onclick = (e) => {
      const b = e.target.closest(".chip"); if (!b) return;
      state.chain = b.dataset.chain;
      document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c === b));
      renderStores();
    };
  }

  function renderStores() {
    const q = $("#storeSearch").value.trim().toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    const list = state.stores.filter((s) => {
      if (state.chain !== "all" && s.chain !== state.chain) return false;
      const hay = `${s.chainName} ${s.name} ${s.sub} ${s.city} ${s.address}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
    $("#storeEmpty").hidden = list.length > 0;
    $("#storeList").innerHTML = list.slice(0, 200).map((s) => `
      <li><button data-id="${esc(s.id)}">
        <div><div class="s-name">${esc(s.name)}</div>
        <div class="s-sub">${esc([s.city, s.address].filter(Boolean).join(" · "))}</div></div>
        <span class="s-chain">${esc(s.chainName)}</span>
      </button></li>`).join("") + (list.length > 200 ? `<li class="muted center">מוצגים 200 מתוך ${list.length} — צמצמו בחיפוש</li>` : "");
  }

  async function selectStore(s) {
    state.store = s; state.storeData = null; state.storeIndex = null;
    storage.set(LS_STORE, s.id);
    $("#storeBtnText").textContent = `${s.chainName} · ${s.name}`;
    $("#storeBtn").hidden = false;
    $("#viewStores").hidden = true;
    $("#viewScan").hidden = false;
    $("#product").hidden = true; $("#alts").hidden = true;
    setStatus("טוען מחירון הסניף…");
    try {
      const d = await getJSON(`store/${s.id}.json`);
      if (state.store !== s) return;
      state.storeData = d;
      state.storeIndex = new Map(d.c.map((c, i) => [c, i]));
      setStatus(`המחירון נטען (${d.c.length.toLocaleString("he-IL")} מוצרים). סרקו מוצר כדי להתחיל.`);
    } catch {
      setStatus("לא הצלחנו לטעון את מחירון הסניף.", true);
    }
  }

  function showStores() {
    stopScan();
    $("#viewScan").hidden = true;
    $("#viewStores").hidden = false;
    $("#storeSearch").focus();
  }

  /* ---------- קטלוג ---------- */
  async function bucket(n) {
    if (!state.buckets.has(n)) state.buckets.set(n, getJSON(`catalog/b${n}.json`));
    return state.buckets.get(n);
  }

  async function productAt(i) {
    const d = state.storeData;
    const code = d.c[i], k = d.k[i];
    const b = await bucket(state.cats[k][1]);
    const info = b[code];
    if (!info) return null;
    return makeProduct(code, info, d.p[i], i);
  }

  // מבצעים בתוקף למוצר: {desc, each (מחיר ליחידה במבצע), qty (כמות מינימלית), kind (0 כללי / 1 מועדון / 2 מותנה), end}
  function promosAt(i) {
    const d = state.storeData;
    const ids = d.px && d.px[i];
    if (!ids) return [];
    return ids.map((j) => { const [desc, each, qty, kind, end, cond] = d.pm[j]; return { desc, each, qty, kind, end, cond: cond || 0 }; })
      .sort((a, b) => a.kind - b.kind || a.each - b.each);
  }

  function makeProduct(code, info, price, i) {
    const [name, manu, qty, unit, cat, weighted] = info;
    const promos = promosAt(i);
    // המחיר האפקטיבי להשוואה: המחיר הרגיל או מחיר המבצע (כולל מבצעים בתנאי), הנמוך מביניהם
    const eff = Math.min(price, ...promos.map((x) => x.each));
    return { code, name, manu, qty, unit, cat, weighted: !!weighted, price, promos, eff, onSale: eff < price };
  }

  const KIND = ["", "למועדון", "בתנאי"];
  // הסבר על התנאי של מבצע מותנה / מועדון
  function condText(x) {
    if (x.kind === 1) return "⚠️ בתנאי: לחברי מועדון הרשת / למשלמים בכרטיס האשראי של הרשת" + (x.cond ? ` ובקנייה מעל ₪${x.cond}` : "");
    if (x.kind === 2) return x.cond ? `⚠️ בתנאי: קנייה בסכום של ₪${x.cond} לפחות בחשבונית` : "⚠️ בתנאי: מבצע מותנה — ראו פירוט בתיאור";
    return "";
  }
  const fmtDate = (s) => (s ? s.slice(8, 10) + "/" + s.slice(5, 7) : "");
  function promoText(x) {
    const deal = x.qty > 1 ? `${trim(x.qty)} ב-${money(x.each * x.qty)} (${money(x.each)} ליח׳)` : `${money(x.each)}`;
    return deal;
  }

  /* ---------- חיפוש מוצר ---------- */
  function findIndex(raw) {
    const idx = state.storeIndex;
    if (!idx) return -1;
    const digits = String(raw).replace(/\D/g, "");
    if (!digits) return -1;
    const stripped = digits.replace(/^0+/, "") || "0";
    const cands = [stripped, `${state.store.chain}:${stripped}`];
    // סריקת UPC-E/EAN-8 לעיתים מחזירה ברקוד ללא ספרת ביקורת
    for (const c of cands) if (idx.has(c)) return idx.get(c);
    return -1;
  }

  async function lookup(code) {
    if (!state.storeData) { setStatus("המחירון עדיין נטען…"); return; }
    const i = findIndex(code);
    if (i < 0) {
      $("#product").hidden = true; $("#alts").hidden = true;
      setStatus(`הברקוד ${code} לא נמצא במחירון של ${state.store.chainName} ${state.store.name}.`, true);
      return;
    }
    setStatus("");
    const p = await productAt(i);
    if (!p) { setStatus("המוצר נמצא במחירון אך חסרים פרטיו.", true); return; }
    showProduct(p);
  }

  function showProduct(p) {
    state.current = p;
    const u = unitInfo(p);
    const meta = [p.manu, u && u.size].filter(Boolean).join(" · ");
    const promoHtml = p.promos.length ? `<div class="promos">${p.promos.map((x) => `
        <div class="promo ${x.kind ? "promo-cond" : ""}">
          <div class="promo-top"><span class="promo-tag">🏷️ מבצע${x.kind ? " " + KIND[x.kind] : ""}</span>
            <b>${promoText(x)}</b></div>
          ${x.kind ? `<div class="promo-cond-note">${esc(condText(x))}</div>` : ""}
          <div class="promo-desc">${esc(x.desc)}${x.end ? ` · עד ${fmtDate(x.end)}` : ""}</div>
        </div>`).join("")}
      </div>` : "";
    $("#product").innerHTML = `
      <span class="cat">${esc(catLabel(state.cats[p.cat][0]))}</span>
      <h2>${esc(p.name)}</h2>
      <div class="meta">${esc(meta)}</div>
      <div class="price-row">
        <div class="price">${p.price.toFixed(2)} <small>₪${p.weighted ? " לק״ג" : ""}</small></div>
        ${u && !p.weighted ? `<div class="unit">${money(u.per)} ${u.label}</div>` : ""}
      </div>
      ${promoHtml}
      <button id="findBtn" class="btn btn-good">💡 מצא תחליף זול</button>
      <div class="code">${esc(p.code.replace(/^\w+:/, ""))}</div>`;
    $("#product").hidden = false;
    $("#alts").hidden = true;
    $("#findBtn").onclick = findAlternatives;
    $("#product").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ---------- מציאת תחליף ----------
   * מחפשים בכל מוצרי הסניף (לא רק באותה קטגוריה) מוצר עם אותה "מהות":
   * מילות המהות = שם המוצר בלי מספרים, גדלים, אריזה, מותג ומילות שיווק.
   * למשל "מלפפונים במלח 13-17 560 גרם" → [מלפפונים, במלח]. כל מוצר בסניף שיש בו
   * "מלפפון" + "במלח" נחשב תחליף — בקופסה, בצנצנת, בשקית או בתפזורת.
   */
  // מילים שלא מתארות את המוצר עצמו: אריזה, גודל, שיווק, כשרות
  const STOP = new Set(["של", "עם", "ללא", "גרם", "גר", "מל", "ליטר", "לי", "קג", "יח", "יחידות", "יחידה", "מארז", "אריזת",
    "אריזה", "חדש", "חדשה", "אורגני", "אורגנית", "אורגניים", "טבעי", "טבעית", "מהדרינ", "מהדרין", "בדצ", "כשר", "לפסח", "למהדרינ",
    "קלאסי", "מקורי", "מקורית", "איכות", "פרימיום", "גדול", "גדולה", "גדולימ", "גדולות", "קטנ", "קטנה", "קטנימ", "קטנות", "בינוני",
    "בינונית", "בינונימ", "ענק", "מיני", "משפחתי", "משפחתית", "חסכונ", "חיסכונ", "מבצע", "שקית", "בשקית", "בקבוק", "בבקבוק", "פחית",
    "בפחית", "קופסה", "בקופסה", "קופסת", "צנצנת", "בצנצנת", "מגש", "במגש", "ואקומ", "בואקומ", "שישיית", "רביעיית", "שלישיית", "זוג",
    "ישראלי", "ישראלית", "מובחר", "מובחרימ", "סלקט", "טרי", "טריה", "טריימ", "טריות", "שומנ", "בתפזורת", "תפזורת", "ארוז", "ארוזה",
    "שימורימ", "שימורי", "משומר", "משומרימ", "פרוס", "פרוסות", "נקודתי", "כולל", "פיקדונ", "פקדונ", "מעדנייה", "מעדניה",
    "רמי", "לוי", "שופרסל", "שלי", "יוחננוף", "אושר", "עד", "טיב", "טעמ", "ויקטורי"]);
  const FINALS = { "ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ" };
  const unfinal = (s) => s.replace(/[ךםןףץ]/g, (c) => FINALS[c]);
  const STOPN = new Set([...STOP].map(unfinal));
  // מחזיר [{w: מילה מנורמלת, o: המילה המקורית}]
  const wordsO = (s) => (s || "").replace(/[\d"'׳״.,()%*/+\-:#!?]+/g, " ").split(/\s+/)
    .map((o) => ({ o, w: unfinal(o) })).filter((x) => x.w.length > 1 && !STOPN.has(x.w));
  const words = (s) => wordsO(s).map((x) => x.w);
  // "שורש" גס: 4 אותיות ראשונות (מלפפונים/מלפפון → מלפפ)
  const stem = (w) => w.slice(0, 4);
  // ב/ו/ה/ל בתחילת מילה ("במלח" ↔ "מלח")
  const stemNoPrefix = (w) => (w.length > 3 && "בוהל".includes(w[0]) ? w.slice(1, 5) : null);
  function coreWords(p) {
    if (p._core) return p._core;
    const brand = new Set(words(p.manu).map(stem));
    const seen = new Set();
    const core = wordsO(p.name).filter(({ w }) => {
      const st = stem(w);
      if (brand.has(st) || seen.has(st)) return false;
      seen.add(st); return true;
    });
    p._core = core.map((x) => x.w);
    p._coreText = core.slice(0, 3).map((x) => x.o).join(" ");
    return p._core;
  }
  function tokenMatch(a, b) {
    if (stem(a) === stem(b)) return true;
    const a2 = stemNoPrefix(a), b2 = stemNoPrefix(b);
    return (a2 && a2 === stem(b)) || (b2 && b2 === stem(a)) || (a2 && b2 && a2 === b2);
  }
  // האם q הוא אותו מוצר-מהות כמו p? מחזיר ציון 0..1 (0 = לא מתאים)
  function substanceMatch(p, q) {
    const A = coreWords(p), B = coreWords(q);
    if (!A.length || !B.length) return 0;
    // המילה הראשונה (שם המוצר עצמו, למשל "מלפפונים") חייבת להופיע בתחילת שם התחליף
    if (!B.slice(0, 2).some((w) => tokenMatch(A[0], w))) return 0;
    // ושאר מילות המהות ("במלח") — לפחות חצי מהן (שמות המוצרים בקבצים לפעמים קטועים)
    const rest = A.slice(1, 4);
    const hit = rest.filter((a) => B.some((b) => tokenMatch(a, b))).length;
    if (hit < Math.ceil(rest.length / 2)) return 0;
    return (1 + hit) / (1 + rest.length);
  }

  // אינדקס כל מוצרי הסניף (נטען פעם אחת לכל סניף)
  let storeProducts = null;
  async function allStoreProducts() {
    if (storeProducts && storeProducts.data === state.storeData) return storeProducts.list;
    const d = state.storeData;
    const nums = [...new Set(d.k.map((k) => state.cats[k][1]))];
    const map = new Map(await Promise.all(nums.map((n) => bucket(n).then((b) => [n, b]))));
    const list = [];
    for (let i = 0; i < d.c.length; i++) {
      const info = map.get(state.cats[d.k[i]][1])[d.c[i]];
      if (info) list.push(makeProduct(d.c[i], info, d.p[i], i));
    }
    storeProducts = { data: d, list };
    return list;
  }

  let altCache = [];
  async function findAlternatives() {
    const p = state.current; if (!p) return;
    $("#findBtn").disabled = true;
    $("#findBtn").textContent = "מחפש תחליפים בכל הסניף…";
    try {
      const all = await allStoreProducts();
      const base = unitInfo(p, p.eff);
      const out = [];
      for (const q0 of all) {
        if (q0.code === p.code) continue;
        const sim = substanceMatch(p, q0);
        if (!sim) continue;
        const q = Object.assign({}, q0, { sim });
        if (base) {
          if (q.unit !== p.unit) continue;
          const u = unitInfo(q, q.eff); if (!u) continue;
          q.per = u.per; q.u = u;
        }
        q.ratio = p.qty && q.qty ? q.qty / p.qty : 1;
        out.push(q);
      }
      altCache = out;
      renderAlts();
    } finally {
      $("#findBtn").disabled = false;
      $("#findBtn").textContent = "💡 מצא תחליף זול";
    }
  }

  function renderAlts() {
    const p = state.current, base = unitInfo(p, p.eff);
    const similarOnly = $("#similarSize").checked;
    const byUnit = state.sort === "unit" && base;
    let list = altCache.filter((q) => (byUnit ? q.per < base.per - 1e-9 : q.eff < p.eff - 1e-9));
    if (similarOnly) list = list.filter((q) => q.ratio >= 0.6 && q.ratio <= 1.7);
    list.sort((a, b) => (byUnit ? a.per - b.per : a.eff - b.eff) || b.sim - a.sim);
    list = list.slice(0, 25);

    coreWords(p);
    $("#altsTitle").textContent = `תחליפים זולים ל: ${p._coreText || p.name}`;
    $("#alts").hidden = false;
    if (!list.length) {
      $("#altList").innerHTML = `<li class="empty" style="display:block;cursor:default"><strong>👍 בחירה טובה!</strong>
        לא נמצא בסניף מוצר דומה ${byUnit ? "ומשתלם" : "וזול"} יותר${similarOnly ? " בגודל דומה" : ""}.</li>`;
    } else {
      $("#altList").innerHTML = list.map((q, i) => {
        const pct = byUnit ? (1 - q.per / base.per) * 100 : (1 - q.eff / p.eff) * 100;
        const sale = q.onSale ? q.promos.find((x) => x.each === q.eff) : null;
        const sub = [q.manu, q.u && q.u.size, q.u && !q.weighted ? `${money(q.per)} ${q.u.label}` : ""].filter(Boolean).join(" · ");
        return `<li data-code="${esc(q.code)}" class="${i === 0 ? "best" : ""}">
          <div>${i === 0 ? `<div class="badge-best">★ ${byUnit ? "הכי משתלם" : "הכי זול"}</div>` : ""}
            <div class="alt-name">${esc(q.name)}</div><div class="alt-sub">${esc(sub)}</div>
            ${sale ? `<div class="alt-promo">🏷️ מבצע: ${promoText(sale)}</div>` : ""}
            ${sale && sale.kind ? `<div class="promo-cond-note">${esc(condText(sale))}</div>` : ""}</div>
          <div>${q.onSale ? `<div class="alt-old">${money(q.price)}</div>` : ""}<div class="alt-price">${money(q.eff)}</div>
            <div class="save">חוסך ${Math.round(pct)}%${byUnit ? " ליחידה" : ""}</div></div>
        </li>`;
      }).join("");
    }
    $("#alts").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ---------- חיפוש לפי שם ---------- */
  let nameIndex = null;
  async function buildNameIndex() {
    if (nameIndex) return nameIndex;
    const d = state.storeData;
    const nums = [...new Set(d.k.map((k) => state.cats[k][1]))];
    $("#nameResults").innerHTML = `<li class="muted">טוען את רשימת המוצרים…</li>`;
    const bs = await Promise.all(nums.map((n) => bucket(n).then((b) => [n, b])));
    const map = new Map(bs);
    nameIndex = d.c.map((c, i) => {
      const info = map.get(state.cats[d.k[i]][1])[c];
      return info ? { i, name: info[0], manu: info[1] } : null;
    }).filter(Boolean);
    return nameIndex;
  }

  async function nameSearch() {
    const q = $("#nameSearch").value.trim();
    if (q.length < 2 || !state.storeData) { $("#nameResults").innerHTML = ""; return; }
    const idx = await buildNameIndex();
    const terms = q.split(/\s+/);
    const res = idx.filter((x) => terms.every((t) => (x.name + " " + x.manu).includes(t))).slice(0, 30);
    $("#nameResults").innerHTML = res.length
      ? res.map((x) => `<li><button data-i="${x.i}"><span>${esc(x.name)}${state.storeData.px && state.storeData.px[x.i] ? " 🏷️" : ""}</span><b>${money(state.storeData.p[x.i])}</b></button></li>`).join("")
      : `<li class="muted">לא נמצאו מוצרים.</li>`;
  }

  /* ---------- סורק ---------- */
  async function startScan() {
    if (!window.Html5Qrcode) { setStatus("רכיב הסריקה לא נטען. אפשר להקליד ברקוד ידנית.", true); return; }
    $("#reader").hidden = false; $("#scanBtn").hidden = true; $("#stopBtn").hidden = false;
    const F = window.Html5QrcodeSupportedFormats;
    state.scanner = new Html5Qrcode("reader", {
      formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.ITF],
      experimentalFeatures: { useBarCodeDetectorIfSupported: true }, verbose: false,
    });
    try {
      await state.scanner.start({ facingMode: "environment" },
        { fps: 12, qrbox: (w) => ({ width: Math.min(300, w * 0.85), height: 150 }) },
        (text) => { if (navigator.vibrate) navigator.vibrate(60); stopScan(); $("#manualCode").value = text; lookup(text); },
        () => {});
      setStatus("כוונו את המצלמה לברקוד…");
    } catch (e) {
      stopScan();
      setStatus("לא ניתן לפתוח את המצלמה. אשרו גישה למצלמה או הקלידו ברקוד ידנית.", true);
    }
  }
  async function stopScan() {
    const s = state.scanner; state.scanner = null;
    $("#reader").hidden = true; $("#scanBtn").hidden = false; $("#stopBtn").hidden = true;
    if (s) { try { await s.stop(); } catch { /* ignore */ } try { s.clear(); } catch { /* ignore */ } }
  }

  /* ---------- אירועים ---------- */
  $("#storeSearch").addEventListener("input", renderStores);
  $("#storeList").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-id]"); if (!b) return;
    const s = state.stores.find((x) => x.id === b.dataset.id);
    nameIndex = null;
    if (s) selectStore(s);
  });
  $("#storeBtn").addEventListener("click", showStores);
  $("#scanBtn").addEventListener("click", startScan);
  $("#stopBtn").addEventListener("click", stopScan);
  $("#manualForm").addEventListener("submit", (e) => { e.preventDefault(); const v = $("#manualCode").value.trim(); if (v) lookup(v); });
  let t; $("#nameSearch").addEventListener("input", () => { clearTimeout(t); t = setTimeout(nameSearch, 200); });
  $("#nameResults").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-i]"); if (!b) return;
    const p = await productAt(+b.dataset.i); if (p) { setStatus(""); showProduct(p); }
  });
  $("#altList").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-code]"); if (!li) return;
    const q = altCache.find((x) => x.code === li.dataset.code);
    if (q) { const { sim, per, u, ratio, _core, _coreText, ...prod } = q; showProduct(prod); }
  });
  document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => {
    state.sort = b.dataset.sort;
    document.querySelectorAll(".seg button").forEach((x) => x.classList.toggle("on", x === b));
    renderAlts();
  }));
  $("#similarSize").addEventListener("change", renderAlts);

  init();
})();
