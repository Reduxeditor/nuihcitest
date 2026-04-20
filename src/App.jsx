import { useEffect, useRef, useState } from "react";
import "@mediapipe/camera_utils/camera_utils.js";
import "@mediapipe/hands/hands.js";
import "@mediapipe/face_mesh/face_mesh.js";
import "./App.css";

const HandsCtor = globalThis.Hands;
const CameraCtor = globalThis.Camera;
const FaceMeshCtor = globalThis.FaceMesh;
const HAND_CONNECTIONS = globalThis.HAND_CONNECTIONS;

const MEDIAPIPE_HANDS_BASE =
  "https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/";
const MEDIAPIPE_FACE_MESH_BASE =
  "https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619/";

const INDEX_TIP = 8;
const CHAR_SETTLE_MS = 540;
const MIN_STROKE_POINTS = 10;
const MIN_STROKE_LENGTH = 0.26;
const MAX_FIELD_LENGTH = 24;

const ALPHANUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pathLength(points) {
  let sum = 0;
  for (let i = 1; i < points.length; i += 1) sum += dist(points[i - 1], points[i]);
  return sum;
}

function resample(points, n) {
  const D = pathLength(points);
  if (D <= 0 || points.length === 0) return points.slice();
  const I = D / (n - 1);
  let d = 0;
  const out = [points[0]];
  const work = points.map((p) => ({ ...p }));
  let i = 1;
  while (i < work.length) {
    const cur = work[i - 1];
    const next = work[i];
    const seg = dist(cur, next);
    if (d + seg >= I) {
      const t = (I - d) / seg;
      const q = {
        x: cur.x + t * (next.x - cur.x),
        y: cur.y + t * (next.y - cur.y),
      };
      out.push(q);
      work.splice(i, 0, q);
      d = 0;
    } else {
      d += seg;
      i += 1;
    }
  }
  while (out.length < n) out.push({ ...out[out.length - 1] });
  return out;
}

function normalize(points) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const w = Math.max(0.001, maxX - minX);
  const h = Math.max(0.001, maxY - minY);
  return points.map((p) => ({ x: (p.x - minX) / w, y: (p.y - minY) / h }));
}

function to8Dir(a, b) {
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const bin = Math.round((angle / (Math.PI / 4) + 8)) % 8;
  return bin;
}

function directions(points) {
  const dirs = [];
  for (let i = 1; i < points.length; i += 1) {
    const d = to8Dir(points[i - 1], points[i]);
    if (dirs.length === 0 || dirs[dirs.length - 1] !== d) dirs.push(d);
  }
  return dirs;
}

function weightedEditDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0),
  );
  for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const subCost = Math.min(Math.abs(a[i - 1] - b[j - 1]), 8 - Math.abs(a[i - 1] - b[j - 1])) / 2;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + subCost,
      );
    }
  }
  return dp[a.length][b.length];
}

function isFingerExtended(lm, tip, pip) {
  const w = lm[0];
  const dTip = Math.hypot(lm[tip].x - w.x, lm[tip].y - w.y);
  const dPip = Math.hypot(lm[pip].x - w.x, lm[pip].y - w.y);
  return dTip > dPip * 1.03;
}

function isFingerCurled(lm, tip, pip) {
  const w = lm[0];
  const dTip = Math.hypot(lm[tip].x - w.x, lm[tip].y - w.y);
  const dPip = Math.hypot(lm[pip].x - w.x, lm[pip].y - w.y);
  return dTip < dPip * 0.99;
}

function isOpenPalm(lm) {
  return (
    isFingerExtended(lm, 8, 6) &&
    isFingerExtended(lm, 12, 10) &&
    isFingerExtended(lm, 16, 14) &&
    isFingerExtended(lm, 20, 18)
  );
}

function palmFacing(lm) {
  const w = lm[0];
  const i = lm[5];
  const p = lm[17];
  const v1 = { x: i.x - w.x, y: i.y - w.y, z: i.z - w.z };
  const v2 = { x: p.x - w.x, y: p.y - w.y, z: p.z - w.z };
  const nz = v1.x * v2.y - v1.y * v2.x;
  const palm = [0, 5, 9, 13, 17];
  const tips = [4, 8, 12, 16, 20];
  const palmZ = palm.reduce((s, idx) => s + lm[idx].z, 0) / palm.length;
  const tipsZ = tips.reduce((s, idx) => s + lm[idx].z, 0) / tips.length;
  const depth = tipsZ - palmZ;
  if (Math.abs(depth) < 0.008) return "unknown";
  const frontLike = depth < 0;
  return frontLike ^ (nz > 0) ? "palm" : "back";
}

function isPointingPose(lm) {
  return (
    isFingerExtended(lm, 8, 6) &&
    isFingerCurled(lm, 12, 10) &&
    isFingerCurled(lm, 16, 14) &&
    isFingerCurled(lm, 20, 18)
  );
}

function facePitch(lm) {
  const nose = lm[1];
  const le = lm[33];
  const re = lm[263];
  const eyeMidY = (le.y + re.y) / 2;
  const scale = Math.max(0.04, Math.hypot(re.x - le.x, re.y - le.y));
  return (nose.y - eyeMidY) / scale;
}

