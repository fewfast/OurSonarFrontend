import { useEffect, useState, useRef, useCallback } from "react";
import io from "socket.io-client";

const BACKEND_URL = "https://oursonarbackend.onrender.com";
const socket = io(BACKEND_URL, {
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 20000,
});

const CANVAS_W = 600;
const CANVAS_H = 300;
const CX = CANVAS_W / 2;
const CY = CANVAS_H;
const RADAR_R = CANVAS_H - 20;
const REPORT_LIMIT = 10;

// ── แปลง frontend key → backend key ──
const toBackendPatch = (patch) => {
  const map = {
    isSystemOn: "isSystemStart",
    isAlertOn: "isAlert",
    mode: "mode",
    currentStaticAngle: "pos",
    maxDetectCm: "maxRange",
    redZoneCm: "RedZone",
    degreeLimit: null,
  };
  const result = {};
  for (const [key, val] of Object.entries(patch)) {
    if (key === "degreeLimit") {
      if (val.min !== undefined) result.minRotate = val.min;
      if (val.max !== undefined) result.maxRotate = val.max;
    } else if (map[key]) {
      result[map[key]] = val;
    }
  }
  return result;
};

// ── แปลง report record จาก DB → alert rows ──
const extractAlertRowsFromReport = (r) => {
  const d = r.data || {};
  const time = r.createdAt ? new Date(r.createdAt).toLocaleTimeString() : "—";
  const mode = d.mode || "—";

  if (d.type !== undefined && d.angle !== undefined) {
    const isRed = d.type === "RedZone";
    return [{
      time, mode,
      angle: d.angle,
      distance: d.distance,
      zone: isRed ? "redzone" : "notice",
      type: isRed ? "ALERT" : "NOTICE",
      msg: `Angle ${d.angle}°  |  ${parseFloat(d.distance ?? 0).toFixed(1)} cm`,
      hasObject: true,
      source: "db",
    }];
  }

  if (Array.isArray(d.objects) && d.objects.length > 0) {
    return d.objects.map((obj) => {
      const isRed = obj.type === "RedZone";
      return {
        time, mode,
        angle: obj.angle,
        distance: obj.distance,
        zone: isRed ? "redzone" : "notice",
        type: isRed ? "ALERT" : "NOTICE",
        msg: `Angle ${obj.angle}°  |  ${parseFloat(obj.distance ?? 0).toFixed(1)} cm`,
        hasObject: true,
        source: "db",
      };
    });
  }

  return [{
    time, mode,
    angle: null, distance: null,
    zone: "notice", type: "NOTICE",
    msg: "No object detected",
    hasObject: false,
    source: "db",
  }];
};

// ── แปลง report payload (live/db) → list of dot objects สำหรับ radar ──
// คืนค่าเป็น array ของ { angle, distance, isRed }
const extractDotsFromPayload = (data, maxDetectCm) => {
  if (!data) return [];
  const mode = data.mode;

  if (mode === "ROAM") {
    if (!Array.isArray(data.objects) || data.objects.length === 0) return [];
    return data.objects.map((obj) => ({
      angle: obj.angle,
      distance: obj.distance,
      isRed: obj.type === "RedZone",
    }));
  }

  if (mode === "TRACK") {
    if (data.angle === undefined || data.distance === undefined) return [];
    return [{
      angle: data.angle,
      distance: data.distance,
      isRed: data.type === "RedZone",
    }];
  }

  if (mode === "STATIC") {
    if (!data.detected || data.distance === undefined) return [];
    // STATIC ไม่มี angle → ใช้ currentAngle จาก config (ส่งมาใน call)
    return [{
      angle: data._staticAngle ?? 90, // inject จากภายนอก
      distance: data.distance,
      isRed: data.type === "RedZone",
    }];
  }

  return [];
};

// ── แปลงมุมจาก ESP32 degree → canvas radian ──
// 0° = ซ้ายสุด, 180° = ขวาสุด, 90° = ตรงกลาง
const degToRad = (deg) => (deg * Math.PI) / 180;

// ── คำนวณ (x, y) บน canvas จาก angle + distance ──
const dotPosition = (angle, distance, maxDetectCm) => {
  const rad = degToRad(angle); // 0°→ซ้าย, 90°→ขึ้นบน, 180°→ขวา
  const dist = Math.min(Math.max(distance, 0), maxDetectCm);
  const normalized = Math.pow(dist / maxDetectCm, 0.7);
  const r = normalized * RADAR_R;
  const x = CX - r * Math.cos(rad); // mirror: 0=ซ้าย
  const y = CY - r * Math.sin(rad);
  return { x, y };
};

