const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mqtt = require('mqtt');
const { MongoClient } = require('mongodb');

// ─────────────────────────────────────────
//  CONFIG  — แก้ค่าตรงนี้อย่างเดียว
// ─────────────────────────────────────────
const CONFIG = {
    // HiveMQ Cloud
    HIVEMQ_HOST:     'xxxxxxxx.s1.eu.hivemq.cloud',   // <-- เปลี่ยนเป็น host ของคุณ
    HIVEMQ_PORT:     8883,
    HIVEMQ_USERNAME: 'your_hivemq_username',
    HIVEMQ_PASSWORD: 'your_hivemq_password',

    // MongoDB Atlas
    MONGO_URI: 'mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority',
    MONGO_DB:  'rtos_radar',

    // Server
    PORT: 4000,
};

// ─────────────────────────────────────────
//  MONGODB SETUP
// ─────────────────────────────────────────
const mongoClient = new MongoClient(CONFIG.MONGO_URI);
let db;

async function connectMongo() {
    await mongoClient.connect();
    db = mongoClient.db(CONFIG.MONGO_DB);
    console.log('✅ Connected to MongoDB Atlas');
}

// Helper: บันทึก log ลง MongoDB
async function saveLog(logEntry) {
    try {
        await db.collection('logs').insertOne({
            ...logEntry,
            createdAt: new Date(),
        });
    } catch (e) {
        console.error('MongoDB insertOne error:', e.message);
    }
}

// Helper: บันทึก radar scan ลง MongoDB (optional — comment ออกถ้า data เยอะเกินไป)
async function saveRadarScan(data) {
    try {
        await db.collection('radar_scans').insertOne({
            ...data,
            createdAt: new Date(),
        });
    } catch (e) {
        console.error('MongoDB insertOne error:', e.message);
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
};

// ─────────────────────────────────────────
//  HIVEMQ CLOUD MQTT SETUP
// ─────────────────────────────────────────
const mqttClient = mqtt.connect({
    host:     CONFIG.HIVEMQ_HOST,
    port:     CONFIG.HIVEMQ_PORT,
    protocol: 'mqtts',               // TLS บังคับสำหรับ HiveMQ Cloud
    username: CONFIG.HIVEMQ_USERNAME,
    password: CONFIG.HIVEMQ_PASSWORD,
    rejectUnauthorized: true,        // ตรวจสอบ SSL Certificate
    reconnectPeriod: 5000,           // reconnect อัตโนมัติทุก 5 วิ
});

mqttClient.on('connect', () => {
    console.log('✅ Connected to HiveMQ Cloud');
    mqttClient.subscribe('rtos/radar_data', (err) => {
        if (!err) console.log('📡 Subscribed to rtos/radar_data');
    });
});

mqttClient.on('error', (err) => {
    console.error('❌ MQTT Error:', err.message);
});

mqttClient.on('reconnect', () => {
    console.log('🔄 MQTT reconnecting...');
});

// รับข้อมูลจาก ESP32
mqttClient.on('message', async (topic, message) => {
    if (topic !== 'rtos/radar_data') return;
    if (!systemConfig.isSystemOn) return;

    try {
        const data = JSON.parse(message.toString());
        const hasObject = data.distance < 50;

        // 1. ส่งข้อมูลไปวาด Radar บน Dashboard
        const scanPayload = {
            angle:     data.angle,
            distance:  data.distance,
            hasObject,
        };
        io.emit('radar_scan', scanPayload);

        // 2. บันทึก radar scan ลง MongoDB
        await saveRadarScan(scanPayload);

        // 3. ถ้าเจอวัตถุ + เปิด Alert → ส่ง ALERT LOG
        if (hasObject && systemConfig.isAlertOn) {
            const logEntry = {
                type: 'ALERT',
                msg:  `Detected at ${data.angle}° - Range: ${data.distance}cm`,
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
    console.log('🌐 Web Dashboard Connected:', socket.id);

    // ส่ง config ปัจจุบันให้ client ที่เพิ่ง connect
    socket.emit('sync_config', systemConfig);

    // รับ config ใหม่จาก Dashboard
    socket.on('update_config', async (newConfig) => {
        // --- SYSTEM LOG: เปิด/ปิดระบบ ---
        if (newConfig.isSystemOn !== undefined && newConfig.isSystemOn !== systemConfig.isSystemOn) {
            const logEntry = {
                type: 'SYSTEM',
                msg:  newConfig.isSystemOn ? '🚀 System Initiated' : '🛑 System Shutdown',
                time: new Date().toLocaleTimeString(),
            };
            io.emit('new_log', logEntry);
            await saveLog(logEntry);
        }

        // --- SYSTEM LOG: เปลี่ยน Mode ---
        if (newConfig.mode !== undefined && newConfig.mode !== systemConfig.mode) {
            const logEntry = {
                type: 'SYSTEM',
                msg:  `Mode switched to: ${newConfig.mode}`,
                time: new Date().toLocaleTimeString(),
            };
            io.emit('new_log', logEntry);
            await saveLog(logEntry);
        }

        // อัปเดต in-memory config
        systemConfig = { ...systemConfig, ...newConfig };

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
//  REST API  — ดึงข้อมูลย้อนหลังจาก MongoDB
// ─────────────────────────────────────────

// GET /api/logs?limit=100
app.get('/api/logs', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const logs = await db.collection('logs')
            .find({})
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
        const limit = parseInt(req.query.limit) || 500;
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

// GET /api/config  — ดู config ปัจจุบัน
app.get('/api/config', (_req, res) => {
    res.json(systemConfig);
});

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