const CHAR_TEMPLATES = {
  A: "24602024",
  B: "0602424642",
  C: "2460",
  D: "06420",
  E: "242424",
  F: "2424",
  G: "246020",
  H: "20242",
  I: "202",
  J: "66042",
  K: "20464",
  L: "20",
  M: "24202",
  N: "2420",
  O: "2460",
  P: "0642",
  Q: "24606",
  R: "06426",
  S: "6060",
  T: "220",
  U: "042",
  V: "042",
  W: "04042",
  X: "4646",
  Y: "640",
  Z: "2620",
  0: "2460",
  1: "0",
  2: "2620",
  3: "6660",
  4: "402",
  5: "24260",
  6: "246042",
  7: "20",
  8: "24602460",
  9: "246020",
};

function recognizeAlnum(stroke) {
  const simplified = normalize(resample(stroke, 24));
  const dirs = directions(simplified);
  if (dirs.length === 0) return null;
  let best = { ch: null, score: Number.POSITIVE_INFINITY };
  for (const ch of ALPHANUM) {
    const tpl = CHAR_TEMPLATES[ch];
    if (!tpl) continue;
    const arr = tpl.split("").map((d) => Number(d));
    const score = weightedEditDistance(dirs, arr);
    if (score < best.score) best = { ch, score };
  }
  return best.score <= 7 ? best.ch : null;
}

