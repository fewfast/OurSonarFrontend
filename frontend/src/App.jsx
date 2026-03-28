import { useEffect, useState, useRef } from 'react';
import io from 'socket.io-client';

const socket = io('http://localhost:4000');

function App() {
  const [config, setConfig] = useState({
    isSystemOn: false,
    isAlertOn: false,
    mode: 'Static',
    degreeLimit: { min: 0, max: 180 },
    staticLimit: { min: 45, max: 135 }
  });
  
  const [currentAngle, setCurrentAngle] = useState(0); // เก็บองศาล่าสุดของ Radar
  const [alertLogs, setAlertLogs] = useState([]);
  const [systemLogs, setSystemLogs] = useState([]);
  const canvasRef = useRef(null);

  useEffect(() => {
    socket.on('sync_config', (data) => setConfig(data));
    
    // แยก Log ตามประเภทที่ได้รับจาก Backend
    socket.on('new_log', (log) => {
      if (log.type === 'ALERT') {
        setAlertLogs(prev => [log, ...prev].slice(0, 20));
      } else {
        setSystemLogs(prev => [log, ...prev].slice(0, 10));
      }
    });

    socket.on('radar_scan', (data) => {
      setCurrentAngle(data.angle); // อัปเดตองศาล่าสุด
      drawRadar(data);
    });

    return () => socket.off();
  }, []);

  const updateConfig = (patch) => socket.emit('update_config', patch);

  // ฟังก์ชันสั่งหมุน Radar ในโหมด Static
  const moveStatic = (direction) => {
    let newAngle = direction === 'left' ? currentAngle - 5 : currentAngle + 5;
    if (newAngle < 0) newAngle = 0;
    if (newAngle > 180) newAngle = 180;
    // ส่งค่าไปยัง Backend เพื่อสั่ง Hardware
    updateConfig({ currentStaticAngle: newAngle }); 
  };

  const drawRadar = (data) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = 'rgba(0, 15, 0, 0.2)';
    ctx.fillRect(0, 0, w, h);
    const rad = (data.angle * Math.PI) / 180;
    ctx.beginPath();
    ctx.strokeStyle = '#0f0';
    ctx.lineWidth = 3;
    ctx.moveTo(w / 2, h);
    ctx.lineTo(w / 2 + (w / 2) * Math.cos(Math.PI + rad), h + (w / 2) * Math.sin(Math.PI + rad));
    ctx.stroke();
  };

  return (
    <div style={{ padding: '20px', background: '#050505', color: '#0f0', minHeight: '100vh', fontFamily: 'monospace' }}>
      <h2 style={{ borderBottom: '2px solid #0f0', paddingBottom: '10px' }}>🛰️ RTOS RADAR COMMAND CENTER</h2>
      
      <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: '25px' }}>
        
        {/* Left Side: Controls */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          
          <div style={{ border: '1px solid #0f0', padding: '15px', borderRadius: '8px', background: '#0a0a0a' }}>
            <div style={{ display: 'flex', gap: '10px', marginBottom: '15px' }}>
              <button onClick={() => updateConfig({ isSystemOn: !config.isSystemOn })} 
                style={{ flex: 1, padding: '12px', cursor: 'pointer', background: config.isSystemOn ? '#ff4444' : '#008800', color: '#fff', border: 'none', fontWeight: 'bold' }}>
                {config.isSystemOn ? 'SHUTDOWN' : 'START SYSTEM'}
              </button>
              <button onClick={() => updateConfig({ isAlertOn: !config.isAlertOn })} 
                style={{ flex: 1, padding: '12px', cursor: 'pointer', background: config.isAlertOn ? '#0f0' : '#222', color: config.isAlertOn ? '#000' : '#0f0', border: '1px solid #0f0' }}>
                ALERT: {config.isAlertOn ? 'ON' : 'OFF'}
              </button>
            </div>

            <h4>MODE SELECTION</h4>
            <div style={{ display: 'flex', gap: '5px', marginBottom: '15px' }}>
              {['Roam', 'Track', 'Static'].map(m => (
                <button key={m} onClick={() => updateConfig({ mode: m })} 
                  style={{ flex: 1, padding: '10px', background: config.mode === m ? '#0f0' : '#111', color: config.mode === m ? '#000' : '#0f0', border: '1px solid #0f0', cursor: 'pointer' }}>
                  {m}
                </button>
              ))}
            </div>

            {/* คุมปุ่มลูกศรเฉพาะโหมด Static */}
            {config.mode === 'Static' && (
              <div style={{ textAlign: 'center', marginBottom: '15px', padding: '10px', border: '1px dashed #0f0' }}>
                <p style={{ margin: '0 0 10px 0' }}>MANUAL ROTATION</p>
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '20px' }}>
                  <button onClick={() => moveStatic('left')} style={{ padding: '10px 20px', fontSize: '20px', background: '#111', color: '#0f0', border: '1px solid #0f0' }}>⬅️</button>
                  <div style={{ fontSize: '24px', fontWeight: 'bold' }}>{currentAngle}°</div>
                  <button onClick={() => moveStatic('right')} style={{ padding: '10px 20px', fontSize: '20px', background: '#111', color: '#0f0', border: '1px solid #0f0' }}>➡️</button>
                </div>
              </div>
            )}

            {/* แสดง Detection Limit เฉพาะ Roam และ Track */}
            {(config.mode === 'Roam' || config.mode === 'Track') && (
              <>
                <h4>DETECTION LIMIT (SCAN RANGE)</h4>
                <div style={{ display: 'flex', gap: '10px', marginBottom: '15px' }}>
                  <div>Min: <input type="number" value={config.degreeLimit.min} onChange={(e) => updateConfig({ degreeLimit: {...config.degreeLimit, min: +e.target.value} })} style={{ width: '60px', background: '#000', color: '#0f0', border: '1px solid #0f0', padding: '5px' }} /></div>
                  <div>Max: <input type="number" value={config.degreeLimit.max} onChange={(e) => updateConfig({ degreeLimit: {...config.degreeLimit, max: +e.target.value} })} style={{ width: '60px', background: '#000', color: '#0f0', border: '1px solid #0f0', padding: '5px' }} /></div>
                </div>
              </>
            )}

            <h4>STATIC LIMIT (FIXED AREA)</h4>
            <div style={{ display: 'flex', gap: '10px' }}>
              <div>Min: <input type="number" value={config.staticLimit.min} onChange={(e) => updateConfig({ staticLimit: {...config.staticLimit, min: +e.target.value} })} style={{ width: '60px', background: '#000', color: '#0f0', border: '1px solid #0f0', padding: '5px' }} /></div>
              <div>Max: <input type="number" value={config.staticLimit.max} onChange={(e) => updateConfig({ staticLimit: {...config.staticLimit, max: +e.target.value} })} style={{ width: '60px', background: '#000', color: '#0f0', border: '1px solid #0f0', padding: '5px' }} /></div>
            </div>
          </div>

          {/* System Logs (ส่วนล่างซ้าย) */}
          <div style={{ border: '1px solid #008800', borderRadius: '8px', padding: '10px', background: '#051005' }}>
            <h5 style={{ margin: '0 0 10px 0', color: '#00ff00' }}>📟 SYSTEM LOGS</h5>
            <div style={{ height: '120px', overflowY: 'auto', fontSize: '11px' }}>
              {systemLogs.map((l, i) => (
                <div key={i} style={{ borderBottom: '1px solid #003300', padding: '2px 0' }}>
                  [{l.time}] {l.msg}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right Side: Radar & Alert Logs */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div style={{ textAlign: 'center', background: '#000', padding: '20px', border: '1px solid #0f0', borderRadius: '8px', boxShadow: '0 0 20px rgba(0,255,0,0.1)' }}>
            <canvas ref={canvasRef} width={600} height={300} style={{ maxWidth: '100%' }} />
            <div style={{ display: 'flex', justifyContent: 'around', marginTop: '10px', fontSize: '14px' }}>
              <span>MODE: <b style={{color: '#fff'}}>{config.mode.toUpperCase()}</b></span>
              <span style={{marginLeft: '20px'}}>SYSTEM: <b style={{color: config.isSystemOn ? '#0f0' : '#f00'}}>{config.isSystemOn ? 'ACTIVE' : 'OFFLINE'}</b></span>
            </div>
          </div>

          {/* Alert Logs (ส่วนขวา ล่างตัว Radar) */}
          <div style={{ border: '1px solid #ff0000', borderRadius: '8px', padding: '15px', background: '#100000' }}>
            <h4 style={{ margin: '0 0 10px 0', color: '#ff4444' }}>🚨 ALERT DETECTION LOGS (REAL-TIME)</h4>
            <div style={{ height: '250px', overflowY: 'auto', fontSize: '14px' }}>
              {alertLogs.map((l, i) => (
                <div key={i} style={{ color: '#ff4444', borderBottom: '1px solid #440000', padding: '8px 0', fontWeight: 'bold' }}>
                  [{l.time}] WARNING: {l.msg}
                </div>
              ))}
              {alertLogs.length === 0 && <p style={{color: '#444'}}>No detection events recorded...</p>}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

export default App;