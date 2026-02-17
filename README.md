# GifFavCache

A plugin for [Equicord](https://github.com/Equicord/Equicord) / [Vencord](https://github.com/Vendicated/Vencord) that caches your favorited GIFs locally so they load instantly instead of re-fetching from Discord's CDN every time.


---

## ✨ Features

- **Instant loading** — GIFs load from local memory on subsequent opens, zero network wait
- **Persistent cache** — survives Discord restarts via IndexedDB (stored in your browser profile)
- **Auto-preload on startup** — all your favorites are cached 5 seconds after Discord launches
- **Real-time caching** — newly favorited GIFs are cached immediately when you heart them
- **Cross-device sync** — listens to `USER_SETTINGS_PROTO_UPDATE` so favorites added on mobile/another device get cached too
- **Auto-refresh** — periodically re-reads your favorites list to catch anything new
- **Cache inspector** — built-in UI in plugin settings showing every cached GIF, its size, when it was cached, and buttons to delete individual entries or wipe the whole cache

---

## 📦 Installation

### Prerequisites

- [Git](https://git-scm.com/download/win)
- [Node.js](https://nodejs.org/) v18+
- [pnpm](https://pnpm.io/) — install with `npm install -g pnpm` or `corepack enable`

### Steps

**1. Clone Equicord**
```bash
git clone https://github.com/Equicord/Equicord
cd Equicord
```

**2. Install dependencies**
```bash
pnpm install
```

**3. Add the plugin**

Copy the `GifFavCache` folder into `src/userplugins/`:
```
Equicord/
└── src/
    └── userplugins/
        └── GifFavCache/
            └── index.tsx   ← this file
```


**4. Build and inject**
```bash
pnpm build
pnpm inject
```

Select your Discord install when prompted (Stable / PTB / Canary).

**5. Restart Discord**

Fully quit Discord (right-click tray icon → Quit) and relaunch it.

**7. Enable the plugin**

Go to **Settings → Plugins → GifFavCache** and toggle it on.

---

## ⚙️ Settings

All settings are in **Settings → Plugins → GifFavCache**:

| Setting | Default | Description |
|---|---|---|
| Preload on startup | `true` | Cache all favorites 5s after Discord launches |
| Refresh interval | `30` min | How often to re-scan favorites. Set to `0` to disable |
| Max cache entries | `200` | IndexedDB entry limit — oldest are pruned automatically |

Below the settings you'll find the **Cache Inspector**:

- Shows total GIF count and total storage size
- Lists every cached entry with filename, size, and cache date
- **↻ Refresh** — reload the list from IndexedDB
- **🗑 Clear All** — wipe the entire cache (GIFs will re-download next time)
- **✕** per row — delete a single entry

---

## 🗂 Where is the database?

The cache lives in **IndexedDB** inside Discord's Electron browser context. You can inspect it directly:

1. Open Discord DevTools: `Ctrl+Shift+I`
2. Go to **Application** tab
3. Expand **IndexedDB** in the left sidebar
4. Look for **`EquicordGifFavCache`** → **`gifs`**

Each entry stores the GIF blob, its URL, and a timestamp.

> You can also just use the Cache Inspector in the plugin settings — it's easier than DevTools.

---

## ⚠️ Known limitations

- **Tenor proxy URLs** (`images-ext-1.discordapp.net`) are intentionally skipped — Discord's CDN proxy for Tenor blocks cross-origin fetches. Direct Tenor URLs (`media.tenor.com`) and Discord attachment GIFs cache fine.
- **Expired attachment URLs** — Discord CDN attachment URLs contain expiry tokens (`?ex=...`). If a URL has expired before it was cached, it will fail silently and retry on the next refresh cycle.
- **Webpack patches** are not used — the plugin caches in the background and preloads into memory. It does not intercept Discord's renderer, so there's no risk of breaking Discord's UI.

---

## 🔧 Updating after a Discord build update

Discord periodically rebuilds its frontend. If the plugin stops working:

1. Check the DevTools console for `[GifFavCache]` errors
2. The most likely breakage is `UserSettingsProtoStore` being renamed — run this in the console to find it:
   ```js
   Vencord.Webpack.findAll(m => m?.getName?.()?.includes?.("UserSettings")).map(m => [m.getName(), Object.getOwnPropertyNames(Object.getPrototypeOf(m))])
   ```
3. DM me on discord under ns5h with the new name(i dont check this very often)

---

## 📄 License

MIT
