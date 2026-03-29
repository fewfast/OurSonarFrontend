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
    maxDetectCm: 100,
    redZoneCm: 30,
  });

  const [currentAngle, setCurrentAngle] = useState(90);
  const [alertLogs, setAlertLogs] = useState([]);
  const [alertFilter, setAlertFilter] = useState('all');
  const [systemLogs, setSystemLogs] = useState([]);
  const [esp32Status, setEsp32Status] = useState('OFFLINE');

  const [draft, setDraft] = useState({
    degreeMin: '0',
    degreeMax: '180',
    maxDetect: '100',
    redZone:   '30',
  });

  const [errors, setErrors] = useState({
    degreeMin: '',
    degreeMax: '',
    maxDetect: '',
    redZone:   '',
  });

  const canvasRef = useRef(null);

  const syncDraftFromConfig = (cfg) => {
    setDraft({
      degreeMin: String(cfg.degreeLimit.min),
      degreeMax: String(cfg.degreeLimit.max),
      maxDetect: String(cfg.maxDetectCm),
      redZone:   String(cfg.redZoneCm),
    });
    setErrors({ degreeMin: '', degreeMax: '', maxDetect: '', redZone: '' });
  };

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

    [0.25, 0.5, 0.75, 1].forEach((scale) => {
      ctx.beginPath();
      ctx.arc(CX, CY, RADAR_R * scale, Math.PI, 2 * Math.PI);
      ctx.strokeStyle = '#003300';
      ctx.lineWidth = 1;
      ctx.stroke();
    });

    for (let deg = 0; deg <= 180; deg += 30) {
      const rad = (deg * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(CX, CY);
      ctx.lineTo(CX + RADAR_R * Math.cos(Math.PI - rad), CY - RADAR_R * Math.sin(rad));
      ctx.strokeStyle = '#002200';
      ctx.lineWidth = 0.5;
      ctx.stroke();

      const lx = CX + (RADAR_R + 12) * Math.cos(Math.PI - rad);
      const ly = CY - (RADAR_R + 12) * Math.sin(rad);
      ctx.fillStyle = '#005500';
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${deg}°`, lx, ly + 4);
    }
  }, []);

  // ─────────────────────────────────────────
  //  วาด Radar Sweep
  // ─────────────────────────────────────────
  const drawRadar = useCallback((data, cfg) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    [0.25, 0.5, 0.75, 1].forEach((scale) => {
      ctx.beginPath();
      ctx.arc(CX, CY, RADAR_R * scale, Math.PI, 2 * Math.PI);
      ctx.strokeStyle = '#002800';
      ctx.lineWidth = 1;
      ctx.stroke();
    });

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

    ctx.beginPath();
    ctx.moveTo(CX, CY);
    ctx.lineTo(ex, ey);
    ctx.strokeStyle = '#00ff00';
    ctx.lineWidth = 2;
    ctx.shadowColor = '#00ff00';
    ctx.shadowBlur = 6;
    ctx.stroke();
    ctx.shadowBlur = 0;

    if (data.hasObject && data.distance > 0 && cfg && cfg.maxDetectCm > 0) {
      const ratio = Math.min(data.distance / cfg.maxDetectCm, 1);
      const dotR = ratio * RADAR_R;
      const dx = CX + dotR * Math.cos(Math.PI - rad);
      const dy = CY - dotR * Math.sin(rad);

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
  const configRef = useRef(config);
  useEffect(() => { configRef.current = config; }, [config]);

  useEffect(() => {
    socket.on('sync_config', (data) => {
      setConfig(data);
      syncDraftFromConfig(data);
      if (data.currentStaticAngle !== undefined) {
        setCurrentAngle(data.currentStaticAngle);
      }
    });

    socket.on('new_log', (log) => {
      if (log.type === 'ALERT') {
        const enriched = { ...log, zone: log.zone ?? (log.inRedZone ? 'redzone' : 'notice') };
        setAlertLogs((prev) => [enriched, ...prev].slice(0, 20));
      } else {
        setSystemLogs((prev) => [log, ...prev].slice(0, 10));
      }
    });

    socket.on('radar_scan', (data) => {
      setCurrentAngle(data.angle);
      drawRadar(data, configRef.current);
    });

    socket.on('esp32_status', (status) => {
      setEsp32Status(status);
    });

    return () => socket.off();
  }, [drawRadar]);

  useEffect(() => { drawEmptyRadar(); }, [drawEmptyRadar]);
  useEffect(() => { drawEmptyRadar(); }, [config.mode, drawEmptyRadar]);

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

  const toInt = (raw) => parseInt(raw, 10);

  // ─────────────────────────────────────────
  //  Live onChange handlers
  // ─────────────────────────────────────────
  const handleDegreeMin = (raw) => {
    setDraft((d) => ({ ...d, degreeMin: raw }));
    const val = toInt(raw);
    if (isNaN(val) || val < 0 || val > 180) {
      setErrors((e) => ({ ...e, degreeMin: 'ต้องเป็นตัวเลข 0–180°' }));
      return;
    }
    if (val >= config.degreeLimit.max) {
      setErrors((e) => ({ ...e, degreeMin: `Min ต้องน้อยกว่า Max (${config.degreeLimit.max}°)` }));
      return;
    }
    setErrors((e) => ({ ...e, degreeMin: '' }));
    setConfig((c) => ({ ...c, degreeLimit: { ...c.degreeLimit, min: val } }));
    updateConfig({ degreeLimit: { ...config.degreeLimit, min: val } });
  };

  const handleDegreeMax = (raw) => {
    setDraft((d) => ({ ...d, degreeMax: raw }));
    const val = toInt(raw);
    if (isNaN(val) || val < 0 || val > 180) {
      setErrors((e) => ({ ...e, degreeMax: 'ต้องเป็นตัวเลข 0–180°' }));
      return;
    }
    if (val <= config.degreeLimit.min) {
      setErrors((e) => ({ ...e, degreeMax: `Max ต้องมากกว่า Min (${config.degreeLimit.min}°)` }));
      return;
    }
    setErrors((e) => ({ ...e, degreeMax: '' }));
    setConfig((c) => ({ ...c, degreeLimit: { ...c.degreeLimit, max: val } }));
    updateConfig({ degreeLimit: { ...config.degreeLimit, max: val } });
  };

  const handleMaxDetect = (raw) => {
    setDraft((d) => ({ ...d, maxDetect: raw }));
    const val = toInt(raw);
    if (isNaN(val) || val < 1 || val > 500) {
      setErrors((e) => ({ ...e, maxDetect: 'ต้องเป็นตัวเลข 1–500 cm' }));
      return;
    }
    if (val < config.redZoneCm) {
      setErrors((e) => ({ ...e, maxDetect: `Max Detect ต้องไม่น้อยกว่า Red Zone (${config.redZoneCm} cm)` }));
      return;
    }
    setErrors((e) => ({ ...e, maxDetect: '' }));
    setConfig((c) => ({ ...c, maxDetectCm: val }));
    updateConfig({ maxDetectCm: val });
  };

  const handleRedZone = (raw) => {
    setDraft((d) => ({ ...d, redZone: raw }));
    const val = toInt(raw);
    if (isNaN(val) || val < 1 || val > 500) {
      setErrors((e) => ({ ...e, redZone: 'ต้องเป็นตัวเลข 1–500 cm' }));
      return;
    }
    if (val > config.maxDetectCm) {
      setErrors((e) => ({ ...e, redZone: `Red Zone ต้องไม่เกิน Max Detect (${config.maxDetectCm} cm)` }));
      return;
    }
    setErrors((e) => ({ ...e, redZone: '' }));
    setConfig((c) => ({ ...c, redZoneCm: val }));
    updateConfig({ redZoneCm: val });
  };

  // ─────────────────────────────────────────
  //  Filtered logs
  // ─────────────────────────────────────────
  const filteredAlertLogs = alertFilter === 'all'
    ? alertLogs
    : alertLogs.filter((l) => l.zone === alertFilter);

  // ─────────────────────────────────────────
  //  Log zone theme  ← จุดที่เปลี่ยนสี
  //  notice  = ขาว/เทาสว่าง
  //  redzone = แดง
  // ─────────────────────────────────────────
  const zoneTheme = {
    notice: {
      rowBorder:  '#2a2a2a',
      timeColor:  '#888888',
      textColor:  '#e8e8e8',
      badgeColor: '#cccccc',
      badgeBg:    '#1e1e1e',
      badgeBorder:'#555555',
      badgeLabel: 'NOTICE',
    },
    redzone: {
      rowBorder:  '#440000',
      timeColor:  '#880000',
      textColor:  '#ff2222',
      badgeColor: '#ff2222',
      badgeBg:    '#2a0000',
      badgeBorder:'#ff2222',
      badgeLabel: 'RED ZONE',
    },
  };

  // ─────────────────────────────────────────
  //  Styles
  // ─────────────────────────────────────────
  const s = {
    page:     { padding: '20px', background: '#050505', color: '#0f0', minHeight: '100vh', fontFamily: 'monospace' },
    grid:     { display: 'grid', gridTemplateColumns: '380px 1fr', gap: '25px' },
    col:      { display: 'flex', flexDirection: 'column', gap: '20px' },
    panel:    { border: '1px solid #0f0', padding: '15px', borderRadius: '8px', background: '#0a0a0a' },
    input:    { width: '70px', background: '#000', color: '#0f0', border: '1px solid #0f0', padding: '5px', fontFamily: 'monospace' },
    inputRed: { width: '70px', background: '#000', color: '#ff4444', border: '1px solid #ff4444', padding: '5px', fontFamily: 'monospace' },
    inputErr: { width: '70px', background: '#1a0000', color: '#ff6666', border: '2px solid #ff4444', padding: '5px', fontFamily: 'monospace' },
    errMsg:   { color: '#ff4444', fontSize: '10px', marginTop: '3px', lineHeight: '1.4' },
    btnPrim: (active) => ({
      flex: 1, padding: '12px', cursor: 'pointer',
      background: active ? '#ff4444' : '#008800', color: '#fff', border: 'none', fontWeight: 'bold',
    }),
    btnSec: (active) => ({
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

  const redPct = config.maxDetectCm > 0
    ? Math.min((config.redZoneCm / config.maxDetectCm) * 100, 100).toFixed(0)
    : 0;

  const filterTabs = [
    { key: 'all',     label: 'ALL',      color: '#aaaaaa', activeBg: '#1a1a1a' },
    { key: 'notice',  label: 'NOTICE',   color: '#cccccc', activeBg: '#1e1e1e' },
    { key: 'redzone', label: 'RED ZONE', color: '#ff2222', activeBg: '#2a0000' },
  ];

  const ErrMsg = ({ msg }) =>
    msg ? <div style={s.errMsg}>⚠ {msg}</div> : null;

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

            {/* Roam/Track: Rotation Limit */}
            {(config.mode === 'Roam' || config.mode === 'Track') && (
              <>
                <h4 style={{ margin: '0 0 8px 0' }}>Rotation LIMIT (SCAN RANGE 0–180°)</h4>
                <div style={{ display: 'flex', gap: '20px', marginBottom: '4px' }}>
                  <div>
                    <div style={{ marginBottom: '4px', fontSize: '12px', color: '#888' }}>Min</div>
                    <input
                      type="number" min="0" max="180"
                      value={draft.degreeMin}
                      onChange={(e) => handleDegreeMin(e.target.value)}
                      style={errors.degreeMin ? s.inputErr : s.input}
                    />
                  </div>
                  <div>
                    <div style={{ marginBottom: '4px', fontSize: '12px', color: '#888' }}>Max</div>
                    <input
                      type="number" min="0" max="180"
                      value={draft.degreeMax}
                      onChange={(e) => handleDegreeMax(e.target.value)}
                      style={errors.degreeMax ? s.inputErr : s.input}
                    />
                  </div>
                </div>
                <ErrMsg msg={errors.degreeMin} />
                <ErrMsg msg={errors.degreeMax} />
                <div style={{ marginBottom: '15px' }} />
              </>
            )}

            {/* Max Detect */}
            <h4 style={{ margin: '0 0 8px 0' }}>MAX DETECT (RANGE)</h4>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
              <input
                type="number" min="1" max="500"
                value={draft.maxDetect}
                onChange={(e) => handleMaxDetect(e.target.value)}
                style={errors.maxDetect ? s.inputErr : s.input}
              />
              <span style={{ fontSize: '12px', color: '#555' }}>cm &nbsp;(1 – 500)</span>
            </div>
            <ErrMsg msg={errors.maxDetect} />
            <div style={{ marginBottom: '15px' }} />

            {/* Red Zone */}
            <h4 style={{ margin: '0 0 8px 0', color: '#ff4444' }}>⚠ RED ZONE (ALERT THRESHOLD)</h4>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
              <input
                type="number" min="1" max="500"
                value={draft.redZone}
                onChange={(e) => handleRedZone(e.target.value)}
                style={errors.redZone ? s.inputErr : s.inputRed}
              />
              <span style={{ fontSize: '12px', color: '#883333' }}>cm &nbsp;(≤ Max Detect)</span>
            </div>
            <ErrMsg msg={errors.redZone} />
            <div style={{ marginBottom: '10px' }} />

            {/* Visual range bar */}
            <div style={{ position: 'relative', height: '18px', background: '#001a00', borderRadius: '4px', overflow: 'hidden', border: '1px solid #003300' }}>
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
              {systemLogs.length === 0 && <p style={{ color: '#333', margin: 0 }}>No system events...</p>}
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
              <span>
                ESP32:{' '}
                <b style={{ color: esp32Status === 'ONLINE' ? '#0f0' : '#f00' }}>
                  {esp32Status === 'ONLINE' ? '🟢 ONLINE' : '🔴 OFFLINE'}
                </b>
              </span>
            </div>
          </div>

          {/* Alert Logs */}
          <div style={{ border: '1px solid #ff0000', borderRadius: '8px', padding: '15px', background: '#100000' }}>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px', flexWrap: 'wrap', gap: '8px' }}>
              <h4 style={{ margin: 0, color: '#ff4444' }}>🚨 ALERT DETECTION LOGS (REAL-TIME)</h4>
              {alertLogs.length > 0 && (
                <button
                  onClick={() => setAlertLogs([])}
                  style={{ padding: '2px 8px', background: 'transparent', color: '#ff4444', border: '1px solid #ff4444', cursor: 'pointer', fontSize: '11px', fontFamily: 'monospace' }}
                >
                  CLEAR
                </button>
              )}
            </div>

            {/* Filter Tabs */}
            <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
              {filterTabs.map(({ key, label, color, activeBg }) => {
                const isActive = alertFilter === key;
                const count = key === 'all' ? alertLogs.length : alertLogs.filter((l) => l.zone === key).length;
                return (
                  <button
                    key={key}
                    onClick={() => setAlertFilter(key)}
                    style={{
                      flex: 1, padding: '6px 4px', fontFamily: 'monospace',
                      fontSize: '11px', fontWeight: 'bold', cursor: 'pointer',
                      borderRadius: '4px', border: `1px solid ${color}`,
                      background: isActive ? activeBg : 'transparent',
                      color: color, opacity: isActive ? 1 : 0.45,
                      transition: 'opacity 0.15s, background 0.15s',
                    }}
                  >
                    {label}
                    {count > 0 && (
                      <span style={{ marginLeft: '5px', background: color, color: '#000', borderRadius: '8px', padding: '0 5px', fontSize: '10px', fontWeight: 'bold' }}>
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Log List */}
            <div style={{ height: '250px', overflowY: 'auto', fontSize: '13px' }}>
              {filteredAlertLogs.length === 0 && (
                <p style={{ color: '#444', margin: 0 }}>No detection events recorded...</p>
              )}
              {filteredAlertLogs.map((l, i) => {
                const t = zoneTheme[l.zone] ?? zoneTheme.notice;
                return (
                  <div key={i} style={{ borderBottom: `1px solid ${t.rowBorder}`, padding: '7px 0', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={{ color: t.timeColor, fontSize: '11px', whiteSpace: 'nowrap' }}>[{l.time}]</span>
                    <span style={{
                      background: t.badgeBg,
                      color: t.badgeColor,
                      border: `1px solid ${t.badgeBorder}`,
                      fontSize: '9px',
                      padding: '1px 5px',
                      borderRadius: '3px',
                      whiteSpace: 'nowrap',
                      fontWeight: 'bold',
                      letterSpacing: '0.5px',
                    }}>
                      {t.badgeLabel}
                    </span>
                    <span style={{ color: t.textColor, fontWeight: 'bold', fontSize: '12px' }}>
                      WARNING: {l.msg}
                    </span>
                  </div>
                );
              })}
            </div>

          </div>

        </div>
      </div>
    </div>
  );
}

export default App;