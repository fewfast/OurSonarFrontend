const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mqtt = require('mqtt');
const { MongoClient } = require('mongodb');
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4']);

// ─────────────────────────────────────────
//  CONFIG  — แก้ค่าตรงนี้อย่างเดียว
// ─────────────────────────────────────────
const CONFIG = {
    HIVEMQ_HOST:     'ec25cb2ef7ae43dab091851245beb8e2.s1.eu.hivemq.cloud',
    HIVEMQ_PORT:     8883,
    HIVEMQ_USERNAME: 'mySonar',
    HIVEMQ_PASSWORD: 'mySonar1234',

    MONGO_URI: 'mongodb+srv://Boss:8ObyrBSKerxUDqEb@mysonar.6ovkcwx.mongodb.net/rtos_radar?retryWrites=true&w=majority&appName=mySonar',
    MONGO_DB:  'rtos_radar',

    PORT: 4000,

    // Rate limit: บันทึก radar_scan ทุก N มิลลิวินาที (ป้องกัน MongoDB เต็ม)
    SCAN_SAVE_INTERVAL_MS: 1000,
};

// ─────────────────────────────────────────
//  MONGODB SETUP
// ─────────────────────────────────────────
const mongoClient = new MongoClient(CONFIG.MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
    family: 4,
});
let db;

async function connectMongo() {
    await mongoClient.connect();
    db = mongoClient.db(CONFIG.MONGO_DB);
    console.log('✅ Connected to MongoDB Atlas');
}

async function saveLog(logEntry) {
    try {
        await db.collection('logs').insertOne({ ...logEntry, createdAt: new Date() });
    } catch (e) {
        console.error('MongoDB saveLog error:', e.message);
    }
}

async function saveRadarScan(data) {
    try {
        await db.collection('radar_scans').insertOne({ ...data, createdAt: new Date() });
    } catch (e) {
        console.error('MongoDB saveRadarScan error:', e.message);
    }
}

// ─────────────────────────────────────────
//  EXPRESS + SOCKET.IO SETUP
// ─────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ─────────────────────────────────────────
//  SYSTEM CONFIG (in-memory)
// ─────────────────────────────────────────
let systemConfig = {
    isSystemOn:         false,
    isAlertOn:          false,
    mode:               'Static',
    degreeLimit:        { min: 0, max: 180 },
    staticLimit:        { min: 45, max: 135 },
    currentStaticAngle: 90,
    maxDetectCm:        100,   // ← ระยะสูงสุดที่จะ detect วัตถุ (cm)
    redZoneCm:          30,    // ← เข้าใกล้กว่านี้จะ trigger alert (cm)
};

// ─────────────────────────────────────────
//  INPUT VALIDATION HELPER
// ─────────────────────────────────────────
function clampAngle(val, min = 0, max = 180) {
    const n = Number(val);
    if (isNaN(n)) return min;
    return Math.max(min, Math.min(max, n));
}

function clampCm(val, min = 1, max = 500) {
    const n = Number(val);
    if (isNaN(n)) return min;
    return Math.max(min, Math.min(max, n));
}

function validateConfig(patch) {
    const safe = { ...patch };

    if (safe.currentStaticAngle !== undefined) {
        safe.currentStaticAngle = clampAngle(safe.currentStaticAngle);
    }
    if (safe.degreeLimit) {
        safe.degreeLimit = {
            min: clampAngle(safe.degreeLimit.min),
            max: clampAngle(safe.degreeLimit.max),
        };
        if (safe.degreeLimit.min > safe.degreeLimit.max) {
            [safe.degreeLimit.min, safe.degreeLimit.max] = [safe.degreeLimit.max, safe.degreeLimit.min];
        }
    }
    if (safe.staticLimit) {
        safe.staticLimit = {
            min: clampAngle(safe.staticLimit.min),
            max: clampAngle(safe.staticLimit.max),
        };
        if (safe.staticLimit.min > safe.staticLimit.max) {
            [safe.staticLimit.min, safe.staticLimit.max] = [safe.staticLimit.max, safe.staticLimit.min];
        }
    }

    // ── ใหม่: validate maxDetectCm และ redZoneCm ──
    if (safe.maxDetectCm !== undefined) {
        safe.maxDetectCm = clampCm(safe.maxDetectCm);
    }
    if (safe.redZoneCm !== undefined) {
        safe.redZoneCm = clampCm(safe.redZoneCm);
    }
    // ป้องกัน redZone ใหญ่กว่า maxDetect
    if (safe.redZoneCm !== undefined || safe.maxDetectCm !== undefined) {
        const red = safe.redZoneCm   ?? systemConfig.redZoneCm;
        const max = safe.maxDetectCm ?? systemConfig.maxDetectCm;
        if (red >= max) {
            safe.redZoneCm = Math.max(1, max - 1);
        }
    }

    // whitelist fields ที่อนุญาต (ป้องกัน inject field แปลกๆ)
    const ALLOWED = [
        'isSystemOn', 'isAlertOn', 'mode',
        'degreeLimit', 'staticLimit', 'currentStaticAngle',
        'maxDetectCm', 'redZoneCm',   // ← เพิ่ม
    ];
    Object.keys(safe).forEach((k) => { if (!ALLOWED.includes(k)) delete safe[k]; });

    // validate mode
    if (safe.mode && !['Roam', 'Track', 'Static'].includes(safe.mode)) {
        delete safe.mode;
    }

    return safe;
}

