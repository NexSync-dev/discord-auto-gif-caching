import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { findStoreLazy } from "@webpack";
import { FluxDispatcher } from "@webpack/common";

// ─── Constants ────────────────────────────────────────────────────────────────

const DB_NAME = "EquicordGifFavCache";
const DB_VERSION = 1;
const STORE_NAME = "gifs";

/** In-memory cache: src URL → blob object URL */
const MEMORY_CACHE = new Map<string, string>();
/** Reverse map: blob object URL → original src URL */
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

async function dbGetAllWithTimestamps(): Promise<{ url: string; cachedAt: number }[]> {
    try {
        const db = await openDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, "readonly");
            const req = tx.objectStore(STORE_NAME).getAll();
            req.onsuccess = () => resolve((req.result as any[]).map(r => ({ url: r.url, cachedAt: r.cachedAt })));
            req.onerror = () => reject(req.error);
        });
    } catch { return []; }
}

// ─── Core cache logic ─────────────────────────────────────────────────────────

function isCacheable(url: string): boolean {
    if (!url || url.startsWith("blob:")) return false;
    // images-ext-1.discordapp.net is Discord's Tenor proxy — it blocks CORS fetches
    // so we skip it. Direct media.tenor.com, media.discordapp.net etc. work fine.
    if (url.includes("images-ext-1.discordapp.net") || url.includes("images-ext-2.discordapp.net")) return false;
    return true;
}

async function cacheGif(url: string): Promise<string | null> {
    if (!isCacheable(url)) return null;

    // Normalize protocol-relative URLs (e.g. //media.tenor.com/...)
    const fetchUrl = url.startsWith("//") ? "https:" + url : url;

    // 1. Memory hit — instant
    if (MEMORY_CACHE.has(fetchUrl)) return MEMORY_CACHE.get(fetchUrl)!;

    // 2. IndexedDB hit — no network needed
    const dbEntry = await dbGet(fetchUrl);
    if (dbEntry?.blob) {
        const objUrl = URL.createObjectURL(dbEntry.blob);
        MEMORY_CACHE.set(fetchUrl, objUrl);
        REVERSE_CACHE.set(objUrl, fetchUrl);
        return objUrl;
    }

    // 3. Network fetch → store in both layers
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
    const all = await dbGetAllWithTimestamps();
    if (all.length <= max) return;
    all.sort((a, b) => a.cachedAt - b.cachedAt);
    const toDelete = all.slice(0, all.length - max);
    for (const entry of toDelete) {
        await dbDelete(entry.url);
        const objUrl = MEMORY_CACHE.get(entry.url);
        if (objUrl) {
            URL.revokeObjectURL(objUrl);
            REVERSE_CACHE.delete(objUrl);
            MEMORY_CACHE.delete(entry.url);
        }
    }
}

// ─── Favorite GIF discovery ───────────────────────────────────────────────────
// Discord stores favorites in:
//   UserSettingsProtoStore.frecencyWithoutFetchingLatest.favoriteGifs.gifs
// Each entry is keyed by the Tenor page URL and has a `src` field with the media URL.

const UserSettingsProtoStore = findStoreLazy("UserSettingsProtoStore");

function getFavoriteGifSrcUrls(): string[] {
    try {
        const frecency = UserSettingsProtoStore?.frecencyWithoutFetchingLatest;
        const gifs = frecency?.favoriteGifs?.gifs;
        if (!gifs) return [];

        return Object.values(gifs)
            .map((g: any) => g?.src)
            .filter((src): src is string => typeof src === "string" && src.length > 0);
    } catch (e) {
        console.warn("[GifFavCache] Could not read favorites:", e);
        return [];
    }
}

// ─── Preload & refresh ────────────────────────────────────────────────────────

async function preloadAllFavorites(): Promise<void> {
    const urls = getFavoriteGifSrcUrls();
    if (!urls.length) {
        console.log("[GifFavCache] No favorites found yet.");
        return;
    }
    console.log(`[GifFavCache] Preloading ${urls.length} favorited GIFs...`);
    const BATCH = 4;
    for (let i = 0; i < urls.length; i += BATCH) {
        await Promise.allSettled(urls.slice(i, i + BATCH).map(cacheGif));
    }
    console.log("[GifFavCache] Preload complete.");
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;

function startAutoRefresh(): void {
    stopAutoRefresh();
    const mins = settings.store.refreshIntervalMinutes;
    if (!mins || mins <= 0) return;
    refreshTimer = setInterval(() => preloadAllFavorites(), mins * 60_000);
}

function stopAutoRefresh(): void {
    if (refreshTimer !== null) { clearInterval(refreshTimer); refreshTimer = null; }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default definePlugin({
    name: "GifFavCache",
    description: "Caches your favorited GIFs locally (memory + IndexedDB) so they load instantly.",
    authors: [
        // Replace 0n with your Discord user ID as a BigInt e.g. 123456789012345678n
        // Right-click your name in Discord (with Developer Mode on) → Copy User ID
        { name: "You", id: 0n },
    ],
    settings,

    patches: [],

    /** Returns cached blob URL if available, otherwise original. Used manually, not via patches. */
    resolveUrl(src: string): string {
        if (!src || src.startsWith("blob:")) return src;
        const normalised = src.startsWith("//") ? "https:" + src : src;
        const cached = MEMORY_CACHE.get(normalised);
        if (cached) return cached;
        cacheGif(normalised).catch(console.error);
        return src;
    },

    /** Before sending, resolve blob URLs back to the original CDN URL */
    resolveOriginalUrl(src: string): string {
        if (!src?.startsWith("blob:")) return src;
        return REVERSE_CACHE.get(src) ?? src;
    },

    _onFavAdded: null as any,
    _onProtoUpdate: null as any,

    async start() {
        // Cache any newly favorited GIF immediately
        this._onFavAdded = (event: any) => {
            const src = event?.gif?.src ?? event?.gif?.url;
            if (src) {
                console.log("[GifFavCache] New favorite, caching:", src);
                cacheGif(src).catch(console.error);
            }
        };

        // Also listen for proto settings updates — Discord fires this when
        // favorites change via sync from another device
        this._onProtoUpdate = () => {
            const newUrls = getFavoriteGifSrcUrls();
            for (const url of newUrls) {
                if (!MEMORY_CACHE.has(url.startsWith("//") ? "https:" + url : url)) {
                    cacheGif(url).catch(console.error);
                }
            }
        };

        FluxDispatcher.subscribe("FAVORITE_GIF_ADDED", this._onFavAdded);
        FluxDispatcher.subscribe("USER_SETTINGS_PROTO_UPDATE", this._onProtoUpdate);

        if (settings.store.preloadOnStartup) {
            // Give Discord 5s to finish loading the proto store before reading it
            setTimeout(() => preloadAllFavorites(), 5000);
        }

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
