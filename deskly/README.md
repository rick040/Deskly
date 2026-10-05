# Deskly

A tiny desktop layer for Windows: fences (app groups), minimal widgets, and live web panels (Notion etc.). Built with Tauri, so the installer is small and it idles at low RAM.

## Use it
- It sits behind your windows like wallpaper. Tray icon (bottom right) > **Edit layout**, or the faint gear in the bottom-right corner.
- In edit mode: drag a header to move, drag the corner to resize, top bar adds fences/widgets, `+` in a fence picks installed apps, you can also drag files/shortcuts from Explorer into a fence.
- Click an item (outside edit mode) to launch it. Tray icon > **Quit Deskly** to close.
- Layout is saved automatically in `%APPDATA%\app.deskly.desktop\layout.json`.

## Get the .exe without installing anything
Push this folder to a GitHub repo, open Actions > "Build Windows installer" > Run workflow, download the `Deskly-installer` artifact.

## Build it yourself
Needs Node 20+, Rust (rustup), Visual Studio Build Tools (C++), WebView2 (already on Windows 11).

    npm install
    npm run dev      # run live
    npm run build    # installer in src-tauri/target/release/bundle/nsis

## Known v1 limits
- Win+D (show desktop) hides it like any window; it is not parented to the wallpaper layer yet.
- Web panels sit above fences/widgets (native views), so don't overlap them.
- Google sign-in is blocked inside embedded views; use Notion email/password or a login link.
- App picker lists Start Menu shortcuts (incl. Chrome Apps), not Store/UWP apps; drag those in manually.