// ─────────────────────────────────────────
//  HIVEMQ CLOUD MQTT SETUP
// ─────────────────────────────────────────
const mqttClient = mqtt.connect({
    host:     CONFIG.HIVEMQ_HOST,
    port:     CONFIG.HIVEMQ_PORT,
    protocol: 'mqtts',
    username: CONFIG.HIVEMQ_USERNAME,
    password: CONFIG.HIVEMQ_PASSWORD,
    rejectUnauthorized: true,
    reconnectPeriod: 5000,
});

mqttClient.on('connect', () => {
    console.log('✅ Connected to HiveMQ Cloud');
    mqttClient.subscribe('rtos/radar_data', (err) => {
        if (!err) console.log('📡 Subscribed to rtos/radar_data');
    });
});

mqttClient.on('error', (err) => console.error('❌ MQTT Error:', err.message));
mqttClient.on('reconnect', () => console.log('🔄 MQTT reconnecting...'));

// ─────────────────────────────────────────
//  Rate Limit สำหรับ Radar Scan บันทึก MongoDB
// ─────────────────────────────────────────
let lastScanSaveTime = 0;

// รับข้อมูลจาก ESP32
mqttClient.on('message', async (topic, message) => {
    if (topic !== 'rtos/radar_data') return;
    if (!systemConfig.isSystemOn) return;

    try {
        const data = JSON.parse(message.toString());

        // validate ข้อมูลจาก ESP32
        if (typeof data.angle !== 'number' || typeof data.distance !== 'number') return;

        // ── ใหม่: hasObject = อยู่ในช่วง maxDetect เท่านั้น ──
        const inDetectRange = data.distance > 0 && data.distance <= systemConfig.maxDetectCm;
        const hasObject     = inDetectRange;
        const inRedZone     = inDetectRange && data.distance <= systemConfig.redZoneCm;

        const scanPayload = {
            angle:     data.angle,
            distance:  data.distance,
            hasObject,
            inRedZone,
        };

        // 1. ส่งข้อมูล Radar ไป Dashboard
        io.emit('radar_scan', scanPayload);

        // 2. บันทึก radar scan ลง MongoDB (Rate limited)
        const now = Date.now();
        if (now - lastScanSaveTime >= CONFIG.SCAN_SAVE_INTERVAL_MS) {
            await saveRadarScan(scanPayload);
            lastScanSaveTime = now;
        }

        // 3. Alert: trigger เฉพาะเมื่อเข้า Red Zone + เปิด Alert
        if (inRedZone && systemConfig.isAlertOn) {
            const logEntry = {
                type: 'ALERT',
                msg:  `RED ZONE breach at ${data.angle}° — Range: ${data.distance}cm (limit: ${systemConfig.redZoneCm}cm)`,
                time: new Date().toLocaleTimeString(),
            };
            io.emit('new_log', logEntry);
            await saveLog(logEntry);
        }
    } catch (e) {
        console.error('MQTT JSON Parse Error:', e.message);
    }
});

