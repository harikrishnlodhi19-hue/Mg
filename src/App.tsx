import React, { useState, useEffect, useRef, useCallback } from "react";
import { Mic, MicOff, Loader2, Volume2, VolumeX, Keyboard, Send, Trash2, LogIn, LogOut, Sparkles, User as UserIcon, Database, MessageSquare, X } from "lucide-react";
import { getZoyaResponse, getZoyaAudio, resetZoyaSession } from "./services/geminiService";
import { processCommand } from "./services/commandService";
import { LiveSessionManager } from "./services/liveService";
import Visualizer from "./components/Visualizer";
import PermissionModal from "./components/PermissionModal";
import { playPCM, initAudio } from "./utils/audioUtils";
import { motion, AnimatePresence } from "motion/react";

// Firebase imports
import { db, auth, googleProvider, handleFirestoreError, OperationType } from "./services/firebase";
import { signInWithPopup, signOut, onAuthStateChanged, GoogleAuthProvider, User as FirebaseUser } from "firebase/auth";
import { doc, getDoc, setDoc, collection, query, orderBy, limit, getDocs, writeBatch, serverTimestamp } from "firebase/firestore";

type AppState = "idle" | "listening" | "processing" | "speaking";

interface ChatMessage {
  id: string;
  sender: "user" | "zoya";
  text: string;
  groundingSources?: { title: string; url: string }[];
}

declare global {
  interface Window {
    SpeechRecognition: any;
    webkitSpeechRecognition: any;
  }
}

