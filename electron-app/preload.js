const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Authentication
  register: (username, email, password) => ipcRenderer.invoke('auth:register', username, email, password),
  login: (username, password) => ipcRenderer.invoke('auth:login', username, password),
  getCurrentUser: () => ipcRenderer.invoke('auth:get-current-user'),
  logout: () => ipcRenderer.invoke('auth:logout'),

  // Games
  getStoreGames: () => ipcRenderer.invoke('games:get-store'),
  getGameDetails: (gameId) => ipcRenderer.invoke('games:get-game-details', gameId),
  getInstalledGames: (userId) => ipcRenderer.invoke('games:get-installed', userId),
  installGame: (userId, gameId) => ipcRenderer.invoke('games:install', userId, gameId),
  uninstallGame: (userId, gameId) => ipcRenderer.invoke('games:uninstall', userId, gameId),
  launchGame: (installPath, executableName) => ipcRenderer.invoke('games:launch', installPath, executableName),
  uploadGame: (gameData) => ipcRenderer.invoke('games:upload-game', gameData),
  selectGameFolder: () => ipcRenderer.invoke('games:select-game-folder'),
  selectExecutable: (folderPath) => ipcRenderer.invoke('games:select-executable', folderPath)
});
