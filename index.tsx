import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { findStoreLazy } from "@webpack";
import { FluxDispatcher, React } from "@webpack/common";

const DB_NAME = "EquicordGifFavCache";
const DB_VERSION = 2;
const STORE_NAME = "gifs";

const MEMORY_CACHE = new Map<string, string>();
const REVERSE_CACHE = new Map<string, string>();
const FAVORITE_KEYS = new Set<string>();
const LAST_ACCESS = new Map<string, number>();

const settings = definePluginSettings({
    preloadOnStartup: {
        type: OptionType.BOOLEAN,
        description: "Preload all favorited GIFs into cache when Discord starts.",
        default: true,
        restartNeeded: false,
    },
    refreshIntervalMinutes: {
        type: OptionType.NUMBER,
        description: "How often to re-cache favorites (minutes). Set to 0 to disable.",
        default: 30,
        restartNeeded: false,
    },
    maxCacheEntries: {
        type: OptionType.NUMBER,
        description: "Max GIFs to keep in IndexedDB. Least-recently-used are pruned automatically.",
        default: 200,
        restartNeeded: false,
    },
});

function extractProxiedUrl(url: string): string | null {
    try {
        const u = new URL(url);
        if (!/discordapp\.net$|discord\.com$/.test(u.hostname)) return null;
        const m = u.pathname.match(/\/external\/[^/]+\/(https?)\/(.+)$/);
        if (!m) return null;
        return `${m[1]}://${m[2]}`;
    } catch {
        return null;
    }
}

function normalizeUrl(url: string): string {
    return url.startsWith("//") ? "https:" + url : url;
}

function canonicalUrl(url: string): string {
    const n = normalizeUrl(url);
    return extractProxiedUrl(n) ?? n;
}

function isCacheable(url: string): boolean {
    return !!url && !url.startsWith("blob:") && !url.startsWith("data:");
}

function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            let store: IDBObjectStore;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                store = db.createObjectStore(STORE_NAME, { keyPath: "url" });
            } else {
                store = req.transaction!.objectStore(STORE_NAME);
            }
            if (!store.indexNames.contains("cachedAt")) store.createIndex("cachedAt", "cachedAt", { unique: false });
            if (!store.indexNames.contains("lastAccessed")) store.createIndex("lastAccessed", "lastAccessed", { unique: false });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

interface DbEntry { url: string; blob: Blob; cachedAt: number; lastAccessed: number; }

async function dbGet(url: string): Promise<DbEntry | undefined> {
    try {
        const db = await openDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, "readonly");
            const req = tx.objectStore(STORE_NAME).get(url);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    } catch { return undefined; }
}

async function dbPut(url: string, blob: Blob): Promise<void> {
    try {
        const db = await openDB();
        const now = Date.now();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, "readwrite");
            tx.objectStore(STORE_NAME).put({ url, blob, cachedAt: now, lastAccessed: now });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) { console.error("[GifFavCache] dbPut failed", e); }
}

async function dbDelete(url: string): Promise<void> {
    try {
        const db = await openDB();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, "readwrite");
            tx.objectStore(STORE_NAME).delete(url);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch { }
}

async function dbGetAll(): Promise<DbEntry[]> {
    try {
        const db = await openDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, "readonly");
            const req = tx.objectStore(STORE_NAME).getAll();
            req.onsuccess = () => resolve(req.result as any[]);
            req.onerror = () => reject(req.error);
        });
    } catch { return []; }
}

async function dbClearAll(): Promise<void> {
    try {
        const db = await openDB();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, "readwrite");
            tx.objectStore(STORE_NAME).clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) { console.error("[GifFavCache] dbClearAll failed", e); }
}

function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatDate(ts: number): string {
    return new Date(ts).toLocaleString();
}

function touch(key: string) {
    LAST_ACCESS.set(key, Date.now());
}

