#!/usr/bin/env python3
"""הורדת קבצי שקיפות המחירים של רשתות השיווק ובניית קבצי JSON לאתר.

לפי חוק המזון (תקנות שקיפות מחירים) כל רשת מפרסמת קבצי XML עם רשימת
הסניפים (Stores) ומחירון מלא לכל סניף (PriceFull). הסקריפט:
  1. מוריד את רשימת הסניפים ואת המחירון העדכני של כל סניף, מכל רשת שמוגדרת ב-CHAINS.
  2. מסווג כל מוצר לקטגוריה (scripts/categories.py) ומחשב כמות בסיס (גרם / מ"ל / יחידה).
  3. כותב לתיקיית הפלט:
       stores.json            — רשימת כל הסניפים
       cats.json              — רשימת הקטגוריות ולאיזה קובץ קטלוג כל אחת שייכת
       catalog/bNN.json       — פרטי מוצרים (שם, יצרן, כמות, יחידה, קטגוריה) מחולקים לפי קטגוריה
       store/<id>.json        — מחירי סניף אחד: ברקודים, מחירים, אינדקס קטגוריה
       meta.json              — זמן עדכון וסטטוס כל רשת

שימוש:
  python3 scripts/fetch_prices.py --out site/data
  MAX_STORES=3 python3 scripts/fetch_prices.py --out site/data   # הרצה מהירה לבדיקה
"""
import argparse
import concurrent.futures as cf
import datetime as dt
import gzip
import http.cookiejar
import io
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from categories import classify  # noqa: E402

UA = "Mozilla/5.0 (compatible; shivuk-price-compare/1.0)"
MAX_STORES = int(os.environ.get("MAX_STORES", "0") or 0)  # 0 = ללא הגבלה
WORKERS = int(os.environ.get("WORKERS", "8"))

# רשתות שמפרסמות בפורטל publishedprices.co.il (שם משתמש ציבורי שהרשת מפרסמת, ללא סיסמה).
# רשת שנכשלת מדולגת ונרשמת ב-meta.json, כך שאפשר להוסיף/להסיר כאן בחופשיות.
CERBERUS_CHAINS = [
    ("ramilevy", "רמי לוי", "RamiLevi", ""),
    ("osherad", "אושר עד", "osherad", ""),
    ("yohananof", "יוחננוף", "yohananof", ""),
    ("tivtaam", "טיב טעם", "TivTaam", ""),
    ("doralon", "דור אלון", "doralon", ""),
    ("keshet", "קשת טעמים", "Keshet", ""),
    ("freshmarket", "פרשמרקט", "freshmarket", ""),
    ("stopmarket", "סטופ מרקט", "Stop_Market", ""),
    ("politzer", "פוליצר", "politzer", ""),
]


# ---------------------------------------------------------------- HTTP

def make_opener():
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    op.addheaders = [("User-Agent", UA)]
    return op


def fetch(op, url, data=None, timeout=90, tries=3):
    last = None
    for i in range(tries):
        try:
            with op.open(url, data=data, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (i + 1))
    raise last


