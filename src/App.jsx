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

function getTimeGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good Morning!";
  if (hour < 18) return "Good Afternoon!";
  return "Good Evening!";
}

function normalizeUsername(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizePassword(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
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

function isThumbsUp(lm) {
  const w = lm[0];
  const thumbTip = lm[4];
  const thumbIp = lm[3];
  const thumbMcp = lm[2];
  const indexMcp = lm[5];

  const thumbExtendedUp = thumbTip.y < thumbIp.y - 0.02 && thumbTip.y < thumbMcp.y - 0.01;
  const thumbSeparated = Math.abs(thumbTip.x - indexMcp.x) > 0.02;

  const indexCurled = lm[8].y > lm[6].y;
  const middleCurled = lm[12].y > lm[10].y;
  const ringCurled = lm[16].y > lm[14].y;
  const pinkyCurled = lm[20].y > lm[18].y;

  return thumbExtendedUp && thumbSeparated && indexCurled && middleCurled && ringCurled && pinkyCurled;
}

function isIndexPointingUp(lm) {
  const indexTip = lm[8];
  const indexPip = lm[6];
  const indexPointingUp = indexTip.y < indexPip.y - 0.05;
  const middleCurled = isFingerCurled(lm, 12, 10);
  const ringCurled = isFingerCurled(lm, 16, 14);
  const pinkyCurled = isFingerCurled(lm, 20, 18);
  return indexPointingUp && middleCurled && ringCurled && pinkyCurled;
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
  const usernameRef = useRef("");
  const passwordRef = useRef("");

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [activeField, setActiveField] = useState(null);
  const [pendingField, setPendingField] = useState(null);
  const [status, setStatus] = useState("Controls: Point to move, index up = speech, two open palms = delete, one thumb up = click, two thumbs up = login.");
  const [handsSeen, setHandsSeen] = useState(0);
  const [cursorPos, setCursorPos] = useState({ x: 50, y: 50 });
  const [isClicking, setIsClicking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [showCamera, setShowCamera] = useState(true);
  const [showGuide, setShowGuide] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [profile, setProfile] = useState({
    picture: "https://via.placeholder.com/84x84.png?text=U",
    name: "Admin User",
    biography: "Welcome to NyoUI messaging dashboard.",
    status: "Online",
  });
  const [notifications, setNotifications] = useState([
    "Welcome back! Your dashboard is ready.",
    "Tip: You can use controls for gesture input and speech.",
  ]);
  const [newFriendName, setNewFriendName] = useState("");
  const [friends, setFriends] = useState(["Ava", "Noah", "Mia"]);
  const [newGroupName, setNewGroupName] = useState("");
  const [chatMessage, setChatMessage] = useState("");
  const [activeConversationId, setActiveConversationId] = useState("private-Ava");
  const [conversations, setConversations] = useState([
    {
      id: "private-Ava",
      type: "private",
      title: "Private: Ava",
      participants: ["You", "Ava"],
      messages: [
        { id: "m1", sender: "Ava", text: "Hi! Ready to chat?", time: new Date().toLocaleTimeString() },
      ],
    },
    {
      id: "group-team",
      type: "group",
      title: "Group: Team",
      participants: ["You", "Ava", "Noah"],
      messages: [
        { id: "m2", sender: "Noah", text: "Let us sync at 3 PM.", time: new Date().toLocaleTimeString() },
      ],
    },
  ]);

  const recognitionRef = useRef(null);
  const uploadInputRef = useRef(null);
  const cameraInputRef = useRef(null);
  const mouthGestureRef = useRef({ active: false, since: 0 });
  const isListeningRef = useRef(false);
  const ttsEnabledRef = useRef(ttsEnabled);
  const lastSpokenRef = useRef({ text: "", at: 0 });
  const hoverSpeakRef = useRef({ text: "", at: 0, element: null });

  const speak = (text) => {
    if (!ttsEnabledRef.current || !window.speechSynthesis) return;
    const cleanText = String(text || "").trim();
    if (!cleanText) return;
    const now = Date.now();
    if (lastSpokenRef.current.text === cleanText && now - lastSpokenRef.current.at < 800) return;
    lastSpokenRef.current = { text: cleanText, at: now };
    try {
      const msg = new SpeechSynthesisUtterance(cleanText);
      msg.lang = "en-US";
      msg.rate = 1;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(msg);
    } catch {
      // Ignore browser TTS errors silently.
    }
  };

  useEffect(() => {
    isListeningRef.current = isListening;
  }, [isListening]);

  useEffect(() => {
    ttsEnabledRef.current = ttsEnabled;
  }, [ttsEnabled]);

  useEffect(() => {
    usernameRef.current = username;
  }, [username]);

  useEffect(() => {
    passwordRef.current = password;
  }, [password]);

  activeFieldRef.current = activeField;
  pendingFieldRef.current = pendingField;

  const handleLogin = () => {
    const currentUsername = normalizeUsername(username || usernameRef.current || "");
    const currentPassword = normalizePassword(password || passwordRef.current || "");
    if (currentUsername === ADMIN_USER && currentPassword === ADMIN_PASS) {
      setStatus("Login successful! Welcome, admin.");
      setIsLoggedIn(true);
      setNotifications((prev) => [`${getTimeGreeting()} You logged in successfully.`, ...prev]);
      speak(`${getTimeGreeting()} Welcome to your messaging dashboard.`);
    } else {
      setStatus("User not found. Would you like to sign up?");
    }
  };

  const handleLogout = () => {
    setIsLoggedIn(false);
    setUsername("");
    setPassword("");
    setActiveField(null);
    setPendingField(null);
    setStatus("Logged out.");
  };

  const updateProfileField = (key, value) => {
    setProfile((prev) => ({ ...prev, [key]: value }));
  };

  const updateProfilePictureFromFile = (file) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setStatus("Please select an image file.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const imageData = String(reader.result || "");
      if (!imageData) return;
      setProfile((prev) => ({ ...prev, picture: imageData }));
      setStatus("Profile picture updated.");
      speak("Profile picture updated.");
    };
    reader.readAsDataURL(file);
  };

  const getTextToRead = (element) => {
    if (!element) return "";
    const explicit = element.getAttribute("data-tts");
    if (explicit) return explicit;
    const aria = element.getAttribute("aria-label");
    if (aria) return aria;
    if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
      const labelText = element.closest("label")?.querySelector("span")?.textContent?.trim();
      const fallback = element.placeholder?.trim();
      return [labelText, fallback].filter(Boolean).join(". ");
    }
    if (element.tagName === "SELECT") {
      const labelText = element.closest("label")?.querySelector("span")?.textContent?.trim();
      return labelText || "Status selection";
    }
    return element.textContent?.trim() || "";
  };

  const handleSpeakFromEvent = (event) => {
    if (!ttsEnabledRef.current) return;
    const target = event.target.closest(
      "[data-tts], button, input, textarea, select, label, h1, h2, h3, p, span, li, strong, em",
    );
    const text = getTextToRead(target);
    if (text) speak(text);
  };

  const speakHoveredElement = (element) => {
    if (!ttsEnabledRef.current || !element) return;
    const readableTarget = element.closest(
      "[data-tts], button, input, textarea, select, label, h1, h2, h3, p, span, li, strong, em",
    );
    if (!readableTarget) return;
    const text = getTextToRead(readableTarget);
    if (!text) return;
    const now = Date.now();
    const isSameElement = hoverSpeakRef.current.element === readableTarget;
    const isSameText = hoverSpeakRef.current.text === text;
    if ((isSameElement || isSameText) && now - hoverSpeakRef.current.at < 1000) return;
    hoverSpeakRef.current = { element: readableTarget, text, at: now };
    speak(text);
  };

  const addFriend = () => {
    const clean = newFriendName.trim();
    if (!clean) return;
    if (friends.some((friend) => friend.toLowerCase() === clean.toLowerCase())) {
      setStatus(`${clean} is already in your friends list.`);
      return;
    }
    setFriends((prev) => [...prev, clean]);
    setConversations((prev) => [
      ...prev,
      {
        id: `private-${clean}`,
        type: "private",
        title: `Private: ${clean}`,
        participants: ["You", clean],
        messages: [],
      },
    ]);
    setNotifications((prev) => [`${clean} added to your friends list.`, ...prev]);
    setNewFriendName("");
    setStatus(`${clean} added as friend.`);
    speak(`${clean} added as friend.`);
  };

  const removeFriend = (friendName) => {
    setFriends((prev) => prev.filter((friend) => friend !== friendName));
    setConversations((prev) => prev.filter((convo) => convo.id !== `private-${friendName}`));
    if (activeConversationId === `private-${friendName}`) {
      setActiveConversationId("group-team");
    }
    setNotifications((prev) => [`${friendName} removed from friends list.`, ...prev]);
    setStatus(`${friendName} removed from friends list.`);
  };

  const createGroupChat = () => {
    const clean = newGroupName.trim();
    if (!clean) return;
    const id = `group-${clean.toLowerCase().replace(/\s+/g, "-")}`;
    if (conversations.some((conversation) => conversation.id === id)) {
      setStatus("Group chat name already exists.");
      return;
    }
    setConversations((prev) => [
      ...prev,
      {
        id,
        type: "group",
        title: `Group: ${clean}`,
        participants: ["You", ...friends.slice(0, 3)],
        messages: [],
      },
    ]);
    setActiveConversationId(id);
    setNewGroupName("");
    setNotifications((prev) => [`Group chat "${clean}" created.`, ...prev]);
    setStatus(`Created group chat: ${clean}`);
    speak(`Group chat ${clean} created.`);
  };

  const sendMessage = () => {
    const text = chatMessage.trim();
    if (!text) return;
    const timestamp = new Date().toLocaleTimeString();
    setConversations((prev) =>
      prev.map((conversation) =>
        conversation.id === activeConversationId
          ? {
              ...conversation,
              messages: [
                ...conversation.messages,
                { id: `${conversation.id}-${Date.now()}`, sender: "You", text, time: timestamp },
              ],
            }
          : conversation,
      ),
    );
    setChatMessage("");
    setStatus("Message sent.");
    speak(`Message sent: ${text}`);
  };

  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId) ?? conversations[0];

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
            let cleanText = "";
            if (field === "username") {
              cleanText = text.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
              setUsername((prev) => (prev + cleanText).slice(0, MAX_FIELD_LENGTH));
            } else if (field === "password") {
              cleanText = text.trim().replace(/[^a-zA-Z0-9]/g, "");
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
          ? "Username active. Click, index up to speak, two palms to delete, or two thumbs up to login."
          : "Password active. Click, index up to speak, two palms to delete, or two thumbs up to login.",
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
      let thumbsUpCount = 0;

      for (let i = 0; i < handsCount; i++) {
        const lm = results.multiHandLandmarks[i];
        if (isPointingPose(lm)) {
          pointingHand = lm;
        } else if (isThumbsUp(lm)) {
          clickHand = lm;
          thumbsUpCount += 1;
        }
      }

      latestPrimary.hand = pointingHand;
      secondaryHand = clickHand;

      if (pointingHand) {
        const tipX = 1 - pointingHand[INDEX_TIP].x;
        const tipY = pointingHand[INDEX_TIP].y;
        setCursorPos({ x: tipX * 100, y: tipY * 100 });
        const hoverX = tipX * window.innerWidth;
        const hoverY = tipY * window.innerHeight;
        const hoveredElement = document.elementFromPoint(hoverX, hoverY);
        speakHoveredElement(hoveredElement);

        const speechGesture = activeFieldRef.current && isIndexPointingUp(pointingHand);
        if (speechGesture) {
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
            let targetElement = element;
            let buttonElement = element.closest("button");

            if (buttonElement) {
              targetElement = buttonElement;
              buttonElement.click();
              setStatus(`Clicked: ${buttonElement.textContent.trim()}`);
            } else {
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
      }

      const twoOpenPalmsFacingCamera = handsCount === 2 &&
        results.multiHandLandmarks.every((lm) => isOpenPalm(lm) && palmFacing(lm) === "palm");

      if (twoOpenPalmsFacingCamera && activeFieldRef.current && now >= clickCooldownUntil) {
        clickCooldownUntil = now + 400;
        const field = activeFieldRef.current;
        if (field === "username") {
          setUsername((prev) => prev.slice(0, -1));
          setStatus("Deleted last character from username");
        } else if (field === "password") {
          setPassword((prev) => prev.slice(0, -1));
          setStatus("Deleted last character from password");
        }
      }

      if (thumbsUpCount === 2 && now >= clickCooldownUntil) {
        clickCooldownUntil = now + 600;
        setIsClicking(true);
        setTimeout(() => setIsClicking(false), 300);
        handleLogin();
      }

      if (!pointingHand) {
        if (mouthGestureRef.current.active) {
          mouthGestureRef.current = { active: false, since: 0 };
          if (recognitionRef.current && isListeningRef.current) {
            try { recognitionRef.current.stop(); } catch {}
          }
        }
        if (handsCount > 0) {
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

  useEffect(() => {
    const handleMouseMove = (event) => {
      const hoveredElement = document.elementFromPoint(event.clientX, event.clientY);
      speakHoveredElement(hoveredElement);
    };
    window.addEventListener("mousemove", handleMouseMove, { passive: true });
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
    };
  }, []);

  return (
    <main
      className="nyoui-screen"
      onMouseOver={handleSpeakFromEvent}
      onFocusCapture={handleSpeakFromEvent}
      onClickCapture={handleSpeakFromEvent}
    >
      <div className="ambient ambient--one" />
      <div className="ambient ambient--two" />
      <div className="ambient ambient--three" />

      {isLoggedIn ? (
        <section className="dashboard" aria-label="Messaging dashboard">
          <div className="dashboard-top">
            <div>
              <h2>{getTimeGreeting()} {profile.name || username}!</h2>
              <p className="small">Messaging dashboard active for {username}.</p>
            </div>
            <div className="top-actions">
              <button type="button" onClick={() => setShowGuide(true)}>CONTROLS</button>
              <button type="button" className="danger" onClick={handleLogout}>LOGOUT</button>
            </div>
          </div>

          <section className="controls-panel" aria-label="Controls preferences">
            <h3>Controls</h3>
            <label className="toggle">
              <input
                type="checkbox"
                checked={ttsEnabled}
                onChange={(e) => {
                  setTtsEnabled(e.target.checked);
                  setStatus(e.target.checked ? "Text-to-Speech enabled." : "Text-to-Speech disabled.");
                }}
              />
              <span>Text-to-Speech {ttsEnabled ? "On" : "Off"}</span>
            </label>
          </section>

          <div className="dashboard-grid">
            <aside className="left-pane" aria-label="Profile and social panels">
              <section className="card" aria-label="Profile settings">
                <h3>Profile</h3>
                <img className="profile-picture" src={profile.picture} alt={`${profile.name} profile`} />
                <input
                  type="url"
                  value={profile.picture}
                  onChange={(e) => updateProfileField("picture", e.target.value)}
                  placeholder="Profile picture URL"
                  aria-label="Profile picture URL"
                />
                <input
                  type="text"
                  value={profile.name}
                  onChange={(e) => updateProfileField("name", e.target.value)}
                  placeholder="Name"
                  aria-label="Profile name"
                />
                <input
                  type="text"
                  value={profile.biography}
                  onChange={(e) => updateProfileField("biography", e.target.value)}
                  placeholder="Biography"
                  aria-label="Profile biography"
                />
                <div className="profile-media-actions">
                  <button
                    type="button"
                    onClick={() => uploadInputRef.current?.click()}
                    data-tts="Upload profile picture"
                  >
                    Upload Picture
                  </button>
                  <button
                    type="button"
                    onClick={() => cameraInputRef.current?.click()}
                    data-tts="Take profile picture"
                  >
                    Take Picture
                  </button>
                  <input
                    ref={uploadInputRef}
                    type="file"
                    accept="image/*"
                    onChange={(e) => updateProfilePictureFromFile(e.target.files?.[0])}
                    className="profile-file-input"
                    aria-label="Upload profile picture file"
                  />
                  <input
                    ref={cameraInputRef}
                    type="file"
                    accept="image/*"
                    capture="user"
                    onChange={(e) => updateProfilePictureFromFile(e.target.files?.[0])}
                    className="profile-file-input"
                    aria-label="Take profile picture using camera"
                  />
                </div>
                <select
                  value={profile.status}
                  onChange={(e) => updateProfileField("status", e.target.value)}
                  aria-label="User availability status"
                >
                  <option>Online</option>
                  <option>Away</option>
                  <option>Offline</option>
                </select>
              </section>

              <section className="card" aria-label="Notifications">
                <h3>Notifications</h3>
                <ul className="list">
                  {notifications.slice(0, 5).map((notice, idx) => (
                    <li key={`${notice}-${idx}`}>
                      <span>{notice}</span>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="card" aria-label="Friends list">
                <h3>Friends List</h3>
                <div className="inline-input">
                  <input
                    type="text"
                    value={newFriendName}
                    onChange={(e) => setNewFriendName(e.target.value)}
                    placeholder="Add friend by name"
                    aria-label="Add friend by name"
                  />
                  <button type="button" onClick={addFriend}>Add</button>
                </div>
                <ul className="list">
                  {friends.map((friend) => (
                    <li key={friend}>
                      <button
                        type="button"
                        className={`list-open small-btn${activeConversationId === `private-${friend}` ? " active" : ""}`}
                        onClick={() => setActiveConversationId(`private-${friend}`)}
                      >
                        {friend}
                      </button>
                      <button type="button" className="small-btn danger" onClick={() => removeFriend(friend)}>Remove</button>
                    </li>
                  ))}
                </ul>
              </section>
            </aside>

            <section className="card chat-pane" aria-label="Chatbox">
              <h3>Chatbox</h3>
              <div className="inline-input">
                <input
                  type="text"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  placeholder="Create group chat"
                  aria-label="Create group chat"
                />
                <button type="button" onClick={createGroupChat}>Create Group</button>
              </div>

              <div className="chat-tabs" role="tablist" aria-label="Conversations">
                {conversations.map((conversation) => (
                  <button
                    key={conversation.id}
                    type="button"
                    role="tab"
                    aria-selected={activeConversationId === conversation.id}
                    className={`chat-tab${activeConversationId === conversation.id ? " active" : ""}`}
                    onClick={() => setActiveConversationId(conversation.id)}
                  >
                    {conversation.title}
                  </button>
                ))}
              </div>

              <div className="messages">
                <p className="muted">
                  {activeConversation?.type === "private" ? "Private Messages" : "Group Chat"} | Participants:{" "}
                  {activeConversation?.participants.join(", ")}
                </p>
                <ul className="list messages-list" aria-label="Conversation messages">
                  {(activeConversation?.messages ?? []).map((message) => (
                    <li key={message.id}>
                      <strong>{message.sender}</strong>
                      <span>{message.text}</span>
                      <em>{message.time}</em>
                    </li>
                  ))}
                </ul>
                <div className="inline-input">
                  <input
                    type="text"
                    value={chatMessage}
                    onChange={(e) => setChatMessage(e.target.value)}
                    placeholder="Type a message"
                    aria-label="Type a message"
                  />
                  <button type="button" onClick={sendMessage}>Send</button>
                </div>
              </div>
            </section>
          </div>

          <p className="status">{status}</p>
          <p className="meta">
            {handsSeen > 0 ? `${handsSeen} hand${handsSeen > 1 ? "s" : ""} tracked` : "Waiting for hands"}
            {isListening ? " | SPEECH..." : ""}
            {isClicking ? " | CLICK!" : ""}
          </p>
        </section>
      ) : (
        <section className="login-card">
          <h1 className="brand">
            Ny<span>o</span>UI
          </h1>

          <form
            className="fields"
            onSubmit={(e) => {
              e.preventDefault();
              handleLogin();
            }}
          >
            <label className={activeField === "username" ? "field active" : "field"}>
              <span>Username</span>
              <input
                ref={userRef}
                type="text"
                value={username}
                onChange={(e) => {
                  const next = e.target.value.slice(0, MAX_FIELD_LENGTH);
                  setUsername(next);
                  usernameRef.current = next;
                }}
                onClick={() => { setActiveField("username"); setPendingField(null); setStatus("Username active. Click, index up to speak, two palms to delete, or two thumbs up to login."); }}
                placeholder="SPEECH OR TYPE USERNAME"
              />
            </label>

            <label className={activeField === "password" ? "field active" : "field"}>
              <span>Password</span>
              <input
                ref={passRef}
                type="password"
                value={password}
                onChange={(e) => {
                  const next = e.target.value.slice(0, MAX_FIELD_LENGTH);
                  setPassword(next);
                  passwordRef.current = next;
                }}
                onClick={() => { setActiveField("password"); setPendingField(null); setStatus("Password active. Click, index up to speak, two palms to delete, or two thumbs up to login."); }}
                placeholder="SPEECH OR TYPE PASSWORD"
              />
            </label>
          </form>

          <div className="actions">
            <button type="button" onClick={() => setShowGuide(true)}>CONTROLS</button>
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
      )}

      <div className={`camera-pane${showCamera ? "" : " camera-pane--hidden"}`} aria-label="Gesture camera">
        <video ref={videoRef} autoPlay playsInline muted />
        <canvas ref={canvasRef} />
        <button className="camera-toggle" onClick={() => setShowCamera(!showCamera)} aria-label={showCamera ? "Hide camera" : "Show camera"}>
          {showCamera ? "✕" : "self camera"}
        </button>
      </div>

      <div
        className={`cursor-follower${isClicking ? " clicking" : ""}${isListening ? " listening" : ""}`}
        style={{
          left: `${cursorPos.x}%`,
          top: `${cursorPos.y}%`,
          opacity: handsSeen > 0 ? 0.85 : 0,
        }}
      />

      {showGuide && (
        <div className="guide-overlay" onClick={() => setShowGuide(false)}>
          <div className="guide-modal" onClick={(e) => e.stopPropagation()}>
            <button className="guide-close" onClick={() => setShowGuide(false)}>✕</button>
            <h2>Controls Guide</h2>
            <div className="guide-content">
              <div className="guide-item">
                <strong>Move cursor:</strong> Point index finger anywhere
              </div>
              <div className="guide-item">
                <strong>Click:</strong> Thumbs up with other hand while pointing
              </div>
              <div className="guide-item">
                <strong>Speech-to-text:</strong> Index finger pointing directly up (vertical) when field is active
              </div>
              <div className="guide-item">
                <strong>Delete last char:</strong> Two hands, both open palms facing camera
              </div>
              <div className="guide-item">
                <strong>Login:</strong> Two thumbs up
              </div>
              <div className="guide-item">
                <strong>Select username field:</strong> Show open palm, then nod
              </div>
              <div className="guide-item">
                <strong>Select password field:</strong> Show back of hand, then nod
              </div>
              <div className="guide-item">
                <strong>Click input directly:</strong> Point at input with cursor and thumbs up
              </div>
              <div className="guide-item">
                <strong>Text-to-Speech:</strong> Use the Controls panel toggle to enable or disable spoken feedback
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
