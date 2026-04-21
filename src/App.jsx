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
const MAX_FIELD_LENGTH = 24;

const ADMIN_USER = "OLDBUTGOLD";
const ADMIN_PASS = "admin";

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

function isThumbsUp(lm) {
  const w = lm[0];
  const thumbTip = lm[4];
  const thumbIp = lm[3];
  const thumbMcp = lm[2];
  const indexMcp = lm[5];

  const thumbExtendedUp = thumbTip.y < thumbIp.y - 0.04 && thumbTip.y < thumbMcp.y - 0.02;
  const thumbSeparated = Math.abs(thumbTip.x - indexMcp.x) > 0.03;

  const indexCurled = lm[8].y > lm[6].y + 0.02;
  const middleCurled = lm[12].y > lm[10].y + 0.02;
  const ringCurled = lm[16].y > lm[14].y + 0.02;
  const pinkyCurled = lm[20].y > lm[18].y + 0.02;

  return thumbExtendedUp && thumbSeparated && indexCurled && middleCurled && ringCurled && pinkyCurled;
}

function isPointingAtMouth(handLm, faceLm) {
  if (!handLm || !faceLm) return false;
  const backOfHand = palmFacing(handLm) === "back";
  const indexExtended = isFingerExtended(handLm, 8, 6);
  const middleCurled = isFingerCurled(handLm, 12, 10);
  const ringCurled = isFingerCurled(handLm, 16, 14);
  const pinkyCurled = isFingerCurled(handLm, 20, 18);

  const lowerLip = faceLm[17];
  const indexTip = handLm[8];
  const distToMouth = Math.hypot(indexTip.x - lowerLip.x, indexTip.y - lowerLip.y);
  const nearMouth = distToMouth < 0.12;
  const fingerAboveMouth = indexTip.y < lowerLip.y;

  return backOfHand && indexExtended && middleCurled && ringCurled && pinkyCurled && nearMouth && fingerAboveMouth;
}