export default function App() {
  const [appState, setAppState] = useState<AppState>("idle");
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [creatorName, setCreatorName] = useState("Harikirshan lodhi");
  const [isDbLoading, setIsDbLoading] = useState(false);
  const [gmailToken, setGmailToken] = useState<string | null>(null);
  const [userLocation, setUserLocation] = useState<{ latitude: number, longitude: number } | null>(null);

  useEffect(() => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          setUserLocation({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude
          });
        },
        (error) => {
          console.log("Geolocation permission or retrieval was declined/restricted:", error);
        }
      );
    }
  }, []);
  
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messagesRef = useRef(messages);

  useEffect(() => {
    messagesRef.current = messages;
    if (!user) {
      localStorage.setItem("zoya_chat_history", JSON.stringify(messages));
    }
  }, [messages, user]);

  const [isMuted, setIsMuted] = useState(false);

  useEffect(() => {
    if (liveSessionRef.current) {
      liveSessionRef.current.isMuted = isMuted;
    }
  }, [isMuted]);

  // Synchronize mute preference to database
  const toggleMutedInDb = async () => {
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    if (user) {
      const writePath = `users/${user.uid}/preferences/settings`;
      try {
        await setDoc(doc(db, "users", user.uid, "preferences", "settings"), {
          userId: user.uid,
          creatorName: creatorName,
          isMuted: nextMuted,
          updatedAt: serverTimestamp()
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, writePath);
      }
    }
  };

  const [showTextInput, setShowTextInput] = useState(false);
  const [textInput, setTextInput] = useState("");
  const [showPermissionModal, setShowPermissionModal] = useState(false);
  const [micErrorMessage, setMicErrorMessage] = useState<string | undefined>(undefined);
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [showHistoryOverlay, setShowHistoryOverlay] = useState(false);
  const [showSettingsOverlay, setShowSettingsOverlay] = useState(false);

  useEffect(() => {
    if (apiError) {
      const timer = setTimeout(() => {
        setApiError(null);
      }, 10000);
      return () => clearTimeout(timer);
    }
  }, [apiError]);

  const liveSessionRef = useRef<LiveSessionManager | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, appState]);

  // Listen to Firebase authentication and sync profile/history
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      if (firebaseUser) {
        setIsDbLoading(true);
        try {
          const prefPath = `users/${firebaseUser.uid}/preferences/settings`;
          let userPrefSnap;
          try {
            userPrefSnap = await getDoc(doc(db, "users", firebaseUser.uid, "preferences", "settings"));
          } catch (err) {
            handleFirestoreError(err, OperationType.GET, prefPath);
          }

          let name = "Harikirshan lodhi";
          let muted = false;

          if (userPrefSnap && userPrefSnap.exists()) {
            const data = userPrefSnap.data();
            name = data.creatorName || "Harikirshan lodhi";
            muted = data.isMuted ?? false;
            setCreatorName(name);
            setIsMuted(muted);
          } else {
            // First time settings initialization
            const writePath = `users/${firebaseUser.uid}/preferences/settings`;
            try {
              await setDoc(doc(db, "users", firebaseUser.uid, "preferences", "settings"), {
                userId: firebaseUser.uid,
                creatorName: name,
                isMuted: muted,
                updatedAt: serverTimestamp()
              });
            } catch (err) {
              handleFirestoreError(err, OperationType.WRITE, writePath);
            }
          }

          // Fetch past conversations up to 30 history messages
          const historyPath = `users/${firebaseUser.uid}/chat_history`;
          try {
            const q = query(
              collection(db, "users", firebaseUser.uid, "chat_history"),
              orderBy("createdAt", "asc"),
              limit(30)
            );
            const querySnapshot = await getDocs(q);
            const fetchedMessages: ChatMessage[] = [];
            querySnapshot.forEach((docSnap) => {
              const d = docSnap.data();
              fetchedMessages.push({
                id: docSnap.id,
                sender: d.sender,
                text: d.text,
                groundingSources: d.groundingSources || undefined
              });
            });
            setMessages(fetchedMessages);
          } catch (err) {
            handleFirestoreError(err, OperationType.GET, historyPath);
          }
        } catch (error) {
          console.error("Failed to sync database", error);
        } finally {
          setIsDbLoading(false);
        }
      } else {
        // Safe guest load fallback
        setCreatorName("Harikirshan lodhi");
        setGmailToken(null);
        const saved = localStorage.getItem("zoya_chat_history");
        if (saved) {
          try {
            setMessages(JSON.parse(saved));
          } catch (e) {
            console.error("Failed to parse chat history", e);
          }
        } else {
          setMessages([]);
        }
      }
    });

    return () => unsubscribe();
  }, []);

  const handleLogin = async () => {
    setIsDbLoading(true);
    try {
      googleProvider.addScope("https://www.googleapis.com/auth/gmail.readonly");
      googleProvider.addScope("https://www.googleapis.com/auth/userinfo.email");
      googleProvider.addScope("https://www.googleapis.com/auth/userinfo.profile");
      const result = await signInWithPopup(auth, googleProvider);
      const credential = GoogleAuthProvider.credentialFromResult(result);
      if (credential?.accessToken) {
        setGmailToken(credential.accessToken);
        if (liveSessionRef.current) {
          liveSessionRef.current.gmailToken = credential.accessToken;
        }
      }
    } catch (err: any) {
      if (err?.code === "auth/popup-closed-by-user" || err?.code === "auth/popup-blocked") {
        console.warn("Google Auth popup closed by user or blocked.");
        setApiError("Database Sync Sign-In was closed or blocked. Because the helper runs in a sandboxed iframe inside AI Studio, click the 'Open in New Tab' icon in the upper-right corner of your preview panel to sign in natively!");
      } else {
        console.error("Google Auth failed: ", err);
        setApiError(err?.message || String(err));
      }
    } finally {
      setIsDbLoading(false);
    }
  };

  const handleLogout = async () => {
    setIsDbLoading(true);
    try {
      await signOut(auth);
      setMessages([]);
      setCreatorName("Harikirshan lodhi");
      setGmailToken(null);
      resetZoyaSession();
    } catch (err) {
      console.error("Logout failed: ", err);
    } finally {
      setIsDbLoading(false);
    }
  };

  const updateCreatorNameInDb = async (newName: string) => {
    if (!newName.trim()) return;
    setCreatorName(newName);
    if (user) {
      const writePath = `users/${user.uid}/preferences/settings`;
      try {
        await setDoc(doc(db, "users", user.uid, "preferences", "settings"), {
          userId: user.uid,
          creatorName: newName,
          isMuted: isMuted,
          updatedAt: serverTimestamp()
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, writePath);
      }
    }
  };

  const clearHistory = async () => {
    if (confirm("Are you sure you want to clear your chat history logs?")) {
      setMessages([]);
      resetZoyaSession();
      if (user) {
        const historyPath = `users/${user.uid}/chat_history`;
        try {
          const q = query(collection(db, "users", user.uid, "chat_history"), limit(100));
          const snap = await getDocs(q);
          const batch = writeBatch(db);
          snap.forEach((d) => {
            batch.delete(d.ref);
          });
          await batch.commit();
        } catch (err) {
          handleFirestoreError(err, OperationType.DELETE, historyPath);
        }
      } else {
        localStorage.removeItem("zoya_chat_history");
      }
    }
  };

  const handleTextCommand = useCallback(async (finalTranscript: string) => {
    if (!finalTranscript.trim()) {
      setAppState("idle");
      return;
    }

    const userMsgId = Date.now().toString() + "-user";
    const userMsg: ChatMessage = { id: userMsgId, sender: "user", text: finalTranscript };
    setMessages((prev) => [...prev, userMsg]);
    
    if (user) {
      const writePath = `users/${user.uid}/chat_history/${userMsgId}`;
      try {
        await setDoc(doc(db, "users", user.uid, "chat_history", userMsgId), {
          userId: user.uid,
          sender: "user",
          text: finalTranscript,
          createdAt: serverTimestamp()
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, writePath);
      }
    }

    // If live session is active, send text through it
    if (isSessionActive && liveSessionRef.current) {
      liveSessionRef.current.sendText(finalTranscript);
      return;
    }

    setAppState("processing");

    // 1. Check for browser commands
    const commandResult = processCommand(finalTranscript);
    let responseText = "";

    if (commandResult.isBrowserAction) {
      responseText = commandResult.action;
      const zMsgId = Date.now().toString() + "-zoya";
      setMessages((prev) => [...prev, { id: zMsgId, sender: "zoya", text: responseText }]);
      
      if (user) {
        const writePath = `users/${user.uid}/chat_history/${zMsgId}`;
        try {
          await setDoc(doc(db, "users", user.uid, "chat_history", zMsgId), {
            userId: user.uid,
            sender: "zoya",
            text: responseText,
            createdAt: serverTimestamp()
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, writePath);
        }
      }

      if (!isMuted) {
        setAppState("speaking");
        const audioBase64 = await getZoyaAudio(responseText);
        if (audioBase64) {
          await playPCM(audioBase64);
        }
      }

      setAppState("idle");

      setTimeout(() => {
        if (commandResult.url) {
          window.open(commandResult.url, "_blank");
        }
      }, 1500);
    } else {
      // 2. General Chit-Chat via Gemini
      try {
        const zoyaRes = await getZoyaResponse(finalTranscript, messagesRef.current, creatorName, gmailToken, userLocation);
        responseText = zoyaRes.text;
        const zMsgId = Date.now().toString() + "-zoya";
        setMessages((prev) => [...prev, { id: zMsgId, sender: "zoya", text: responseText, groundingSources: zoyaRes.groundingSources }]);
        
        if (user) {
          const writePath = `users/${user.uid}/chat_history/${zMsgId}`;
          try {
            await setDoc(doc(db, "users", user.uid, "chat_history", zMsgId), {
              userId: user.uid,
              sender: "zoya",
              text: responseText,
              groundingSources: zoyaRes.groundingSources || null,
              createdAt: serverTimestamp()
            });
          } catch (err) {
            handleFirestoreError(err, OperationType.WRITE, writePath);
          }
        }

        if (!isMuted) {
          setAppState("speaking");
          const audioBase64 = await getZoyaAudio(responseText);
          if (audioBase64) {
            await playPCM(audioBase64);
          }
        }
      } catch (err: any) {
        console.error("Zoya response failure", err);
        const errMsg = err?.message || String(err);
        setApiError(errMsg);
        
        let customZoyaErr = `Uff, mera dimaag kharab ho gaya hai (System error: ${errMsg}). Can you try reloading or check settings?`;
        if (errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.includes("429")) {
          customZoyaErr = `Arre yaar! Humari daily limits exhaust ho chuki hain! 😫 (Zoya exceeded Gemini Quota). Please wait a moment or link a paid API key from Settings.`;
        }
        
        const zMsgId = Date.now().toString() + "-zoya";
        setMessages((prev) => [...prev, { id: zMsgId, sender: "zoya", text: customZoyaErr }]);
      } finally {
        setAppState("idle");
      }
    }
  }, [isMuted, isSessionActive, user, creatorName, gmailToken, userLocation]);

  useEffect(() => {
    return () => {
      if (liveSessionRef.current) {
        liveSessionRef.current.stop();
      }
    };
  }, []);

  const toggleListening = async () => {
    initAudio();
    if (isSessionActive) {
      setIsSessionActive(false);
      if (liveSessionRef.current) {
        liveSessionRef.current.stop();
        liveSessionRef.current = null;
      }
      setAppState("idle");
      resetZoyaSession();
    } else {
      try {
        setIsSessionActive(true);
        setMicErrorMessage(undefined);
        resetZoyaSession();
        
        const session = new LiveSessionManager();
        session.isMuted = isMuted;
        session.creatorName = creatorName; // Pass database preferred name
        session.gmailToken = gmailToken || ""; // Pass Google OAuth Access Token for Gemini Live API fetch
        liveSessionRef.current = session;
        
        session.onStateChange = (state) => {
          setAppState(state);
        };
        
        session.onMessage = async (sender, text) => {
          const msgId = Date.now().toString() + "-" + sender;
          setMessages((prev) => [...prev, { id: msgId, sender, text }]);
          
          if (auth.currentUser) {
            const uid = auth.currentUser.uid;
            const writePath = `users/${uid}/chat_history/${msgId}`;
            try {
              await setDoc(doc(db, "users", uid, "chat_history", msgId), {
                userId: uid,
                sender,
                text,
                createdAt: serverTimestamp()
              });
            } catch (err) {
              handleFirestoreError(err, OperationType.WRITE, writePath);
            }
          }
        };
        
        session.onCommand = (url) => {
          setTimeout(() => {
            window.open(url, "_blank");
          }, 1000);
        };

        session.onError = (errorMsg) => {
          console.warn("Live assistant error callback received (Non-fatal warning, expected if permissions blocked in sandbox):", errorMsg);
          setApiError(errorMsg);
          setIsSessionActive(false);
          setAppState("idle");
          
          // Append error notice in chat log for full visual feedback
          const zMsgId = Date.now().toString() + "-zoya";
          let userNotice = `Arre, stream block ho gayi hai: ${errorMsg}.`;
          if (errorMsg.includes("Permission denied") || errorMsg.includes("NotAllowedError")) {
            userNotice = `Arre, microphone block ho gaya hai. Frame restrictions context mein voice support nahi chal sakta inside the editor. Please click the "Open in new tab" icon pointing upwards at top-right of your preview to talk, or click the keyboard button (⌨️) below to type!`;
          } else if (errorMsg.includes("RESOURCE_EXHAUSTED") || errorMsg.includes("429")) {
            userNotice = `Arre yaar, live microphone quota exhaust ho gaya hai! 😫 Please wait a minute or connect a paid key.`;
          }
          setMessages((prev) => [...prev, { id: zMsgId, sender: "zoya", text: userNotice }]);
        };

        await session.start();
      } catch (e: any) {
        console.warn("Failed to start session (Handled expected user exception):", e);
        const errorMsg = e?.message || String(e);
        setMicErrorMessage(errorMsg);
        setShowPermissionModal(true);
        setIsSessionActive(false);
        setAppState("idle");

        // Append high visibility tip in Zoya chat
        const zMsgId = Date.now().toString() + "-zoya";
        let userNotice = "Mera dimaag abhi sun nahi paa raha hai (Microphone is blocked or disabled in this window). But don't worry, click the keyboard icon (⌨️) next to the talk button and we can text!";
        if (errorMsg.includes("Permission denied") || errorMsg.includes("NotAllowedError")) {
          userNotice = `Microphone Permission Denied! Because of sandboxed iframe policies in Google AI Studio, please click 'Open in New Tab' on the top-right to speak natively, or activate the Keyboard Option (⌨️) next to 'Start Realtime Talk' to type with me!`;
        }
        setMessages((prev) => [...prev, { id: zMsgId, sender: "zoya", text: userNotice }]);
      }
    }
  };

  const handleTextSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    initAudio();
    if (!textInput.trim()) return;
    
    handleTextCommand(textInput);
    setTextInput("");
    setShowTextInput(false);
  };

  return (
    <div className="h-[100dvh] w-screen bg-[#02080b] text-white flex flex-col items-center justify-between font-sans relative overflow-hidden m-0 p-0">
      {showPermissionModal && (
        <PermissionModal 
          onClose={() => setShowPermissionModal(false)} 
          onTypeInstead={() => {
            setShowPermissionModal(false);
            setShowTextInput(true);
          }}
          errorMessage={micErrorMessage}
        />
      )}

      {/* Slide-down API Error Panel */}
      <AnimatePresence>
        {apiError && (
          <motion.div
            initial={{ opacity: 0, y: -50, x: "-50%" }}
            animate={{ opacity: 1, y: 0, x: "-50%" }}
            exit={{ opacity: 0, y: -50, x: "-50%" }}
            transition={{ type: "spring", stiffness: 300, damping: 25 }}
            className="fixed top-24 left-1/2 z-50 w-[90%] max-w-md bg-red-500/10 border border-red-500/20 backdrop-blur-md px-4 py-3 rounded-xl flex items-start gap-3 shadow-xl shadow-red-950/30 pointer-events-auto"
          >
            <div className="shrink-0 p-1 bg-red-500/20 rounded-lg text-red-400 mt-0.5">
              <Sparkles size={14} className="animate-pulse" />
            </div>
            <div className="flex-1 overflow-hidden">
              <h4 className="text-xs font-mono uppercase tracking-wider text-red-400 font-bold">Zoya System Note</h4>
              <p className="text-[11px] text-white/80 leading-relaxed mt-0.5">{apiError}</p>
            </div>
            <button 
              onClick={() => setApiError(null)}
              className="text-white/40 hover:text-white/80 shrink-0 text-[10px] font-mono font-bold cursor-pointer hover:bg-white/5 px-2 py-1 rounded"
            >
              [Dismiss]
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Cinematic Background Gradients */}
      <div className="absolute inset-0 w-full h-full overflow-hidden pointer-events-none">
        <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] bg-violet-900/20 blur-[120px] rounded-full animate-pulse duration-5000" />
        <div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] bg-pink-900/20 blur-[120px] rounded-full animate-pulse duration-[7000ms]" />
      </div>

      {/* Header */}
      <header className="absolute top-0 left-0 w-full flex justify-between items-center z-20 shrink-0 px-6 py-4 md:px-12 md:py-6 bg-gradient-to-b from-[#02080b]/80 to-transparent">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-violet-500 to-pink-500 flex items-center justify-center font-bold text-sm shadow-lg shadow-violet-500/25 animate-bounce">
            Z
          </div>
          <div>
            <h1 className="text-xl font-serif font-semibold tracking-wider text-transparent bg-clip-text bg-gradient-to-r from-violet-200 to-pink-200">Zoya</h1>
            <p className="text-[9px] font-mono opacity-40 uppercase tracking-widest">AI Voice Assistant</p>
          </div>
        </div>
        <div className="flex items-center gap-2 pointer-events-auto">
          {/* Mobile view db settings & history trigger */}
          <button
            onClick={() => setShowSettingsOverlay(true)}
            className="p-2 md:hidden rounded-full transition-all border border-white/10 bg-white/5 hover:bg-white/10"
            title="Database Preferences"
          >
            <Database size={18} className="text-violet-400" />
          </button>
          
          <button
            onClick={() => setShowHistoryOverlay(true)}
            className="p-2 md:hidden rounded-full transition-all border border-white/10 bg-white/5 hover:bg-white/10"
            title="Conversation Logs"
          >
            <MessageSquare size={18} className="text-pink-400" />
          </button>

          <button
            onClick={toggleMutedInDb}
            className={`p-2 rounded-full transition-all border border-white/10 ${
              isMuted ? "bg-red-500/10 text-red-400 border-red-500/30" : "bg-white/5 hover:bg-white/10"
            }`}
            title={isMuted ? "Unmute Voice" : "Mute Voice"}
          >
            {isMuted ? (
              <VolumeX size={18} />
            ) : (
              <Volume2 size={18} className="opacity-80" />
            )}
          </button>
        </div>
      </header>

      {/* Main Content - Visualizer & Chat Columns */}
      <main className="absolute inset-0 flex flex-row items-center justify-between w-full h-full z-10 overflow-hidden pt-24 pb-28 px-4 md:px-8 lg:px-12 pointer-events-none">
        
        {/* Left Column: Creator Identity & Database Config */}
        <div className="hidden md:flex w-[30%] lg:w-[32%] h-full flex-col justify-between z-10 bg-white/5 border border-white/10 p-4 rounded-2xl backdrop-blur-md overflow-hidden pointer-events-auto shadow-2xl">
          <div className="flex items-center justify-between border-b border-white/10 pb-2">
            <div className="flex items-center gap-2">
              <UserIcon size={16} className="text-violet-400" />
              <span className="font-mono text-xs uppercase tracking-wider text-white/80">Creator Identity</span>
            </div>
            {isDbLoading && <Loader2 size={14} className="animate-spin text-white/40" />}
          </div>

          <div className="flex-1 flex flex-col justify-center py-4 space-y-4">
            {user ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3 bg-white/5 p-3 rounded-xl border border-white/5">
                  <img 
                    src={user.photoURL || "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=80&auto=format&fit=crop&q=60"} 
                    alt="Profile photo" 
                    referrerPolicy="no-referrer"
                    className="w-10 h-10 rounded-full border border-violet-500/50" 
                  />
                  <div className="overflow-hidden">
                    <h4 className="font-semibold text-sm truncate">{user.displayName || "Harikirshan lodhi"}</h4>
                    <p className="text-[10px] text-white/40 font-mono truncate">{user.email}</p>
                  </div>
                </div>

                {/* Preferred Creator Name input */}
                <div className="space-y-1.5">
                  <label className="text-[10px] text-white/40 uppercase tracking-wider font-mono">Dynamic AI Persona Name</label>
                  <input 
                    type="text" 
                    value={creatorName}
                    onChange={(e) => updateCreatorNameInDb(e.target.value)}
                    placeholder="Enter creator name..."
                    maxLength={40}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:border-violet-500 focus:outline-none transition-colors"
                  />
                  <p className="text-[10px] text-white/30 leading-snug font-mono">
                    Updated live in Firestore rules database. Zoya roasts you by this name.
                  </p>
                </div>

                {gmailToken ? (
                  <div className="flex items-center gap-1.5 text-[10px] text-emerald-400 font-mono bg-emerald-500/10 p-2 rounded-xl border border-emerald-500/20">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    <span className="truncate">Gmail Access Enabled</span>
                  </div>
                ) : (
                  <button
                    onClick={handleLogin}
                    className="w-full py-1.5 bg-violet-600/10 hover:bg-violet-600/20 text-violet-300 border border-violet-500/20 rounded-xl text-[10px] font-mono transition-all cursor-pointer flex items-center justify-center gap-1.5"
                  >
                    <Sparkles size={11} className="text-violet-400" />
                    <span>Authorize Gmail Search</span>
                  </button>
                )}

                <button
                  onClick={handleLogout}
                  className="w-full py-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 rounded-xl text-xs font-mono transition-colors cursor-pointer"
                >
                  Unbind Database Sync
                </button>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center text-center space-y-4 p-2">
                <div className="w-11 h-11 bg-gradient-to-tr from-violet-500/10 to-pink-500/10 border border-violet-500/20 rounded-full flex items-center justify-center text-violet-400">
                  <Sparkles size={20} className="animate-pulse" />
                </div>
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold font-serif leading-tight">Welcome, Harikirshan Lodhi</h3>
                  <p className="text-xs text-white/40 leading-relaxed max-w-[210px] mx-auto">
                    Bind your Google Account to synchronize settings, mute configuration, and chat memory in Firebase!
                  </p>
                </div>
                
                <button
                  onClick={handleLogin}
                  className="flex items-center justify-center gap-2 bg-gradient-to-r from-violet-600 to-pink-600 hover:scale-102 transition-transform text-white font-medium text-xs py-2 px-3 rounded-xl shadow-lg shadow-violet-500/20 cursor-pointer"
                >
                  <LogIn size={12} />
                  <span>Connect Firestore Sync</span>
                </button>
              </div>
            )}
          </div>
          
          <div className="border-t border-white/10 pt-2 flex items-center gap-1.5 text-[10px] text-white/30 font-mono">
            <span>Status:</span>
            <span className="text-emerald-400 truncate">{user ? "Synced Securely" : "Guest Mode (Local Only)"}</span>
          </div>
        </div>

        {/* Center Visualizer Area */}
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none z-0">
          <Visualizer state={appState} />
          
          {/* Centered Floating Status Badge */}
          <div className="absolute bottom-[28%] h-8 flex items-center justify-center">
            <AnimatePresence mode="wait">
              {appState === "processing" && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="flex items-center gap-2 bg-cyan-500/10 border border-cyan-500/30 px-3 py-1.5 rounded-full text-cyan-300 text-xs font-mono uppercase tracking-widest shadow-lg shadow-cyan-500/10 backdrop-blur-md"
                >
                  <Loader2 size={12} className="animate-spin text-cyan-400" />
                  Zoya is Thinking
                </motion.div>
              )}
              {appState === "listening" && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="flex items-center gap-2 bg-violet-500/10 border border-violet-500/30 px-3 py-1.5 rounded-full text-violet-300 text-xs font-mono uppercase tracking-widest shadow-lg shadow-violet-500/10 backdrop-blur-md animate-pulse"
                >
                  <div className="w-1.5 h-1.5 rounded-full bg-violet-400" />
                  Listening Harikirshan
                </motion.div>
              )}
              {appState === "speaking" && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="flex items-center gap-2 bg-pink-500/10 border border-pink-500/30 px-3 py-1.5 rounded-full text-pink-300 text-xs font-mono uppercase tracking-widest shadow-lg shadow-pink-500/10 backdrop-blur-md"
                >
                  <Volume2 size={12} className="text-pink-400 animate-bounce" />
                  Zoya is Speaking
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Right Column: Synced Realtime Chat Log */}
        <div className="hidden md:flex w-[30%] lg:w-[32%] h-full flex-col justify-between z-10 bg-white/5 border border-white/10 p-4 rounded-2xl backdrop-blur-md overflow-hidden pointer-events-auto shadow-2xl">
          <div className="flex items-center justify-between border-b border-white/10 pb-2">
            <div className="flex items-center gap-2">
              <Sparkles size={16} className="text-violet-400" />
              <span className="font-mono text-xs uppercase tracking-wider text-white/80">Secure Database Log</span>
            </div>
            {user ? (
              <span className="text-[9px] bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded-full font-mono">
                Memory Active
              </span>
            ) : (
              <span className="text-[9px] bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded-full font-mono">
                No Cloud Sync
              </span>
            )}
          </div>
          
          {/* Chat log messages list */}
          <div className="flex-1 overflow-y-auto scrollbar-hide py-3 space-y-3">
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center p-4">
                <p className="text-xs text-white/30 font-mono">No conversation logs</p>
                <p className="text-[10px] text-white/20 mt-1">Start chatting to write history to Firestore</p>
              </div>
            ) : (
              messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex flex-col max-w-[85%] ${
                    msg.sender === "user" ? "ml-auto items-end" : "mr-auto items-start"
                  }`}
                >
                  <span className="text-[9px] text-white/30 font-mono mb-0.5 uppercase tracking-wide">
                    {msg.sender === "user" ? creatorName : "Zoya"}
                  </span>
                  <div
                    className={`px-3 py-1.5 text-xs rounded-2xl ${
                      msg.sender === "user"
                        ? "bg-gradient-to-tr from-violet-600 to-pink-600 text-white rounded-tr-none shadow-lg shadow-violet-500/10"
                        : "bg-white/10 text-white border border-white/10 rounded-tl-none"
                    }`}
                  >
                    <div>{msg.text}</div>
                    {msg.groundingSources && msg.groundingSources.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2 border-t border-white/10 pt-1.5 pointer-events-auto">
                        {msg.groundingSources.map((src, idx) => (
                          <a
                            key={idx}
                            href={src.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-[9px] bg-white/5 hover:bg-violet-500/30 text-violet-300 hover:text-white px-1.5 py-0.5 rounded border border-white/5 transition-colors"
                          >
                            <Sparkles size={8} className="text-violet-400 shrink-0" />
                            <span className="max-w-[100px] truncate">{src.title}</span>
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="border-t border-white/10 pt-2 flex items-center justify-between text-[10px] text-white/40">
            <span className="font-mono">{user ? "Firestore DB Active" : "Local Temp Storage"}</span>
            {messages.length > 0 && (
              <button
                onClick={clearHistory}
                className="flex items-center gap-1 hover:text-red-400 transition-colors pointer-events-auto font-mono cursor-pointer"
                title="Wipe database history logs"
              >
                <Trash2 size={10} />
                <span>Wipe Memory</span>
              </button>
            )}
          </div>
        </div>

      </main>

      {/* Controls */}
      <footer className="absolute bottom-0 left-0 w-full flex flex-col items-center justify-center pb-6 md:pb-8 z-20 shrink-0 gap-4">
        <AnimatePresence>
          {showTextInput && (
            <motion.form 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              onSubmit={handleTextSubmit}
              className="w-full max-w-md flex items-center gap-2 bg-white/5 border border-white/10 rounded-full p-1 pl-4 backdrop-blur-md shadow-2xl"
            >
              <input 
                type="text"
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                placeholder="Type a message to Zoya..."
                className="flex-1 bg-transparent border-none outline-none text-white placeholder:text-white/30 text-sm"
                autoFocus
              />
              <button 
                type="submit"
                disabled={!textInput.trim()}
                className="p-2 rounded-full bg-violet-500 hover:bg-violet-600 disabled:opacity-50 disabled:hover:bg-violet-500 transition-colors cursor-pointer"
              >
                <Send size={16} />
              </button>
            </motion.form>
          )}
        </AnimatePresence>

        <div className="flex items-center gap-4">
          <button
            onClick={toggleListening}
            className={`
              group relative flex items-center gap-3 px-8 py-4 rounded-full font-medium tracking-wide transition-all duration-300 shadow-2xl cursor-pointer
              ${
                isSessionActive
                  ? "bg-red-500/20 text-red-400 border border-red-500/50 hover:bg-red-500/30"
                  : "bg-white/10 text-white border border-white/20 hover:bg-white/20 hover:scale-105 animate-pulse"
              }
            `}
          >
            {isSessionActive ? (
              <>
                <MicOff size={20} />
                <span>End Realtime Talk</span>
              </>
            ) : (
              <>
                <Mic size={20} className="group-hover:animate-bounce" />
                <span>Start Realtime Talk</span>
              </>
            )}
          </button>
          
          {!isSessionActive && (
            <button
              onClick={() => setShowTextInput(!showTextInput)}
              className="p-4 rounded-full bg-white/5 border border-white/10 hover:bg-white/10 transition-colors shadow-2xl cursor-pointer"
              title="Type instead"
            >
              <Keyboard size={20} className="opacity-70" />
            </button>
          )}
        </div>
      </footer>

      {/* Mobile Settings/Database Overlay */}
      <AnimatePresence>
        {showSettingsOverlay && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 md:hidden bg-black/85 backdrop-blur-md flex items-center justify-center p-4 pointer-events-auto"
          >
            <motion.div
              initial={{ scale: 0.95, y: 15 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 15 }}
              className="relative w-full max-w-sm bg-[#050f14] border border-white/10 p-5 rounded-2xl shadow-2xl flex flex-col justify-between"
            >
              <button
                onClick={() => setShowSettingsOverlay(false)}
                className="absolute top-4 right-4 p-1 rounded-full hover:bg-white/10 text-white/50 hover:text-white transition-colors animate-pulse"
              >
                <X size={18} />
              </button>

              <div className="flex items-center gap-2 border-b border-white/10 pb-3 mb-4">
                <UserIcon size={16} className="text-violet-400" />
                <span className="font-mono text-xs uppercase tracking-wider text-white/80">Database & Preferences</span>
              </div>

              <div className="space-y-4">
                {user ? (
                  <div className="space-y-4">
                    <div className="flex items-center gap-3 bg-white/5 p-3 rounded-xl border border-white/5">
                      <img 
                        src={user.photoURL || "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=80&auto=format&fit=crop&q=60"} 
                        alt="Profile photo" 
                        referrerPolicy="no-referrer"
                        className="w-10 h-10 rounded-full border border-violet-500/50" 
                      />
                      <div className="overflow-hidden">
                        <h4 className="font-semibold text-sm truncate">{user.displayName || "Harikirshan lodhi"}</h4>
                        <p className="text-[10px] text-white/40 font-mono truncate">{user.email}</p>
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-[10px] text-white/40 uppercase tracking-wider font-mono">Dynamic AI Persona Name</label>
                      <input 
                        type="text" 
                        value={creatorName}
                        onChange={(e) => updateCreatorNameInDb(e.target.value)}
                        placeholder="Enter creator name..."
                        maxLength={40}
                        className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:border-violet-500 focus:outline-none transition-colors"
                      />
                      <p className="text-[10px] text-white/30 leading-snug font-mono">
                        Zoya will address and roast you by this name. Synced live on Firestore.
                      </p>
                    </div>

                    {gmailToken ? (
                      <div className="flex items-center gap-1.5 text-[10px] text-emerald-400 font-mono bg-emerald-500/10 p-2 rounded-xl border border-emerald-500/20">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                        <span className="truncate">Gmail Access Enabled</span>
                      </div>
                    ) : (
                      <button
                        onClick={handleLogin}
                        className="w-full py-1.5 bg-violet-600/10 hover:bg-violet-600/20 text-violet-300 border border-violet-500/20 rounded-xl text-[10px] font-mono transition-all cursor-pointer flex items-center justify-center gap-1.5"
                      >
                        <Sparkles size={11} className="text-violet-400" />
                        <span>Authorize Gmail Search</span>
                      </button>
                    )}

                    <button
                      onClick={() => { handleLogout(); setShowSettingsOverlay(false); }}
                      className="w-full py-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 rounded-xl text-xs font-mono transition-colors cursor-pointer"
                    >
                      Unbind Database Sync
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center text-center space-y-4 py-4">
                    <div className="w-11 h-11 bg-gradient-to-tr from-violet-500/10 to-pink-500/10 border border-violet-500/20 rounded-full flex items-center justify-center text-violet-400">
                      <Sparkles size={20} className="animate-pulse" />
                    </div>
                    <div className="space-y-1">
                      <h3 className="text-sm font-semibold font-serif leading-tight">Welcome, Harikirshan Lodhi</h3>
                      <p className="text-xs text-white/40 leading-relaxed max-w-[210px] mx-auto">
                        Bind your Google Account to synchronize settings, mute configuration, and chat memory in Firebase!
                      </p>
                    </div>
                    
                    <button
                      onClick={() => { handleLogin(); setShowSettingsOverlay(false); }}
                      className="flex items-center justify-center gap-2 bg-gradient-to-r from-violet-600 to-pink-600 text-white font-medium text-xs py-2 px-4 rounded-xl shadow-lg shadow-violet-500/20 cursor-pointer"
                    >
                      <LogIn size={12} />
                      <span>Connect Firestore Sync</span>
                    </button>
                  </div>
                )}
              </div>

              <div className="border-t border-white/10 pt-3 mt-4 flex justify-between items-center text-[10px] text-white/40 font-mono">
                <span>Sync Status:</span>
                <span className="text-emerald-400">{user ? "Synced Securely" : "Guest Mode (Local)"}</span>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Mobile Chat History/Memory Overlay */}
      <AnimatePresence>
        {showHistoryOverlay && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 md:hidden bg-black/85 backdrop-blur-md flex items-center justify-center p-4 pointer-events-auto"
          >
            <motion.div
              initial={{ scale: 0.95, y: 15 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 15 }}
              className="relative w-full max-w-sm h-[75vh] bg-[#050f14] border border-white/10 p-5 rounded-2xl shadow-2xl flex flex-col justify-between"
            >
              <button
                onClick={() => setShowHistoryOverlay(false)}
                className="absolute top-4 right-4 p-1 rounded-full hover:bg-white/10 text-white/50 hover:text-white transition-colors"
              >
                <X size={18} />
              </button>

              <div className="flex items-center justify-between border-b border-white/10 pb-3 mb-3">
                <div className="flex items-center gap-2">
                  <Sparkles size={16} className="text-violet-400" />
                  <span className="font-mono text-xs uppercase tracking-wider text-white/80">Secure Database Log</span>
                </div>
                {user ? (
                  <span className="text-[9px] bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded-full font-mono">
                    Memory Active
                  </span>
                ) : (
                  <span className="text-[9px] bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded-full font-mono">
                    No Cloud Sync
                  </span>
                )}
              </div>

              {/* Message scroll log */}
              <div className="flex-1 overflow-y-auto scrollbar-hide py-2 space-y-3 pr-1">
                {messages.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center p-4">
                    <p className="text-xs text-white/30 font-mono">No conversation logs</p>
                    <p className="text-[10px] text-white/20 mt-1">Start talking to write history to Firestore</p>
                  </div>
                ) : (
                  messages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`flex flex-col max-w-[85%] ${
                        msg.sender === "user" ? "ml-auto items-end" : "mr-auto items-start"
                      }`}
                    >
                      <span className="text-[9px] text-white/30 font-mono mb-0.5 uppercase tracking-wide">
                        {msg.sender === "user" ? creatorName : "Zoya"}
                      </span>
                      <div
                        className={`px-3 py-1.5 text-xs rounded-2xl ${
                          msg.sender === "user"
                            ? "bg-gradient-to-tr from-violet-600 to-pink-600 text-white rounded-tr-none shadow-lg shadow-violet-500/10"
                            : "bg-white/10 text-white border border-white/10 rounded-tl-none"
                        }`}
                      >
                        <div>{msg.text}</div>
                        {msg.groundingSources && msg.groundingSources.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2 border-t border-white/10 pt-1.5 pointer-events-auto">
                            {msg.groundingSources.map((src, idx) => (
                              <a
                                key={idx}
                                href={src.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-[9px] bg-white/5 hover:bg-violet-500/30 text-violet-300 hover:text-white px-1.5 py-0.5 rounded border border-white/5 transition-colors"
                              >
                                <Sparkles size={8} className="text-violet-400 shrink-0" />
                                <span className="max-w-[100px] truncate">{src.title}</span>
                              </a>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div className="border-t border-white/10 pt-3 mt-3 flex justify-between items-center text-[10px] text-white/40 font-mono">
                <span>{user ? "Firestore DB Active" : "Local Temp Storage"}</span>
                {messages.length > 0 && (
                  <button
                    onClick={() => { clearHistory(); setShowHistoryOverlay(false); }}
                    className="flex items-center gap-1 hover:text-red-400 transition-colors pointer-events-auto font-mono cursor-pointer"
                  >
                    <Trash2 size={10} />
                    <span>Wipe Memory</span>
                  </button>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