function App() {
  // ── radar dots ──
  // เก็บเป็น snapshot ล่าสุดเท่านั้น: ข้อมูลใหม่มา = replace ทั้งหมด
  const [radarDots, setRadarDots] = useState([]);
  const radarDotsRef = useRef([]);

  const [config, setConfig] = useState({
    isSystemOn: false,
    isAlertOn: false,
    mode: "STATIC",
    degreeLimit: { min: 0, max: 180 },
    currentStaticAngle: 90,
    maxDetectCm: 100,
    redZoneCm: 30,
  });
  const configRef = useRef(config);
  useEffect(() => { configRef.current = config; }, [config]);

  const [expandedAlertRows, setExpandedAlertRows] = useState({});
  const [expandedReportRows, setExpandedReportRows] = useState({});

  const [currentAngle, setCurrentAngle] = useState(90);
  const [alertLogs, setAlertLogs] = useState([]);
  const [alertFilter, setAlertFilter] = useState("all");
  const [systemLogs, setSystemLogs] = useState([]);
  const [esp32Status, setEsp32Status] = useState("OFFLINE");
  const [esp32StatusDetail, setEsp32StatusDetail] = useState(null);
  const [socketConnected, setSocketConnected] = useState(false);

  const [reports, setReports] = useState([]);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportTab, setReportTab] = useState("history");
  const [activePanel, setActivePanel] = useState("control");
  const [reportPage, setReportPage] = useState(1);
  const [reportPagination, setReportPagination] = useState(null);

  const [draft, setDraft] = useState({
    degreeMin: "0", degreeMax: "180",
    maxDetect: "100", redZone: "30",
  });
  const [errors, setErrors] = useState({
    degreeMin: "", degreeMax: "",
    maxDetect: "", redZone: "",
  });

  const canvasRef = useRef(null);

  const addSystemLog = (msg) => {
    setSystemLogs((prev) =>
      [{ time: new Date().toLocaleTimeString(), msg }, ...prev].slice(0, 10)
    );
  };

  const syncFromBackendState = (data) => {
    setConfig((prev) => ({
      ...prev,
      isSystemOn: data.isSystemStart ?? prev.isSystemOn,
      isAlertOn: data.isAlert ?? prev.isAlertOn,
      mode: data.mode ?? prev.mode,
      currentStaticAngle: data.pos ?? prev.currentStaticAngle,
      maxDetectCm: data.maxRange ?? prev.maxDetectCm,
      redZoneCm: data.RedZone ?? prev.redZoneCm,
      degreeLimit: {
        min: data.minRotate ?? prev.degreeLimit.min,
        max: data.maxRotate ?? prev.degreeLimit.max,
      },
    }));
    setDraft((prev) => ({
      ...prev,
      degreeMin: String(data.minRotate ?? prev.degreeMin),
      degreeMax: String(data.maxRotate ?? prev.degreeMax),
      maxDetect: String(data.maxRange ?? prev.maxDetect),
      redZone: String(data.RedZone ?? prev.redZone),
    }));
    if (data.pos !== undefined) setCurrentAngle(data.pos);
  };

  const fetchReports = useCallback(async (page = 1) => {
    setReportLoading(true);
    try {
      const res = await fetch(`${BACKEND_URL}/report?page=${page}&limit=${REPORT_LIMIT}`);
      const json = await res.json();
      if (json.success) {
        setReports(json.data);
        setReportPagination(json.pagination ?? null);
        setReportPage(page);
        addSystemLog(`Loaded page ${page} (${json.data.length} records)`);

        if (page === 1) {
          const dbRows = json.data
            .flatMap((r) => extractAlertRowsFromReport(r))
            .slice(0, 20);
          setAlertLogs((prev) => {
            const liveRows = prev.filter((l) => l.source !== "db");
            return [...liveRows, ...dbRows].slice(0, 40);
          });
        }
      }
    } catch {
      addSystemLog("⚠ Failed to load reports");
    } finally {
      setReportLoading(false);
    }
  }, []);

  const fetchEsp32Status = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/status`);
      if (!res.ok) return;
      const json = await res.json();
      if (json.success && json.data) {
        setEsp32StatusDetail(json.data);
        const s = json.data.status === "online" ? "ONLINE" : "OFFLINE";
        setEsp32Status(s);
        addSystemLog(`ESP32 status fetched: ${s}`);
      }
    } catch {
      addSystemLog("⚠ Failed to fetch ESP32 status");
    }
  }, []);

  // =============================================
  // 🎯 RADAR DRAWING — pure canvas render
  // =============================================

  // วาด grid (วงกลม + เส้นมุม + label องศา)
  const drawGrid = useCallback((ctx) => {
    // พื้นหลัง
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // วงกลม 4 ชั้น พร้อม label ระยะ
    const rings = [0.25, 0.5, 0.75, 1.0];
    rings.forEach((scale) => {
      const r = RADAR_R * scale;
      ctx.beginPath();
      ctx.arc(CX, CY, r, Math.PI, 2 * Math.PI);
      ctx.strokeStyle = "#003300";
      ctx.lineWidth = 1;
      ctx.stroke();
    });

    // เส้นมุม 0°–180° ทุก 30°
    for (let deg = 0; deg <= 180; deg += 30) {
      const rad = degToRad(deg);
      const ex = CX - RADAR_R * Math.cos(rad);
      const ey = CY - RADAR_R * Math.sin(rad);

      ctx.beginPath();
      ctx.moveTo(CX, CY);
      ctx.lineTo(ex, ey);
      ctx.strokeStyle = "#002200";
      ctx.lineWidth = 0.5;
      ctx.stroke();

      // label องศา
      const lx = CX - (RADAR_R + 14) * Math.cos(rad);
      const ly = CY - (RADAR_R + 14) * Math.sin(rad);
      ctx.fillStyle = "#005500";
      ctx.font = "11px monospace";
      ctx.textAlign = "center";
      ctx.fillText(`${deg}°`, lx, ly + 4);
    }
  }, []);

  // วาด label ระยะห่างบนวงกลม (cm)
  const drawRangeLabels = useCallback((ctx, maxDetectCm) => {
    const rings = [0.25, 0.5, 0.75, 1.0];
    rings.forEach((scale) => {
      const cm = Math.round(maxDetectCm * scale);
      const r = RADAR_R * scale;
      // วาง label ที่ 90° (กลางจอ บนสุด)
      const lx = CX; // 90°: cos=0
      const ly = CY - r;
      ctx.fillStyle = "#004400";
      ctx.font = "10px monospace";
      ctx.textAlign = "center";
      ctx.fillText(`${cm}cm`, lx, ly - 3);
    });
  }, []);

  // วาด sweep line ที่มุม angle
  const drawSweepLine = useCallback((ctx, angle) => {
    const rad = degToRad(angle);
    const ex = CX - RADAR_R * Math.cos(rad);
    const ey = CY - RADAR_R * Math.sin(rad);
    ctx.beginPath();
    ctx.moveTo(CX, CY);
    ctx.lineTo(ex, ey);
    ctx.strokeStyle = "rgba(0,255,0,0.5)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }, []);

  // วาดจุด 1 ตัว พร้อม label ระยะ
  const drawDot = useCallback((ctx, dot, maxDetectCm) => {
    const { x, y, isRed, distance } = dot;

    // เงากลม (glow)
    const glowColor = isRed ? "rgba(255,60,60,0.25)" : "rgba(220,220,220,0.15)";
    ctx.beginPath();
    ctx.arc(x, y, isRed ? 10 : 8, 0, 2 * Math.PI);
    ctx.fillStyle = glowColor;
    ctx.fill();

    // จุด
    ctx.beginPath();
    ctx.arc(x, y, isRed ? 5 : 4, 0, 2 * Math.PI);
    ctx.fillStyle = isRed ? "#ff3e3e" : "#ffffff";
    ctx.fill();

    // outline
    ctx.beginPath();
    ctx.arc(x, y, isRed ? 5 : 4, 0, 2 * Math.PI);
    ctx.strokeStyle = isRed ? "#ff8888" : "#aaaaaa";
    ctx.lineWidth = 1;
    ctx.stroke();

    // label ระยะห่าง
    ctx.font = "bold 10px monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = isRed ? "#ff9999" : "#cccccc";
    ctx.fillText(`${parseFloat(distance).toFixed(1)}cm`, x, y - 10);
  }, []);

  // ── render canvas ทั้งหมดจาก radarDots state ──
  const renderCanvas = useCallback((dots, cfg) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    drawGrid(ctx);
    drawRangeLabels(ctx, cfg.maxDetectCm);

    // วาด sweep line ที่ currentAngle
    if (cfg._sweepAngle !== undefined) {
      drawSweepLine(ctx, cfg._sweepAngle);
    }

    // วาดจุดทั้งหมด
    dots.forEach((dot) => drawDot(ctx, dot, cfg.maxDetectCm));
  }, [drawGrid, drawRangeLabels, drawSweepLine, drawDot]);

  // ── handle incoming report payload (live) ──
  const handleReport = useCallback((data) => {
    const cfg = configRef.current;

    // Inject static angle สำหรับ STATIC mode
    if (data.mode === "STATIC") {
      data._staticAngle = cfg.currentStaticAngle;
    }

    const dots = extractDotsFromPayload(data, cfg.maxDetectCm);

    // แปลง dots → canvas positions
    const canvasDots = dots.map((d) => {
      const pos = dotPosition(d.angle, d.distance, cfg.maxDetectCm);
      return { ...pos, isRed: d.isRed, distance: d.distance, angle: d.angle };
    });

    // update sweep angle (ใช้ first dot หรือ angle ตรง)
    const sweepAngle =
      data.angle !== undefined ? data.angle
      : dots.length > 0 ? dots[0].angle
      : cfg.currentStaticAngle;

    setCurrentAngle(sweepAngle);

    // replace dots ทั้งหมด (ไม่ต้องสะสม)
    radarDotsRef.current = canvasDots;
    setRadarDots(canvasDots);

    renderCanvas(canvasDots, { ...cfg, _sweepAngle: sweepAngle });

    // ── Alert log ──
    if (dots.length === 0) return;

    const firstDot = dots[0];
    const isRed = firstDot.isRed;

    setAlertLogs((prev) => [
      {
        id: Date.now() + Math.random(),
        time: new Date().toLocaleTimeString(),
        angle: firstDot.angle,
        distance: firstDot.distance,
        zone: isRed ? "redzone" : "notice",
        type: isRed ? "ALERT" : "NOTICE",
        msg: `Angle ${firstDot.angle}° | ${parseFloat(firstDot.distance ?? 0).toFixed(1)} cm`,
        mode: data.mode ?? "—",
        hasObject: true,
        source: "live",
        objects: dots.length > 1 ? dots : null,
      },
      ...prev,
    ].slice(0, 40));
  }, [renderCanvas]);

  // ── init empty radar ──
  const drawEmptyRadar = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    drawGrid(ctx);
    drawRangeLabels(ctx, configRef.current.maxDetectCm);
  }, [drawGrid, drawRangeLabels]);

  // ── fetch latest report on load ──
  const fetchLatestReport = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/report/latest`);
      const json = await res.json();
      if (json.success && json.data) {
        const d = json.data.data || json.data;

        // วาด dots จาก latest report
        const cfg = configRef.current;
        if (d.mode === "STATIC") d._staticAngle = cfg.currentStaticAngle;
        const dots = extractDotsFromPayload(d, cfg.maxDetectCm);
        const canvasDots = dots.map((dot) => {
          const pos = dotPosition(dot.angle, dot.distance, cfg.maxDetectCm);
          return { ...pos, isRed: dot.isRed, distance: dot.distance, angle: dot.angle };
        });

        radarDotsRef.current = canvasDots;
        setRadarDots(canvasDots);

        const sweepAngle = d.angle ?? (dots[0]?.angle) ?? cfg.currentStaticAngle;
        renderCanvas(canvasDots, { ...cfg, _sweepAngle: sweepAngle });

        const dbRows = extractAlertRowsFromReport(json.data);
        setAlertLogs((prev) => {
          const liveRows = prev.filter((l) => l.source === "live");
          return [...liveRows, ...dbRows].slice(0, 40);
        });

        addSystemLog("Loaded latest report");
      }
    } catch {
      addSystemLog("⚠ Failed to load latest report");
    }
  }, [renderCanvas]);

  // ── socket events ──
  useEffect(() => {
    socket.on("connect", () => {
      setSocketConnected(true);
      addSystemLog("Socket connected to server");
      fetch(`${BACKEND_URL}/state`)
        .then((res) => res.json())
        .then((data) => { syncFromBackendState(data); addSystemLog("Initial state loaded from server"); })
        .catch(() => addSystemLog("⚠ Failed to load initial state"));
      fetchEsp32Status();
      fetchLatestReport();
      fetchReports(1);
    });

    socket.on("disconnect", () => {
      setSocketConnected(false);
      addSystemLog("Socket disconnected");
    });

    socket.on("state", (data) => {
      syncFromBackendState(data);
      addSystemLog("Config synced from server");
    });

    socket.on("status", (data) => {
      const s = data.status === "online" || data.status === "updated" ? "ONLINE" : "OFFLINE";
      setEsp32Status(s);
      setEsp32StatusDetail(data);
      addSystemLog(`ESP32 ${s}`);
    });

    socket.on("report", (data) => {
      handleReport(data);
    });

    return () => {
      socket.off("connect");
      socket.off("disconnect");
      socket.off("state");
      socket.off("status");
      socket.off("report");
    };
  }, [handleReport, fetchEsp32Status, fetchReports, fetchLatestReport]);

  // redraw เมื่อ maxDetectCm หรือ mode เปลี่ยน
  useEffect(() => {
    renderCanvas(radarDotsRef.current, { ...configRef.current, _sweepAngle: currentAngle });
  }, [config.maxDetectCm, config.mode, renderCanvas]);

  // init
  useEffect(() => { drawEmptyRadar(); }, [drawEmptyRadar]);

  useEffect(() => { setExpandedAlertRows({}); }, [reportPage]);

  // =============================================
  // Config / Control
  // =============================================

  const updateConfig = async (patch) => {
    setConfig((prev) => {
      const next = { ...prev };
      if (patch.isSystemOn !== undefined) next.isSystemOn = patch.isSystemOn;
      if (patch.isAlertOn !== undefined) next.isAlertOn = patch.isAlertOn;
      if (patch.mode !== undefined) next.mode = patch.mode;
      if (patch.currentStaticAngle !== undefined) next.currentStaticAngle = patch.currentStaticAngle;
      if (patch.maxDetectCm !== undefined) next.maxDetectCm = patch.maxDetectCm;
      if (patch.redZoneCm !== undefined) next.redZoneCm = patch.redZoneCm;
      if (patch.degreeLimit !== undefined) next.degreeLimit = { ...prev.degreeLimit, ...patch.degreeLimit };
      return next;
    });
    const backendPatch = toBackendPatch(patch);
    try {
      const res = await fetch(`${BACKEND_URL}/state`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(backendPatch),
      });
      const json = await res.json();
      console.log("✅ PATCH /state:", json);
      addSystemLog(`Config updated: ${Object.keys(backendPatch).join(", ")}`);
    } catch (err) {
      console.error("🔴 PATCH /state error:", err);
      addSystemLog("⚠ Failed to update config");
    }
  };

  const moveStatic = (direction) => {
    let newAngle = direction === "left" ? currentAngle - 5 : currentAngle + 5;
    newAngle = Math.max(0, Math.min(180, newAngle));
    setCurrentAngle(newAngle);
    updateConfig({ currentStaticAngle: newAngle });
  };

  const toInt = (raw) => parseInt(raw, 10);

  // onChange: เก็บค่า draft + validate เฉยๆ (ไม่ส่ง backend)
  // onBlur: ถ้าไม่มี error ค่อยส่ง backend

  const handleDegreeMin = (raw) => {
    setDraft((d) => ({ ...d, degreeMin: raw }));
    const val = toInt(raw);
    if (isNaN(val) || val < 0 || val > 180) { setErrors((e) => ({ ...e, degreeMin: "ต้องเป็นตัวเลข 0–180°" })); return; }
    if (val >= config.degreeLimit.max) { setErrors((e) => ({ ...e, degreeMin: `Min ต้องน้อยกว่า Max (${config.degreeLimit.max}°)` })); return; }
    setErrors((e) => ({ ...e, degreeMin: "" }));
  };
  const commitDegreeMin = (raw) => {
    const val = toInt(raw);
    const cfg = configRef.current;
    if (isNaN(val) || val < 0 || val > 180 || val >= cfg.degreeLimit.max) return;
    updateConfig({ degreeLimit: { ...cfg.degreeLimit, min: val } });
  };

  const handleDegreeMax = (raw) => {
    setDraft((d) => ({ ...d, degreeMax: raw }));
    const val = toInt(raw);
    if (isNaN(val) || val < 0 || val > 180) { setErrors((e) => ({ ...e, degreeMax: "ต้องเป็นตัวเลข 0–180°" })); return; }
    if (val <= config.degreeLimit.min) { setErrors((e) => ({ ...e, degreeMax: `Max ต้องมากกว่า Min (${config.degreeLimit.min}°)` })); return; }
    setErrors((e) => ({ ...e, degreeMax: "" }));
  };
  const commitDegreeMax = (raw) => {
    const val = toInt(raw);
    const cfg = configRef.current;
    if (isNaN(val) || val < 0 || val > 180 || val <= cfg.degreeLimit.min) return;
    updateConfig({ degreeLimit: { ...cfg.degreeLimit, max: val } });
  };

  const handleMaxDetect = (raw) => {
    setDraft((d) => ({ ...d, maxDetect: raw }));
    const val = toInt(raw);
    if (isNaN(val) || val < 1 || val > 400) { setErrors((e) => ({ ...e, maxDetect: "ต้องเป็นตัวเลข 1–400 cm" })); return; }
    if (val < config.redZoneCm) { setErrors((e) => ({ ...e, maxDetect: `Max Detect ต้องไม่น้อยกว่า Red Zone (${config.redZoneCm} cm)` })); return; }
    setErrors((e) => ({ ...e, maxDetect: "" }));
  };
  const commitMaxDetect = (raw) => {
    const val = toInt(raw);
    const cfg = configRef.current;
    if (isNaN(val) || val < 1 || val > 400 || val < cfg.redZoneCm) return;
    updateConfig({ maxDetectCm: val });
  };

  const handleRedZone = (raw) => {
    setDraft((d) => ({ ...d, redZone: raw }));
    const val = toInt(raw);
    if (isNaN(val) || val < 1 || val > 400) { setErrors((e) => ({ ...e, redZone: "ต้องเป็นตัวเลข 1–400 cm" })); return; }
    if (val > config.maxDetectCm) { setErrors((e) => ({ ...e, redZone: `Red Zone ต้องไม่เกิน Max Detect (${config.maxDetectCm} cm)` })); return; }
    setErrors((e) => ({ ...e, redZone: "" }));
  };
  const commitRedZone = (raw) => {
    const val = toInt(raw);
    const cfg = configRef.current;
    if (isNaN(val) || val < 1 || val > 400 || val > cfg.maxDetectCm) return;
    updateConfig({ redZoneCm: val });
  };

  const filteredAlertLogs =
    alertFilter === "all" ? alertLogs
    : alertFilter === "redzone" ? alertLogs.filter((l) => l.zone === "redzone")
    : alertLogs.filter((l) => l.zone === "notice");

  // =============================================
  // Styles & Themes
  // =============================================

  const zoneTheme = {
    notice: {
      rowBorder: "#003300",
      timeColor: "#00aa00",
      textColor: "#ccffcc",
      badgeColor: "#00ff00",
      badgeBg: "#002200",
      badgeBorder: "#00aa00",
      badgeLabel: "NOTICE",
    },
    redzone: {
      rowBorder: "#660000",
      timeColor: "#ff4444",
      textColor: "#ffcccc",
      badgeColor: "#ff2222",
      badgeBg: "#330000",
      badgeBorder: "#ff0000",
      badgeLabel: "RED ZONE",
    },
  };

  const s = {
    page: { padding: "20px", background: "#050505", color: "#0f0", minHeight: "100vh", fontFamily: "monospace" },
    grid: { display: "grid", gridTemplateColumns: "380px 1fr", gap: "25px" },
    col: { display: "flex", flexDirection: "column", gap: "20px" },
    panel: { border: "1px solid #0f0", padding: "15px", borderRadius: "8px", background: "#0a0a0a" },
    input: { width: "70px", background: "#000", color: "#0f0", border: "1px solid #0f0", padding: "5px", fontFamily: "monospace" },
    inputRed: { width: "70px", background: "#000", color: "#ff4444", border: "1px solid #ff4444", padding: "5px", fontFamily: "monospace" },
    inputErr: { width: "70px", background: "#1a0000", color: "#ff6666", border: "2px solid #ff4444", padding: "5px", fontFamily: "monospace" },
    errMsg: { color: "#ff4444", fontSize: "10px", marginTop: "3px", lineHeight: "1.4" },
    btnPrim: (active) => ({ flex: 1, padding: "12px", cursor: "pointer", background: active ? "#ff4444" : "#008800", color: "#fff", border: "none", fontWeight: "bold" }),
    btnSec: (active) => ({ flex: 1, padding: "12px", cursor: "pointer", background: active ? "#0f0" : "#222", color: active ? "#000" : "#0f0", border: "1px solid #0f0" }),
    btnMode: (active) => ({ flex: 1, padding: "10px", background: active ? "#0f0" : "#111", color: active ? "#000" : "#0f0", border: "1px solid #0f0", cursor: "pointer" }),
    btnArrow: { padding: "10px 20px", fontSize: "20px", background: "#111", color: "#0f0", border: "1px solid #0f0", cursor: "pointer" },
  };

  const redPct =
    config.maxDetectCm > 0
      ? Math.min((config.redZoneCm / config.maxDetectCm) * 100, 100).toFixed(0)
      : 0;

  const filterTabs = [
    { key: "all",     label: "ALL",      color: "#aaaaaa", activeBg: "#1a1a1a" },
    { key: "notice",  label: "NOTICE",   color: "#00cc00", activeBg: "#001a00" },
    { key: "redzone", label: "RED ZONE", color: "#ff2222", activeBg: "#2a0000" },
  ];

  const ErrMsg = ({ msg }) => msg ? <div style={s.errMsg}>⚠ {msg}</div> : null;

  // ── Alert Log Row ──
  const AlertLogRow = ({ l, i }) => {
    const t = zoneTheme[l.zone] ?? zoneTheme.notice;
    const isLive = l.source === "live";
    const hasMultiple = Array.isArray(l.objects) && l.objects.length > 1;
    const key = l.id ?? i;
    const isExpanded = expandedAlertRows[key];
    const first = l.objects?.[0] || l;
    const rest = l.objects?.slice(1) || [];

    return (
      <div style={{ borderBottom: `1px solid ${t.rowBorder}` }}>
        <div
          style={{
            padding: "7px 4px",
            display: "grid",
            gridTemplateColumns: "85px auto 60px 70px 1fr 36px",
            gap: "5px",
            alignItems: "center",
            fontSize: "11px",
            background: l.zone === "redzone" ? "rgba(50,0,0,0.25)" : "transparent",
            cursor: hasMultiple ? "pointer" : "default",
          }}
          onClick={() => {
            if (rest.length > 0) {
              setExpandedAlertRows((prev) => ({ ...prev, [key]: !prev[key] }));
            }
          }}
        >
          <span style={{ color: t.timeColor }}>[{l.time}]</span>
          <span style={{
            background: t.badgeBg, color: t.badgeColor,
            border: `1px solid ${t.badgeBorder}`,
            fontSize: "8px", padding: "1px 4px", borderRadius: "3px", fontWeight: "bold",
          }}>
            {t.badgeLabel}
          </span>
          <span style={{ color: "#0cc", textAlign: "right" }}>{first.angle ?? "—"}°</span>
          <span style={{ color: l.zone === "redzone" ? "#ff4444" : "#0f0", textAlign: "right" }}>
            {parseFloat(first.distance ?? 0).toFixed(1)}cm
          </span>
          <span style={{ color: t.textColor }}>
            {hasMultiple ? `+${rest.length} more objects` : l.msg}
          </span>
          <span style={{ fontSize: "8px", color: isLive ? "#00ff88" : "#336633" }}>
            {isLive ? "LIVE" : "DB"}
          </span>
        </div>

        {isExpanded && rest.map((obj, idx) => {
          const isRed = obj.type === "RedZone" || obj.isRed;
          return (
            <div key={idx} style={{
              padding: "5px 4px 5px 16px",
              display: "grid",
              gridTemplateColumns: "85px auto 60px 70px 1fr 36px",
              gap: "5px", fontSize: "10px",
              background: isRed ? "rgba(40,0,0,0.4)" : "rgba(0,20,0,0.3)",
              borderLeft: `2px solid ${isRed ? "#882222" : "#004400"}`,
            }}>
              <span style={{ color: "#444" }}>↳ obj {idx + 2}</span>
              <span />
              <span style={{ color: "#0cc", textAlign: "right" }}>{obj.angle}°</span>
              <span style={{ color: isRed ? "#ff4444" : "#0f0", textAlign: "right" }}>
                {parseFloat(obj.distance ?? 0).toFixed(1)}cm
              </span>
              <span>{isRed ? "RED ZONE" : "NOTICE"}</span>
              <span />
            </div>
          );
        })}
      </div>
    );
  };

  // ── DB Report Row ──
  const renderReportRow = (r, i) => {
    const d = r.data || {};
    const time = r.createdAt ? new Date(r.createdAt).toLocaleTimeString() : "—";
    const mode = d.mode || "—";

    if (d.type !== undefined && d.angle !== undefined) {
      const isRed = d.type === "RedZone";
      return (
        <div key={r._id || i} style={{
          borderBottom: `1px solid ${isRed ? "#440000" : "#1a1a1a"}`,
          padding: "7px 4px",
          display: "grid",
          gridTemplateColumns: "100px 55px 80px 85px 60px 1fr",
          gap: "6px", alignItems: "center", fontSize: "11px",
          background: isRed ? "rgba(60,0,0,0.3)" : "transparent",
        }}>
          <span style={{ color: "#555" }}>{time}</span>
          <span style={{ color: "#0ff", textAlign: "right" }}>{d.angle}°</span>
          <span style={{ color: isRed ? "#ff4444" : "#0f0", textAlign: "right" }}>
            {parseFloat(d.distance ?? 0).toFixed(1)} cm
          </span>
          <span>
            {isRed
              ? <span style={{ background: "#2a0000", color: "#ff4444", border: "1px solid #ff4444", fontSize: "9px", padding: "1px 5px", borderRadius: "3px", fontWeight: "bold" }}>RED ZONE</span>
              : <span style={{ background: "#001a00", color: "#00aa00", border: "1px solid #004400", fontSize: "9px", padding: "1px 5px", borderRadius: "3px" }}>NOTICE</span>
            }
          </span>
          <span style={{ color: "#336633", fontSize: "9px" }}>SINGLE</span>
          <span style={{ color: "#444", fontSize: "10px" }}>MODE: {mode}</span>
        </div>
      );
    }

    if (Array.isArray(d.objects)) {
      const key = r._id || i;
      const isExpanded = expandedReportRows[key];
      const first = d.objects[0];
      const rest = d.objects.slice(1);

      return (
        <div key={r._id || i} style={{ borderBottom: "1px solid #1a2a1a", marginBottom: "2px" }}>
          <div style={{
            padding: "5px 4px",
            display: "grid",
            gridTemplateColumns: "100px 55px 80px 85px 60px 1fr",
            gap: "6px", alignItems: "center", fontSize: "11px",
            background: "rgba(0,20,0,0.4)",
            cursor: rest.length > 0 ? "pointer" : "default",
          }}
            onClick={() => {
              if (rest.length > 0) {
                setExpandedReportRows((prev) => ({ ...prev, [key]: !prev[key] }));
              }
            }}
          >
            <span style={{ color: "#555" }}>{time}</span>
            <span style={{ color: "#0bb", textAlign: "right" }}>{first?.angle ?? "—"}°</span>
            <span style={{ color: first?.type === "RedZone" ? "#ff4444" : "#0f0", textAlign: "right" }}>
              {parseFloat(first?.distance ?? 0).toFixed(1)} cm
            </span>
            <span>
              {first?.type === "RedZone"
                ? <span style={{ background: "#2a0000", color: "#ff4444", border: "1px solid #ff4444", fontSize: "9px", padding: "1px 5px", borderRadius: "3px" }}>RED ZONE</span>
                : <span style={{ background: "#001a00", color: "#00aa00", border: "1px solid #004400", fontSize: "9px", padding: "1px 5px", borderRadius: "3px" }}>NOTICE</span>
              }
            </span>
            <span style={{ color: "#336633", fontSize: "9px" }}>
              {rest.length > 0 ? `+${rest.length} MORE` : "SINGLE"}
            </span>
            <span style={{ color: "#336633", fontSize: "10px" }}>MODE: {mode}</span>
          </div>

          {isExpanded && rest.map((obj, oi) => {
            const isRed = obj.type === "RedZone";
            return (
              <div key={oi} style={{
                padding: "4px 4px 4px 18px",
                display: "grid",
                gridTemplateColumns: "100px 55px 80px 85px 60px 1fr",
                gap: "6px", alignItems: "center", fontSize: "10px",
                background: isRed ? "rgba(40,0,0,0.4)" : "rgba(0,12,0,0.3)",
                borderLeft: `2px solid ${isRed ? "#882222" : "#004400"}`,
              }}>
                <span style={{ color: "#444" }}>↳ obj {oi + 2}</span>
                <span style={{ color: "#0bb", textAlign: "right" }}>{obj.angle}°</span>
                <span style={{ color: isRed ? "#ff4444" : "#0f0", textAlign: "right" }}>
                  {parseFloat(obj.distance ?? 0).toFixed(1)} cm
                </span>
                <span>
                  {isRed
                    ? <span style={{ background: "#2a0000", color: "#ff4444", border: "1px solid #ff4444", fontSize: "8px", padding: "1px 4px", borderRadius: "3px" }}>RED ZONE</span>
                    : <span style={{ background: "#001500", color: "#009900", border: "1px solid #003300", fontSize: "8px", padding: "1px 4px", borderRadius: "3px" }}>NOTICE</span>
                  }
                </span>
                <span /><span />
              </div>
            );
          })}
        </div>
      );
    }

    return (
      <div key={r._id || i} style={{ borderBottom: "1px solid #1a1a1a", padding: "6px 4px", fontSize: "11px", color: "#333" }}>
        <span style={{ color: "#555" }}>[{time}]</span> Unknown format — MODE: {mode}
      </div>
    );
  };

  // ── Pagination ──
  const PaginationBar = () => {
    if (!reportPagination || reportPagination.totalPages <= 1) return null;
    const { totalPages, total } = reportPagination;
    const getPageNumbers = () => {
      if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
      const pages = [];
      if (reportPage <= 4) {
        for (let i = 1; i <= 5; i++) pages.push(i);
        pages.push("..."); pages.push(totalPages);
      } else if (reportPage >= totalPages - 3) {
        pages.push(1); pages.push("...");
        for (let i = totalPages - 4; i <= totalPages; i++) pages.push(i);
      } else {
        pages.push(1); pages.push("...");
        for (let i = reportPage - 1; i <= reportPage + 1; i++) pages.push(i);
        pages.push("..."); pages.push(totalPages);
      }
      return pages;
    };
    const btn = { padding: "5px 10px", fontFamily: "monospace", fontSize: "12px", borderRadius: "4px", cursor: "pointer", transition: "all 0.15s" };
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "4px", marginTop: "12px", flexWrap: "wrap" }}>
        <button onClick={() => fetchReports(reportPage - 1)} disabled={reportPage <= 1 || reportLoading}
          style={{ ...btn, background: "transparent", color: reportPage <= 1 ? "#222" : "#0cc", border: `1px solid ${reportPage <= 1 ? "#1a1a1a" : "#004444"}`, cursor: reportPage <= 1 ? "not-allowed" : "pointer" }}>← PREV</button>
        {getPageNumbers().map((p, idx) =>
          p === "..." ? (
            <span key={`e${idx}`} style={{ color: "#333", padding: "0 4px", fontSize: "12px" }}>...</span>
          ) : (
            <button key={p} onClick={() => fetchReports(p)} disabled={reportLoading}
              style={{ ...btn, background: p === reportPage ? "#003333" : "transparent", color: p === reportPage ? "#0ff" : "#0cc", border: `1px solid ${p === reportPage ? "#0cc" : "#004444"}`, fontWeight: p === reportPage ? "bold" : "normal", minWidth: "34px" }}>{p}</button>
          )
        )}
        <button onClick={() => fetchReports(reportPage + 1)} disabled={reportPage >= totalPages || reportLoading}
          style={{ ...btn, background: "transparent", color: reportPage >= totalPages ? "#222" : "#0cc", border: `1px solid ${reportPage >= totalPages ? "#1a1a1a" : "#004444"}`, cursor: reportPage >= totalPages ? "not-allowed" : "pointer" }}>NEXT →</button>
        <span style={{ color: "#004444", fontSize: "11px", marginLeft: "8px" }}>PAGE {reportPage}/{totalPages} · {total} RECORDS</span>
      </div>
    );
  };

  // ── Radar Legend ──
  const RadarLegend = () => (
    <div style={{ display: "flex", justifyContent: "center", gap: "20px", marginTop: "8px", fontSize: "11px" }}>
      <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
        <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: "#ffffff", boxShadow: "0 0 4px #aaa" }} />
        <span style={{ color: "#aaa" }}>NOTICE</span>
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
        <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: "#ff3e3e", boxShadow: "0 0 6px #f00" }} />
        <span style={{ color: "#ff9999" }}>RED ZONE</span>
      </span>
      <span style={{ color: "#004400", fontSize: "10px" }}>
        {radarDots.length > 0 ? `${radarDots.length} object(s) displayed` : "awaiting data..."}
      </span>
    </div>
  );

  // =============================================
  // RENDER
  // =============================================

  return (
    <div style={s.page}>
      <h2 style={{ borderBottom: "2px solid #0f0", paddingBottom: "10px", display: "flex", alignItems: "center", gap: "12px" }}>
        🛰️ RTOS RADAR COMMAND CENTER
        <span style={{ fontSize: "12px", fontWeight: "normal", color: socketConnected ? "#0f0" : "#f00" }}>
          {socketConnected ? "● CONNECTED" : "● DISCONNECTED"}
        </span>
      </h2>

      <div style={{ display: "flex", gap: "8px", marginBottom: "20px" }}>
        {[{ key: "control", label: "⚙ CONTROL PANEL" }, { key: "reports", label: "📋 REPORT HISTORY" }].map(({ key, label }) => (
          <button key={key}
            onClick={() => { setActivePanel(key); if (key === "reports") fetchReports(1); }}
            style={{
              padding: "8px 20px", fontFamily: "monospace", fontWeight: "bold", fontSize: "13px", cursor: "pointer",
              border: `1px solid ${activePanel === key ? "#0f0" : "#333"}`,
              background: activePanel === key ? "#001a00" : "transparent",
              color: activePanel === key ? "#0f0" : "#444",
              borderRadius: "4px", letterSpacing: "1px", transition: "all 0.15s",
            }}>{label}</button>
        ))}
      </div>

      {activePanel === "control" && (
        <div style={s.grid}>
          {/* ── Left ── */}
          <div style={s.col}>
            <div style={s.panel}>
              <div style={{ display: "flex", gap: "10px", marginBottom: "15px" }}>
                <button onClick={() => updateConfig({ isSystemOn: !config.isSystemOn })} style={s.btnPrim(config.isSystemOn)}>
                  {config.isSystemOn ? "SHUTDOWN" : "START SYSTEM"}
                </button>
                <button onClick={() => updateConfig({ isAlertOn: !config.isAlertOn })} style={s.btnSec(config.isAlertOn)}>
                  ALERT: {config.isAlertOn ? "ON" : "OFF"}
                </button>
              </div>

              <h4 style={{ margin: "0 0 8px 0" }}>MODE SELECTION</h4>
              <div style={{ display: "flex", gap: "5px", marginBottom: "15px" }}>
                {["ROAM", "TRACK", "STATIC"].map((m) => (
                  <button key={m} onClick={() => updateConfig({ mode: m })} style={s.btnMode(config.mode === m)}>{m}</button>
                ))}
              </div>

              {config.mode === "STATIC" && (
                <div style={{ textAlign: "center", marginBottom: "15px", padding: "10px", border: "1px dashed #0f0" }}>
                  <p style={{ margin: "0 0 10px 0", fontSize: "12px", letterSpacing: "1px" }}>MANUAL ROTATION</p>
                  <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "20px" }}>
                    <button onClick={() => moveStatic("left")} style={s.btnArrow}>⬅️</button>
                    <div style={{ fontSize: "28px", fontWeight: "bold", minWidth: "70px", textAlign: "center" }}>{currentAngle}°</div>
                    <button onClick={() => moveStatic("right")} style={s.btnArrow}>➡️</button>
                  </div>
                  <input type="range" min="0" max="180" value={currentAngle}
                    onChange={(e) => { setCurrentAngle(Number(e.target.value)); }}
                    onMouseUp={(e) => { updateConfig({ currentStaticAngle: Number(e.target.value) }); }}
                    onTouchEnd={(e) => { updateConfig({ currentStaticAngle: Number(e.target.value) }); }}
                    style={{ width: "100%", marginTop: "10px", accentColor: "#0f0" }} />
                </div>
              )}

              {(config.mode === "ROAM" || config.mode === "TRACK") && (
                <>
                  <h4 style={{ margin: "0 0 8px 0" }}>Rotation LIMIT (SCAN RANGE 0–180°)</h4>
                  <div style={{ display: "flex", gap: "20px", marginBottom: "4px" }}>
                    <div><div style={{ marginBottom: "4px", fontSize: "12px", color: "#888" }}>Min</div>
                      <input type="number" min="0" max="180" value={draft.degreeMin} onChange={(e) => handleDegreeMin(e.target.value)} onBlur={(e) => commitDegreeMin(e.target.value)} style={errors.degreeMin ? s.inputErr : s.input} /></div>
                    <div><div style={{ marginBottom: "4px", fontSize: "12px", color: "#888" }}>Max</div>
                      <input type="number" min="0" max="180" value={draft.degreeMax} onChange={(e) => handleDegreeMax(e.target.value)} onBlur={(e) => commitDegreeMax(e.target.value)} style={errors.degreeMax ? s.inputErr : s.input} /></div>
                  </div>
                  <ErrMsg msg={errors.degreeMin} /><ErrMsg msg={errors.degreeMax} />
                  <div style={{ marginBottom: "15px" }} />
                </>
              )}

              <h4 style={{ margin: "0 0 8px 0" }}>MAX DETECT (RANGE)</h4>
              <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
                <input type="number" min="1" max="400" value={draft.maxDetect} onChange={(e) => handleMaxDetect(e.target.value)} onBlur={(e) => commitMaxDetect(e.target.value)} style={errors.maxDetect ? s.inputErr : s.input} />
                <span style={{ fontSize: "12px", color: "#555" }}>cm &nbsp;(1 – 400)</span>
              </div>
              <ErrMsg msg={errors.maxDetect} />
              <div style={{ marginBottom: "15px" }} />

              <h4 style={{ margin: "0 0 8px 0", color: "#ff4444" }}>⚠ RED ZONE (ALERT THRESHOLD)</h4>
              <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
                <input type="number" min="1" max="400" value={draft.redZone} onChange={(e) => handleRedZone(e.target.value)} onBlur={(e) => commitRedZone(e.target.value)} style={errors.redZone ? s.inputErr : s.inputRed} />
                <span style={{ fontSize: "12px", color: "#883333" }}>cm &nbsp;(≤ Max Detect)</span>
              </div>
              <ErrMsg msg={errors.redZone} />
              <div style={{ marginBottom: "10px" }} />

              <div style={{ position: "relative", height: "18px", background: "#001a00", borderRadius: "4px", overflow: "hidden", border: "1px solid #003300" }}>
                <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${redPct}%`, background: "#3a0000", borderRight: "2px solid #ff4444", transition: "width 0.3s" }} />
                <span style={{ position: "absolute", left: "5px", top: "2px", fontSize: "10px", color: "#ff4444", pointerEvents: "none" }}>RED 0–{config.redZoneCm}cm</span>
                <span style={{ position: "absolute", right: "5px", top: "2px", fontSize: "10px", color: "#005500", pointerEvents: "none" }}>MAX {config.maxDetectCm}cm</span>
              </div>
            </div>

            {/* System Logs */}
            <div style={{ border: "1px solid #008800", borderRadius: "8px", padding: "10px", background: "#051005" }}>
              <h5 style={{ margin: "0 0 10px 0", color: "#00ff00" }}>📟 SYSTEM LOGS</h5>
              <div style={{ height: "150px", overflowY: "auto", fontSize: "11px" }}>
                {systemLogs.length === 0 && <p style={{ color: "#333", margin: 0 }}>No system events...</p>}
                {systemLogs.map((l, i) => (
                  <div key={i} style={{ borderBottom: "1px solid #003300", padding: "3px 0" }}>
                    <span style={{ color: "#005500" }}>[{l.time}]</span> {l.msg}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ── Right ── */}
          <div style={s.col}>
            <div style={{ background: "#000", padding: "20px", border: "1px solid #0f0", borderRadius: "8px", boxShadow: "0 0 20px rgba(0,255,0,0.1)", textAlign: "center" }}>
              <canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H} style={{ maxWidth: "100%", display: "block", margin: "0 auto" }} />
              <RadarLegend />
              <div style={{ display: "flex", justifyContent: "center", gap: "20px", marginTop: "10px", fontSize: "13px", flexWrap: "wrap" }}>
                <span>MODE: <b style={{ color: "#fff" }}>{config.mode.toUpperCase()}</b></span>
                <span>SYSTEM: <b style={{ color: config.isSystemOn ? "#0f0" : "#f00" }}>{config.isSystemOn ? "ACTIVE" : "OFFLINE"}</b></span>
                <span>ALERT: <b style={{ color: config.isAlertOn ? "#ff0" : "#555" }}>{config.isAlertOn ? "ARMED" : "OFF"}</b></span>
                <span>ANGLE: <b style={{ color: "#0ff" }}>{currentAngle}°</b></span>
                <span>MAX: <b style={{ color: "#0f0" }}>{config.maxDetectCm}cm</b></span>
                <span>RED: <b style={{ color: "#f44" }}>{config.redZoneCm}cm</b></span>
                <span>ESP32: <b style={{ color: esp32Status === "ONLINE" ? "#0f0" : "#f00" }}>{esp32Status === "ONLINE" ? "🟢 ONLINE" : "🔴 OFFLINE"}</b></span>
              </div>
            </div>

            {/* Alert Detection Logs */}
            <div style={{ border: "1px solid #ff0000", borderRadius: "8px", padding: "15px", background: "#100000" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px", flexWrap: "wrap", gap: "8px" }}>
                <h4 style={{ margin: 0, color: "#ff4444" }}>
                  🚨 ALERT DETECTION LOGS
                  <span style={{ marginLeft: "8px", fontSize: "10px", color: "#555", fontWeight: "normal" }}>(LIVE + DB)</span>
                </h4>
                <div style={{ display: "flex", gap: "6px" }}>
                  <button onClick={() => fetchReports(1)}
                    style={{ padding: "2px 8px", background: "transparent", color: "#0cc", border: "1px solid #004444", cursor: "pointer", fontSize: "10px", fontFamily: "monospace" }}>
                    ↻ RELOAD DB
                  </button>
                  {alertLogs.length > 0 && (
                    <button onClick={() => setAlertLogs([])}
                      style={{ padding: "2px 8px", background: "transparent", color: "#ff4444", border: "1px solid #ff4444", cursor: "pointer", fontSize: "11px", fontFamily: "monospace" }}>
                      CLEAR
                    </button>
                  )}
                </div>
              </div>

              <div style={{ display: "flex", gap: "6px", marginBottom: "8px" }}>
                {filterTabs.map(({ key, label, color, activeBg }) => {
                  const isActive = alertFilter === key;
                  const count =
                    key === "all" ? alertLogs.length
                    : key === "redzone" ? alertLogs.filter((l) => l.zone === "redzone").length
                    : alertLogs.filter((l) => l.zone === "notice").length;
                  return (
                    <button key={key} onClick={() => setAlertFilter(key)} style={{
                      flex: 1, padding: "6px 4px", fontFamily: "monospace", fontSize: "11px",
                      fontWeight: "bold", cursor: "pointer", borderRadius: "4px",
                      border: `1px solid ${color}`,
                      background: isActive ? activeBg : "transparent",
                      color, opacity: isActive ? 1 : 0.4, transition: "opacity 0.15s, background 0.15s",
                    }}>
                      {label}
                      {count > 0 && (
                        <span style={{ marginLeft: "5px", background: color, color: "#000", borderRadius: "8px", padding: "0 5px", fontSize: "10px", fontWeight: "bold" }}>{count}</span>
                      )}
                    </button>
                  );
                })}
              </div>

              <div style={{
                display: "grid", gridTemplateColumns: "85px auto 60px 70px 1fr 36px",
                gap: "10px", fontSize: "15px", color: "#ffffff",
                borderBottom: "1px solid #2a0000", paddingBottom: "4px", marginBottom: "2px", letterSpacing: "1px",
              }}>
                <span>TIME</span><span>TYPE</span>
                <span style={{ textAlign: "right" }}>ANGLE</span>
                <span style={{ textAlign: "right" }}>DIST</span>
                <span>DETAIL</span><span style={{ textAlign: "center" }}>SRC</span>
              </div>

              <div style={{ height: "280px", overflowY: "auto" }}>
                {filteredAlertLogs.length === 0 && (
                  <p style={{ color: "#444", margin: "20px 0", textAlign: "center" }}>No detection events...</p>
                )}
                {filteredAlertLogs.map((l, i) => (
                  <AlertLogRow key={l.id ?? i} l={l} i={i} />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {activePanel === "reports" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          <div style={{ display: "flex", gap: "6px" }}>
            {[{ key: "history", label: "📂 DB HISTORY" }, { key: "live", label: "⚡ LIVE + DB ALERTS" }].map(({ key, label }) => (
              <button key={key} onClick={() => setReportTab(key)} style={{
                padding: "7px 16px", fontFamily: "monospace", fontSize: "12px", cursor: "pointer",
                border: `1px solid ${reportTab === key ? "#0cc" : "#ffffff"}`,
                background: reportTab === key ? "#001a1a" : "transparent",
                color: reportTab === key ? "#0cc" : "#ffffff",
                borderRadius: "4px", transition: "all 0.15s",
              }}>{label}</button>
            ))}
          </div>

          {reportTab === "history" && (
            <div style={{ border: "1px solid #004444", borderRadius: "8px", padding: "15px", background: "#010d0d" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", flexWrap: "wrap", gap: "8px" }}>
                <h4 style={{ margin: 0, color: "#0cc" }}>
                  📋 REPORT HISTORY
                  {reportPagination && (
                    <span style={{ marginLeft: "10px", background: "#003333", color: "#0cc", border: "1px solid #0cc", fontSize: "10px", padding: "1px 8px", borderRadius: "8px" }}>
                      {reportPagination.total} records total
                    </span>
                  )}
                </h4>
                <button onClick={() => fetchReports(reportPage)} disabled={reportLoading}
                  style={{ padding: "5px 14px", background: reportLoading ? "#ffffff" : "transparent", color: "#0cc", border: "1px solid #004444", cursor: reportLoading ? "not-allowed" : "pointer", fontSize: "11px", fontFamily: "monospace", borderRadius: "4px" }}>
                  {reportLoading ? "⟳ LOADING..." : "↻ REFRESH"}
                </button>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "100px 55px 80px 85px 60px 1fr", gap: "6px", fontSize: "10px", color: "#005555", borderBottom: "1px solid #003333", paddingBottom: "6px", marginBottom: "4px", letterSpacing: "1px" }}>
                <span>TIME</span>
                <span style={{ textAlign: "right" }}>ANGLE</span>
                <span style={{ textAlign: "right" }}>DISTANCE</span>
                <span>ZONE</span><span>TYPE</span><span>MODE</span>
              </div>

              <div style={{ minHeight: "300px" }}>
                {reportLoading && <p style={{ color: "#004444", margin: "20px 0", textAlign: "center" }}>⟳ Fetching from MongoDB...</p>}
                {!reportLoading && reports.length === 0 && <p style={{ color: "#333", margin: "20px 0", textAlign: "center" }}>No reports found in database.</p>}
                {!reportLoading && reports.map((r, i) => renderReportRow(r, i))}
              </div>

              <PaginationBar />
            </div>
          )}

          {reportTab === "live" && (
            <div style={{ border: "1px solid #440000", borderRadius: "8px", padding: "15px", background: "#0d0000" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                <h4 style={{ margin: 0, color: "#ff4444" }}>
                  ⚡ LIVE + DB ALERTS
                  {alertLogs.length > 0 && (
                    <span style={{ marginLeft: "10px", background: "#2a0000", color: "#ff4444", border: "1px solid #ff4444", fontSize: "10px", padding: "1px 8px", borderRadius: "8px" }}>
                      {alertLogs.length} events
                    </span>
                  )}
                </h4>
                {alertLogs.length > 0 && (
                  <button onClick={() => setAlertLogs([])} style={{ padding: "5px 14px", background: "transparent", color: "#ff4444", border: "1px solid #440000", cursor: "pointer", fontSize: "11px", fontFamily: "monospace", borderRadius: "4px" }}>
                    CLEAR ALL
                  </button>
                )}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "85px auto 60px 70px 1fr 36px", gap: "5px", fontSize: "9px", color: "#444", borderBottom: "1px solid #2a0000", paddingBottom: "4px", marginBottom: "4px", letterSpacing: "1px" }}>
                <span>TIME</span><span>TYPE</span>
                <span style={{ textAlign: "right" }}>ANGLE</span>
                <span style={{ textAlign: "right" }}>DIST</span>
                <span>DETAIL</span><span style={{ textAlign: "center" }}>SRC</span>
              </div>
              <div style={{ height: "400px", overflowY: "auto" }}>
                {alertLogs.length === 0 && <p style={{ color: "#333", margin: "20px 0", textAlign: "center" }}>No alerts yet.</p>}
                {alertLogs.map((l, i) => <AlertLogRow key={i} l={l} i={i} />)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default App;