function facePitch(lm) {
  const nose = lm[1];
  const le = lm[33];
  const re = lm[263];
  const eyeMidY = (le.y + re.y) / 2;
  const scale = Math.max(0.04, Math.hypot(re.x - le.x, re.y - le.y));
  return (nose.y - eyeMidY) / scale;
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
  const [status, setStatus] = useState("Controls: Point to move, thumbs up = click, point at mouth = speech.");
  const [handsSeen, setHandsSeen] = useState(0);
  const [cursorPos, setCursorPos] = useState({ x: 50, y: 50 });
  const [isClicking, setIsClicking] = useState(false);
  const [isListening, setIsListening] = useState(false);

  const recognitionRef = useRef(null);
  const mouthGestureRef = useRef({ active: false, since: 0 });
  const isListeningRef = useRef(false);

  useEffect(() => {
    isListeningRef.current = isListening;
  }, [isListening]);

  activeFieldRef.current = activeField;
  pendingFieldRef.current = pendingField;

  const handleLogin = () => {
    if (username.toUpperCase() === ADMIN_USER && password === ADMIN_PASS) {
      setStatus("Login successful! Welcome, admin.");
    } else {
      setStatus("Invalid credentials. Try: OldButGold / admin");
    }
  };

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
    let secondaryHand = null;
    let clickCooldownUntil = 0;
    let latestFaceLm = null;

    const drawOverlay = () => {
      if (disposed) return;
      const cw = video.videoWidth || 1280;
      const ch = video.videoHeight || 720;
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
      ctx.clearRect(0, 0, cw, ch);
    };

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current.continuous = true;
      recognitionRef.current.interimResults = true;
      recognitionRef.current.lang = "en-US";

      recognitionRef.current.onstart = () => {
        setIsListening(true);
        setStatus("Listening... Speak now.");
      };

      recognitionRef.current.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current.onresult = (event) => {
        const results = event.results;
        if (results.length > 0) {
          const lastResult = results[results.length - 1];
          const text = lastResult[0].transcript;
          if (lastResult.isFinal && activeFieldRef.current) {
            const field = activeFieldRef.current;
            const cleanText = text.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
            if (field === "username") {
              setUsername((prev) => (prev + cleanText).slice(0, MAX_FIELD_LENGTH));
            } else if (field === "password") {
              setPassword((prev) => (prev + cleanText).slice(0, MAX_FIELD_LENGTH));
            }
            setStatus(`Speech recognized: "${cleanText}"`);
          }
        }
      };

      recognitionRef.current.onerror = (event) => {
        if (event.error !== "aborted") {
          setIsListening(false);
        }
      };
    }

    const confirmSelection = () => {
      const field = pendingFieldRef.current;
      if (!field) return;
      setActiveField(field);
      setStatus(
        field === "username"
          ? "Username active. Click or point at mouth to speak."
          : "Password active. Click or point at mouth to speak.",
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
      maxNumHands: 2,
      modelComplexity: 1,
      minDetectionConfidence: 0.65,
      minTrackingConfidence: 0.6,
    });
    hands.onResults((results) => {
      if (disposed) return;
      const handsCount = results.multiHandLandmarks?.length ?? 0;
      setHandsSeen(handsCount);

      const now = performance.now();

      let pointingHand = null;
      let clickHand = null;

      for (let i = 0; i < handsCount; i++) {
        const lm = results.multiHandLandmarks[i];
        if (isPointingPose(lm)) {
          pointingHand = lm;
        } else if (isThumbsUp(lm)) {
          clickHand = lm;
        }
      }

      latestPrimary.hand = pointingHand;
      secondaryHand = clickHand;

      if (pointingHand) {
        const tipX = 1 - pointingHand[INDEX_TIP].x;
        const tipY = pointingHand[INDEX_TIP].y;
        setCursorPos({ x: tipX * 100, y: tipY * 100 });

        const mouthPointing = activeFieldRef.current && latestFaceLm && isPointingAtMouth(pointingHand, latestFaceLm);
        if (mouthPointing) {
          if (!mouthGestureRef.current.active) {
            mouthGestureRef.current = { active: true, since: now };
            if (recognitionRef.current && !isListeningRef.current) {
              try { recognitionRef.current.start(); } catch {}
            }
          }
        } else {
          if (mouthGestureRef.current.active) {
            mouthGestureRef.current = { active: false, since: 0 };
            if (recognitionRef.current && isListeningRef.current) {
              try { recognitionRef.current.stop(); } catch {}
            }
          }
        }

        if (clickHand && now >= clickCooldownUntil) {
          setIsClicking(true);
          clickCooldownUntil = now + 500;
          setTimeout(() => setIsClicking(false), 200);

          const screenX = tipX * window.innerWidth;
          const screenY = tipY * window.innerHeight;
          const element = document.elementFromPoint(screenX, screenY);

          if (element) {
            const mousedown = new MouseEvent("mousedown", {
              bubbles: true,
              cancelable: true,
              clientX: screenX,
              clientY: screenY,
            });
            const mouseup = new MouseEvent("mouseup", {
              bubbles: true,
              cancelable: true,
              clientX: screenX,
              clientY: screenY,
            });
            const click = new MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              clientX: screenX,
              clientY: screenY,
            });
            element.dispatchEvent(mousedown);
            element.dispatchEvent(mouseup);
            element.dispatchEvent(click);
            element.focus?.();
            setStatus(`Clicked: ${element.tagName.toLowerCase()}${element.id ? "#" + element.id : ""}`);
          }
        }
      }

      if (!pointingHand && handsCount > 0) {
        const lm = results.multiHandLandmarks[0];
        const open = isOpenPalm(lm);
        const side = palmFacing(lm);
        if (open && side === "palm" && pendingFieldRef.current !== "username") {
          setPendingField("username");
          setStatus("Open palm = Username field. Nod to confirm.");
        } else if (open && side === "back" && pendingFieldRef.current !== "password") {
          setPendingField("password");
          setStatus("Back of hand = Password field. Nod to confirm.");
        }
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
      if (lm) {
        latestFaceLm = lm;
        detectNod(lm);
      }
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
      if (recognitionRef.current) {
        recognitionRef.current.abort();
        recognitionRef.current = null;
      }
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
              placeholder="SPEECH OR TYPE USERNAME"
            />
          </label>

          <label className={activeField === "password" ? "field active" : "field"}>
            <span>Password</span>
            <input
              ref={passRef}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value.slice(0, MAX_FIELD_LENGTH))}
              placeholder="SPEECH OR TYPE PASSWORD"
            />
          </label>
        </div>

        <div className="actions">
          <button type="button" onClick={() => setStatus("Sign up not implemented.")}>SIGN UP</button>
          <button type="button" onClick={handleLogin}>LOGIN</button>
        </div>

        <p className="status">{status}</p>
        <p className="meta">
          {handsSeen > 0 ? `${handsSeen} hand${handsSeen > 1 ? "s" : ""} tracked` : "Waiting for hands"} |{" "}
          {pendingField ? `pending: ${pendingField}` : `active: ${activeField ?? "none"}`}
          {isListening ? " | SPEECH..." : ""}
          {isClicking ? " | CLICK!" : ""}
        </p>
      </section>

      <div className="camera-pane" aria-label="Gesture camera">
        <video ref={videoRef} autoPlay playsInline muted />
        <canvas ref={canvasRef} />
      </div>

      <div
        className={`cursor-follower${isClicking ? " clicking" : ""}${isListening ? " listening" : ""}`}
        style={{
          left: `${cursorPos.x}%`,
          top: `${cursorPos.y}%`,
          opacity: handsSeen > 0 ? 0.85 : 0,
        }}
      />
    </main>
  );
}
