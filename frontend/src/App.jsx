import { useEffect, useState, useRef, useCallback } from 'react';
import io from 'socket.io-client';

const socket = io('http://localhost:4000');

// ─────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────
const CANVAS_W = 600;
const CANVAS_H = 300;
const CX = CANVAS_W / 2;
const CY = CANVAS_H;
const RADAR_R = CANVAS_H - 20;

function App() {
  const [config, setConfig] = useState({
    isSystemOn: false,
    isAlertOn: false,
    mode: 'Static',
    degreeLimit: { min: 0, max: 180 },
    staticLimit: { min: 45, max: 135 },
    currentStaticAngle: 90,
    maxDetectCm: 100,   // ← ใหม่
    redZoneCm:   30,    // ← ใหม่
  });

  const [currentAngle, setCurrentAngle] = useState(90);
  const [alertLogs, setAlertLogs] = useState([]);
  const [systemLogs, setSystemLogs] = useState([]);
  const canvasRef = useRef(null);

  // ─────────────────────────────────────────
  //  วาด Radar Grid ว่างๆ (ตอน mount)
  // ─────────────────────────────────────────
  const drawEmptyRadar = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // วาด Arc Grid
    [0.25, 0.5, 0.75, 1].forEach((scale) => {
      ctx.beginPath();
      ctx.arc(CX, CY, RADAR_R * scale, Math.PI, 2 * Math.PI);
      ctx.strokeStyle = '#003300';
      ctx.lineWidth = 1;
      ctx.stroke();
    });

    // วาดเส้น degree แบ่ง 30°
    for (let deg = 0; deg <= 180; deg += 30) {
      const rad = (deg * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(CX, CY);
      ctx.lineTo(CX + RADAR_R * Math.cos(Math.PI - rad), CY - RADAR_R * Math.sin(rad));
      ctx.strokeStyle = '#002200';
      ctx.lineWidth = 0.5;
      ctx.stroke();

      // Label degree
      const lx = CX + (RADAR_R + 12) * Math.cos(Math.PI - rad);
      const ly = CY - (RADAR_R + 12) * Math.sin(rad);
      ctx.fillStyle = '#005500';
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${deg}°`, lx, ly + 4);
    }
  }, []);

  // ─────────────────────────────────────────
  //  วาด Radar Sweep (รับ data จาก Socket)
  //  ── ใหม่: dot สีแดงเข้ม = red zone, แดงปกติ = detect ──
  // ─────────────────────────────────────────
  const drawRadar = useCallback((data, cfg) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // Trail fade effect
    ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // วาด Arc Grid (วาดซ้ำเพื่อไม่ให้หายตาม fade)
    [0.25, 0.5, 0.75, 1].forEach((scale) => {
      ctx.beginPath();
      ctx.arc(CX, CY, RADAR_R * scale, Math.PI, 2 * Math.PI);
      ctx.strokeStyle = '#002800';
      ctx.lineWidth = 1;
      ctx.stroke();
    });

    // ── ใหม่: วาด Red Zone arc ──
    if (cfg && cfg.maxDetectCm > 0) {
      const redRatio = Math.min(cfg.redZoneCm / cfg.maxDetectCm, 1);
      ctx.beginPath();
      ctx.arc(CX, CY, RADAR_R * redRatio, Math.PI, 2 * Math.PI);
      ctx.strokeStyle = 'rgba(255, 50, 50, 0.35)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const rad = (data.angle * Math.PI) / 180;
    const ex = CX + RADAR_R * Math.cos(Math.PI - rad);
    const ey = CY - RADAR_R * Math.sin(rad);

    // Sweep Line (สีเขียวสว่าง)
    ctx.beginPath();
    ctx.moveTo(CX, CY);
    ctx.lineTo(ex, ey);
    ctx.strokeStyle = '#00ff00';
    ctx.lineWidth = 2;
    ctx.shadowColor = '#00ff00';
    ctx.shadowBlur = 6;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // จุดวัตถุที่ตรวจพบ
    if (data.hasObject && data.distance > 0 && cfg && cfg.maxDetectCm > 0) {
      const ratio = Math.min(data.distance / cfg.maxDetectCm, 1);
      const dotR = ratio * RADAR_R;
      const dx = CX + dotR * Math.cos(Math.PI - rad);
      const dy = CY - dotR * Math.sin(rad);

      // สีต่างกันถ้าอยู่ใน red zone
      const isRed = data.inRedZone;
      ctx.beginPath();
      ctx.arc(dx, dy, isRed ? 8 : 6, 0, 2 * Math.PI);
      ctx.fillStyle   = isRed ? '#ff0000' : '#ff8800';
      ctx.shadowColor = isRed ? '#ff0000' : '#ff8800';
      ctx.shadowBlur  = isRed ? 16 : 8;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }, []);

  // ─────────────────────────────────────────
  //  Socket.IO Events
  // ─────────────────────────────────────────
  // เก็บ config ref เพื่อใช้ใน drawRadar โดยไม่ต้อง re-subscribe socket
  const configRef = useRef(config);
  useEffect(() => { configRef.current = config; }, [config]);

  useEffect(() => {
    socket.on('sync_config', (data) => {
      setConfig(data);
      if (data.currentStaticAngle !== undefined) {
        setCurrentAngle(data.currentStaticAngle);
      }
    });

    socket.on('new_log', (log) => {
      if (log.type === 'ALERT') {
        setAlertLogs((prev) => [log, ...prev].slice(0, 20));
      } else {
        setSystemLogs((prev) => [log, ...prev].slice(0, 10));
      }
    });

    socket.on('radar_scan', (data) => {
      setCurrentAngle(data.angle);
      drawRadar(data, configRef.current);
    });

    return () => socket.off();
  }, [drawRadar]);

  // วาด Empty Grid ตอน Mount
  useEffect(() => {
    drawEmptyRadar();
  }, [drawEmptyRadar]);

  // Clear Canvas เมื่อ Mode เปลี่ยน
  useEffect(() => {
    drawEmptyRadar();
  }, [config.mode, drawEmptyRadar]);

  // ─────────────────────────────────────────
  //  Helpers
  // ─────────────────────────────────────────
  const updateConfig = (patch) => socket.emit('update_config', patch);

  const moveStatic = (direction) => {
    let newAngle = direction === 'left' ? currentAngle - 5 : currentAngle + 5;
    newAngle = Math.max(0, Math.min(180, newAngle));
    setCurrentAngle(newAngle);
    updateConfig({ currentStaticAngle: newAngle });
  };

  const clamp = (val, min = 0, max = 180) => Math.max(min, Math.min(max, Number(val)));

  // ─────────────────────────────────────────
  //  Styles
  // ─────────────────────────────────────────
  const s = {
    page:    { padding: '20px', background: '#050505', color: '#0f0', minHeight: '100vh', fontFamily: 'monospace' },
    grid:    { display: 'grid', gridTemplateColumns: '380px 1fr', gap: '25px' },
    col:     { display: 'flex', flexDirection: 'column', gap: '20px' },
    panel:   { border: '1px solid #0f0', padding: '15px', borderRadius: '8px', background: '#0a0a0a' },
    input:   { width: '60px', background: '#000', color: '#0f0', border: '1px solid #0f0', padding: '5px' },
    inputRed:{ width: '60px', background: '#000', color: '#ff4444', border: '1px solid #ff4444', padding: '5px' },
    btnPrim: (active) => ({
      flex: 1, padding: '12px', cursor: 'pointer',
      background: active ? '#ff4444' : '#008800', color: '#fff', border: 'none', fontWeight: 'bold',
    }),
    btnSec:  (active) => ({
      flex: 1, padding: '12px', cursor: 'pointer',
      background: active ? '#0f0' : '#222', color: active ? '#000' : '#0f0', border: '1px solid #0f0',
    }),
    btnMode: (active) => ({
      flex: 1, padding: '10px',
      background: active ? '#0f0' : '#111', color: active ? '#000' : '#0f0',
      border: '1px solid #0f0', cursor: 'pointer',
    }),
    btnArrow: { padding: '10px 20px', fontSize: '20px', background: '#111', color: '#0f0', border: '1px solid #0f0', cursor: 'pointer' },
  };

  // คำนวณ % red zone สำหรับ visual bar
  const redPct = config.maxDetectCm > 0
    ? Math.min((config.redZoneCm / config.maxDetectCm) * 100, 100).toFixed(0)
    : 0;

  return (
    <div style={s.page}>
      <h2 style={{ borderBottom: '2px solid #0f0', paddingBottom: '10px' }}>🛰️ RTOS RADAR COMMAND CENTER</h2>

      <div style={s.grid}>

        {/* ── Left: Controls ── */}
        <div style={s.col}>
          <div style={s.panel}>

            {/* System & Alert Buttons */}
            <div style={{ display: 'flex', gap: '10px', marginBottom: '15px' }}>
              <button onClick={() => updateConfig({ isSystemOn: !config.isSystemOn })} style={s.btnPrim(config.isSystemOn)}>
                {config.isSystemOn ? 'SHUTDOWN' : 'START SYSTEM'}
              </button>
              <button onClick={() => updateConfig({ isAlertOn: !config.isAlertOn })} style={s.btnSec(config.isAlertOn)}>
                ALERT: {config.isAlertOn ? 'ON' : 'OFF'}
              </button>
            </div>

            {/* Mode Selection */}
            <h4 style={{ margin: '0 0 8px 0' }}>MODE SELECTION</h4>
            <div style={{ display: 'flex', gap: '5px', marginBottom: '15px' }}>
              {['Roam', 'Track', 'Static'].map((m) => (
                <button key={m} onClick={() => updateConfig({ mode: m })} style={s.btnMode(config.mode === m)}>
                  {m}
                </button>
              ))}
            </div>

            {/* Static Mode: Manual Rotation */}
            {config.mode === 'Static' && (
              <div style={{ textAlign: 'center', marginBottom: '15px', padding: '10px', border: '1px dashed #0f0' }}>
                <p style={{ margin: '0 0 10px 0', fontSize: '12px', letterSpacing: '1px' }}>MANUAL ROTATION</p>
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '20px' }}>
                  <button onClick={() => moveStatic('left')} style={s.btnArrow}>⬅️</button>
                  <div style={{ fontSize: '28px', fontWeight: 'bold', minWidth: '70px', textAlign: 'center' }}>
                    {currentAngle}°
                  </div>
                  <button onClick={() => moveStatic('right')} style={s.btnArrow}>➡️</button>
                </div>
                <input
                  type="range" min="0" max="180" value={currentAngle}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setCurrentAngle(v);
                    updateConfig({ currentStaticAngle: v });
                  }}
                  style={{ width: '100%', marginTop: '10px', accentColor: '#0f0' }}
                />
              </div>
            )}

            {/* Roam/Track: Detection Limit */}
            {(config.mode === 'Roam' || config.mode === 'Track') && (
              <>
                <h4 style={{ margin: '0 0 8px 0' }}>DETECTION LIMIT (SCAN RANGE)</h4>
                <div style={{ display: 'flex', gap: '10px', marginBottom: '15px' }}>
                  <div>
                    Min:{' '}
                    <input
                      type="number" min="0" max="180"
                      value={config.degreeLimit.min}
                      onChange={(e) =>
                        updateConfig({ degreeLimit: { ...config.degreeLimit, min: clamp(e.target.value) } })
                      }
                      style={s.input}
                    />
                  </div>
                  <div>
                    Max:{' '}
                    <input
                      type="number" min="0" max="180"
                      value={config.degreeLimit.max}
                      onChange={(e) =>
                        updateConfig({ degreeLimit: { ...config.degreeLimit, max: clamp(e.target.value) } })
                      }
                      style={s.input}
                    />
                  </div>
                </div>
              </>
            )}

            {/* Static Limit */}
            <h4 style={{ margin: '0 0 8px 0' }}>STATIC LIMIT (FIXED AREA)</h4>
            <div style={{ display: 'flex', gap: '10px', marginBottom: '15px' }}>
              <div>
                Min:{' '}
                <input
                  type="number" min="0" max="180"
                  value={config.staticLimit.min}
                  onChange={(e) =>
                    updateConfig({ staticLimit: { ...config.staticLimit, min: clamp(e.target.value) } })
                  }
                  style={s.input}
                />
              </div>
              <div>
                Max:{' '}
                <input
                  type="number" min="0" max="180"
                  value={config.staticLimit.max}
                  onChange={(e) =>
                    updateConfig({ staticLimit: { ...config.staticLimit, max: clamp(e.target.value) } })
                  }
                  style={s.input}
                />
              </div>
            </div>

            {/* ── ใหม่: Max Detect ── */}
            <h4 style={{ margin: '0 0 8px 0' }}>MAX DETECT (RANGE)</h4>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '15px' }}>
              <input
                type="number" min="1" max="500"
                value={config.maxDetectCm}
                onChange={(e) => updateConfig({ maxDetectCm: clamp(e.target.value, 1, 500) })}
                style={{ ...s.input, width: '70px' }}
              />
              <span style={{ fontSize: '12px', color: '#555' }}>cm &nbsp;(1 – 500 cm)</span>
            </div>

            {/* ── ใหม่: Red Zone ── */}
            <h4 style={{ margin: '0 0 8px 0', color: '#ff4444' }}>⚠ RED ZONE (ALERT THRESHOLD)</h4>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
              <input
                type="number" min="1" max="499"
                value={config.redZoneCm}
                onChange={(e) => updateConfig({ redZoneCm: clamp(e.target.value, 1, 499) })}
                style={s.inputRed}
              />
              <span style={{ fontSize: '12px', color: '#883333' }}>cm &nbsp;(ต้องน้อยกว่า Max Detect)</span>
            </div>

            {/* Visual range bar */}
            <div style={{ position: 'relative', height: '18px', background: '#001a00', borderRadius: '4px', overflow: 'hidden', border: '1px solid #003300' }}>
              {/* Red zone fill */}
              <div style={{
                position: 'absolute', left: 0, top: 0, height: '100%',
                width: `${redPct}%`,
                background: '#3a0000',
                borderRight: '2px solid #ff4444',
                transition: 'width 0.3s',
              }} />
              <span style={{ position: 'absolute', left: '5px', top: '2px', fontSize: '10px', color: '#ff4444', pointerEvents: 'none' }}>
                RED 0–{config.redZoneCm}cm
              </span>
              <span style={{ position: 'absolute', right: '5px', top: '2px', fontSize: '10px', color: '#005500', pointerEvents: 'none' }}>
                MAX {config.maxDetectCm}cm
              </span>
            </div>

          </div>

          {/* System Logs */}
          <div style={{ border: '1px solid #008800', borderRadius: '8px', padding: '10px', background: '#051005' }}>
            <h5 style={{ margin: '0 0 10px 0', color: '#00ff00' }}>📟 SYSTEM LOGS</h5>
            <div style={{ height: '150px', overflowY: 'auto', fontSize: '11px' }}>
              {systemLogs.length === 0 && (
                <p style={{ color: '#333', margin: 0 }}>No system events...</p>
              )}
              {systemLogs.map((l, i) => (
                <div key={i} style={{ borderBottom: '1px solid #003300', padding: '3px 0' }}>
                  <span style={{ color: '#005500' }}>[{l.time}]</span> {l.msg}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Right: Radar + Alert Logs ── */}
        <div style={s.col}>

          {/* Radar Canvas */}
          <div style={{ background: '#000', padding: '20px', border: '1px solid #0f0', borderRadius: '8px', boxShadow: '0 0 20px rgba(0,255,0,0.1)', textAlign: 'center' }}>
            <canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H} style={{ maxWidth: '100%', display: 'block', margin: '0 auto' }} />
            <div style={{ display: 'flex', justifyContent: 'center', gap: '20px', marginTop: '10px', fontSize: '13px', flexWrap: 'wrap' }}>
              <span>MODE: <b style={{ color: '#fff' }}>{config.mode.toUpperCase()}</b></span>
              <span>SYSTEM: <b style={{ color: config.isSystemOn ? '#0f0' : '#f00' }}>{config.isSystemOn ? 'ACTIVE' : 'OFFLINE'}</b></span>
              <span>ALERT: <b style={{ color: config.isAlertOn ? '#ff0' : '#555' }}>{config.isAlertOn ? 'ARMED' : 'OFF'}</b></span>
              <span>ANGLE: <b style={{ color: '#0ff' }}>{currentAngle}°</b></span>
              <span>MAX: <b style={{ color: '#0f0' }}>{config.maxDetectCm}cm</b></span>
              <span>RED: <b style={{ color: '#f44' }}>{config.redZoneCm}cm</b></span>
            </div>
          </div>

          {/* Alert Logs */}
          <div style={{ border: '1px solid #ff0000', borderRadius: '8px', padding: '15px', background: '#100000' }}>
            <h4 style={{ margin: '0 0 10px 0', color: '#ff4444' }}>
              🚨 ALERT DETECTION LOGS (REAL-TIME)
              {alertLogs.length > 0 && (
                <button
                  onClick={() => setAlertLogs([])}
                  style={{ marginLeft: '10px', padding: '2px 8px', background: 'transparent', color: '#ff4444', border: '1px solid #ff4444', cursor: 'pointer', fontSize: '11px' }}
                >
                  CLEAR
                </button>
              )}
            </h4>
            <div style={{ height: '250px', overflowY: 'auto', fontSize: '14px' }}>
              {alertLogs.map((l, i) => (
                <div key={i} style={{ color: '#ff4444', borderBottom: '1px solid #440000', padding: '8px 0', fontWeight: 'bold' }}>
                  <span style={{ color: '#880000' }}>[{l.time}]</span> WARNING: {l.msg}
                </div>
              ))}
              {alertLogs.length === 0 && <p style={{ color: '#444', margin: 0 }}>No detection events recorded...</p>}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

export default App;