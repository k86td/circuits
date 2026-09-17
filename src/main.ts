import "./style.css";
import { App } from "./ui/app";
import { Editor } from "./ui/editor";
import { setupPanels } from "./ui/panels";
import { Renderer } from "./ui/renderer";

const app = new App();
const canvas = document.querySelector<HTMLCanvasElement>("#canvas")!;
const renderer = new Renderer(app);
const editor = new Editor(app, canvas, renderer);
setupPanels(app, editor);

if (!app.restoreAutosave()) {
  app.loadExample("divider");
}
editor.zoomToFit();
app.setRunning(true);

// Exposé pour le débogage dans la console
(window as unknown as { app: App; editor: Editor }).app = app;
(window as unknown as { app: App; editor: Editor }).editor = editor;
