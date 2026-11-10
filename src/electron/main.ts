// Aplicación de escritorio: arranca el servidor local y lo muestra en una ventana.
import path from "node:path";
import { app, BrowserWindow, dialog, shell } from "electron";
import { startServer, type SoundToolServer } from "../server/index.ts";

// El juego tiene que poder sonar sin que el usuario haga clic antes
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

let server: SoundToolServer | undefined;
let win: BrowserWindow | undefined;

async function createWindow(): Promise<void> {
    const window = new BrowserWindow({
        width: 1500,
        height: 920,
        minWidth: 1000,
        minHeight: 640,
        title: "SoundTool",
        backgroundColor: "#101114",
        webPreferences: { contextIsolation: true, sandbox: true },
    });
    win = window;

    try {
        server ??= await startServer({
            port: 0,
            pickFolder: async (prompt) => {
                const r = await dialog.showOpenDialog(window, { title: prompt, properties: ["openDirectory"] });
                return r.canceled ? null : (r.filePaths[0] ?? null);
            },
        });
    } catch (err) {
        dialog.showErrorBox("SoundTool no pudo arrancar", String((err as Error)?.stack ?? err));
        app.quit();
        return;
    }
    const origin = server.url.replace(/\/__soundtool\/$/, "");

    // Enlaces externos en el navegador del sistema, no dentro de la app
    window.webContents.setWindowOpenHandler(({ url }) => {
        if (!url.startsWith(origin)) void shell.openExternal(url);
        return { action: "deny" };
    });

    // «Exportar .zip»: preguntar dónde guardarlo y mostrarlo al terminar
    window.webContents.session.on("will-download", (_event, item) => {
        item.setSaveDialogOptions({
            title: "Guardar los cambios de sonido",
            defaultPath: path.join(app.getPath("downloads"), item.getFilename()),
            buttonLabel: "Guardar",
        });
        item.once("done", (_e, state) => {
            if (state === "completed") shell.showItemInFolder(item.getSavePath());
        });
    });

    // La página bloquea el cierre si hay cambios sin guardar; en Electron hay que preguntar nosotros
    window.webContents.on("will-prevent-unload", (event) => {
        const choice = dialog.showMessageBoxSync(window, {
            type: "warning",
            buttons: ["Salir sin guardar", "Cancelar"],
            defaultId: 1,
            cancelId: 1,
            message: "Hay cambios de sonido sin guardar ni exportar.",
            detail: "Si sales ahora se perderán esos cambios.",
        });
        if (choice === 0) event.preventDefault(); // ignora el bloqueo y cierra
    });

    await window.loadURL(server.url);
}

// Una sola ventana: si la abren otra vez, se enfoca la que ya está
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on("second-instance", () => {
        if (!win) return;
        if (win.isMinimized()) win.restore();
        win.focus();
    });
    void app.whenReady().then(createWindow);
}

app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && app.isReady()) void createWindow();
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => server?.close());
