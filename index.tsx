import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { findStoreLazy } from "@webpack";
import { FluxDispatcher, React } from "@webpack/common";

// ─── Constants ────────────────────────────────────────────────────────────────

const DB_NAME = "EquicordGifFavCache";
const DB_VERSION = 1;
const STORE_NAME = "gifs";

const MEMORY_CACHE = new Map<string, string>();
const REVERSE_CACHE = new Map<string, string>();

// ─── Settings ─────────────────────────────────────────────────────────────────

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
        description: "Max GIFs to keep in IndexedDB. Oldest are pruned automatically.",
        default: 200,
        restartNeeded: false,
    },
});

// ─── IndexedDB helpers ────────────────────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, { keyPath: "url" });
                store.createIndex("cachedAt", "cachedAt", { unique: false });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function dbGet(url: string): Promise<{ url: string; blob: Blob; cachedAt: number } | undefined> {
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
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, "readwrite");
            tx.objectStore(STORE_NAME).put({ url, blob, cachedAt: Date.now() });
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

async function dbGetAll(): Promise<{ url: string; blob: Blob; cachedAt: number }[]> {
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

// ─── Cache Inspector Component ────────────────────────────────────────────────

interface CacheEntry { url: string; size: number; cachedAt: number; }

function CacheInspector() {
    const [entries, setEntries] = React.useState<CacheEntry[]>([]);
    const [loading, setLoading] = React.useState(false);
    const [clearing, setClearing] = React.useState(false);
    const [status, setStatus] = React.useState<string | null>(null);

    const totalSize = entries.reduce((acc, e) => acc + e.size, 0);

    async function load() {
        setLoading(true);
        setStatus(null);
        const all = await dbGetAll();
        setEntries(all.map(e => ({ url: e.url, size: e.blob.size, cachedAt: e.cachedAt }))
            .sort((a, b) => b.cachedAt - a.cachedAt));
        setLoading(false);
    }

    async function clearCache() {
        if (!confirm("Clear the entire GIF cache? This will re-download GIFs next time you open your favorites.")) return;
        setClearing(true);
        await dbClearAll();
        for (const objUrl of MEMORY_CACHE.values()) URL.revokeObjectURL(objUrl);
        MEMORY_CACHE.clear();
        REVERSE_CACHE.clear();
        setEntries([]);
        setClearing(false);
        setStatus("✅ Cache cleared!");
    }

    async function deleteEntry(url: string) {
        await dbDelete(url);
        const objUrl = MEMORY_CACHE.get(url);
        if (objUrl) { URL.revokeObjectURL(objUrl); REVERSE_CACHE.delete(objUrl); MEMORY_CACHE.delete(url); }
        setEntries(prev => prev.filter(e => e.url !== url));
        setStatus(`🗑️ Deleted 1 entry`);
    }

    React.useEffect(() => { load(); }, []);

    const styles: Record<string, React.CSSProperties> = {
        wrap: { fontFamily: "monospace", fontSize: 12, color: "var(--text-normal)" },
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
            <div style={styles.header}>
                <span style={styles.badge}>{entries.length} GIFs cached</span>
                <span style={styles.badge}>{formatBytes(totalSize)} total</span>
                <button style={styles.btn} onClick={load} disabled={loading}>
                    {loading ? "Loading…" : "↻ Refresh"}
                </button>
                <button style={styles.btnDanger} onClick={clearCache} disabled={clearing || entries.length === 0}>
                    {clearing ? "Clearing…" : "🗑 Clear All"}
                </button>
                {status && <span style={styles.status}>{status}</span>}
            </div>

            {entries.length === 0 && !loading
                ? <div style={styles.empty}>No cached GIFs yet. Enable the plugin and open your GIF picker!</div>
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

// ─── Core cache logic ─────────────────────────────────────────────────────────

function isCacheable(url: string): boolean {
    if (!url || url.startsWith("blob:")) return false;
    if (url.includes("images-ext-1.discordapp.net") || url.includes("images-ext-2.discordapp.net")) return false;
    return true;
}

async function cacheGif(url: string): Promise<string | null> {
    if (!isCacheable(url)) return null;
    const fetchUrl = url.startsWith("//") ? "https:" + url : url;

    if (MEMORY_CACHE.has(fetchUrl)) return MEMORY_CACHE.get(fetchUrl)!;

    const dbEntry = await dbGet(fetchUrl);
    if (dbEntry?.blob) {
        const objUrl = URL.createObjectURL(dbEntry.blob);
        MEMORY_CACHE.set(fetchUrl, objUrl);
        REVERSE_CACHE.set(objUrl, fetchUrl);
        return objUrl;
    }

    try {
        const res = await fetch(fetchUrl, { mode: "cors" });
        if (!res.ok) return null;
        const blob = await res.blob();
        await dbPut(fetchUrl, blob);
        await pruneCache();
        const objUrl = URL.createObjectURL(blob);
        MEMORY_CACHE.set(fetchUrl, objUrl);
        REVERSE_CACHE.set(objUrl, fetchUrl);
        console.log("[GifFavCache] Cached:", fetchUrl);
        return objUrl;
    } catch (e) {
        console.warn("[GifFavCache] Failed to cache:", fetchUrl, e);
        return null;
    }
}

async function pruneCache(): Promise<void> {
    const max = settings.store.maxCacheEntries;
    const all = await dbGetAll();
    if (all.length <= max) return;
    all.sort((a, b) => a.cachedAt - b.cachedAt);
    const toDelete = all.slice(0, all.length - max);
    for (const entry of toDelete) {
        await dbDelete(entry.url);
        const objUrl = MEMORY_CACHE.get(entry.url);
        if (objUrl) { URL.revokeObjectURL(objUrl); REVERSE_CACHE.delete(objUrl); MEMORY_CACHE.delete(entry.url); }
    }
}

// ─── Favorite GIF discovery ───────────────────────────────────────────────────

const UserSettingsProtoStore = findStoreLazy("UserSettingsProtoStore");

function getFavoriteGifSrcUrls(): string[] {
    try {
        const gifs = UserSettingsProtoStore?.frecencyWithoutFetchingLatest?.favoriteGifs?.gifs;
        if (!gifs) return [];
        return Object.values(gifs)
            .map((g: any) => g?.src)
            .filter((src): src is string => typeof src === "string" && src.length > 0);
    } catch (e) {
        console.warn("[GifFavCache] Could not read favorites:", e);
        return [];
    }
}

async function preloadAllFavorites(): Promise<void> {
    const urls = getFavoriteGifSrcUrls();
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

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default definePlugin({
    name: "GifFavCache",
    description: "Caches your favorited GIFs locally (memory + IndexedDB) for instant loading.",
    authors: [
        { name: "ns5h", id: 1278368743331991646 },
    ],
    settings,

    // Rendered inside the plugin's settings panel
    settingsAboutComponent: () => <CacheInspector />,

    patches: [],

    resolveUrl(src: string): string {
        if (!src || src.startsWith("blob:")) return src;
        const n = src.startsWith("//") ? "https:" + src : src;
        const cached = MEMORY_CACHE.get(n);
        if (cached) return cached;
        cacheGif(n).catch(console.error);
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
            if (src) { console.log("[GifFavCache] New favorite, caching:", src); cacheGif(src).catch(console.error); }
        };

        this._onProtoUpdate = () => {
            for (const url of getFavoriteGifSrcUrls()) {
                const n = url.startsWith("//") ? "https:" + url : url;
                if (!MEMORY_CACHE.has(n)) cacheGif(url).catch(console.error);
            }
        };

        FluxDispatcher.subscribe("FAVORITE_GIF_ADDED", this._onFavAdded);
        FluxDispatcher.subscribe("USER_SETTINGS_PROTO_UPDATE", this._onProtoUpdate);

        if (settings.store.preloadOnStartup) setTimeout(() => preloadAllFavorites(), 5000);
        startAutoRefresh();
        console.log("[GifFavCache] Started.");
    },

    stop() {
        if (this._onFavAdded) FluxDispatcher.unsubscribe("FAVORITE_GIF_ADDED", this._onFavAdded);
        if (this._onProtoUpdate) FluxDispatcher.unsubscribe("USER_SETTINGS_PROTO_UPDATE", this._onProtoUpdate);
        stopAutoRefresh();
        for (const objUrl of MEMORY_CACHE.values()) URL.revokeObjectURL(objUrl);
        MEMORY_CACHE.clear();
        REVERSE_CACHE.clear();
        console.log("[GifFavCache] Stopped.");
    },
});
