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

    // --- WebSocket (RFC 6455, zero dependencies) ---
    function acceptWebSocket(req, socket) {
        const key = req.headers['sec-websocket-key'];
        const accept = crypto
            .createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-5AB940E35C9A')
            .digest('base64');

        socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
        );
        return socket;
    }

    function decodeFrame(buf) {
        if (buf.length < 2) return null;
        const opcode = buf[0] & 0x0f;
        if (opcode === 0x8) return { opcode: 0x8, data: null, totalLen: 2 };
        if (opcode === 0x9) return { opcode: 0x9, data: null, totalLen: 2 };
        const masked = (buf[1] & 0x80) !== 0;
        let payloadLen = buf[1] & 0x7f;
        let offset = 2;
        if (payloadLen === 126) {
            if (buf.length < 4) return null;
            payloadLen = buf.readUInt16BE(2);
            offset = 4;
        } else if (payloadLen === 127) {
            if (buf.length < 10) return null;
            payloadLen = Number(buf.readBigUInt64BE(2));
            offset = 10;
        }
        let maskKey = null;
        if (masked) {
            if (buf.length < offset + 4) return null;
            maskKey = buf.slice(offset, offset + 4);
            offset += 4;
        }
        if (buf.length < offset + payloadLen) return null;
        let payload = buf.slice(offset, offset + payloadLen);
        if (masked) {
            for (let i = 0; i < payload.length; i++) {
                payload[i] ^= maskKey[i % 4];
            }
        }
        return { opcode, data: payload.toString('utf8'), totalLen: offset + payloadLen };
    }

    function encodeFrame(text) {
        const payload = Buffer.from(text, 'utf8');
        let header;
        if (payload.length < 126) {
            header = Buffer.alloc(2);
            header[0] = 0x81;
            header[1] = payload.length;
        } else if (payload.length < 65536) {
            header = Buffer.alloc(4);
            header[0] = 0x81;
            header[1] = 126;
            header.writeUInt16BE(payload.length, 2);
        } else {
            header = Buffer.alloc(10);
            header[0] = 0x81;
            header[1] = 127;
            header.writeBigUInt64BE(BigInt(payload.length), 2);
        }
        return Buffer.concat([header, payload]);
    }

    function wsSend(socket, obj) {
        try { socket.write(encodeFrame(JSON.stringify(obj))); } catch (e) {}
    }

    function broadcastRoom(roomCode, msg, excludeId) {
        const room = rooms[roomCode];
        if (!room) return;
        const frame = encodeFrame(JSON.stringify(msg));
        Object.keys(room.players).forEach(function (pid) {
            if (pid === excludeId) return;
            try { room.players[pid].ws.write(frame); } catch (e) {}
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
                ws.end();
                return false;
            } else if (ANTICHEAT.penalty === 'warn') {
                pd.warnings++;
                wsSend(ws, { type: 'acWarning', reason: violations[0], warnings: pd.warnings, max: ANTICHEAT.maxWarnings });
                if (pd.warnings >= ANTICHEAT.maxWarnings) {
                    wsSend(ws, { type: 'acViolation', reason: 'MAX_WARNINGS_REACHED' });
                    ws.end();
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
    server.on('upgrade', function (req, socket, head) {
        if (req.url !== '/ws') {
            socket.destroy();
            return;
        }
        acceptWebSocket(req, socket);

        const playerId = generateId();
        let playerRoom = null;
        let buf = Buffer.alloc(0);

        socket.on('data', function (chunk) {
            buf = Buffer.concat([buf, chunk]);
            while (true) {
                const frame = decodeFrame(buf);
                if (!frame) break;
                buf = buf.slice(frame.totalLen || buf.length);

                if (frame.opcode === 0x8) {
                    socket.end();
                    return;
                }
                if (frame.opcode === 0x9) {
                    const pong = Buffer.alloc(2);
                    pong[0] = 0x8a; pong[1] = 0;
                    socket.write(pong);
                    continue;
                }

                let msg;
                try { msg = JSON.parse(frame.data); } catch (e) { continue; }

                // Anticheat check
                if (!checkAnticheat(playerId, msg, socket, playerRoom)) return;

                handleMessage(playerId, socket, msg);
            }
        });

        socket.on('close', function () {
            if (playerRoom) removePlayerFromRoom(playerRoom, playerId);
            delete playerData[playerId];
        });

        socket.on('error', function () {
            if (playerRoom) removePlayerFromRoom(playerRoom, playerId);
            delete playerData[playerId];
        });

        function handleMessage(pid, ws, msg) {
            if (msg.type === 'createRoom') {
                const code = msg.code;
                if (rooms[code]) {
                    wsSend(ws, { type: 'error', msg: 'ROOM_CODE_IN_USE' });
                    return;
                }
                rooms[code] = { host: pid, timer: 60, players: {} };
                rooms[code].players[pid] = { ws: ws, name: msg.name || 'HOST', alive: true, snake: [], skin: 'emerald', score: 0 };
                playerRoom = code;
                initPlayerAC(pid);
                wsSend(ws, { type: 'roomCreated', code: code, pid: pid, isHost: true });

            } else if (msg.type === 'joinRoom') {
                const code = msg.code;
                if (!rooms[code]) {
                    wsSend(ws, { type: 'error', msg: 'ROOM_NOT_FOUND' });
                    return;
                }
                rooms[code].players[pid] = { ws: ws, name: msg.name || 'PLAYER', alive: true, snake: [], skin: 'emerald', score: 0 };
                playerRoom = code;
                initPlayerAC(pid);
                wsSend(ws, { type: 'roomJoined', code: code, pid: pid, isHost: false, timer: rooms[code].timer });
                broadcastRoom(code, { type: 'playerList', players: getPlayerList(code) });

            } else if (msg.type === 'timerSet') {
                const room = rooms[playerRoom];
                if (!room || room.host !== pid) return;
                room.timer = msg.seconds;
                broadcastRoom(playerRoom, { type: 'timerSet', seconds: msg.seconds }, pid);

            } else if (msg.type === 'startGame') {
                const room = rooms[playerRoom];
                if (!room || room.host !== pid) return;
                Object.keys(room.players).forEach(function (p) {
                    room.players[p].alive = true;
                    room.players[p].score = 0;
                    // Reset anticheat tracking for new round
                    if (playerData[p]) {
                        playerData[p].lastScore = 0;
                        playerData[p].lastSnakeHead = null;
                        playerData[p].warnings = 0;
                    }
                });
                broadcastRoom(playerRoom, { type: 'startGame', mode: msg.mode }, pid);

            } else if (msg.type === 'sync') {
                const room = rooms[playerRoom];
                if (!room) return;
                var p = room.players[pid];
                if (p) {
                    p.snake = msg.snake || [];
                    p.skin = msg.skin || 'emerald';
                    p.score = msg.score || 0;
                    p.alive = msg.alive !== false;
                }
                broadcastRoom(playerRoom, {
                    type: 'sync', pid: pid,
                    snake: msg.snake, skin: msg.skin,
                    score: msg.score, name: msg.name, alive: msg.alive
                }, pid);

            } else if (msg.type === 'eliminated') {
                const room = rooms[playerRoom];
                if (!room) return;
                if (room.players[pid]) room.players[pid].alive = false;
                broadcastRoom(playerRoom, { type: 'playerDied', pid: pid });
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
                    broadcastRoom(playerRoom, { type: 'gameEnd', reason: 'laststanding', scores: scores });
                }

            } else if (msg.type === 'timerExpired') {
                const room = rooms[playerRoom];
                if (!room || room.host !== pid) return;
                var scores = [];
                Object.keys(room.players).forEach(function (p) {
                    scores.push({ name: room.players[p].name, score: room.players[p].score, alive: room.players[p].alive });
                });
                scores.sort(function (a, b) { return b.score - a.score; });
                broadcastRoom(playerRoom, { type: 'gameEnd', reason: 'timer', scores: scores });

            } else if (msg.type === 'timerSync') {
                broadcastRoom(playerRoom, { type: 'timerSync', remaining: msg.remaining }, pid);

            } else if (msg.type === 'leave') {
                if (playerRoom) {
                    removePlayerFromRoom(playerRoom, pid);
                    playerRoom = null;
                }
            }
        }
    });

    server.listen(port, function () {
        console.log('SCANLINE_SERPENT server running on http://localhost:' + port);
        console.log('WebSocket endpoint: ws://localhost:' + port + '/ws');
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
