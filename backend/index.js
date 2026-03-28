const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mqtt = require('mqtt');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// เชื่อมต่อ MQTT Broker (ตรวจสอบว่า Mosquitto รันอยู่)
const mqttClient = mqtt.connect('mqtt://localhost'); 

let systemConfig = {
    isSystemOn: false,
    isAlertOn: false,
    mode: 'Static',
    degreeLimit: { min: 0, max: 180 },
    staticLimit: { min: 45, max: 135 },
    currentStaticAngle: 90 // เก็บองศาเป้าหมายสำหรับโหมด Static
};

mqttClient.on('connect', () => {
    console.log('✅ Connected to MQTT Broker');
    mqttClient.subscribe('rtos/radar_data');
});

// รับข้อมูลจาก ESP32
mqttClient.on('message', (topic, message) => {
    if (topic === 'rtos/radar_data') {
        // ประมวลผลข้อมูลเมื่อเปิดระบบ (isSystemOn) เท่านั้น
        if (!systemConfig.isSystemOn) return;

        try {
            const data = JSON.parse(message.toString());
            
            // 1. ส่งข้อมูลไปวาด Radar
            io.emit('radar_scan', {
                angle: data.angle,
                distance: data.distance,
                hasObject: data.distance < 50
            });

            // 2. ถ้าเจอวัตถุ และเปิด Alert ไว้ -> ส่ง ALERT LOG
            if (data.distance < 50 && systemConfig.isAlertOn) {
                io.emit('new_log', {
                    type: 'ALERT',
                    msg: `Detected at ${data.angle}° - Range: ${data.distance}cm`,
                    time: new Date().toLocaleTimeString()
                });
            }
        } catch (e) {
            console.error("MQTT JSON Parse Error");
        }
    }
});

io.on('connection', (socket) => {
    console.log('🌐 Web Dashboard Connected');
    socket.emit('sync_config', systemConfig);

    socket.on('update_config', (newConfig) => {
        // ตรวจสอบการเปลี่ยนแปลงที่สำคัญเพื่อสร้าง SYSTEM LOG
        if (newConfig.isSystemOn !== undefined && newConfig.isSystemOn !== systemConfig.isSystemOn) {
            io.emit('new_log', {
                type: 'SYSTEM',
                msg: newConfig.isSystemOn ? '🚀 System Initiated' : '🛑 System Shutdown',
                time: new Date().toLocaleTimeString()
            });
        }

        if (newConfig.mode !== undefined && newConfig.mode !== systemConfig.mode) {
            io.emit('new_log', {
                type: 'SYSTEM',
                msg: `Mode switched to: ${newConfig.mode}`,
                time: new Date().toLocaleTimeString()
            });
        }

        // อัปเดตค่า Config
        systemConfig = { ...systemConfig, ...newConfig };
        
        // ส่งค่าไปให้ ESP32 ผ่าน MQTT
        mqttClient.publish('rtos/set_config', JSON.stringify(systemConfig));
        
        // อัปเดตสถานะให้หน้าเว็บทุกหน้าจอ
        io.emit('sync_config', systemConfig);
    });
});

server.listen(4000, () => {
    console.log('🚀 RTOS Command Server running on port 4000');
});