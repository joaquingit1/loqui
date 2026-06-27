/**
 * @file The Loqui application menu. Electron's default menu titles the app menu
 * "Electron"; this builds a minimal, correctly-branded menu so the macOS menu bar
 * reads "Loqui" (About Loqui / Hide Loqui / Quit Loqui — the role items use
 * `app.name`, which we set to "Loqui") plus the standard Edit/View/Window menus
 * users expect (copy/paste, reload, zoom, minimize). Pure builder — no IO.
 */
import { app, Menu, type MenuItemConstructorOptions } from "electron";

export function buildLoquiMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [];

  if (process.platform === "darwin") {
    template.push({
      // app.name is "Loqui" (set via app.setName), so this + the role items below
      // render as "About Loqui", "Hide Loqui", "Quit Loqui".
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  template.push(
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  );

  return Menu.buildFromTemplate(template);
}