async function cacheGif(rawUrl: string): Promise<string | null> {
    if (!isCacheable(rawUrl)) return null;
    const key = canonicalUrl(rawUrl);

    if (MEMORY_CACHE.has(key)) { touch(key); return MEMORY_CACHE.get(key)!; }

    const dbEntry = await dbGet(key);
    if (dbEntry?.blob) {
        const objUrl = URL.createObjectURL(dbEntry.blob);
        MEMORY_CACHE.set(key, objUrl);
        REVERSE_CACHE.set(objUrl, key);
        touch(key);
        return objUrl;
    }

    try {
        const res = await fetch(key, { mode: "cors" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        await dbPut(key, blob);
        await pruneCache();
        const objUrl = URL.createObjectURL(blob);
        MEMORY_CACHE.set(key, objUrl);
        REVERSE_CACHE.set(objUrl, key);
        touch(key);
        console.log("[GifFavCache] Cached:", key);
        swapAllMatchingElements(key, objUrl);
        return objUrl;
    } catch (e) {
        console.warn("[GifFavCache] Failed to cache:", key, e);
        return null;
    }
}

async function pruneCache(): Promise<void> {
    const max = settings.store.maxCacheEntries;
    const all = await dbGetAll();
    if (all.length <= max) return;
    all.sort((a, b) => (LAST_ACCESS.get(a.url) ?? a.lastAccessed) - (LAST_ACCESS.get(b.url) ?? b.lastAccessed));
    const toDelete = all.slice(0, all.length - max);
    for (const entry of toDelete) {
        await dbDelete(entry.url);
        const objUrl = MEMORY_CACHE.get(entry.url);
        if (objUrl) { URL.revokeObjectURL(objUrl); REVERSE_CACHE.delete(objUrl); MEMORY_CACHE.delete(entry.url); }
        LAST_ACCESS.delete(entry.url);
    }
}

const UserSettingsProtoStore = findStoreLazy("UserSettingsProtoStore");

function getFavoriteGifRawUrls(): string[] {
    try {
        const gifs = UserSettingsProtoStore?.frecencyWithoutFetchingLatest?.favoriteGifs?.gifs;
        if (!gifs) return [];
        const urls = new Set<string>();
        for (const g of Object.values(gifs) as any[]) {
            if (typeof g?.src === "string" && g.src) urls.add(g.src);
            if (typeof g?.url === "string" && g.url) urls.add(g.url);
        }
        return [...urls];
    } catch (e) {
        console.warn("[GifFavCache] Could not read favorites:", e);
        return [];
    }
}

function refreshFavoriteKeys(urls: string[]) {
    FAVORITE_KEYS.clear();
    for (const url of urls) FAVORITE_KEYS.add(canonicalUrl(url));
}

async function preloadAllFavorites(): Promise<void> {
    const urls = getFavoriteGifRawUrls();
    refreshFavoriteKeys(urls);
    if (!urls.length) { console.log("[GifFavCache] No favorites found yet."); return; }
    console.log(`[GifFavCache] Preloading ${urls.length} favorited GIFs...`);
    const BATCH = 4;
    for (let i = 0; i < urls.length; i += BATCH) {
        await Promise.allSettled(urls.slice(i, i + BATCH).map(cacheGif));
    }
    console.log("[GifFavCache] Preload complete.");
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;
function startAutoRefresh() {
    stopAutoRefresh();
    const mins = settings.store.refreshIntervalMinutes;
    if (!mins || mins <= 0) return;
    refreshTimer = setInterval(() => preloadAllFavorites(), mins * 60_000);
}
function stopAutoRefresh() {
    if (refreshTimer !== null) { clearInterval(refreshTimer); refreshTimer = null; }
}

const TAG_SELECTOR = "img[src], video[src], source[src]";

function trySwapElement(el: Element) {
    const src = el.getAttribute("src");
    if (!src || src.startsWith("blob:") || src.startsWith("data:")) return;

    const key = canonicalUrl(normalizeUrl(src));
    const cached = MEMORY_CACHE.get(key);
    if (cached) {
        if (el.getAttribute("src") !== cached) el.setAttribute("src", cached);
        touch(key);
        return;
    }

    if (FAVORITE_KEYS.has(key)) {
        cacheGif(src).then(objUrl => {
            if (objUrl && el.isConnected && el.getAttribute("src") === src) {
                el.setAttribute("src", objUrl);
            }
        }).catch(() => { });
    }
}

function swapAllMatchingElements(key: string, objUrl: string) {
    document.querySelectorAll(TAG_SELECTOR).forEach(el => {
        const src = el.getAttribute("src");
        if (!src) return;
        if (canonicalUrl(normalizeUrl(src)) === key) el.setAttribute("src", objUrl);
    });
}

let mutationObserver: MutationObserver | null = null;

function startDomWatcher() {
    stopDomWatcher();
    mutationObserver = new MutationObserver(mutations => {
        for (const m of mutations) {
            if (m.type === "attributes" && m.target instanceof Element) {
                trySwapElement(m.target);
            } else if (m.type === "childList") {
                m.addedNodes.forEach(node => {
                    if (!(node instanceof Element)) return;
                    if (node.matches?.(TAG_SELECTOR)) trySwapElement(node);
                    node.querySelectorAll?.(TAG_SELECTOR).forEach(trySwapElement);
                });
            }
        }
    });
    mutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src"],
    });
    document.querySelectorAll(TAG_SELECTOR).forEach(trySwapElement);
}

function stopDomWatcher() {
    mutationObserver?.disconnect();
    mutationObserver = null;
}

interface CacheEntry { url: string; size: number; cachedAt: number; }

function CacheInspector() {
    const [entries, setEntries] = React.useState<CacheEntry[]>([]);
    const [loading, setLoading] = React.useState(false);
    const [clearing, setClearing] = React.useState(false);
    const [preloading, setPreloading] = React.useState(false);
    const [status, setStatus] = React.useState<string | null>(null);
    const [quota, setQuota] = React.useState<{ usage: number; quota: number } | null>(null);

    const totalSize = entries.reduce((acc, e) => acc + e.size, 0);
    const storeFound = !!UserSettingsProtoStore;
    const favoriteCount = FAVORITE_KEYS.size;

    async function load() {
        setLoading(true);
        setStatus(null);
        const all = await dbGetAll();
        setEntries(all.map(e => ({ url: e.url, size: e.blob.size, cachedAt: e.cachedAt }))
            .sort((a, b) => b.cachedAt - a.cachedAt));
        if (navigator.storage?.estimate) {
            const est = await navigator.storage.estimate();
            setQuota({ usage: est.usage ?? 0, quota: est.quota ?? 0 });
        }
        setLoading(false);
    }

    async function clearCache() {
        if (!confirm("Clear the entire GIF cache? This will re-download GIFs next time you view your favorites.")) return;
        setClearing(true);
        await dbClearAll();
        for (const objUrl of MEMORY_CACHE.values()) URL.revokeObjectURL(objUrl);
        MEMORY_CACHE.clear();
        REVERSE_CACHE.clear();
        LAST_ACCESS.clear();
        setEntries([]);
        setClearing(false);
        setStatus("✅ Cache cleared!");
    }

    async function deleteEntry(url: string) {
        await dbDelete(url);
        const objUrl = MEMORY_CACHE.get(url);
        if (objUrl) { URL.revokeObjectURL(objUrl); REVERSE_CACHE.delete(objUrl); MEMORY_CACHE.delete(url); }
        LAST_ACCESS.delete(url);
        setEntries(prev => prev.filter(e => e.url !== url));
        setStatus("🗑️ Deleted 1 entry");
    }

    async function preloadNow() {
        setPreloading(true);
        setStatus(null);
        await preloadAllFavorites();
        await load();
        setPreloading(false);
        setStatus("✅ Preload finished");
    }

    React.useEffect(() => { load(); }, []);

    const styles: Record<string, React.CSSProperties> = {
        wrap: { fontFamily: "monospace", fontSize: 12, color: "var(--text-normal)" },
        diag: { display: "flex", gap: 10, flexWrap: "wrap" as const, marginBottom: 10, fontSize: 11, color: "var(--text-muted)" },
        diagOk: { color: "var(--text-positive)" },
        diagBad: { color: "var(--text-danger)" },
        header: { display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" as const },
        badge: { background: "var(--brand-experiment)", borderRadius: 4, padding: "2px 8px", fontSize: 11, color: "#fff", fontWeight: 700 },
        btn: { background: "var(--button-secondary-background)", border: "none", borderRadius: 4, padding: "4px 12px", color: "var(--text-normal)", cursor: "pointer", fontSize: 12 },
        btnDanger: { background: "var(--button-danger-background)", border: "none", borderRadius: 4, padding: "4px 12px", color: "#fff", cursor: "pointer", fontSize: 12 },
        table: { width: "100%", borderCollapse: "collapse" as const, marginTop: 6 },
        th: { textAlign: "left" as const, padding: "4px 8px", borderBottom: "1px solid var(--background-modifier-accent)", color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase" as const },
        td: { padding: "4px 8px", borderBottom: "1px solid var(--background-modifier-accent)", verticalAlign: "middle" as const },
        url: { maxWidth: 340, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, display: "block", color: "var(--text-link)" },
        status: { color: "var(--text-positive)", marginLeft: "auto", fontSize: 11 },
        empty: { color: "var(--text-muted)", textAlign: "center" as const, padding: 20 },
        scroll: { maxHeight: 320, overflowY: "auto" as const, marginTop: 4 },
    };

    return (
        <div style={styles.wrap}>
            <div style={styles.diag}>
                <span>UserSettingsProtoStore: <b style={storeFound ? styles.diagOk : styles.diagBad}>{storeFound ? "found" : "MISSING (report this!)"}</b></span>
                <span>Favorites detected: <b>{favoriteCount}</b></span>
                <span>DOM watcher: <b style={mutationObserver ? styles.diagOk : styles.diagBad}>{mutationObserver ? "active" : "inactive"}</b></span>
                {quota && <span>Storage used: <b>{formatBytes(quota.usage)}</b> / {formatBytes(quota.quota)}</span>}
            </div>

            <div style={styles.header}>
                <span style={styles.badge}>{entries.length} GIFs cached</span>
                <span style={styles.badge}>{formatBytes(totalSize)} total</span>
                <button style={styles.btn} onClick={load} disabled={loading}>
                    {loading ? "Loading…" : "↻ Refresh"}
                </button>
                <button style={styles.btn} onClick={preloadNow} disabled={preloading}>
                    {preloading ? "Preloading…" : "⬇ Preload Now"}
                </button>
                <button style={styles.btnDanger} onClick={clearCache} disabled={clearing || entries.length === 0}>
                    {clearing ? "Clearing…" : "🗑 Clear All"}
                </button>
                {status && <span style={styles.status}>{status}</span>}
            </div>

            {entries.length === 0 && !loading
                ? <div style={styles.empty}>No cached GIFs yet. Click "Preload Now" or open your GIF picker!</div>
                : (
                    <div style={styles.scroll}>
                        <table style={styles.table}>
                            <thead>
                                <tr>
                                    <th style={styles.th}>URL</th>
                                    <th style={styles.th}>Size</th>
                                    <th style={styles.th}>Cached</th>
                                    <th style={styles.th}></th>
                                </tr>
                            </thead>
                            <tbody>
                                {entries.map(e => (
                                    <tr key={e.url}>
                                        <td style={styles.td}>
                                            <a href={e.url} target="_blank" rel="noreferrer" style={styles.url} title={e.url}>
                                                {e.url.split("/").pop()?.split("?")[0] ?? e.url}
                                            </a>
                                        </td>
                                        <td style={styles.td}>{formatBytes(e.size)}</td>
                                        <td style={styles.td}>{formatDate(e.cachedAt)}</td>
                                        <td style={styles.td}>
                                            <button style={styles.btnDanger} onClick={() => deleteEntry(e.url)}>✕</button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )
            }
        </div>
    );
}

export default definePlugin({
    name: "GifFavCache",
    description: "Caches your favorited GIFs locally (memory + IndexedDB) and swaps them in the moment they'd render, for instant loading.",
    authors: [
        { name: "ns5h", id: 1278368743331991646 },
    ],
    settings,

    settingsAboutComponent: () => <CacheInspector />,

    patches: [],

    resolveUrl(src: string): string {
        if (!src || src.startsWith("blob:")) return src;
        const key = canonicalUrl(normalizeUrl(src));
        const cached = MEMORY_CACHE.get(key);
        if (cached) return cached;
        cacheGif(src).catch(console.error);
        return src;
    },

    resolveOriginalUrl(src: string): string {
        if (!src?.startsWith("blob:")) return src;
        return REVERSE_CACHE.get(src) ?? src;
    },

    _onFavAdded: null as any,
    _onProtoUpdate: null as any,

    async start() {
        this._onFavAdded = (event: any) => {
            const src = event?.gif?.src ?? event?.gif?.url;
            if (src) {
                console.log("[GifFavCache] New favorite, caching:", src);
                FAVORITE_KEYS.add(canonicalUrl(normalizeUrl(src)));
                cacheGif(src).catch(console.error);
            }
        };

        this._onProtoUpdate = () => {
            const urls = getFavoriteGifRawUrls();
            refreshFavoriteKeys(urls);
            for (const url of urls) {
                const key = canonicalUrl(normalizeUrl(url));
                if (!MEMORY_CACHE.has(key)) cacheGif(url).catch(console.error);
            }
        };

        FluxDispatcher.subscribe("FAVORITE_GIF_ADDED", this._onFavAdded);
        FluxDispatcher.subscribe("USER_SETTINGS_PROTO_UPDATE", this._onProtoUpdate);

        startDomWatcher();
        if (settings.store.preloadOnStartup) setTimeout(() => preloadAllFavorites(), 5000);
        startAutoRefresh();
        console.log("[GifFavCache] Started.");
    },

    stop() {
        if (this._onFavAdded) FluxDispatcher.unsubscribe("FAVORITE_GIF_ADDED", this._onFavAdded);
        if (this._onProtoUpdate) FluxDispatcher.unsubscribe("USER_SETTINGS_PROTO_UPDATE", this._onProtoUpdate);
        stopAutoRefresh();
        stopDomWatcher();
        for (const objUrl of MEMORY_CACHE.values()) URL.revokeObjectURL(objUrl);
        MEMORY_CACHE.clear();
        REVERSE_CACHE.clear();
        FAVORITE_KEYS.clear();
        LAST_ACCESS.clear();
        console.log("[GifFavCache] Stopped.");
    },
});
