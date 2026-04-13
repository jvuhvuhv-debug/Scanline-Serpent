/**
 * SCANLINE SERPENT — WebSocket Multiplayer Server + Anticheat
 * 
 * Standalone: node server.js
 * Embedded:   require('./server.js').start(port, gameDir)
 *
 * Default port: 3000 (override with PORT env var)
 * Serves game files via HTTP + WebSocket multiplayer on /ws
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

// ============================================
//  ANTICHEAT CONFIG — MODIFY THESE VALUES
// ============================================
const ANTICHEAT = {
    enabled: true,

    // Max score increase per sync tick (100ms). 
    // Normal play: 1 apple per ~0.5-2s depending on speed.
    // At 10 syncs/sec, max ~1 apple per 5 ticks is generous.
    maxScorePerTick: 2,

    // Max total score jump between any two syncs
    maxScoreJump: 5,

    // Snake length must roughly match score (length ≈ startLen + score)
    // Allow this much slack (e.g. 10 extra segments)
    maxLengthOverScore: 15,

    // Starting snake length (game starts with ~4 segments)
    startingLength: 4,

    // Max snake speed: head can't teleport more than this many cells per tick
    // At 100ms sync rate and ~150ms game tick, 2 cells is generous
    maxHeadMovePerTick: 5,

    // Rate limit: max messages per second per player
    maxMessagesPerSecond: 30,

    // Penalty: what happens when a violation is detected
    // 'kick' = disconnect, 'warn' = log + notify, 'ignore' = log only
    penalty: 'kick',

    // How many warnings before auto-kick (only used when penalty='warn')
    maxWarnings: 3,

    // Log violations to console
    logViolations: true,
};
// ============================================

const rooms = {};
const playerData = {};  // playerId -> anticheat tracking data

function generateId() {
    return crypto.randomBytes(8).toString('hex');
}

const MIME = {
    '.html': 'text/html',
    '.js':   'application/javascript',
    '.css':  'text/css',
    '.json': 'application/json',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.gif':  'image/gif',
    '.svg':  'image/svg+xml',
    '.mp3':  'audio/mpeg',
    '.wav':  'audio/wav',
    '.ico':  'image/x-icon',
};

function start(port, gameDir) {
    port = port || parseInt(process.env.PORT, 10) || 3000;
    gameDir = gameDir || process.cwd();

    const server = http.createServer(function (req, res) {
        let filePath = path.join(gameDir, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
        filePath = path.normalize(filePath);

        // Security: prevent directory traversal
        if (!filePath.startsWith(path.normalize(gameDir))) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME[ext] || 'application/octet-stream';

        fs.readFile(filePath, function (err, data) {
            if (err) {
                res.writeHead(404);
                res.end('Not Found');
                return;
            }
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(data);
        });
    });

    // --- WebSocket via 'ws' package (works behind reverse proxies) ---
    function wsSend(socket, obj) {
        try { if (socket.readyState === 1) socket.send(JSON.stringify(obj)); } catch (e) {}
    }

    function broadcastRoom(roomCode, msg, excludeId) {
        const room = rooms[roomCode];
        if (!room) return;
        const data = JSON.stringify(msg);
        Object.keys(room.players).forEach(function (pid) {
            if (pid === excludeId) return;
            try { if (room.players[pid].ws.readyState === 1) room.players[pid].ws.send(data); } catch (e) {}
        });
    }

    function getPlayerList(roomCode) {
        const room = rooms[roomCode];
        if (!room) return {};
        const list = {};
        Object.keys(room.players).forEach(function (pid) {
            list[pid] = { name: room.players[pid].name };
        });
        return list;
    }

    function removePlayerFromRoom(roomCode, playerId) {
        const room = rooms[roomCode];
        if (!room) return;
        const wasHost = (room.host === playerId);
        delete room.players[playerId];
        delete playerData[playerId];
        const remaining = Object.keys(room.players);

        if (remaining.length === 0) {
            delete rooms[roomCode];
            return;
        }

        if (wasHost) {
            room.host = remaining[0];
            wsSend(room.players[room.host].ws, { type: 'hostMigrate' });
        }

        broadcastRoom(roomCode, { type: 'playerList', players: getPlayerList(roomCode) });
        broadcastRoom(roomCode, { type: 'playerLeft', pid: playerId });
    }

    // ============================================
    //  ANTICHEAT ENGINE
    // ============================================
    function initPlayerAC(pid) {
        playerData[pid] = {
            lastScore: 0,
            lastSnakeHead: null,
            lastSyncTime: Date.now(),
            warnings: 0,
            msgCount: 0,
            msgWindowStart: Date.now(),
        };
    }

    function checkAnticheat(pid, msg, ws, roomCode) {
        if (!ANTICHEAT.enabled) return true;

        const pd = playerData[pid];
        if (!pd) return true;

        const now = Date.now();
        const violations = [];

        // --- Rate limiting ---
        if (now - pd.msgWindowStart > 1000) {
            pd.msgCount = 0;
            pd.msgWindowStart = now;
        }
        pd.msgCount++;
        if (pd.msgCount > ANTICHEAT.maxMessagesPerSecond) {
            violations.push('RATE_LIMIT_EXCEEDED (' + pd.msgCount + ' msg/s)');
        }

        // --- Score checks (only on sync messages) ---
        if (msg.type === 'sync') {
            const newScore = msg.score || 0;
            const scoreDelta = newScore - pd.lastScore;

            if (scoreDelta > ANTICHEAT.maxScoreJump && pd.lastScore > 0) {
                violations.push('SCORE_JUMP (' + pd.lastScore + ' -> ' + newScore + ', delta=' + scoreDelta + ')');
            }

            if (scoreDelta > ANTICHEAT.maxScorePerTick && pd.lastScore > 0) {
                violations.push('SCORE_RATE (' + scoreDelta + ' per tick, max=' + ANTICHEAT.maxScorePerTick + ')');
            }

            // --- Snake length vs score ---
            const snakeLen = (msg.snake && msg.snake.length) || 0;
            const expectedMax = ANTICHEAT.startingLength + newScore + ANTICHEAT.maxLengthOverScore;
            if (snakeLen > expectedMax) {
                violations.push('SNAKE_TOO_LONG (len=' + snakeLen + ', score=' + newScore + ', max=' + expectedMax + ')');
            }

            // --- Head teleport check ---
            if (pd.lastSnakeHead && msg.snake && msg.snake.length > 0) {
                const head = msg.snake[0];
                const dx = Math.abs(head.x - pd.lastSnakeHead.x);
                const dy = Math.abs(head.y - pd.lastSnakeHead.y);
                // Rough cell size estimate (grid is typically 25px cells on 500px canvas)
                const cellEst = 25;
                const cellsMoved = Math.max(dx, dy) / cellEst;
                if (cellsMoved > ANTICHEAT.maxHeadMovePerTick) {
                    violations.push('HEAD_TELEPORT (moved ' + cellsMoved.toFixed(1) + ' cells, max=' + ANTICHEAT.maxHeadMovePerTick + ')');
                }
            }

            // Update tracking
            pd.lastScore = newScore;
            if (msg.snake && msg.snake.length > 0) {
                pd.lastSnakeHead = { x: msg.snake[0].x, y: msg.snake[0].y };
            }
            pd.lastSyncTime = now;
        }

        // --- Process violations ---
        if (violations.length > 0) {
            if (ANTICHEAT.logViolations) {
                const room = rooms[roomCode];
                const name = room && room.players[pid] ? room.players[pid].name : pid;
                console.log('[ANTICHEAT] ' + name + ': ' + violations.join(', '));
            }

            if (ANTICHEAT.penalty === 'kick') {
                wsSend(ws, { type: 'acViolation', reason: violations[0] });
                ws.close();
                return false;
            } else if (ANTICHEAT.penalty === 'warn') {
                pd.warnings++;
                wsSend(ws, { type: 'acWarning', reason: violations[0], warnings: pd.warnings, max: ANTICHEAT.maxWarnings });
                if (pd.warnings >= ANTICHEAT.maxWarnings) {
                    wsSend(ws, { type: 'acViolation', reason: 'MAX_WARNINGS_REACHED' });
                    ws.close();
                    return false;
                }
            }
            // 'ignore' just logs
        }

        return true;
    }

    // ============================================
    //  WEBSOCKET CONNECTION HANDLER
    // ============================================
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', function (req, socket, head) {
        if (req.url !== '/ws') {
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, function (ws) {
            wss.emit('connection', ws, req);
        });
    });

    wss.on('connection', function (ws) {
        const playerId = generateId();
        let playerRoom = null;

        ws.on('message', function (raw) {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

            // Anticheat check
            if (!checkAnticheat(playerId, msg, ws, playerRoom)) return;

            // --- handleMessage ---
            if (msg.type === 'createRoom') {
                const code = msg.code;
                if (rooms[code]) {
                    wsSend(ws, { type: 'error', msg: 'ROOM_CODE_IN_USE' });
                    return;
                }
                rooms[code] = { host: playerId, timer: 60, players: {}, isPublic: msg.isPublic !== false, hostName: msg.name || 'HOST', inGame: false };
                rooms[code].players[playerId] = { ws: ws, name: msg.name || 'HOST', alive: true, snake: [], skin: 'emerald', score: 0 };
                playerRoom = code;
                initPlayerAC(playerId);
                wsSend(ws, { type: 'roomCreated', code: code, pid: playerId, isHost: true });

            } else if (msg.type === 'joinRoom') {
                const code = msg.code;
                if (!rooms[code]) {
                    wsSend(ws, { type: 'error', msg: 'ROOM_NOT_FOUND' });
                    return;
                }
                rooms[code].players[playerId] = { ws: ws, name: msg.name || 'PLAYER', alive: true, snake: [], skin: 'emerald', score: 0 };
                playerRoom = code;
                initPlayerAC(playerId);
                wsSend(ws, { type: 'roomJoined', code: code, pid: playerId, isHost: false, timer: rooms[code].timer });
                broadcastRoom(code, { type: 'playerList', players: getPlayerList(code) });

            } else if (msg.type === 'timerSet') {
                const room = rooms[playerRoom];
                if (!room || room.host !== playerId) return;
                room.timer = msg.seconds;
                broadcastRoom(playerRoom, { type: 'timerSet', seconds: msg.seconds }, playerId);

            } else if (msg.type === 'startGame') {
                const room = rooms[playerRoom];
                if (!room || room.host !== playerId) return;
                room.inGame = true;
                Object.keys(room.players).forEach(function (p) {
                    room.players[p].alive = true;
                    room.players[p].score = 0;
                    if (playerData[p]) {
                        playerData[p].lastScore = 0;
                        playerData[p].lastSnakeHead = null;
                        playerData[p].warnings = 0;
                    }
                });
                broadcastRoom(playerRoom, { type: 'startGame', mode: msg.mode }, playerId);

            } else if (msg.type === 'sync') {
                const room = rooms[playerRoom];
                if (!room) return;
                var p = room.players[playerId];
                if (p) {
                    p.snake = msg.snake || [];
                    p.skin = msg.skin || 'emerald';
                    p.score = msg.score || 0;
                    p.alive = msg.alive !== false;
                }
                broadcastRoom(playerRoom, {
                    type: 'sync', pid: playerId,
                    snake: msg.snake, skin: msg.skin,
                    score: msg.score, name: msg.name, alive: msg.alive
                }, playerId);

            } else if (msg.type === 'eliminated') {
                const room = rooms[playerRoom];
                if (!room) return;
                if (room.players[playerId]) room.players[playerId].alive = false;
                broadcastRoom(playerRoom, { type: 'playerDied', pid: playerId });
                var aliveCount = 0;
                Object.keys(room.players).forEach(function (p) {
                    if (room.players[p].alive) aliveCount++;
                });
                if (aliveCount <= 1) {
                    var scores = [];
                    Object.keys(room.players).forEach(function (p) {
                        scores.push({ name: room.players[p].name, score: room.players[p].score, alive: room.players[p].alive });
                    });
                    scores.sort(function (a, b) { return b.score - a.score; });
                    room.inGame = false;
                    broadcastRoom(playerRoom, { type: 'gameEnd', reason: 'laststanding', scores: scores });
                }

            } else if (msg.type === 'timerExpired') {
                const room = rooms[playerRoom];
                if (!room || room.host !== playerId) return;
                var scores = [];
                Object.keys(room.players).forEach(function (p) {
                    scores.push({ name: room.players[p].name, score: room.players[p].score, alive: room.players[p].alive });
                });
                scores.sort(function (a, b) { return b.score - a.score; });
                room.inGame = false;
                broadcastRoom(playerRoom, { type: 'gameEnd', reason: 'timer', scores: scores });

            } else if (msg.type === 'timerSync') {
                broadcastRoom(playerRoom, { type: 'timerSync', remaining: msg.remaining }, playerId);

            } else if (msg.type === 'setVisibility') {
                const room = rooms[playerRoom];
                if (!room || room.host !== playerId) return;
                room.isPublic = msg.isPublic === true;

            } else if (msg.type === 'listRooms') {
                var roomList = [];
                Object.keys(rooms).forEach(function (code) {
                    var r = rooms[code];
                    if (r.isPublic && !r.inGame) {
                        roomList.push({
                            code: code,
                            host: r.hostName,
                            players: Object.keys(r.players).length
                        });
                    }
                });
                wsSend(ws, { type: 'roomList', rooms: roomList });

            } else if (msg.type === 'leave') {
                if (playerRoom) {
                    removePlayerFromRoom(playerRoom, playerId);
                    playerRoom = null;
                }
            }
        });

        ws.on('close', function () {
            if (playerRoom) removePlayerFromRoom(playerRoom, playerId);
            delete playerData[playerId];
        });

        ws.on('error', function () {
            if (playerRoom) removePlayerFromRoom(playerRoom, playerId);
            delete playerData[playerId];
        });
    });

    server.listen(port, '0.0.0.0', function () {
        console.log('SCANLINE_SERPENT server running on http://0.0.0.0:' + port);
        console.log('WebSocket endpoint: ws://0.0.0.0:' + port + '/ws');
        console.log('Anticheat: ' + (ANTICHEAT.enabled ? 'ENABLED (penalty=' + ANTICHEAT.penalty + ')' : 'DISABLED'));
    });

    return server;
}

// --- Export for embedding in Electron, or run standalone ---
module.exports = { start, ANTICHEAT };

if (require.main === module) {
    start();
    // Auto-open browser (skip on cloud hosts like Glitch/Render)
    if (!process.env.PROJECT_DOMAIN && !process.env.RENDER) {
        const url = 'http://localhost:' + (parseInt(process.env.PORT, 10) || 3000);
        const { exec } = require('child_process');
        switch (process.platform) {
            case 'darwin': exec('open ' + url); break;
            case 'win32':  exec('start ' + url); break;
            default:       exec('xdg-open ' + url); break;
        }
    }
}
