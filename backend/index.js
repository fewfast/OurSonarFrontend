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
    maxDetectCm:        100,
    redZoneCm:          30,
};

let esp32Status = 'OFFLINE';

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

    if (safe.maxDetectCm !== undefined) {
        safe.maxDetectCm = clampCm(safe.maxDetectCm);
    }
    if (safe.redZoneCm !== undefined) {
        safe.redZoneCm = clampCm(safe.redZoneCm);
    }
    if (safe.redZoneCm !== undefined || safe.maxDetectCm !== undefined) {
        const red = safe.redZoneCm   ?? systemConfig.redZoneCm;
        const max = safe.maxDetectCm ?? systemConfig.maxDetectCm;
        if (red >= max) {
            safe.redZoneCm = Math.max(1, max - 1);
        }
    }

    const ALLOWED = [
        'isSystemOn', 'isAlertOn', 'mode',
        'degreeLimit', 'staticLimit', 'currentStaticAngle',
        'maxDetectCm', 'redZoneCm',
    ];
    Object.keys(safe).forEach((k) => { if (!ALLOWED.includes(k)) delete safe[k]; });

    if (safe.mode && !['Roam', 'Track', 'Static'].includes(safe.mode)) {
        delete safe.mode;
    }

    return safe;
}

// ─────────────────────────────────────────
//  แปลง systemConfig → format ที่ ESP32 เข้าใจ
// ─────────────────────────────────────────
function toESP32Payload(cfg) {
    return {
        isSystemStart: cfg.isSystemOn,
        isAlert:       cfg.isAlertOn,
        mode:          cfg.mode,
        pos:           cfg.currentStaticAngle,
        minRotate:     cfg.degreeLimit.min,
        maxRotate:     cfg.degreeLimit.max,
        maxRange:      cfg.maxDetectCm,
        RedZone:       cfg.redZoneCm,
    };
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

    mqttClient.subscribe('BeanNian/esp32/status', (err) => {
        if (!err) console.log('📡 Subscribed to BeanNian/esp32/status');
    });
});

mqttClient.on('error', (err) => console.error('❌ MQTT Error:', err.message));
mqttClient.on('reconnect', () => console.log('🔄 MQTT reconnecting...'));

// ─────────────────────────────────────────
//  Rate Limit สำหรับ Radar Scan บันทึก MongoDB
// ─────────────────────────────────────────
let lastScanSaveTime = 0;

mqttClient.on('message', async (topic, message) => {

    if (topic === 'BeanNian/esp32/status') {
        const raw = message.toString();
        esp32Status = raw.includes('Connected') ? 'ONLINE' : 'OFFLINE';
        console.log(`📶 ESP32 status: ${esp32Status}`);
        io.emit('esp32_status', esp32Status);
        return;
    }

    if (topic !== 'rtos/radar_data') return;
    if (!systemConfig.isSystemOn) return;

    try {
        const data = JSON.parse(message.toString());

        if (typeof data.angle !== 'number' || typeof data.distance !== 'number') return;

        const inDetectRange = data.distance > 0 && data.distance <= systemConfig.maxDetectCm;
        const hasObject     = inDetectRange;
        const inRedZone     = inDetectRange && data.distance <= systemConfig.redZoneCm;

        const scanPayload = {
            angle:     data.angle,
            distance:  data.distance,
            hasObject,
            inRedZone,
        };

        io.emit('radar_scan', scanPayload);

        const now = Date.now();
        if (now - lastScanSaveTime >= CONFIG.SCAN_SAVE_INTERVAL_MS) {
            await saveRadarScan(scanPayload);
            lastScanSaveTime = now;
        }

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

    socket.emit('sync_config', systemConfig);
    socket.emit('esp32_status', esp32Status);

    socket.on('update_config', async (rawPatch) => {
        const patch = validateConfig(rawPatch);
        if (!patch || Object.keys(patch).length === 0) return;

        if (patch.isSystemOn !== undefined && patch.isSystemOn !== systemConfig.isSystemOn) {
            const logEntry = {
                type: 'SYSTEM',
                msg:  patch.isSystemOn ? '🚀 System Initiated' : '🛑 System Shutdown',
                time: new Date().toLocaleTimeString(),
            };
            io.emit('new_log', logEntry);
            await saveLog(logEntry);
        }

        if (patch.mode !== undefined && patch.mode !== systemConfig.mode) {
            const logEntry = {
                type: 'SYSTEM',
                msg:  `Mode switched to: ${patch.mode}`,
                time: new Date().toLocaleTimeString(),
            };
            io.emit('new_log', logEntry);
            await saveLog(logEntry);
        }

        if (patch.isAlertOn !== undefined && patch.isAlertOn !== systemConfig.isAlertOn) {
            const logEntry = {
                type: 'SYSTEM',
                msg:  patch.isAlertOn ? '🔔 Alert Armed' : '🔕 Alert Disabled',
                time: new Date().toLocaleTimeString(),
            };
            io.emit('new_log', logEntry);
            await saveLog(logEntry);
        }

        if (patch.maxDetectCm !== undefined && patch.maxDetectCm !== systemConfig.maxDetectCm) {
            const logEntry = {
                type: 'SYSTEM',
                msg:  `Max Detect changed to: ${patch.maxDetectCm}cm`,
                time: new Date().toLocaleTimeString(),
            };
            io.emit('new_log', logEntry);
            await saveLog(logEntry);
        }

        if (patch.redZoneCm !== undefined && patch.redZoneCm !== systemConfig.redZoneCm) {
            const logEntry = {
                type: 'SYSTEM',
                msg:  `Red Zone changed to: ${patch.redZoneCm}cm`,
                time: new Date().toLocaleTimeString(),
            };
            io.emit('new_log', logEntry);
            await saveLog(logEntry);
        }

        systemConfig = { ...systemConfig, ...patch };

        mqttClient.publish(
            'BeanNian/esp32/state',
            JSON.stringify(toESP32Payload(systemConfig))
        );

        io.emit('sync_config', systemConfig);
    });

    socket.on('disconnect', () => {
        console.log('❌ Dashboard Disconnected:', socket.id);
    });
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
        // ─────────────────────────────────────────
        //  ROUTES — mount หลัง db พร้อม
        // ─────────────────────────────────────────
        const logsRoute   = require('./routes/logs');
        const radarRoute  = require('./routes/radar');
        const configRoute = require('./routes/config');
        const statsRoute  = require('./routes/stats');

        app.use('/api/logs',        logsRoute(db));
        app.use('/api/radar_scans', radarRoute(db));
        app.use('/api/config',      configRoute(() => systemConfig));
        app.use('/api/stats',       statsRoute(db));

        server.listen(CONFIG.PORT, () => {
            console.log(`🚀 RTOS Command Server running on port ${CONFIG.PORT}`);
        });
    })
    .catch((err) => {
        console.error('❌ Failed to connect to MongoDB:', err.message);
        process.exit(1);
    });