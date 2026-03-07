# GifFavCache

Equicord/Vencord plugin that caches your favorited GIFs locally. Opens from memory instead of hitting Discord's CDN every time.

---

## What it does

Fetches all your favorited GIFs in the background and stores them in IndexedDB. Next time you open the GIF picker, they're already there. New favorites get cached as soon as you heart them, and it listens to `USER_SETTINGS_PROTO_UPDATE` so favorites from other devices sync too.

The plugin settings page has a cache inspector where you can see what's cached, how much space it's using, and delete individual entries or nuke everything.

---

## Installation

You'll need [Git](https://git-scm.com/download/win), [Node.js](https://nodejs.org/) v18+, and [pnpm](https://pnpm.io/).

```bash
git clone https://github.com/Equicord/Equicord
cd Equicord
pnpm install
```

Drop the `GifFavCache` folder into `src/userplugins/`, then:

```bash
pnpm build
pnpm inject
```

Fully restart Discord, then enable the plugin under **Settings → Plugins → GifFavCache**.

---

## Settings

| Setting | Default | Description |
|---|---|---|
| Preload on startup | `true` | Cache all favorites 5s after launch |
| Refresh interval | `30` min | Re-scan favorites periodically. `0` to disable |
| Max cache entries | `200` | Oldest entries are pruned when the limit is hit |

---

## Caveats

Tenor proxy URLs (`images-ext-1.discordapp.net`) are skipped because Discord's proxy blocks cross-origin fetches. Direct Tenor URLs (`media.tenor.com`) and Discord attachment GIFs work fine.

CDN attachment URLs have expiry tokens (`?ex=...`). If one expires before it gets cached, it'll fail silently and retry on the next refresh.

---

## If it breaks after a Discord update

Discord rebuilds its frontend occasionally. Check the DevTools console for `[GifFavCache]` errors. Most likely `UserSettingsProtoStore` got renamed — run this to find it:

```js
Vencord.Webpack.findAll(m => m?.getName?.()?.includes?.("UserSettings")).map(m => [m.getName(), Object.getOwnPropertyNames(Object.getPrototypeOf(m))])
```

DM `ns5h` on Discord with the new name. I don't check it that often.

---

MIT

---

## Features

GIFs load from local memory on subsequent opens. The cache persists across Discord restarts via IndexedDB and is preloaded 5 seconds after Discord launches. Newly favorited GIFs are cached immediately when you heart them. The plugin also listens to `USER_SETTINGS_PROTO_UPDATE`, so favorites added on mobile or another device get cached too, and it periodically re-reads your favorites list to catch anything new.

The plugin settings include a cache inspector showing every cached GIF, its size, when it was cached, and buttons to delete individual entries or wipe the whole cache.

---

## Installation

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
            └── index.tsx
```

**4. Build and inject**
```bash
pnpm build
pnpm inject
```

Select your Discord install when prompted (Stable / PTB / Canary).

**5. Restart Discord**

Fully quit Discord (right-click tray icon → Quit) and relaunch it.

**6. Enable the plugin**

Go to **Settings → Plugins → GifFavCache** and toggle it on.

---

## Settings

All settings are in **Settings → Plugins → GifFavCache**:

| Setting | Default | Description |
|---|---|---|
| Preload on startup | `true` | Cache all favorites 5s after Discord launches |
| Refresh interval | `30` min | How often to re-scan favorites. Set to `0` to disable |
| Max cache entries | `200` | IndexedDB entry limit — oldest are pruned automatically |

Below the settings is the cache inspector: total GIF count, total storage size, and a list of every cached entry with filename, size, and cache date. The **↻ Refresh** button reloads the list from IndexedDB, **🗑 Clear All** wipes the entire cache, and the **✕** button on each row deletes a single entry.

---

## Where is the database?

The cache lives in IndexedDB inside Discord's Electron browser context. To inspect it directly:

1. Open Discord DevTools: `Ctrl+Shift+I`
2. Go to the **Application** tab
3. Expand **IndexedDB** in the left sidebar
4. Look for **`EquicordGifFavCache`** → **`gifs`**

Each entry stores the GIF blob, its URL, and a timestamp. The cache inspector in plugin settings is easier for day-to-day use.

---

## Known limitations

- Tenor proxy URLs (`images-ext-1.discordapp.net`) are skipped. Discord's CDN proxy for Tenor blocks cross-origin fetches. Direct Tenor URLs (`media.tenor.com`) and Discord attachment GIFs cache fine.
- Discord CDN attachment URLs contain expiry tokens (`?ex=...`). If a URL expired before it was cached, it fails silently and retries on the next refresh cycle.
- The plugin caches in the background and preloads into memory. It does not patch Discord's webpack or intercept the renderer.

---

## If the plugin breaks after a Discord update

Discord periodically rebuilds its frontend. If things stop working:

1. Check the DevTools console for `[GifFavCache]` errors
2. The most likely cause is `UserSettingsProtoStore` being renamed. Run this in the console to find it:
   ```js
   Vencord.Webpack.findAll(m => m?.getName?.()?.includes?.("UserSettings")).map(m => [m.getName(), Object.getOwnPropertyNames(Object.getPrototypeOf(m))])
   ```
3. DM me on Discord at `ns5h` with the new name (I don't check this very often)

---

## Preview

![Plugin Preview](./proof.png)

## License

MIT
