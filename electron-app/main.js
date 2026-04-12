const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

// Start the multiplayer server embedded in Electron
const gameDir = path.join(__dirname, '..');
const serverModule = require(path.join(gameDir, 'server.js'));
const SERVER_PORT = 3000;
let gameServer = null;

let mainWindow;

function createWindow() {
    // Start server before loading the game
    if (!gameServer) {
        gameServer = serverModule.start(SERVER_PORT, gameDir);
    }

    mainWindow = new BrowserWindow({
        width: 1280,
        height: 720,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: false,
            enableRemoteModule: false
        }
    });

    // Load from the local server so WebSocket works on same origin
    mainWindow.loadURL('http://localhost:' + SERVER_PORT);

    // Show dev tools on Windows for debugging
    if (process.platform === 'win32') {
        mainWindow.webContents.openDevTools();
    }

    mainWindow.on('closed', function () {
        mainWindow = null;
    });
}

// Add stub handlers for IPC calls that preload.js exposes but aren't used by the game
// This prevents errors when preload.js tries to set up these APIs
ipcMain.handle('auth:register', () => ({ error: 'Not implemented' }));
ipcMain.handle('auth:login', () => ({ error: 'Not implemented' }));
ipcMain.handle('auth:get-current-user', () => ({ error: 'Not implemented' }));
ipcMain.handle('auth:logout', () => ({ error: 'Not implemented' }));
ipcMain.handle('games:get-store', () => ({ error: 'Not implemented' }));
ipcMain.handle('games:get-game-details', () => ({ error: 'Not implemented' }));
ipcMain.handle('games:get-installed', () => ({ error: 'Not implemented' }));
ipcMain.handle('games:install', () => ({ error: 'Not implemented' }));
ipcMain.handle('games:uninstall', () => ({ error: 'Not implemented' }));
ipcMain.handle('games:launch', () => ({ error: 'Not implemented' }));
ipcMain.handle('games:upload-game', () => ({ error: 'Not implemented' }));
ipcMain.handle('games:select-game-folder', () => ({ error: 'Not implemented' }));
ipcMain.handle('games:select-executable', () => ({ error: 'Not implemented' }));

app.on('ready', createWindow);

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', function () {
    if (mainWindow === null) {
        createWindow();
    }
});