// ─────────────────────────────────────────
//  SOCKET.IO EVENTS
// ─────────────────────────────────────────
io.on('connection', (socket) => {
    console.log('🌐 Dashboard Connected:', socket.id);

    // ส่ง config ปัจจุบันให้ client ทันที
    socket.emit('sync_config', systemConfig);

    socket.on('update_config', async (rawPatch) => {
        // Validate & sanitize input จาก client
        const patch = validateConfig(rawPatch);
        if (!patch || Object.keys(patch).length === 0) return;

        // LOG: เปิด/ปิดระบบ
        if (patch.isSystemOn !== undefined && patch.isSystemOn !== systemConfig.isSystemOn) {
            const logEntry = {
                type: 'SYSTEM',
                msg:  patch.isSystemOn ? '🚀 System Initiated' : '🛑 System Shutdown',
                time: new Date().toLocaleTimeString(),
            };
            io.emit('new_log', logEntry);
            await saveLog(logEntry);
        }

        // LOG: เปลี่ยน Mode
        if (patch.mode !== undefined && patch.mode !== systemConfig.mode) {
            const logEntry = {
                type: 'SYSTEM',
                msg:  `Mode switched to: ${patch.mode}`,
                time: new Date().toLocaleTimeString(),
            };
            io.emit('new_log', logEntry);
            await saveLog(logEntry);
        }

        // LOG: เปิด/ปิด Alert
        if (patch.isAlertOn !== undefined && patch.isAlertOn !== systemConfig.isAlertOn) {
            const logEntry = {
                type: 'SYSTEM',
                msg:  patch.isAlertOn ? '🔔 Alert Armed' : '🔕 Alert Disabled',
                time: new Date().toLocaleTimeString(),
            };
            io.emit('new_log', logEntry);
            await saveLog(logEntry);
        }

        // LOG: เปลี่ยน maxDetectCm
        if (patch.maxDetectCm !== undefined && patch.maxDetectCm !== systemConfig.maxDetectCm) {
            const logEntry = {
                type: 'SYSTEM',
                msg:  `Max Detect changed to: ${patch.maxDetectCm}cm`,
                time: new Date().toLocaleTimeString(),
            };
            io.emit('new_log', logEntry);
            await saveLog(logEntry);
        }

        // LOG: เปลี่ยน redZoneCm
        if (patch.redZoneCm !== undefined && patch.redZoneCm !== systemConfig.redZoneCm) {
            const logEntry = {
                type: 'SYSTEM',
                msg:  `Red Zone changed to: ${patch.redZoneCm}cm`,
                time: new Date().toLocaleTimeString(),
            };
            io.emit('new_log', logEntry);
            await saveLog(logEntry);
        }

        // อัปเดต in-memory config
        systemConfig = { ...systemConfig, ...patch };

        // ส่งค่าใหม่ไปให้ ESP32 ผ่าน HiveMQ
        mqttClient.publish('rtos/set_config', JSON.stringify(systemConfig));

        // Broadcast config ให้ทุก client
        io.emit('sync_config', systemConfig);
    });

    socket.on('disconnect', () => {
        console.log('❌ Dashboard Disconnected:', socket.id);
    });
});

// ─────────────────────────────────────────
//  REST API
// ─────────────────────────────────────────

// GET /api/logs?limit=100&type=ALERT
app.get('/api/logs', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
        const filter = req.query.type ? { type: req.query.type } : {};
        const logs = await db.collection('logs')
            .find(filter)
            .sort({ createdAt: -1 })
            .limit(limit)
            .toArray();
        res.json(logs);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/radar_scans?limit=500
app.get('/api/radar_scans', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 500, 5000);
        const scans = await db.collection('radar_scans')
            .find({})
            .sort({ createdAt: -1 })
            .limit(limit)
            .toArray();
        res.json(scans);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/config
app.get('/api/config', (_req, res) => {
    res.json(systemConfig);
});

// GET /api/stats — สรุปสถิติ
app.get('/api/stats', async (req, res) => {
    try {
        const [alertCount, systemCount, scanCount, latestAlert] = await Promise.all([
            db.collection('logs').countDocuments({ type: 'ALERT' }),
            db.collection('logs').countDocuments({ type: 'SYSTEM' }),
            db.collection('radar_scans').countDocuments(),
            db.collection('logs').findOne({ type: 'ALERT' }, { sort: { createdAt: -1 } }),
        ]);
        res.json({ alertCount, systemCount, scanCount, latestAlert });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────
//  GRACEFUL SHUTDOWN
// ─────────────────────────────────────────
async function gracefulShutdown(signal) {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    try {
        mqttClient.end();
        await mongoClient.close();
        console.log('✅ Connections closed');
    } catch (e) {
        console.error('Shutdown error:', e.message);
    }
    process.exit(0);
}

process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ─────────────────────────────────────────
//  START SERVER
// ─────────────────────────────────────────
connectMongo()
    .then(() => {
        server.listen(CONFIG.PORT, () => {
            console.log(`🚀 RTOS Command Server running on port ${CONFIG.PORT}`);
        });
    })
    .catch((err) => {
        console.error('❌ Failed to connect to MongoDB:', err.message);
        process.exit(1);
    });