export default function App() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const userRef = useRef(null);
  const passRef = useRef(null);
  const activeFieldRef = useRef(null);
  const pendingFieldRef = useRef(null);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [activeField, setActiveField] = useState(null);
  const [pendingField, setPendingField] = useState(null);
  const [status, setStatus] = useState("Show open palm for username, back of hand for password.");
  const [handsSeen, setHandsSeen] = useState(0);
  const [recognizedChar, setRecognizedChar] = useState("");
  const [isWriting, setIsWriting] = useState(false);

  activeFieldRef.current = activeField;
  pendingFieldRef.current = pendingField;

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return undefined;
    if (!HandsCtor || !CameraCtor || !FaceMeshCtor) return undefined;

    let disposed = false;
    const ctx = canvas.getContext("2d");

    let nodBaseline = null;
    let nodSmooth = null;
    let nodState = "idle";
    let nodPeak = 0;
    let nodRef = 0;
    let nodAt = 0;
    let nodCooldownUntil = 0;

    const latestPrimary = { hand: null, handedness: null };
    let stroke = [];
    let lastStrokeAt = 0;

    const commitChar = (ch) => {
      if (!ch) return;
      setRecognizedChar(ch);
      setTimeout(() => setRecognizedChar(""), 700);
      const targetField = activeFieldRef.current;
      if (targetField === "username") {
        setUsername((prev) => (prev + ch).slice(0, MAX_FIELD_LENGTH));
      } else if (targetField === "password") {
        setPassword((prev) => (prev + ch).slice(0, MAX_FIELD_LENGTH));
      }
    };

    const maybeFinalizeStroke = (now) => {
      if (stroke.length < MIN_STROKE_POINTS) return;
      if (now - lastStrokeAt < CHAR_SETTLE_MS) return;
      const len = pathLength(stroke);
      if (len < MIN_STROKE_LENGTH) {
        stroke = [];
        setIsWriting(false);
        return;
      }
      const ch = recognizeAlnum(stroke);
      commitChar(ch);
      stroke = [];
      setIsWriting(false);
    };

    const drawOverlay = () => {
      if (disposed) return;
      const cw = video.videoWidth || 1280;
      const ch = video.videoHeight || 720;
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
      ctx.clearRect(0, 0, cw, ch);
      ctx.save();
      ctx.scale(-1, 1);
      ctx.translate(-cw, 0);
      if (latestPrimary.hand) {
        ctx.strokeStyle = "rgba(255,255,255,0.75)";
        ctx.lineWidth = 2;
        for (const [a, b] of HAND_CONNECTIONS || []) {
          const A = latestPrimary.hand[a];
          const B = latestPrimary.hand[b];
          ctx.beginPath();
          ctx.moveTo(A.x * cw, A.y * ch);
          ctx.lineTo(B.x * cw, B.y * ch);
          ctx.stroke();
        }
      }
      if (stroke.length > 1) {
        ctx.strokeStyle = "rgba(129, 140, 248, 0.95)";
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(stroke[0].x * cw, stroke[0].y * ch);
        for (let i = 1; i < stroke.length; i += 1) {
          ctx.lineTo(stroke[i].x * cw, stroke[i].y * ch);
        }
        ctx.stroke();
      }
      ctx.restore();
    };

    const confirmSelection = () => {
      const field = pendingFieldRef.current;
      if (!field) return;
      setActiveField(field);
      setStatus(
        field === "username"
          ? "Username selected. Start air-writing letters or numbers."
          : "Password selected. Start air-writing letters or numbers.",
      );
      if (field === "username") userRef.current?.focus();
      if (field === "password") passRef.current?.focus();
      setPendingField(null);
    };

    const detectNod = (faceLm) => {
      const now = performance.now();
      const pitch = facePitch(faceLm);
      nodSmooth = nodSmooth === null ? pitch : 0.34 * pitch + 0.66 * nodSmooth;
      if (nodState === "idle") {
        nodBaseline = nodBaseline === null ? pitch : 0.05 * pitch + 0.95 * nodBaseline;
        if (now >= nodCooldownUntil && nodSmooth > nodBaseline + 0.08) {
          nodState = "armed";
          nodAt = now;
          nodRef = nodBaseline;
          nodPeak = nodSmooth;
        }
      } else {
        if (nodSmooth > nodPeak) nodPeak = nodSmooth;
        const timedOut = now - nodAt > 1200;
        const complete = nodPeak > nodRef + 0.05 && nodPeak - nodSmooth > 0.058;
        if (complete) {
          confirmSelection();
          nodState = "idle";
          nodCooldownUntil = now + 320;
          nodBaseline = nodSmooth;
        } else if (timedOut) {
          nodState = "idle";
          nodCooldownUntil = now + 240;
        }
      }
    };

    const hands = new HandsCtor({
      locateFile: (file) => `${MEDIAPIPE_HANDS_BASE}${file}`,
    });
    hands.setOptions({
      maxNumHands: 1,
      modelComplexity: 1,
      minDetectionConfidence: 0.65,
      minTrackingConfidence: 0.6,
    });
    hands.onResults((results) => {
      if (disposed) return;
      const lm = results.multiHandLandmarks?.[0] ?? null;
      const handed = results.multiHandedness?.[0]?.label ?? null;
      latestPrimary.hand = lm;
      latestPrimary.handedness = handed;
      setHandsSeen(results.multiHandLandmarks?.length ?? 0);

      const now = performance.now();
      if (!lm) {
        maybeFinalizeStroke(now);
        drawOverlay();
        return;
      }

      const open = isOpenPalm(lm);
      const side = palmFacing(lm);
      if (open && side === "palm" && pendingFieldRef.current !== "username") {
        setPendingField("username");
        setStatus("Open palm detected: nod to confirm USERNAME field.");
      } else if (open && side === "back" && pendingFieldRef.current !== "password") {
        setPendingField("password");
        setStatus("Back of hand detected: nod to confirm PASSWORD field.");
      }

      if (activeFieldRef.current && isPointingPose(lm)) {
        stroke.push({ x: lm[INDEX_TIP].x, y: lm[INDEX_TIP].y });
        if (stroke.length > 180) stroke.shift();
        lastStrokeAt = now;
        setIsWriting(true);
      } else {
        maybeFinalizeStroke(now);
      }
      drawOverlay();
    });

    const faceMesh = new FaceMeshCtor({
      locateFile: (file) => `${MEDIAPIPE_FACE_MESH_BASE}${file}`,
    });
    faceMesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    faceMesh.onResults((results) => {
      if (disposed) return;
      const lm = results.multiFaceLandmarks?.[0];
      if (lm) detectNod(lm);
    });

    const camera = new CameraCtor(video, {
      onFrame: async () => {
        if (disposed) return;
        await hands.send({ image: video });
        await faceMesh.send({ image: video });
      },
      width: 1280,
      height: 720,
      facingMode: "user",
    });

    camera.start().catch(() => {
      setStatus("Unable to access camera. Allow webcam permission and refresh.");
    });

    return () => {
      disposed = true;
      camera.stop();
      hands.close();
      faceMesh.close();
    };
  }, []);

  return (
    <main className="nyoui-screen">
      <div className="ambient ambient--one" />
      <div className="ambient ambient--two" />
      <div className="ambient ambient--three" />

      <section className="login-card">
        <h1 className="brand">
          Ny<span>o</span>UI
        </h1>

        <div className="fields">
          <label className={activeField === "username" ? "field active" : "field"}>
            <span>Username</span>
            <input
              ref={userRef}
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value.toUpperCase().slice(0, MAX_FIELD_LENGTH))}
              placeholder="AIR-WRITE USERNAME"
            />
          </label>

          <label className={activeField === "password" ? "field active" : "field"}>
            <span>Password</span>
            <input
              ref={passRef}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value.toUpperCase().slice(0, MAX_FIELD_LENGTH))}
              placeholder="AIR-WRITE PASSWORD"
            />
          </label>
        </div>

        <div className="actions">
          <button type="button">SIGN UP</button>
          <button type="button">LOGIN</button>
        </div>

        <p className="status">{status}</p>
        <p className="meta">
          {handsSeen > 0 ? "Hand tracked" : "Waiting for hand"} |{" "}
          {pendingField ? `pending: ${pendingField}` : `active: ${activeField ?? "none"}`}
          {isWriting ? " | writing..." : ""}
          {recognizedChar ? ` | detected: ${recognizedChar}` : ""}
        </p>
      </section>

      <div className="camera-pane" aria-label="Gesture camera">
        <video ref={videoRef} autoPlay playsInline muted />
        <canvas ref={canvasRef} />
      </div>
    </main>
  );
}
