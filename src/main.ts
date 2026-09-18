import "./style.css";
import "./ui/material";
import { theme } from "./ui/theme";
import { App } from "./ui/app";
import { setupCommands } from "./ui/commands";
import { $ } from "./ui/dom";
import { Editor } from "./ui/editor";
import { hydrateIcons } from "./ui/icons";
import { Keymap } from "./ui/keys";
import { Layout } from "./ui/layout";
import { setupPanels } from "./ui/panels";
import { Renderer } from "./ui/renderer";

theme.apply();
hydrateIcons();
const app = new App();
const canvas = document.querySelector<HTMLCanvasElement>("#canvas")!;
const renderer = new Renderer(app);
const editor = new Editor(app, canvas, renderer);
setupPanels(app, editor);
const layout = new Layout();
const keymap = new Keymap($("#workspace"));
editor.keymap = keymap;
setupCommands({ app, editor, layout, keymap });

if (!app.restoreAutosave()) {
  app.loadExample("divider");
}
editor.zoomToFit();
app.setRunning(true);

// Exposé pour le débogage dans la console
Object.assign(window as unknown as Record<string, unknown>, { app, editor, layout, theme, keymap });