def unpack(raw):
    """קבצי הרשתות מגיעים כ-gz, zip או XML גולמי."""
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    elif raw[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            raw = z.read(z.namelist()[0])
    return raw


def parse_xml(raw):
    raw = unpack(raw)
    if raw.startswith(b"\xef\xbb\xbf"):
        raw = raw[3:]
    try:
        return ET.fromstring(raw)
    except ET.ParseError:
        # חלק מהקבצים מוצהרים כ-UTF-8 אבל מקודדים אחרת
        for enc in ("utf-16", "cp1255"):
            try:
                txt = raw.decode(enc)
                txt = re.sub(r"<\?xml[^>]*\?>", "", txt, count=1)
                return ET.fromstring(txt)
            except Exception:  # noqa: BLE001
                continue
        raise


def kids(el):
    return {c.tag.lower(): (c.text or "").strip() for c in el}


# ---------------------------------------------------------------- Stores / prices parsing

def parse_stores(root):
    out = {}
    for el in root.iter():
        if el.tag.lower() not in ("store", "branch"):
            continue
        k = kids(el)
        sid = k.get("storeid")
        if not sid or not sid.strip().isdigit():
            continue
        out[int(sid)] = {
            "name": k.get("storename", ""),
            "address": k.get("address", ""),
            "city": k.get("city", ""),
            "sub": k.get("subchainname", ""),
        }
    return out


def parse_items(root):
    for el in root.iter():
        t = el.tag.lower()
        if t not in ("item", "product"):
            continue
        k = kids(el)
        if "itemcode" in k:
            yield k


UNIT_PATTERNS = [
    (re.compile(r"ק\"?ג|קילו|ק'ג|קג"), ("g", 1000)),
    (re.compile(r"מ\"?ל|מיליליטר|מל'|מ''ל"), ("ml", 1)),
    (re.compile(r"ליטר|^ל'?$|^ל\.?$"), ("ml", 1000)),
    (re.compile(r"גרם|גר'?|^ג'?$|^ג\.?$"), ("g", 1)),
    (re.compile(r"יח|יחידה|יחידות"), ("u", 1)),
    (re.compile(r"מטר"), ("m", 1)),
]
NAME_QTY = re.compile(r"(\d+(?:\.\d+)?)\s*(ק\"ג|קג|קילו|ליטר|ל'|ל(?=\s|$)|מ\"ל|מל|גרם|גר|ג'|ג(?=\s|$))")


def unit_of(s):
    s = (s or "").strip()
    if not s or s in ("לא ידוע", "0"):
        return None
    for pat, u in UNIT_PATTERNS:
        if pat.search(s):
            return u
    return None


def to_float(s):
    try:
        return float(str(s).replace(",", "."))
    except (TypeError, ValueError):
        return 0.0


PACK = re.compile(r"(?:(\d+)\s*[*xX×]\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*\S{0,4}\s*[*xX×]\s*(\d+))")


def name_quantity(name):
    """כמות מתוך שם המוצר, כולל מארזים ("10*25 גרם", "4*1.5 ליטר"). מחזיר (יחידה, כמות ליחידה, כמות כוללת)."""
    m = NAME_QTY.search(name or "")
    if not m:
        return None
    typ, mult = unit_of(m.group(2)) or ("", 1)
    if not typ:
        return None
    single = float(m.group(1)) * mult
    packs = 1
    pm = PACK.search(name)
    if pm:
        n = int(pm.group(1) or pm.group(2))
        if 1 < n <= 48:
            packs = n
    return typ, single, single * packs


def base_quantity(k):
    """מחזיר (סוג יחידה, כמות ביחידת בסיס) — גרם / מ"ל / יחידות / מטר."""
    q = to_float(k.get("quantity"))
    if k.get("bisweighted") == "1":
        return "g", 1000.0  # מוצר שקיל — המחיר הוא לק"ג
    u = unit_of(k.get("unitqty")) or unit_of(k.get("unitofmeasure"))
    nq = name_quantity(k.get("itemname", ""))
    if nq and (not u or u[0] == "u"):
        return nq[0], round(nq[2], 2)
    if u and q > 0:
        typ, mult = u
        val = q * mult
        if typ in ("g", "ml") and val < 5 and mult == 1:
            val = q * 1000  # "1.5" עם יחידה גרם/מ"ל → כנראה ק"ג/ליטר
        if nq and nq[0] == typ and nq[2] > nq[1] and abs(val - nq[1]) < 0.01 * nq[1] + 0.5:
            val = nq[2]  # השדה מציין כמות של יחידה בודדת מתוך מארז
        if 0 < val < 100000:
            return typ, round(val, 2)
    if nq:
        return nq[0], round(nq[2], 2)
    if u and u[0] == "u" and q > 0:
        return "u", q
    return "", 0.0


def gtin_ok(code):
    if len(code) not in (8, 12, 13, 14) or not code.isdigit():
        return False
    digits = [int(c) for c in code]
    check = digits.pop()
    total = sum(d * (3 if i % 2 == 0 else 1) for i, d in enumerate(reversed(digits)))
    return (10 - total % 10) % 10 == check


def norm_code(code, chain_key):
    """ברקוד תקני (EAN/UPC) — גלובלי. קוד פנימי של רשת — מקבל קידומת של הרשת."""
    c = re.sub(r"\D", "", code or "")
    if not c:
        return None
    stripped = c.lstrip("0") or "0"
    padded = c.zfill(13) if len(c) <= 13 else c
    if gtin_ok(c) or gtin_ok(padded):
        return stripped
    return f"{chain_key}:{stripped}"


# ---------------------------------------------------------------- Chain fetchers

def latest_price_files(names):
    """מתוך רשימת קבצים מחזיר {storeId: name} — המחירון המלא העדכני של כל סניף."""
    best = {}
    for n in names:
        m = re.match(r"PriceFull(\d+)-(\d+)-(\d+)-(\d{8})-?(\d{4,6})?", n, re.I)
        if not m:
            m2 = re.match(r"PriceFull(\d+)-(\d+)-(\d{8})(\d{4})?", n, re.I)
            if not m2:
                continue
            sid, stamp = int(m2.group(2)), m2.group(3) + (m2.group(4) or "")
        else:
            sid, stamp = int(m.group(3)), m.group(4) + (m.group(5) or "")
        if sid not in best or stamp > best[sid][0]:
            best[sid] = (stamp, n)
    return {k: v[1] for k, v in best.items()}


class Shufersal:
    key, name = "shufersal", "שופרסל"
    BASE = "https://prices.shufersal.co.il"

    def __init__(self):
        self.op = make_opener()

    def _list(self, cat):
        links, page = [], 1
        while page < 200:
            html = fetch(self.op, f"{self.BASE}/FileObject/UpdateCategory?catID={cat}&storeId=0&page={page}").decode("utf-8", "replace")
            found = [h.replace("&amp;", "&") for h in re.findall(r'href="(https://[^"]+\.gz[^"]*)"', html)]
            new = [f for f in found if f not in links]
            if not new:
                break
            links += new
            if f"page={page + 1}" not in html:
                break
            page += 1
        return links

    @staticmethod
    def _fname(url):
        return urllib.parse.urlparse(url).path.rsplit("/", 1)[-1]

    def stores(self):
        urls = self._list(5)
        return parse_stores(parse_xml(fetch(self.op, urls[0])))

    def price_files(self):
        urls = self._list(2)
        by_name = {self._fname(u): u for u in urls}
        return {sid: by_name[n] for sid, n in latest_price_files(by_name).items()}

    def download(self, ref):
        return fetch(self.op, ref)


class Cerberus:
    BASE = "https://url.publishedprices.co.il"

    def __init__(self, key, name, user, password):
        self.key, self.name, self.user, self.password = key, name, user, password
        self.op = make_opener()
        self.files = None

    def _token(self, html):
        m = re.search(r'name="csrftoken"\s+content="([^"]+)"', html)
        return m.group(1) if m else ""

    def _login(self):
        tok = self._token(fetch(self.op, self.BASE + "/login").decode("utf-8", "replace"))
        body = urllib.parse.urlencode({"username": self.user, "password": self.password,
                                       "csrftoken": tok, "Submit": "Sign in"}).encode()
        html = fetch(self.op, self.BASE + "/login/user", body).decode("utf-8", "replace")
        tok = self._token(html)
        if not tok:
            raise RuntimeError("login failed")
        body = urllib.parse.urlencode({"sEcho": 1, "iColumns": 5, "iDisplayStart": 0, "iDisplayLength": 100000,
                                       "sSearch": "", "cd": "/", "csrftoken": tok}).encode()
        data = json.loads(fetch(self.op, self.BASE + "/file/json/dir", body))
        self.files = [x["fname"] for x in data.get("aaData", [])]
        if not self.files:
            raise RuntimeError("no files listed")

    def stores(self):
        if self.files is None:
            self._login()
        st = sorted(f for f in self.files if f.lower().startswith("stores"))
        if not st:
            return {}
        return parse_stores(parse_xml(self.download(st[-1])))

    def price_files(self):
        if self.files is None:
            self._login()
        return latest_price_files(self.files)

    def download(self, ref):
        return fetch(self.op, self.BASE + "/file/d/" + urllib.parse.quote(ref))


# ---------------------------------------------------------------- Build

def load_cities():
    """ממפה סמל יישוב של הלמ"ס לשם יישוב (data.gov.il)."""
    url = ("https://data.gov.il/api/3/action/datastore_search?"
           "resource_id=b7cf8f14-64a2-4b33-8d4b-edb286fdbd37&limit=5000")
    try:
        data = json.loads(fetch(make_opener(), url, timeout=60))
        return {str(r["סמל_ישוב"]).strip(): r["שם_ישוב"].strip().replace(")", "#").replace("(", ")").replace("#", "(")
                for r in data["result"]["records"]}
    except Exception as e:  # noqa: BLE001
        print("cities: failed", e, file=sys.stderr)
        return {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="site/data")
    ap.add_argument("--chains", default="", help="רשימת מפתחות רשתות מופרדת בפסיקים (ברירת מחדל: כולן)")
    args = ap.parse_args()

    out = args.out
    os.makedirs(os.path.join(out, "store"), exist_ok=True)
    os.makedirs(os.path.join(out, "catalog"), exist_ok=True)

    chains = [Shufersal()] + [Cerberus(*c) for c in CERBERUS_CHAINS]
    if args.chains:
        wanted = set(args.chains.split(","))
        chains = [c for c in chains if c.key in wanted]

    cities = load_cities()
    catalog = {}          # code -> [name, manufacturer, qty, unitType, catKey]
    cat_index = {}        # catKey -> idx
    stores_out = []
    meta = {"updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="minutes"), "chains": []}

    def cat_id(k):
        if k not in cat_index:
            cat_index[k] = len(cat_index)
        return cat_index[k]

    for ch in chains:
        t0 = time.time()
        try:
            stores = ch.stores()
            files = ch.price_files()
        except Exception as e:  # noqa: BLE001
            print(f"[{ch.key}] skipped: {e}", file=sys.stderr)
            meta["chains"].append({"key": ch.key, "name": ch.name, "ok": False, "error": str(e)[:200]})
            continue
        sids = sorted(files)
        if MAX_STORES:
            sids = sids[:MAX_STORES]
        print(f"[{ch.key}] {len(stores)} stores in list, {len(files)} price files, processing {len(sids)}", file=sys.stderr)

        def work(sid):
            return sid, ch.download(files[sid])

        n_ok = 0
        with cf.ThreadPoolExecutor(WORKERS) as ex:
            futs = [ex.submit(work, s) for s in sids]
            for fut in cf.as_completed(futs):
                try:
                    sid, raw = fut.result()
                    root = parse_xml(raw)
                except Exception as e:  # noqa: BLE001
                    print(f"[{ch.key}] store failed: {e}", file=sys.stderr)
                    continue
                codes, prices, cats = [], [], []
                seen = set()
                for k in parse_items(root):
                    code = norm_code(k.get("itemcode"), ch.key)
                    price = to_float(k.get("itemprice"))
                    if not code or code in seen or price <= 0:
                        continue
                    seen.add(code)
                    info = catalog.get(code)
                    if info is None:
                        name = re.sub(r"\s+", " ", k.get("itemname") or k.get("manufactureritemdescription") or "").strip()
                        if not name:
                            continue
                        typ, qty = base_quantity(k)
                        manu = (k.get("manufacturename") or k.get("manufacturername") or "").strip()
                        if manu in ("לא ידוע", "כללי", "unknown") or not re.search(r"\w", manu):
                            manu = ""
                        info = [name, manu, qty, typ, cat_id(classify(name)), 1 if k.get("bisweighted") == "1" else 0]
                        catalog[code] = info
                    codes.append(code)
                    prices.append(round(price, 2))
                    cats.append(info[4])
                if not codes:
                    continue
                st = stores.get(sid, {})
                store_id = f"{ch.key}-{sid}"
                city = st.get("city", "")
                city = cities.get(city, city) if city.isdigit() else city
                if city.isdigit():
                    city = ""
                with open(os.path.join(out, "store", store_id + ".json"), "w", encoding="utf-8") as f:
                    json.dump({"c": codes, "p": prices, "k": cats}, f, ensure_ascii=False, separators=(",", ":"))
                stores_out.append({"id": store_id, "chain": ch.key, "chainName": ch.name,
                                   "name": st.get("name") or f"סניף {sid}", "sub": st.get("sub", ""),
                                   "address": st.get("address", ""), "city": city, "n": len(codes)})
                n_ok += 1
        meta["chains"].append({"key": ch.key, "name": ch.name, "ok": n_ok > 0, "stores": n_ok,
                               "seconds": round(time.time() - t0)})
        print(f"[{ch.key}] done: {n_ok} stores in {time.time() - t0:.0f}s, catalog={len(catalog)}", file=sys.stderr)

    # חלוקת הקטלוג לקבצים לפי קטגוריה (כדי שהדפדפן יטען רק את מה שצריך)
    sizes = {}
    for info in catalog.values():
        sizes[info[4]] = sizes.get(info[4], 0) + 1
    target = 1500
    bucket_of, buckets, cur, cur_n = {}, [], [], 0
    for cid, n in sorted(sizes.items(), key=lambda x: -x[1]):
        if cur and cur_n + n > target:
            buckets.append(cur)
            cur, cur_n = [], 0
        cur.append(cid)
        cur_n += n
    if cur:
        buckets.append(cur)
    for b, cids in enumerate(buckets):
        for cid in cids:
            bucket_of[cid] = b
    files = [{} for _ in buckets]
    for code, info in catalog.items():
        files[bucket_of[info[4]]][code] = info
    for old in os.listdir(os.path.join(out, "catalog")):
        os.remove(os.path.join(out, "catalog", old))
    for b, data in enumerate(files):
        with open(os.path.join(out, "catalog", f"b{b}.json"), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))

    cats = [None] * len(cat_index)
    for k, i in cat_index.items():
        cats[i] = [k, bucket_of.get(i, 0)]
    with open(os.path.join(out, "cats.json"), "w", encoding="utf-8") as f:
        json.dump(cats, f, ensure_ascii=False, separators=(",", ":"))

    stores_out.sort(key=lambda s: (s["chainName"], s["city"], s["name"]))
    with open(os.path.join(out, "stores.json"), "w", encoding="utf-8") as f:
        json.dump(stores_out, f, ensure_ascii=False, separators=(",", ":"))
    meta["stores"] = len(stores_out)
    meta["products"] = len(catalog)
    with open(os.path.join(out, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    print(f"total: {len(stores_out)} stores, {len(catalog)} products, {len(buckets)} catalog files", file=sys.stderr)
    if not stores_out:
        sys.exit("no data fetched")


if __name__ == "__main__":
    main()
